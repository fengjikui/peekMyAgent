import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-project-source-actions-"));
const storePath = path.join(tmpDir, "store.sqlite");
const cwd = process.cwd();

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_project_source_smoke", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd, storePath });

try {
  const archiveWorkspace = path.join(tmpDir, "archive-project");
  const deleteWorkspace = path.join(tmpDir, "delete-project");
  const otherWorkspace = path.join(tmpDir, "other-project");
  fs.mkdirSync(archiveWorkspace, { recursive: true });
  fs.mkdirSync(deleteWorkspace, { recursive: true });
  fs.mkdirSync(otherWorkspace, { recursive: true });

  const archivedA = await startWatch(archiveWorkspace, "project-archive-a");
  const archivedB = await startWatch(archiveWorkspace, "project-archive-b");
  const other = await startWatch(otherWorkspace, "project-other");
  let sources = await getJson(`${viewer.url}/api/sources`);
  assert.equal(sources.filter((source) => source.workspace === archiveWorkspace).length, 2, "same workspace sources are grouped before archive");

  const archiveResult = await postJson(`${viewer.url}/api/source/update`, {
    project: { agent: "Claude Code", workspace: archiveWorkspace, project: path.basename(archiveWorkspace) },
    archive: true,
  });
  assert.equal(archiveResult.archived, 2, "project archive affects every source in the project");
  assert.deepEqual(new Set(archiveResult.affected_ids), new Set([archivedA.id, archivedB.id]));
  assert.equal(archiveResult.sources.some((source) => source.workspace === archiveWorkspace), false, "archived project leaves the sidebar list");
  assert.equal(archiveResult.sources.some((source) => source.id === other.id), true, "archive leaves other projects visible");

  let store = openPersistenceStore(storePath);
  try {
    const persistedIds = new Set(store.listSources().map((source) => source.store_watch_id));
    assert.equal(persistedIds.has(archivedA.watch_id), true, "project archive keeps first persisted watch data");
    assert.equal(persistedIds.has(archivedB.watch_id), true, "project archive keeps second persisted watch data");
  } finally {
    store.close();
  }

  const deletedA = await startWatch(deleteWorkspace, "project-delete-a");
  const deletedB = await startWatch(deleteWorkspace, "project-delete-b");
  const deleteResult = await postJson(`${viewer.url}/api/source/update`, {
    project: { agent: "Claude Code", workspace: deleteWorkspace, project: path.basename(deleteWorkspace) },
    delete: true,
  });
  assert.equal(deleteResult.deleted, 2, "project delete affects every source in the project");
  assert.deepEqual(new Set(deleteResult.affected_ids), new Set([deletedA.id, deletedB.id]));
  assert.equal(deleteResult.sources.some((source) => source.workspace === deleteWorkspace), false, "deleted project leaves the sidebar list");

  store = openPersistenceStore(storePath);
  try {
    const persistedIds = new Set(store.listSources().map((source) => source.store_watch_id));
    assert.equal(persistedIds.has(deletedA.watch_id), false, "project delete removes first persisted watch data");
    assert.equal(persistedIds.has(deletedB.watch_id), false, "project delete removes second persisted watch data");
  } finally {
    store.close();
  }

  console.log("project-source-actions smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function startWatch(workspace, conversationId) {
  return postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace,
    conversation_id: conversationId,
    target_base_url: upstreamUrl,
    reuse: false,
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
    headers: jsonHeadersForUrl(url),
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
