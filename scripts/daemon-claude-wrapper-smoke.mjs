import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-daemon-claude-"));
const binDir = path.join(tmpDir, "bin");
const storePath = path.join(tmpDir, "store.sqlite");
fs.mkdirSync(binDir);

const runId = `daemon-smoke-${Date.now()}-${process.pid}`;
const sessionId = `${runId}-resume`;
const upstreamRequests = [];

const upstream = http.createServer(async (req, res) => {
  const rawBody = await readBody(req);
  upstreamRequests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(rawBody) });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_daemon_smoke", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

let daemon = null;

try {
  const upstreamUrl = await listen(upstream);
  const apiPort = await freePort();
  const capturePort = await freePort();
  const daemonUrl = `http://127.0.0.1:${apiPort}`;
  const captureUrl = `http://127.0.0.1:${capturePort}`;

  writeFakeNodeCommand(
    binDir,
    "claude",
    `
import assert from 'node:assert/strict';

const resumeIndex = process.argv.indexOf('--resume');
const shortResumeIndex = process.argv.indexOf('-r');
const sessionId = resumeIndex !== -1
  ? process.argv[resumeIndex + 1]
  : shortResumeIndex !== -1
    ? process.argv[shortResumeIndex + 1]
    : '${sessionId}';

assert.ok(process.env.ANTHROPIC_BASE_URL, 'ANTHROPIC_BASE_URL is required');
assert.ok(process.env.ANTHROPIC_BASE_URL.startsWith('${captureUrl}/watch/'), process.env.ANTHROPIC_BASE_URL);

const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-claude-code-session-id': sessionId,
    authorization: 'Bearer smoke'
  },
  body: JSON.stringify({
    model: 'mock-claude',
    system: 'daemon wrapper smoke',
    messages: [{ role: 'user', content: 'hello from daemon wrapper' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }]
  })
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(2);
}
console.log('fake claude daemon ok');
`,
  );

  daemon = spawn(
    process.execPath,
    ["bin/peekmyagent.mjs", "daemon", "--api-port", String(apiPort), "--capture-port", String(capturePort)],
    {
      cwd,
      env: { ...process.env, PEEKMYAGENT_STORE_PATH: storePath },
    },
  );

  const daemonOutput = captureOutput(daemon);
  await waitForDaemon(daemonUrl);

  const result = await runCli(["claude", "--resume", sessionId], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
    PEEKMYAGENT_STORE_PATH: storePath,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /peekMyAgent watch:/);
  assert.match(result.stderr, new RegExp(escapeRegExp(`${daemonUrl}?source=live-`)));
  assert.match(result.stdout, /fake claude daemon ok/);

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].method, "POST");
  assert.equal(upstreamRequests[0].url, "/v1/messages?beta=true");
  assert.equal(upstreamRequests[0].body.messages[0].content, "hello from daemon wrapper");

  const status = await getJson(`${daemonUrl}/api/daemon/status`);
  assert.equal(status.shared_capture_proxy, true);
  assert.equal(status.capture_url, captureUrl);
  const watch = status.watches.find((item) => item.agent === "Claude Code" && item.conversation_id === sessionId);
  assert.ok(watch);
  assert.equal(watch.status, "stopped");
  assert.equal(watch.request_count, 1);
  assert.match(watch.base_url, new RegExp(`^${escapeRegExp(captureUrl)}/watch/`));
  const firstWatchId = watch.watch_id;

  const data = await getJson(`${daemonUrl}/api/view?source=${encodeURIComponent(watch.id)}`);
  assert.equal(data.stats.request_count, 1);
  assert.equal(data.requests[0].conversation_id, sessionId);
  assert.equal(data.requests[0].path, "/v1/messages?beta=true");
  assert.equal(data.requests[0].request_index, 1);
  assert.equal(data.requests[0].summary.current_user, "hello from daemon wrapper");

  daemon.kill("SIGTERM");
  await waitForClose(daemon);
  daemon = null;

  daemon = spawn(
    process.execPath,
    ["bin/peekmyagent.mjs", "daemon", "--api-port", String(apiPort), "--capture-port", String(capturePort)],
    {
      cwd,
      env: { ...process.env, PEEKMYAGENT_STORE_PATH: storePath },
    },
  );
  captureOutput(daemon);
  await waitForDaemon(daemonUrl);

  const reuseResult = await runCli(["--reuse", "claude", "--resume", sessionId], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
    PEEKMYAGENT_STORE_PATH: storePath,
  });
  assert.equal(reuseResult.code, 0, reuseResult.stderr);
  assert.match(reuseResult.stdout, /fake claude daemon ok/);
  assert.equal(upstreamRequests.length, 2);

  const restoredStatus = await getJson(`${daemonUrl}/api/daemon/status`);
  const restoredWatch = restoredStatus.watches.find((item) => item.agent === "Claude Code" && item.conversation_id === sessionId);
  assert.ok(restoredWatch);
  assert.equal(restoredWatch.watch_id, firstWatchId);
  assert.equal(restoredWatch.status, "stopped");
  assert.equal(restoredWatch.request_count, 2);

  const restoredData = await getJson(`${daemonUrl}/api/view?source=${encodeURIComponent(restoredWatch.id)}`);
  assert.equal(restoredData.stats.request_count, 2);
  assert.deepEqual(
    restoredData.requests.map((request) => request.request_index),
    [1, 2],
  );

  daemon.kill("SIGTERM");
  await waitForClose(daemon);
  daemon = null;

  assert.ok(daemonOutput.stdout.includes("peekMyAgent daemon:"));
  assert.ok(daemonOutput.stdout.includes("peekMyAgent capture proxy:"));
  console.log("daemon claude wrapper smoke passed");
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await waitForClose(daemon).catch(() => {});
  }
  await closeServer(upstream).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/peekmyagent.mjs", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function captureOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr += chunk;
  });
  return output;
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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
