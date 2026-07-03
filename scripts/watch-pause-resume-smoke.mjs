import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-watch-pause-resume-"));
const storePath = path.join(tmpDir, "store.sqlite");
let upstreamRequestCount = 0;
const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  upstreamRequestCount += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_${upstreamRequestCount}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `ok ${upstreamRequestCount}` }],
      model: "mock-claude",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd: process.cwd(), capturePort: 0, storePath });

try {
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: process.cwd(),
    conversation_id: "pause-resume-smoke",
    target_base_url: upstreamUrl,
  });
  assert.equal(watch.status, "watching");

  await sendModelRequest(watch.base_url, "first captured");
  let view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}`);
  assert.equal(upstreamRequestCount, 1);
  assert.equal(view.stats.request_count, 1);

  const paused = await postJson(`${viewer.url}/api/watch/pause`, {
    id: watch.id,
    status: "paused",
  });
  assert.equal(paused.status, "paused");

  await sendModelRequest(watch.base_url, "forwarded but not captured");
  view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}`);
  assert.equal(upstreamRequestCount, 2);
  assert.equal(view.stats.request_count, 1);

  const statusWhilePaused = await getJson(`${viewer.url}/api/watch/status`);
  const pausedWatch = statusWhilePaused.find((item) => item.watch_id === watch.watch_id);
  assert.equal(pausedWatch.status, "paused");
  assert.equal(pausedWatch.skipped_while_paused, 1);

  const resumed = await postJson(`${viewer.url}/api/watch/pause`, {
    id: watch.id,
    status: "watching",
  });
  assert.equal(resumed.status, "watching");
  assert.equal(resumed.skipped_while_paused, 1);

  await sendModelRequest(watch.base_url, "captured after resume");
  view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}`);
  assert.equal(upstreamRequestCount, 3);
  assert.equal(view.stats.request_count, 2);
  assert.equal(view.requests.map((request) => request.summary.current_user).join(" | "), "first captured | captured after resume");

  console.log("watch pause/resume smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function sendModelRequest(baseUrl, text) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify({
      model: "mock-claude",
      system: "You are a smoke test.",
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
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
