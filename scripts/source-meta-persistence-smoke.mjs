import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-source-meta-"));
const storePath = path.join(tmpDir, "store.sqlite");

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_meta_smoke", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
});

const upstreamUrl = await listen(upstream);

try {
  let viewer = await startViewerServer({ cwd, demo: "openclaw-subagent", storePath });
  await postJson(`${viewer.url}/api/source/update`, {
    id: "openclaw-subagent",
    title: "Renamed demo source",
    pinned: true,
  });
  await viewer.close();

  viewer = await startViewerServer({ cwd, demo: "openclaw-subagent", storePath });
  let sources = await getJson(`${viewer.url}/api/sources`);
  const renamedDemo = sources.find((source) => source.id === "openclaw-subagent");
  assert.equal(renamedDemo?.label, "Renamed demo source", "static source rename survives viewer restart");
  assert.equal(renamedDemo?.user_title, "Renamed demo source", "static source keeps user_title after viewer restart");
  assert.equal(renamedDemo?.pinned, true, "static source pin survives viewer restart");

  const live = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: cwd,
    conversation_id: "source-meta-smoke-session",
    target_base_url: upstreamUrl,
  });
  await postJson(`${viewer.url}/api/source/update`, {
    id: live.id,
    title: "Renamed live source",
    pinned: true,
  });

  const freshLiveSameConversation = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: cwd,
    conversation_id: "source-meta-smoke-session",
    target_base_url: upstreamUrl,
    reuse: false,
  });
  sources = await getJson(`${viewer.url}/api/sources`);
  const sameConversationLive = sources.find((source) => source.live_watch_id === freshLiveSameConversation.watch_id);
  assert.equal(sameConversationLive?.label, "Renamed live source", "rename follows the same conversation across a new live watch id");
  assert.equal(sameConversationLive?.user_title, "Renamed live source", "live source keeps user_title across a new live watch id");

  await viewer.close();

  viewer = await startViewerServer({ cwd, storePath });
  sources = await getJson(`${viewer.url}/api/sources`);
  const persistedLive = sources.find((source) => source.store_watch_id === live.watch_id);
  assert.equal(persistedLive?.label, "Renamed live source", "live source rename survives as stored source after viewer restart");
  assert.equal(persistedLive?.user_title, "Renamed live source", "stored source keeps user_title after viewer restart");
  assert.equal(persistedLive?.pinned, true, "live source pin survives as stored source after viewer restart");
  await viewer.close();

  console.log("source-meta persistence smoke passed");
} finally {
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
