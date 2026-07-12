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
import { validateCaptureProvenance } from "../src/core/provenance.mjs";

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
const correlatedEnv = otelTelemetryEnv(dir, {
  logsEndpoint: "http://127.0.0.1:43110/api/capture/otel/events",
  tracesEndpoint: "http://127.0.0.1:43110/api/capture/otel/traces",
  headers: "x-peekmyagent-intent=otel-event-ingest,x-peekmyagent-watch-id=w",
});
assert.equal(correlatedEnv.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, "1");
assert.equal(correlatedEnv.OTEL_LOGS_EXPORTER, "otlp");
assert.equal(correlatedEnv.OTEL_TRACES_EXPORTER, "otlp");
assert.equal(correlatedEnv.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
assert.equal(correlatedEnv.OTEL_EXPORTER_OTLP_HEADERS, "x-peekmyagent-intent=otel-event-ingest,x-peekmyagent-watch-id=w");

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
assert.equal(c1.provenance.request.fidelity, "exact");
assert.equal(c1.provenance.response.fidelity, "exact");
assert.equal(c1.provenance.association.method, "file_write_order");
assert.equal(c1.provenance.association.confidence, "heuristic");
assert.equal(validateCaptureProvenance(c1.provenance).ok, true);

// --- request without a response still ingests ---
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "otel-capture-smoke2-"));
fs.writeFileSync(path.join(dir2, "solo.request.json"), JSON.stringify({ model: "m", messages: [], system: [] }));
const solo = otelDirToCaptures(dir2, { watchId: "w2" });
assert.equal(solo.length, 1);
assert.equal(solo[0].response, undefined, "no response when none dumped");
assert.equal(solo[0].conversation_id, null, "no conversation_id without metadata");
assert.equal(solo[0].provenance.response.fidelity, "missing");
assert.equal(solo[0].provenance.association.confidence, "none");

// --- trace/span correlation survives responses completing out of request order ---
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "otel-capture-correlation-"));
function writeCorrelated(name, mtimeSeconds, payload) {
  const full = path.join(dir3, name);
  fs.writeFileSync(full, JSON.stringify(payload));
  fs.utimesSync(full, mtimeSeconds, mtimeSeconds);
}
writeCorrelated("request-a.request.json", 3000, { model: "same", messages: [{ role: "user", content: "A" }] });
writeCorrelated("request-b.request.json", 3001, { model: "same", messages: [{ role: "user", content: "B" }] });
writeCorrelated("response-b.response.json", 3002, { id: "response-b", content: [{ type: "text", text: "B result" }] });
writeCorrelated("response-a.response.json", 3003, { id: "response-a", content: [{ type: "text", text: "A result" }] });
const correlatedEvents = [
  bodyEvent("api_request_body", "request-a.request.json", "trace-a", "span-a", 1),
  bodyEvent("api_request_body", "request-b.request.json", "trace-b", "span-b", 2),
  bodyEvent("api_response_body", "response-b.response.json", "trace-b", "span-b", 3),
  bodyEvent("api_response_body", "response-a.response.json", "trace-a", "span-a", 4),
];
const correlated = otelDirToCaptures(dir3, { watchId: "w3" }, { events: correlatedEvents, allowHeuristicPairing: false });
assert.equal(correlated[0].response.body_json.id, "response-a", "request A follows trace/span rather than response write order");
assert.equal(correlated[1].response.body_json.id, "response-b", "request B follows trace/span rather than response write order");
assert.equal(correlated[0].provenance.association.method, "otel_trace_span");
assert.equal(correlated[0].provenance.association.confidence, "exact");

// Multiple attempts share one LLM span. The final request-body event is the
// successful attempt, so only that request receives the response.
const retryEvents = [
  bodyEvent("api_request_body", "request-a.request.json", "trace-r", "span-r", 10),
  bodyEvent("api_request_body", "request-b.request.json", "trace-r", "span-r", 11),
  bodyEvent("api_response_body", "response-b.response.json", "trace-r", "span-r", 12),
];
const retried = otelDirToCaptures(dir3, { watchId: "w4" }, { events: retryEvents, allowHeuristicPairing: false });
assert.equal(retried[0].response, undefined, "failed retry attempt remains response-less");
assert.equal(retried[1].response.body_json.id, "response-b", "final attempt owns the successful response");
assert.equal(retried[1].provenance.association.method, "otel_trace_span_last_attempt");
assert.equal(retried[1].provenance.association.confidence, "high");
const unorderedRetryEvents = retryEvents.map((event) => ({ ...event, event_sequence: null }));
const unorderedRetry = otelDirToCaptures(dir3, { watchId: "w5" }, { events: unorderedRetryEvents, allowHeuristicPairing: false });
const unorderedPaired = unorderedRetry.find((capture) => capture.response);
assert.equal(unorderedPaired.provenance.association.method, "otel_trace_span_ambiguous_attempt");
assert.equal(unorderedPaired.provenance.association.confidence, "heuristic");

// --- explicit ctx.conversationId overrides body-derived ---
const cap = otelRequestFileToCapture(
  scanOtelDir(dir).requests[0],
  { watchId: "w", conversationId: "explicit-conv" },
  null,
);
assert.equal(cap.conversation_id, "explicit-conv");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(dir3, { recursive: true, force: true });

console.log("otel-capture smoke: OK (2 captures, response pairing, conversation_id, dedupe id)");

function bodyEvent(eventName, bodyRef, traceId, spanId, eventSequence) {
  return {
    event_name: eventName,
    body_ref: bodyRef,
    trace_id: traceId,
    span_id: spanId,
    event_sequence: eventSequence,
    prompt_id: "prompt-1",
    query_source: "sdk",
  };
}
