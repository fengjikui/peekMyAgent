import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-run-claude-"));
const binDir = path.join(tmpDir, "bin");
fs.mkdirSync(binDir);
const runId = `run-smoke-${Date.now()}-${process.pid}`;
const resumeSession = `${runId}-resume`;
const continueSession = `${runId}-continue`;
const shortcutSession = `${runId}-shortcut`;
const failSession = `${runId}-fail`;
const missingWatchCleanupSession = `${runId}-missing-watch-cleanup`;
const argsPath = path.join(tmpDir, "claude-args.json");
const originalStateDir = process.env.PEEKMYAGENT_STATE_DIR;
process.env.PEEKMYAGENT_STATE_DIR = path.join(tmpDir, "state");

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_smoke", type: "message", content: [{ type: "text", text: "ok" }] }));
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd, demo: "openclaw-subagent" });

try {
  writeFakeNodeCommand(
    binDir,
    "claude",
    `
import fs from 'node:fs';
const resumeIndex = process.argv.indexOf('--resume');
const shortResumeIndex = process.argv.indexOf('-r');
const sessionId = process.argv.includes('--continue') || process.argv.includes('-c')
  ? '${continueSession}'
  : resumeIndex !== -1
    ? process.argv[resumeIndex + 1]
    : shortResumeIndex !== -1
      ? process.argv[shortResumeIndex + 1]
      : '${resumeSession}';
await fs.promises.writeFile(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2), null, 2));
if (process.env.PEEK_FAKE_CLAUDE_FAIL === '1') {
  console.error('fake claude fail');
  process.exit(7);
}
const url = process.env.ANTHROPIC_BASE_URL + '/v1/messages';
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-claude-code-session-id': sessionId,
    authorization: 'Bearer smoke'
  },
  body: JSON.stringify({
    model: 'mock-claude',
    system: 'run wrapper smoke',
    messages: [{ role: 'user', content: 'hello from run wrapper' }]
  })
});
if (!response.ok) process.exit(2);
console.log('fake claude ok');
if (process.env.PEEK_FAKE_CLEAR_WATCH === '1') {
  const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL);
  const watchId = baseUrl.pathname.split('/').filter(Boolean)[1];
  if (!watchId) process.exit(3);
  const stopResponse = await fetch(process.env.PEEK_FAKE_VIEWER_URL + '/api/watch/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-peekmyagent-intent': 'watch-stop' },
    body: JSON.stringify({ id: 'live-' + watchId, clear: true })
  });
  if (!stopResponse.ok) process.exit(4);
}
	`,
  );

  const result = await runCli(["run", "claude", "--viewer-url", viewer.url, "--", "--resume", resumeSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /peekMyAgent watch:/);
  assert.match(result.stdout, /fake claude ok/);
  const firstArgs = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  assert.equal(firstArgs.includes("--mode=single_session"), false);

  const sources = await getJson(`${viewer.url}/api/sources`);
  const live = sources.find((source) => source.agent === "Claude Code" && source.conversation_id === resumeSession);
  assert.ok(live);
  assert.equal(live.live_status, "stopped");
  assert.equal(live.request_count, 1);

  const data = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(live.id)}`);
  assert.equal(data.stats.request_count, 1);
  assert.equal(data.requests[0].conversation_id, resumeSession);
  assert.equal(data.requests[0].request_index, 1);

  const reuseResult = await runCli(["run", "claude", "--viewer-url", viewer.url, "--watch", "reuse", "--mode=single_session", "--", "--resume", resumeSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(reuseResult.code, 0, reuseResult.stderr);
  assert.match(reuseResult.stdout, /fake claude ok/);
  const reuseArgs = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  assert.equal(reuseArgs.includes("--mode=single_session"), false);

  const sourcesAfterReuse = await getJson(`${viewer.url}/api/sources`);
  const liveAfterReuse = sourcesAfterReuse.filter((source) => source.agent === "Claude Code" && source.conversation_id === resumeSession);
  assert.equal(liveAfterReuse.length, 1);
  assert.equal(liveAfterReuse[0].id, live.id);
  assert.equal(liveAfterReuse[0].live_status, "stopped");
  assert.equal(liveAfterReuse[0].request_count, 2);

  const reusedData = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(live.id)}`);
  assert.equal(reusedData.stats.request_count, 2);
  assert.deepEqual(
    reusedData.requests.map((request) => request.request_index),
    [1, 2],
  );

  const continueResult = await runCli(["run", "claude", "--viewer-url", viewer.url, "--", "--continue"], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(continueResult.code, 0, continueResult.stderr);
  assert.match(continueResult.stderr, /当前不是交互式终端；本次将新建监听/);
  assert.match(continueResult.stdout, /fake claude ok/);

  const sourcesAfterContinue = await getJson(`${viewer.url}/api/sources`);
  const continueLive = sourcesAfterContinue.find((source) => source.agent === "Claude Code" && source.conversation_id === continueSession);
  assert.ok(continueLive);
  assert.equal(continueLive.request_count, 1);

  const shortcutResult = await runCli([`--viewer-url=${viewer.url}`, "--capture=proxy", "claude", "-r", shortcutSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(shortcutResult.code, 0, shortcutResult.stderr);
  assert.match(shortcutResult.stdout, /fake claude ok/);

  const shortcutReuseResult = await runCli([`--viewer-url=${viewer.url}`, "--watch=reuse", "claude", "-r", shortcutSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(shortcutReuseResult.code, 0, shortcutReuseResult.stderr);
  assert.match(shortcutReuseResult.stdout, /fake claude ok/);

  const sourcesAfterShortcut = await getJson(`${viewer.url}/api/sources`);
  const shortcutLive = sourcesAfterShortcut.filter((source) => source.agent === "Claude Code" && source.conversation_id === shortcutSession);
  assert.equal(shortcutLive.length, 1);
  assert.equal(shortcutLive[0].request_count, 2);

  const failResult = await runCli(["run", "claude", "--viewer-url", viewer.url, "--", "--resume", failSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
    PEEK_FAKE_CLAUDE_FAIL: "1",
  });
  assert.equal(failResult.code, 7, failResult.stderr);
  assert.match(failResult.stderr, /peekMyAgent watch:/);
  assert.match(failResult.stderr, /fake claude fail/);

  const sourcesAfterFailure = await getJson(`${viewer.url}/api/sources`);
  const failedLive = sourcesAfterFailure.find((source) => source.agent === "Claude Code" && source.conversation_id === failSession);
  assert.ok(failedLive);
  assert.equal(failedLive.live_status, "stopped");
  assert.equal(failedLive.request_count, 0);

  const missingWatchCleanupResult = await runCli(["run", "claude", "--viewer-url", viewer.url, "--", "--resume", missingWatchCleanupSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
    PEEK_FAKE_CLEAR_WATCH: "1",
    PEEK_FAKE_VIEWER_URL: viewer.url,
  });
  assert.equal(missingWatchCleanupResult.code, 0, missingWatchCleanupResult.stderr);
  assert.match(missingWatchCleanupResult.stdout, /fake claude ok/);
  assert.doesNotMatch(missingWatchCleanupResult.stderr, /peekmyagent error|Watch not found/i);

  console.log("run claude wrapper smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
  if (originalStateDir == null) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = originalStateDir;
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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function listen(server) {
  return new Promise((resolve) => {
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
