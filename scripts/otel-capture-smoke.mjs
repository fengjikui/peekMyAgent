import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OTEL_CAPTURE_METHOD,
  otelDirToCaptures,
  otelRequestFileToCapture,
  otelTelemetryEnv,
  scanOtelDir,
} from "../src/core/otel-capture.mjs";

// Deterministic smoke for the OTel raw-body capture core module. No real Claude
// Code; we synthesize a dump directory shaped like OTEL_LOG_RAW_API_BODIES output.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-capture-smoke-"));

function writeDump(name, mtimeSeconds, payload) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, JSON.stringify(payload));
  fs.utimesSync(full, mtimeSeconds, mtimeSeconds);
  return full;
}

const sessionId = "5f8f789b-9933-4ffd-a1b3-5ecc11d60684";
const metadata = { user_id: JSON.stringify({ device_id: "dev", account_uuid: "acc", session_id: sessionId }) };

// Request #1 (haiku, no tools), then request #2 (opus, tools) written later.
writeDump("aaaa-1111.request.json", 1000, {
  model: "claude-haiku-4-5-20251001",
  stream: true,
  max_tokens: 32000,
  system: [{ type: "text", text: "sys block" }],
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  metadata,
});
writeDump("req_AAA.response.json", 1001, {
  id: "req_AAA",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 506, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
writeDump("bbbb-2222.request.json", 2000, {
  model: "claude-opus-4-8",
  stream: true,
  max_tokens: 64000,
  system: [{ type: "text", text: "sys" }, { type: "text", text: "more" }],
  messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
  tools: [{ name: "Bash" }, { name: "Read" }],
  metadata,
});
writeDump("req_BBB.response.json", 2001, {
  id: "req_BBB",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3646, output_tokens: 4, cache_read_input_tokens: 14376, cache_creation_input_tokens: 2953 },
});
// A stray non-dump file must be ignored.
fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");

// --- otelTelemetryEnv ---
const env = otelTelemetryEnv(dir);
assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
assert.equal(env.OTEL_LOGS_EXPORTER, "console");
assert.equal(env.OTEL_LOG_RAW_API_BODIES, `file:${dir}`);
assert.equal(env.OTEL_LOGS_EXPORT_INTERVAL, "1000");
assert.throws(() => otelTelemetryEnv(""), /requires a directory/);

// --- scanOtelDir ---
const scan = scanOtelDir(dir);
assert.equal(scan.requests.length, 2, "should find 2 request files");
assert.equal(scan.responses.length, 2, "should find 2 response files");
assert.deepEqual(scan.requests.map((r) => r.id), ["aaaa-1111", "bbbb-2222"], "requests sorted by mtime");
assert.deepEqual(scan.responses.map((r) => r.id), ["req_AAA", "req_BBB"], "responses sorted by mtime");
assert.equal(scanOtelDir(path.join(dir, "does-not-exist")).requests.length, 0, "missing dir yields empty");

// --- otelDirToCaptures ---
const captures = otelDirToCaptures(dir, { watchId: "watch-1", workspace: "/tmp/ws", agent: "Claude Code" });
assert.equal(captures.length, 2, "two captures");

const [c1, c2] = captures;
// capture_id derived from request file name (stable -> dedupe on re-ingest)
assert.equal(c1.capture_id, "aaaa-1111");
assert.equal(c2.capture_id, "bbbb-2222");
// request_index is positional, 1-based
assert.equal(c1.request_index, 1);
assert.equal(c2.request_index, 2);
// body is the raw request JSON, untouched -> store will tree/chunk it as usual
assert.equal(c1.body.model, "claude-haiku-4-5-20251001");
assert.equal(c2.body.model, "claude-opus-4-8");
assert.equal(c2.body.tools.length, 2);
assert.equal(c2.body.messages.length, 2);
// watch wiring + capture method
assert.equal(c1.watch_id, "watch-1");
assert.equal(c1.workspace, "/tmp/ws");
assert.equal(c1.capture_method, OTEL_CAPTURE_METHOD);
assert.equal(c1.method, "POST");
assert.equal(c1.path, "/v1/messages");
// conversation_id extracted from metadata.user_id session_id
assert.equal(c1.conversation_id, sessionId, "conversation_id from metadata session_id");
// response paired positionally, real usage preserved in body_text
assert.ok(c1.response, "capture #1 has paired response");
assert.equal(c1.upstream_status, 200);
// Non-stream display path reads body_json; OTel must provide it alongside body_text.
assert.deepEqual(c1.response.body_json, JSON.parse(c1.response.body_text), "response carries body_json for rendering");
assert.equal(c1.response.body_json.usage.input_tokens, 506);
const resp2 = JSON.parse(c2.response.body_text);
assert.equal(resp2.usage.cache_read_input_tokens, 14376, "real cache token usage preserved");
// source provenance
assert.equal(c1.source.type, "otel_raw_body_file");
assert.equal(c1.source.request_file, "aaaa-1111.request.json");
assert.equal(c1.source.response_file, "req_AAA.response.json");
assert.ok(/^[0-9a-f]{64}$/.test(c1.source.request_sha256), "sha256 of raw request body");

// --- request without a response still ingests ---
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "otel-capture-smoke2-"));
fs.writeFileSync(path.join(dir2, "solo.request.json"), JSON.stringify({ model: "m", messages: [], system: [] }));
const solo = otelDirToCaptures(dir2, { watchId: "w2" });
assert.equal(solo.length, 1);
assert.equal(solo[0].response, undefined, "no response when none dumped");
assert.equal(solo[0].conversation_id, null, "no conversation_id without metadata");

// --- explicit ctx.conversationId overrides body-derived ---
const cap = otelRequestFileToCapture(
  scanOtelDir(dir).requests[0],
  { watchId: "w", conversationId: "explicit-conv" },
  null,
);
assert.equal(cap.conversation_id, "explicit-conv");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });

console.log("otel-capture smoke: OK (2 captures, response pairing, conversation_id, dedupe id)");
