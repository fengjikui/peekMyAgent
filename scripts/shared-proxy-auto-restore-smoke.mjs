import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-shared-restore-"));
const storePath = path.join(tmpDir, "store.sqlite");
const sessionId = `shared-restore-${Date.now()}-${process.pid}`;
const upstreamRequests = [];

const upstream = http.createServer(async (req, res) => {
  const rawBody = await readBody(req);
  upstreamRequests.push({ method: req.method, url: req.url, body: JSON.parse(rawBody) });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_shared_restore", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

let daemon = null;

try {
  const upstreamUrl = await listen(upstream);
  const apiPort = await freePort();
  const capturePort = await freePort();
  const daemonUrl = `http://127.0.0.1:${apiPort}`;

  daemon = await startDaemon({ apiPort, capturePort, upstreamUrl });
  await waitForDaemon(daemonUrl);

  const watch = await postJson(`${daemonUrl}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: cwd,
    conversation_id: sessionId,
    target_base_url: upstreamUrl,
    started_by: "shared-proxy-auto-restore-smoke",
  });

  await postModelRequest(watch.base_url, "before restart");
  assert.equal(upstreamRequests.length, 1);

  daemon.kill("SIGTERM");
  await waitForClose(daemon);
  daemon = null;

  daemon = await startDaemon({ apiPort, capturePort, upstreamUrl });
  await waitForDaemon(daemonUrl);

  await postModelRequest(watch.base_url, "after restart with stale watch url");
  assert.equal(upstreamRequests.length, 2);

  const status = await getJson(`${daemonUrl}/api/daemon/status`);
  const restoredWatch = status.watches.find((item) => item.watch_id === watch.watch_id);
  assert.ok(restoredWatch, "watch should be restored from persisted store");
  assert.equal(restoredWatch.status, "watching");
  assert.equal(restoredWatch.request_count, 2);

  const data = await getJson(`${daemonUrl}/api/view?source=${encodeURIComponent(restoredWatch.id)}`);
  assert.equal(data.stats.request_count, 2);
  assert.deepEqual(
    data.requests.map((request) => request.summary.current_user),
    ["before restart", "after restart with stale watch url"],
  );

  daemon.kill("SIGTERM");
  await waitForClose(daemon);
  daemon = null;

  console.log("shared proxy auto restore smoke passed");
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await waitForClose(daemon).catch(() => {});
  }
  await closeServer(upstream).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function startDaemon({ apiPort, capturePort, upstreamUrl }) {
  const child = spawn(process.execPath, ["bin/peekmyagent.mjs", "daemon", "--api-port", String(apiPort), "--capture-port", String(capturePort)], {
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: upstreamUrl,
      PEEKMYAGENT_STORE_PATH: storePath,
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function postModelRequest(baseUrl, content) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": sessionId,
      authorization: "Bearer smoke",
    },
    body: JSON.stringify({
      model: "mock-claude",
      max_tokens: 8,
      messages: [{ role: "user", content }],
    }),
  });
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForDaemon(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      const data = await getJson(`${url}/api/daemon/status`);
      if (data.shared_capture_proxy) return data;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for daemon at ${url}`);
}

async function freePort() {
  const server = http.createServer();
  const url = await listen(server);
  const port = Number(new URL(url).port);
  await closeServer(server);
  return port;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForClose(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    child.once("close", resolve);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
