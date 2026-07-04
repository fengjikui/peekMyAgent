import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { defaultStoreDir, defaultStorePath, openPersistenceStore, sourceIdForWatch } from "../src/core/persistence-store.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-store-"));
const storePath = path.join(tmpDir, "store.sqlite");
const cwd = process.cwd();
const originalTarget = process.env.PEEK_CLAUDE_TARGET_BASE_URL;
const originalStateDir = process.env.PEEKMYAGENT_STATE_DIR;

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_mock", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

const upstreamUrl = await listen(upstream);
process.env.PEEK_CLAUDE_TARGET_BASE_URL = upstreamUrl;

let firstRequestId = null;
let secondRequestId = null;
let sourceId = null;
let watchId = null;

try {
  process.env.PEEKMYAGENT_STATE_DIR = tmpDir;
  assert.equal(defaultStoreDir(), tmpDir);
  assert.equal(defaultStorePath(), storePath);

  const firstViewer = await startViewerServer({ cwd, storePath });
  try {
    const watch = await postJson(`${firstViewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: cwd,
      conversation_id: "persisted-smoke-session",
      target_base_url: upstreamUrl,
    });
    sourceId = watch.id;
    watchId = watch.watch_id;
    const storeBeforeCapture = openPersistenceStore(storePath);
    try {
      const emptySource = storeBeforeCapture.listSources().find((source) => source.store_watch_id === watchId);
      assert.ok(emptySource, "watch should be persisted before the first request");
      assert.equal(emptySource.request_count, 0);
      assert.equal(emptySource.live_status, "watching");
    } finally {
      storeBeforeCapture.close();
    }

    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      system: [
        { type: "text", text: "volatile cc header: aaa" },
        { type: "text", text: "stable system block" },
      ],
      messages: [{ role: "user", content: "hello persisted store" }],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      system: [
        { type: "text", text: "volatile cc header: bbb" },
        { type: "text", text: "stable system block" },
      ],
      messages: [
        { role: "user", content: "hello persisted store" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "second request" },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    });

    const liveView = await getJson(`${firstViewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
    assert.equal(liveView.stats.request_count, 2);
    firstRequestId = liveView.requests[0].id;
    secondRequestId = liveView.requests[1].id;
  } finally {
    await firstViewer.close();
  }
  assertPrivateStoreFiles(storePath);

  const secondViewer = await startViewerServer({ cwd, storePath });
  try {
    const sources = await getJson(`${secondViewer.url}/api/sources`);
    const persisted = sources.find((source) => source.id === sourceIdForWatch(watchId));
    assert.ok(persisted, "persisted source should be listed after viewer restart");
    assert.equal(persisted.request_count, 2);

    const persistedView = await getJson(`${secondViewer.url}/api/view?source=${encodeURIComponent(persisted.id)}`);
    assert.equal(persistedView.stats.request_count, 2);
    assert.equal(persistedView.requests[0].summary.current_user, "hello persisted store");
    assert.equal(persistedView.requests[1].changes.system_changed, true);
    assert.equal(persistedView.requests[1].raw.body_source, "original");

    const renamed = await postJson(`${secondViewer.url}/api/source/update`, {
      id: persisted.id,
      title: "Persisted renamed session",
    });
    assert.equal(renamed.source.label, "Persisted renamed session", "rename updates persisted source immediately");

  } finally {
    await secondViewer.close();
  }

  const fastDetailStore = openPersistenceStore(storePath);
  let fullLoadCalled = false;
  fastDetailStore.loadCaptures = () => {
    fullLoadCalled = true;
    throw new Error("loadCaptures should not be used for single request detail");
  };
  const fastDetailViewer = await startViewerServer({ cwd, persistenceStore: fastDetailStore });
  try {
    const fastDetail = await getJson(`${fastDetailViewer.url}/api/request?source=${encodeURIComponent(sourceIdForWatch(watchId))}&request=${encodeURIComponent(secondRequestId)}`);
    assert.equal(fastDetail.request.summary.current_user, "second request", "request detail endpoint returns the target request");
    assert.equal(fastDetail.request.raw.body.messages.length, 3, "request detail endpoint hydrates full target raw body");
    assert.equal(fullLoadCalled, false, "request detail endpoint should avoid full source load for persisted captures");
  } finally {
    await fastDetailViewer.close();
    fastDetailStore.close();
  }

  const store = openPersistenceStore(storePath);
  try {
    store.clearRawBody(secondRequestId);
    const stats = store.blobStats();
    const systemStats = stats.find((item) => item.kind === "system_block");
    assert.equal(systemStats.count, 3);
    assert.ok(systemStats.refs >= 4);
    const reconstructed = store.reconstructBody(secondRequestId);
    assert.equal(reconstructed.system[0].text, "volatile cc header: bbb");
    assert.equal(reconstructed.system[1].text, "stable system block");
  } finally {
    store.close();
  }

  const thirdViewer = await startViewerServer({ cwd, storePath });
  try {
    const sourcesAfterRestart = await getJson(`${thirdViewer.url}/api/sources`);
    const renamedAfterRestart = sourcesAfterRestart.find((source) => source.id === sourceIdForWatch(watchId));
    assert.equal(renamedAfterRestart?.label, "Persisted renamed session", "rename survives viewer restart");
    assert.equal(renamedAfterRestart?.user_title, "Persisted renamed session", "persisted source keeps user_title after viewer restart");

    const reconstructedView = await getJson(`${thirdViewer.url}/api/view?source=${encodeURIComponent(sourceIdForWatch(watchId))}`);
    assert.equal(reconstructedView.source.label, "Persisted renamed session");
    assert.equal(reconstructedView.source.user_title, "Persisted renamed session");
    assert.equal(reconstructedView.requests[1].raw.body_source, "reconstructed");
    assert.equal(reconstructedView.requests[1].summary.current_user, "second request");

    const archived = await postJson(`${thirdViewer.url}/api/source/update`, {
      id: sourceIdForWatch(watchId),
      archive: true,
    });
    assert.equal(archived.archived || archived.source?.hidden, true, "archive hides the source");
    assert.equal(archived.sources.some((source) => source.id === sourceIdForWatch(watchId)), false, "archived source should leave the sidebar list");
    const storeAfterArchive = openPersistenceStore(storePath);
    try {
      assert.ok(storeAfterArchive.listSources().some((source) => source.store_watch_id === watchId), "archive keeps persisted data");
    } finally {
      storeAfterArchive.close();
    }

    const deleted = await postJson(`${thirdViewer.url}/api/source/update`, {
      id: sourceIdForWatch(watchId),
      delete: true,
    });
    assert.equal(deleted.deleted, true, "delete removes persisted source");
    assert.equal(deleted.sources.some((source) => source.id === sourceIdForWatch(watchId)), false);
  } finally {
    await thirdViewer.close();
  }

  const storeAfterDelete = openPersistenceStore(storePath);
  try {
    assert.equal(storeAfterDelete.listSources().some((source) => source.store_watch_id === watchId), false, "delete removes persisted data from the store");
  } finally {
    storeAfterDelete.close();
  }

  assert.ok(firstRequestId);
  console.log("persistence-store smoke passed");
} finally {
  await closeServer(upstream);
  if (originalTarget == null) delete process.env.PEEK_CLAUDE_TARGET_BASE_URL;
  else process.env.PEEK_CLAUDE_TARGET_BASE_URL = originalTarget;
  if (originalStateDir == null) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = originalStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postModelRequest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postJson(url, payload) {
  const headers = { "content-type": "application/json" };
  if (String(url).includes("/api/source/update")) headers["x-peekmyagent-intent"] = "source-update";
  const response = await fetch(url, {
    method: "POST",
    headers,
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

function assertPrivateStoreFiles(storePath) {
  if (process.platform === "win32") return;
  for (const filePath of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    if (!fs.existsSync(filePath)) continue;
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode & 0o077, 0, `${path.basename(filePath)} should not be group/world readable or writable; got ${mode.toString(8)}`);
  }
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
