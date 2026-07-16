import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canConnect, listeningPidsForPort, terminatePids } from "../src/core/process-tools.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-dashboard-open-"));
const stateDir = path.join(tmpDir, "state");
const storePath = path.join(tmpDir, "store.sqlite");
const apiPort = await freePort();
const capturePort = await freePort();
const dashboardUrl = `http://127.0.0.1:${apiPort}`;
const captureUrl = `http://127.0.0.1:${capturePort}`;

const env = {
  ...process.env,
  PEEKMYAGENT_STATE_DIR: stateDir,
  PEEKMYAGENT_DAEMON_PORT: String(apiPort),
  PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
  PEEKMYAGENT_STORE_PATH: storePath,
};

try {
  killListeningPort(apiPort);
  killListeningPort(capturePort);

  const openResult = runCli(["open", "--print", "--no-open"], env);
  assert.equal(openResult.status, 0, openResult.stderr);
  assert.equal(openResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}`);

  const status = await getJson(`${dashboardUrl}/api/daemon/status`);
  assert.equal(status.shared_capture_proxy, true);
  assert.equal(status.capture_url, captureUrl);
  assert.equal(typeof status.pid, "number");
  const translationContract = await getText(`${dashboardUrl}/translation-blocks.js`);
  assert.match(translationContract, /export function translationLookupKey/, "browser translation contract is served");

  const viewResult = runCli(["view", "--print", "--no-open"], env);
  assert.equal(viewResult.status, 0, viewResult.stderr);
  assert.equal(viewResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}`);

  const sourceResult = runCli(["dashboard", "--source", "live-test-watch", "--print", "--no-open"], env);
  assert.equal(sourceResult.status, 0, sourceResult.stderr);
  assert.equal(sourceResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}/?source=live-test-watch`);

  const sourceAssignmentResult = runCli(["open", "--source=live-test-watch-2", "--print", "--no-open"], env);
  assert.equal(sourceAssignmentResult.status, 0, sourceAssignmentResult.stderr);
  assert.equal(sourceAssignmentResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}/?source=live-test-watch-2`);

  const missingSourceResult = runCli(["open", "--source", "--print", "--no-open"], env);
  assert.equal(missingSourceResult.status, 1);
  assert.match(missingSourceResult.stderr, /--source requires a value/);

  const shutdownResult = runCli(["shutdown"], env);
  assert.equal(shutdownResult.status, 0, shutdownResult.stderr);
  assert.match(shutdownResult.stdout, new RegExp(`peekMyAgent daemon stopped: ${escapeRegExp(dashboardUrl)}`));
  assert.equal(await canConnect("127.0.0.1", apiPort), false);
  assert.equal(await canConnect("127.0.0.1", capturePort), false);

  const shutdownAgainResult = runCli(["shutdown"], env);
  assert.equal(shutdownAgainResult.status, 0, shutdownAgainResult.stderr);
  assert.equal(shutdownAgainResult.stdout.trim(), "peekMyAgent daemon: not running");

  const restartResult = runCli(["restart", "--print", "--no-open"], env);
  assert.equal(restartResult.status, 0, restartResult.stderr);
  assert.match(restartResult.stdout, new RegExp(`peekMyAgent restarted: ${escapeRegExp(dashboardUrl)}`));

  const restartedStatus = await getJson(`${dashboardUrl}/api/daemon/status`);
  assert.equal(restartedStatus.shared_capture_proxy, true);
  assert.equal(restartedStatus.capture_url, captureUrl);

  const shutdownJsonResult = runCli(["shutdown", "--json"], env);
  assert.equal(shutdownJsonResult.status, 0, shutdownJsonResult.stderr);
  const shutdownJson = JSON.parse(shutdownJsonResult.stdout);
  assert.equal(shutdownJson.action, "shutdown");
  assert.equal(shutdownJson.status, "stopped");
  assert.equal(shutdownJson.url, dashboardUrl);
  assert.equal(shutdownJson.method, "api");
  assert.equal(await canConnect("127.0.0.1", apiPort), false);
  assert.equal(await canConnect("127.0.0.1", capturePort), false);

  const restartJsonResult = runCli(["restart", "--json", "--no-open"], env);
  assert.equal(restartJsonResult.status, 0, restartJsonResult.stderr);
  const restartJson = JSON.parse(restartJsonResult.stdout);
  assert.equal(restartJson.action, "restart");
  assert.equal(restartJson.status, "started");
  assert.equal(restartJson.url, dashboardUrl);
  assert.equal(restartJson.stopped.status, "not_running");
  const restartedJsonStatus = await getJson(`${dashboardUrl}/api/daemon/status`);
  assert.equal(restartedJsonStatus.shared_capture_proxy, true);
  assert.equal(restartedJsonStatus.capture_url, captureUrl);

  const finalShutdown = runCli(["shutdown", "--json"], env);
  assert.equal(finalShutdown.status, 0, finalShutdown.stderr);
  assert.equal(JSON.parse(finalShutdown.stdout).status, "stopped");

  const staleServer = await startStaleDaemonServer(apiPort);
  try {
    writeViewerRegistry({ url: dashboardUrl, pid: staleServer.pid });
    const forceShutdown = runCli(["shutdown", "--force", "--json"], env);
    assert.equal(forceShutdown.status, 0, forceShutdown.stderr);
    const forceShutdownJson = JSON.parse(forceShutdown.stdout);
    assert.equal(forceShutdownJson.action, "shutdown");
    assert.equal(forceShutdownJson.status, "stopped");
    assert.equal(forceShutdownJson.url, dashboardUrl);
    assert.equal(forceShutdownJson.method, process.platform === "win32" ? "taskkill" : "SIGTERM");
    await waitForExit(staleServer);
    assert.equal(await canConnect("127.0.0.1", apiPort), false);
  } finally {
    if (staleServer.exitCode === null && staleServer.signalCode === null) staleServer.kill("SIGTERM");
  }

  console.log("dashboard open smoke passed");
} finally {
  killListeningPort(apiPort);
  killListeningPort(capturePort);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, commandEnv) {
  return spawnSync(process.execPath, ["bin/peekmyagent.mjs", ...args], {
    cwd,
    env: commandEnv,
    encoding: "utf8",
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function getText(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
  return text;
}

function killListeningPort(port) {
  const owner = listeningPidsForPort(port);
  if (!owner.supported || !owner.pids.length) return;
  terminatePids(owner.pids);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeViewerRegistry(entry) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "viewer.json"), `${JSON.stringify(entry, null, 2)}\n`);
}

function startStaleDaemonServer(port) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const http = require('node:http');",
        "const port = Number(process.argv[1]);",
        "const server = http.createServer((req, res) => {",
        "  res.writeHead(404, { 'content-type': 'application/json' });",
        "  res.end(JSON.stringify({ error: 'old daemon has no shutdown endpoint' }));",
        "});",
        "server.listen(port, '127.0.0.1', () => console.log('ready'));",
      ].join("\n"),
      String(port),
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for stale daemon server.")), 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
