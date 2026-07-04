import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
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

  const noisyTitle = `  Renamed\nsource\u0000with\u007fcontrols ${"x".repeat(120)}  `;
  await postJson(`${viewer.url}/api/source/update`, {
    id: "openclaw-subagent",
    title: noisyTitle,
  });
  await viewer.close();
  viewer = await startViewerServer({ cwd, demo: "openclaw-subagent", storePath });
  sources = await getJson(`${viewer.url}/api/sources`);
  const sanitizedDemo = sources.find((source) => source.id === "openclaw-subagent");
  assert.equal(/[\x00-\x1F\x7F]/.test(sanitizedDemo?.user_title || ""), false, "source rename strips control characters before persistence");
  assert.equal((sanitizedDemo?.user_title || "").includes("\n"), false, "source rename is normalized to one line");
  assert.equal((sanitizedDemo?.user_title || "").length <= 80, true, "source rename is bounded before persistence");

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

  const lateConversationLive = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: cwd,
    target_base_url: upstreamUrl,
    reuse: false,
  });
  await postJson(`${viewer.url}/api/source/update`, {
    id: lateConversationLive.id,
    title: "Renamed before first request",
  });
  await sendModelRequest(lateConversationLive.base_url, "first request after rename", {
    "x-claude-code-session-id": "source-meta-late-session",
  });
  sources = await getJson(`${viewer.url}/api/sources`);
  const lateConversationSource = sources.find((source) => source.live_watch_id === lateConversationLive.watch_id);
  assert.equal(lateConversationSource?.conversation_id, "source-meta-late-session", "conversation id learned from first request");
  assert.equal(lateConversationSource?.label, "Renamed before first request", "rename survives after conversation id is learned");

  const freshLateConversationLive = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: cwd,
    conversation_id: "source-meta-late-session",
    target_base_url: upstreamUrl,
    reuse: false,
  });
  sources = await getJson(`${viewer.url}/api/sources`);
  const inheritedLateConversationLive = sources.find((source) => source.live_watch_id === freshLateConversationLive.watch_id);
  assert.equal(inheritedLateConversationLive?.label, "Renamed before first request", "rename before first request follows the later conversation");

  const directStore = openPersistenceStore(storePath);
  try {
    directStore.upsertWatch({
      watch_id: "source-meta-stale-auto-title",
      label: "Claude Code · OTel",
      agent: "Claude Code",
      mode: "single_session",
      confidence: "exact",
      kind: "otel_raw_body",
      workspace: cwd,
      conversation_id: "source-meta-late-session",
      status: "stopped",
      title: "Old automatic title",
    });
  } finally {
    directStore.close();
  }
  sources = await getJson(`${viewer.url}/api/sources`);
  const staleSameConversationSource = sources.find((source) => source.store_watch_id === "source-meta-stale-auto-title");
  assert.equal(staleSameConversationSource?.label, "Renamed before first request", "manual conversation title overrides later stale automatic titles");

  const otelDir = path.join(tmpDir, "otel");
  fs.mkdirSync(otelDir, { recursive: true });
  fs.writeFileSync(
    path.join(otelDir, "source-meta-otel.request.json"),
    JSON.stringify({
      model: "claude-test",
      messages: [{ role: "user", content: "same conversation via otel" }],
      metadata: { user_id: JSON.stringify({ session_id: "source-meta-smoke-session" }) },
    }),
  );
  const otel = await postJson(`${viewer.url}/api/capture/otel`, {
    dir: otelDir,
    watch_id: "claude-code-source-meta-otel",
    agent: "Claude Code",
    workspace: cwd,
    conversation_id: "source-meta-smoke-session",
  }, { headers: { "x-peekmyagent-intent": "otel-ingest" } });
  sources = await getJson(`${viewer.url}/api/sources`);
  const sameConversationOtel = sources.find((source) => source.id === otel.source_id);
  assert.equal(sameConversationOtel?.label, "Renamed live source", "rename follows the same conversation into OTel capture mode");
  assert.equal(sameConversationOtel?.user_title, "Renamed live source", "OTel source inherits conversation user_title");

  await viewer.close();

  viewer = await startViewerServer({ cwd, storePath });
  sources = await getJson(`${viewer.url}/api/sources`);
  const persistedLive = sources.find((source) => source.store_watch_id === live.watch_id);
  assert.equal(persistedLive?.label, "Renamed live source", "live source rename survives as stored source after viewer restart");
  assert.equal(persistedLive?.user_title, "Renamed live source", "stored source keeps user_title after viewer restart");
  assert.equal(persistedLive?.pinned, true, "live source pin survives as stored source after viewer restart");
  const persistedOtel = sources.find((source) => source.store_watch_id === "claude-code-source-meta-otel");
  assert.equal(persistedOtel?.label, "Renamed live source", "OTel source keeps conversation title after viewer restart");
  assert.equal(persistedOtel?.user_title, "Renamed live source", "OTel source keeps conversation user_title after viewer restart");
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

async function postJson(url, payload, { headers = {} } = {}) {
  const defaultHeaders = { "content-type": "application/json" };
  if (String(url).includes("/api/source/update")) defaultHeaders["x-peekmyagent-intent"] = "source-update";
  const response = await fetch(url, {
    method: "POST",
    headers: { ...defaultHeaders, ...headers },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function sendModelRequest(baseUrl, text, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke", ...headers },
    body: JSON.stringify({
      model: "mock-claude",
      system: "You are a smoke test.",
      messages: [{ role: "user", content: text }],
    }),
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
