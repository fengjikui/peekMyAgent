import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-response-transaction-"));
const store = openPersistenceStore(path.join(tmpDir, "store.sqlite"));
const captureId = "response-transaction-capture";
const watchId = "response-transaction-watch";
const requestReceivedAt = "2026-07-15T09:00:00.000Z";
const responseReceivedAt = "2026-07-15T09:00:05.000Z";

try {
  store.upsertCapture({
    watch: {
      watch_id: watchId,
      label: "Response transaction contract",
      agent: "Claude Code",
      workspace: tmpDir,
      created_at: requestReceivedAt,
    },
    capture: {
      capture_id: captureId,
      watch_id: watchId,
      request_index: 1,
      conversation_id: "response-transaction-conversation",
      agent_profile: "Claude Code",
      workspace: tmpDir,
      received_at: requestReceivedAt,
      method: "POST",
      path: "/v1/messages",
      body: {
        model: "contract-model",
        messages: [{ role: "user", content: "persist the response atomically" }],
      },
    },
  });

  const before = persistedState();
  store.db.exec(`
    CREATE TRIGGER fail_capture_response_update
    BEFORE UPDATE OF capture_json ON model_requests
    WHEN NEW.request_id = '${captureId}'
    BEGIN
      SELECT RAISE(ABORT, 'injected capture response failure');
    END
  `);

  assert.throws(
    () => store.updateCaptureResponse(responseCapture()),
    /injected capture response failure/,
    "the fixture must fail after response blob writes begin",
  );
  assert.deepEqual(
    persistedState(),
    before,
    "a failed response update must roll back blobs, links, Capture JSON, refcounts, and watch timestamps",
  );

  store.db.exec("DROP TRIGGER fail_capture_response_update");
  assert.deepEqual(store.updateCaptureResponse(responseCapture()), { updated: true, request_id: captureId });
  const loaded = store.loadCaptureWindow(watchId, captureId)[0];
  assert.equal(loaded.response.body_text, '{"answer":"committed"}');
  assert.equal(store.loadWatch(watchId).last_seen, responseReceivedAt);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM response_blobs WHERE request_id = ?").get(captureId).count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM content_blobs WHERE kind = 'response_body'").get().count, 1);
  assert.deepEqual(store.updateCaptureResponse({ capture_id: "missing-capture" }), { updated: false });

  console.log("capture response transaction smoke passed");
} finally {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function responseCapture() {
  return {
    capture_id: captureId,
    watch_id: watchId,
    upstream_status: 200,
    provenance: { artifact_fidelity: "raw", association: "exact" },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body_text: '{"answer":"committed"}',
      received_at: responseReceivedAt,
    },
  };
}

function persistedState() {
  const request = store.db.prepare("SELECT capture_json FROM model_requests WHERE request_id = ?").get(captureId);
  const watch = store.db.prepare("SELECT updated_at, last_seen FROM watches WHERE watch_id = ?").get(watchId);
  const responseLinks = store.db.prepare("SELECT request_id, blob_hash FROM response_blobs ORDER BY request_id").all();
  const contentBlobs = store.db
    .prepare("SELECT hash, kind, ref_count, payload_json FROM content_blobs ORDER BY hash")
    .all();
  return {
    capture_json: request.capture_json,
    watch,
    response_links: responseLinks,
    content_blobs: contentBlobs,
  };
}
