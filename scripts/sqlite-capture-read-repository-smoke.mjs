import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
import { SqliteCaptureReadRepository } from "../src/persistence/repositories/sqlite-capture-read-repository.mjs";

const STORE_RAW_BODY_ENV = "PEEKMYAGENT_STORE_RAW_BODY_JSON";
const originalStoreRawBody = process.env[STORE_RAW_BODY_ENV];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-capture-read-repository-"));
const store = openPersistenceStore(path.join(tmpDir, "store.sqlite"));
const watchId = "capture-read-contract";
const receivedAt = "2026-07-15T08:00:00.000Z";

try {
  process.env[STORE_RAW_BODY_ENV] = "1";
  insertCapture({
    captureId: "first",
    requestIndex: 1,
    body: requestBody("first raw request"),
  });

  delete process.env[STORE_RAW_BODY_ENV];
  insertCapture({
    captureId: "index-two",
    requestIndex: 2,
    body: requestBody("request selected only by index"),
  });
  insertCapture({
    captureId: "2",
    requestIndex: 3,
    body: requestBody("numeric capture id wins"),
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body_text: '{"answer":"hydrated"}',
      received_at: "2026-07-15T08:00:03.000Z",
    },
  });
  insertCapture({
    captureId: "corrupt-outside-page",
    requestIndex: 4,
    body: requestBody("unique body that will lose one blob"),
  });

  const repository = new SqliteCaptureReadRepository(store.db);
  assert.ok(store.captureReadRepository instanceof SqliteCaptureReadRepository);
  assert.equal(store.schemaVersion(), 1, "read repository extraction must not change the persisted schema");
  assert.equal(typeof repository.close, "undefined", "read repository does not own the database lifecycle");
  assert.equal(typeof repository.upsertCapture, "undefined", "read repository exposes no write path");

  const repositoryCaptures = repository.loadCaptures(watchId);
  assert.deepEqual(store.loadCaptures(watchId), repositoryCaptures, "PersistenceStore remains a behavior-compatible facade");
  assert.deepEqual(
    repositoryCaptures.map((capture) => capture.capture_id),
    ["first", "index-two", "2", "corrupt-outside-page"],
    "captures remain ordered by request index",
  );
  assert.equal(repositoryCaptures[0].body_source, "original");
  assert.equal(repositoryCaptures[0].body.messages[0].content, "first raw request");
  assert.equal(repositoryCaptures[2].body_source, "reconstructed");
  assert.equal(repositoryCaptures[2].response.body_text, '{"answer":"hydrated"}', "response blobs are hydrated on read");

  store.db.prepare("UPDATE model_requests SET raw_body_length = 0 WHERE request_id = ?").run("index-two");
  assert.ok(repository.loadCaptureWindow(watchId, "index-two")[0].raw_body_length > 0, "missing raw length is derived from the body");
  assert.equal(repository.findCaptureRow(watchId, "2").request_index, 3, "exact numeric request id wins over an index collision");
  assert.deepEqual(
    repository.loadCaptureWindow(watchId, "2", { previousCount: 2 }).map((capture) => capture.capture_id),
    ["first", "index-two", "2"],
    "window reads preserve previous-to-target order",
  );
  assert.deepEqual(repository.loadCaptureWindow(watchId, "missing"), []);
  assert.deepEqual(
    repository.loadCapturePage(watchId, { offset: -20, limit: 1 }).map((capture) => capture.capture_id),
    ["first"],
    "negative page offsets clamp to zero",
  );
  assert.deepEqual(
    repository.loadInitialCaptures(watchId, { limit: 2 }).map((capture) => capture.capture_id),
    ["first", "index-two"],
  );

  const uniqueBlob = store.db
    .prepare(
      `
        SELECT node.blob_hash
        FROM request_tree_nodes node
        WHERE node.request_id = ?
          AND node.blob_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM request_tree_nodes other
            WHERE other.blob_hash = node.blob_hash
              AND other.request_id <> node.request_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM response_blobs response
            WHERE response.blob_hash = node.blob_hash
          )
        LIMIT 1
      `,
    )
    .get("corrupt-outside-page");
  assert.ok(uniqueBlob?.blob_hash, "fixture should have a request-local content blob");
  store.db.prepare("DELETE FROM content_blobs WHERE hash = ?").run(uniqueBlob.blob_hash);

  assert.deepEqual(
    repository.loadCapturePage(watchId, { offset: 0, limit: 3 }).map((capture) => capture.capture_id),
    ["first", "index-two", "2"],
    "page hydration must not touch captures outside the selected page",
  );
  assert.throws(
    () => repository.loadCapturePage(watchId, { offset: 3, limit: 1 }),
    /Missing content blob/,
    "the corrupt capture still fails when it is explicitly requested",
  );

  console.log("sqlite capture read repository smoke passed");
} finally {
  store.close();
  if (originalStoreRawBody == null) delete process.env[STORE_RAW_BODY_ENV];
  else process.env[STORE_RAW_BODY_ENV] = originalStoreRawBody;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function insertCapture({ captureId, requestIndex, body, response = null }) {
  store.upsertCapture({
    watch: {
      watch_id: watchId,
      label: "Capture read repository contract",
      agent: "Claude Code",
      mode: "single_session",
      kind: "proxy_capture",
      workspace: tmpDir,
      created_at: receivedAt,
    },
    capture: {
      capture_id: captureId,
      watch_id: watchId,
      request_index: requestIndex,
      conversation_id: "capture-read-conversation",
      agent_profile: "Claude Code",
      workspace: tmpDir,
      received_at: `2026-07-15T08:00:0${requestIndex}.000Z`,
      method: "POST",
      path: "/v1/messages",
      body,
      response,
    },
  });
}

function requestBody(message) {
  return {
    model: "contract-model",
    system: [{ type: "text", text: "stable system block" }],
    messages: [{ role: "user", content: message }],
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
  };
}
