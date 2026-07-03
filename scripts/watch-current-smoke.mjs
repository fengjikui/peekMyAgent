import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startViewerServer } from "../src/viewer/server.mjs";

const cwd = process.cwd();
const originalTarget = process.env.PEEK_CLAUDE_TARGET_BASE_URL;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-watch-current-"));
const storePath = path.join(tmpDir, "store.sqlite");

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "mock-claude",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});

const upstreamUrl = await listen(upstream);
process.env.PEEK_CLAUDE_TARGET_BASE_URL = upstreamUrl;

const viewer = await startViewerServer({ cwd, demo: "openclaw-subagent", storePath });

try {
  const env = {
    ...process.env,
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "smoke-claude-session",
    PWD: cwd,
  };
  const first = await runCli(["watch-current", "--agent", "claude-code", "--viewer-url", viewer.url, "--json"], env);
  assert.equal(first.status, "watching");
  assert.equal(first.reused, false);
  assert.equal(first.conversation_id, "smoke-claude-session");
  assert.match(first.resume_command, /claude --resume/);
  const sourcesBeforeCapture = await getJson(`${viewer.url}/api/sources`);
  const liveBeforeCapture = sourcesBeforeCapture.find((source) => source.id === first.id);
  assert.ok(liveBeforeCapture, "new watch should appear in the sidebar before the first request");
  assert.equal(liveBeforeCapture.request_count, 0);
  assert.equal(liveBeforeCapture.live_status, "watching");

  const second = await runCli(["watch-current", "--agent", "claude-code", "--viewer-url", viewer.url, "--json"], env);
  assert.equal(second.reused, true);
  assert.equal(second.watch_id, first.watch_id);

  await fetch(`${first.base_url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify({
      model: "mock-claude",
      system: "You are a smoke test.",
      messages: [{ role: "user", content: "hello from smoke" }],
    }),
  });

  const viewAfterCapture = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(first.id)}`);
  assert.equal(viewAfterCapture.stats.request_count, 1);
  assert.equal(viewAfterCapture.requests[0].conversation_id, "smoke-claude-session");

  const sourcesAfterCapture = await getJson(`${viewer.url}/api/sources`);
  const liveAfterCapture = sourcesAfterCapture.find((source) => source.id === first.id);
  assert.equal(liveAfterCapture.label, "hello from smoke");

  const updatedSource = await postJson(`${viewer.url}/api/source/update`, {
    id: first.id,
    title: "Renamed smoke session",
    pinned: true,
  });
  assert.equal(updatedSource.source.label, "Renamed smoke session");
  assert.equal(updatedSource.source.pinned, true);
  assert.equal(updatedSource.sources[0].id, first.id);

  const viewAfterRename = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(first.id)}`);
  assert.equal(viewAfterRename.source.label, "Renamed smoke session");

  const paused = await runCli(["watch-current", "--agent", "claude-code", "--viewer-url", viewer.url, "--pause", "--json"], env);
  assert.equal(paused.action, "pause");
  assert.equal(paused.status, "paused");
  assert.equal(paused.watch_id, first.watch_id);

  await fetch(`${first.base_url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify({
      model: "mock-claude",
      system: "You are a smoke test.",
      messages: [{ role: "user", content: "paused smoke should not persist" }],
    }),
  });

  const viewWhilePaused = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(first.id)}`);
  assert.equal(viewWhilePaused.stats.request_count, 1);

  const resumed = await runCli(["watch-current", "--agent", "claude-code", "--viewer-url", viewer.url, "--resume", "--json"], env);
  assert.equal(resumed.action, "resume");
  assert.equal(resumed.status, "watching");
  assert.equal(resumed.watch_id, first.watch_id);

  const removedStatic = await postJson(`${viewer.url}/api/source/update`, {
    id: "openclaw-subagent",
    remove: true,
  });
  assert.equal(removedStatic.sources.some((source) => source.id === "openclaw-subagent"), false);

  const stopped = await runCli(["watch-current", "--agent", "claude-code", "--viewer-url", viewer.url, "--stop", "--json"], env);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.request_count, 1);

  const viewAfterStop = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(first.id)}`);
  assert.equal(viewAfterStop.source.workbench.status, "已停止");
  assert.equal(viewAfterStop.stats.request_count, 1);

  const cleared = await runCli(["watch-current", "--agent", "claude-code", "--viewer-url", viewer.url, "--clear", "--json"], env);
  assert.equal(cleared.status, "cleared");

  const sources = await getJson(`${viewer.url}/api/sources`);
  assert.equal(sources.some((source) => source.id === first.id), false);

  console.log("watch-current smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
  if (originalTarget == null) delete process.env.PEEK_CLAUDE_TARGET_BASE_URL;
  else process.env.PEEK_CLAUDE_TARGET_BASE_URL = originalTarget;
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
    }, 5000);
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
      if (code !== 0) return reject(new Error(stderr || stdout || `CLI exited ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
