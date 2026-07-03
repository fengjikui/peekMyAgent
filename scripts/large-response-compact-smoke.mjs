import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-large-response-compact-"));
const evidenceDir = path.join(tmpDir, "evidence");
const storePath = path.join(tmpDir, "store.sqlite");

try {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const largeStream = Array.from({ length: 2500 }, () => `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  fs.writeFileSync(
    path.join(evidenceDir, "proxy-captures.json"),
    JSON.stringify([
      {
        capture_id: "large-stream-response",
        request_index: 1,
        watch_id: "large-response",
        received_at: "2026-07-04T00:00:00.000Z",
        method: "POST",
        path: "/v1/messages",
        headers: {},
        body: {
          model: "mock-stream",
          messages: [{ role: "user", content: "large stream" }],
        },
        response: {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          body_text: largeStream,
          body_json: null,
          raw_body_length: Buffer.byteLength(largeStream),
          captured_body_length: Buffer.byteLength(largeStream),
          received_at: "2026-07-04T00:00:01.000Z",
        },
      },
    ]),
  );

  const viewer = await startViewerServer({ cwd: process.cwd(), storePath, evidencePath: evidenceDir });
  try {
    const response = await fetch(`${viewer.url}/api/view?source=custom`);
    const text = await response.text();
    assert.equal(response.ok, true, text);
    assert.ok(text.length < largeStream.length / 2, "viewer payload should not include the full stream body");
    assert.equal(text.includes("data:"), false, "viewer payload should not contain SSE raw lines");
    const view = JSON.parse(text);
    assert.equal(view.requests[0].summary.response.stream, true);
    assert.equal(view.requests[0].summary.response.text.length, 2500);
    assert.equal(view.requests[0].raw.response.body_text, undefined);
    assert.equal(view.requests[0].raw.response.body_text_omitted.reason, "stream");
    assert.equal(view.requests[0].raw.response.body_text_omitted.byte_size, Buffer.byteLength(largeStream));
  } finally {
    await viewer.close();
  }

  console.log("large-response-compact smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
