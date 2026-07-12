import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

// Smoke for the daemon OTel ingest endpoint + viewer surfacing. Drives
// POST /api/capture/otel with a synthetic dump dir, then asserts /api/view and
// /api/sources reflect the persisted captures. No real Claude Code, no wrapper.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "otel-ingest-smoke-"));
const dumpDir = path.join(tmp, "dump");
fs.mkdirSync(dumpDir, { recursive: true });
const storePath = path.join(tmp, "store.sqlite");

function dump(name, t, payload, root = dumpDir) {
  const f = path.join(root, name);
  fs.writeFileSync(f, JSON.stringify(payload));
  fs.utimesSync(f, t, t);
}

const sessionId = "sess-otel-ingest";
const meta = { user_id: JSON.stringify({ session_id: sessionId }) };
dump("c1.request.json", 1000, {
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "S1" }, { type: "text", text: "S2" }],
  messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "Bash" }, { name: "Read" }],
  metadata: meta,
});
dump("req_1.response.json", 1001, {
  id: "req_1",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3646, output_tokens: 4, cache_read_input_tokens: 14376, cache_creation_input_tokens: 2953 },
});
dump("c2.request.json", 2000, {
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "S1" }, { type: "text", text: "S2" }],
  messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "more" }],
  tools: [{ name: "Bash" }, { name: "Read" }],
  metadata: meta,
});

process.env.PEEKMYAGENT_STATE_DIR = tmp;
const viewer = await startViewerServer({ cwd: process.cwd(), storePath });
let failed = false;
try {
  const watchId = "claude-code-oteltest1";

  const noIntentRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: dumpDir, watch_id: watchId, agent: "Claude Code", workspace: "/tmp/ws" }),
  });
  assert.equal(noIntentRes.status, 403, "OTel ingest requires explicit local wrapper intent");

  const noEventIntentRes = await fetch(`${viewer.url}/api/capture/otel/events?watch_id=${watchId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otelPayload([])),
  });
  assert.equal(noEventIntentRes.status, 403, "OTel events require explicit telemetry intent");

  const eventRes = await fetch(`${viewer.url}/api/capture/otel/events?watch_id=${watchId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-event-ingest" },
    body: JSON.stringify(
      otelPayload([
        logRecord("api_request_body", "c1.request.json", "trace-1", "span-1", 1),
        logRecord("api_response_body", "req_1.response.json", "trace-1", "span-1", 2),
        logRecord("api_request_body", "c2.request.json", "trace-2", "span-2", 3),
      ]),
    ),
  });
  assert.equal(eventRes.status, 200);
  const eventResult = await eventRes.json();
  assert.equal(eventResult.accepted, 3);

  // --- ingest ---
  const ingestRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-ingest" },
    body: JSON.stringify({ dir: dumpDir, watch_id: watchId, agent: "Claude Code", workspace: "/tmp/ws", event_correlation_enabled: true }),
  });
  const ingest = await ingestRes.json();
  assert.equal(ingest.ok, true);
  assert.equal(ingest.total, 2, "two captures total");
  assert.equal(ingest.ingested, 2, "two newly inserted");
  assert.equal(ingest.responses, 1, "one response paired");
  assert.ok(ingest.source_id, "returns a source id");

  // --- /api/view surfaces them ---
  const viewRes = await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(ingest.source_id)}`);
  const view = await viewRes.json();
  assert.equal(view.requests.length, 2, "view has 2 requests");
  assert.equal(view.requests[0].model, "claude-opus-4-8");
  assert.equal(view.requests[0].request_index, 1);
  assert.equal(view.requests[0].conversation_id, sessionId, "conversation_id from metadata reaches the view");
  assert.equal(view.requests[0].upstream_status, 200, "paired response gives upstream_status 200");
  assert.equal(view.requests[0].raw.provenance.association.method, "otel_trace_span");
  assert.equal(view.requests[0].raw.provenance.association.confidence, "exact");
  assert.equal(view.requests[1].request_index, 2);

  // --- /api/sources lists it ---
  const sourcesRes = await fetch(`${viewer.url}/api/sources`);
  const sources = await sourcesRes.json();
  const src = (Array.isArray(sources) ? sources : sources.sources || []).find((s) => s.id === ingest.source_id);
  assert.ok(src, "source appears in /api/sources");
  assert.equal(src.agent, "Claude Code");
  assert.equal(src.request_count, 2);
  assert.equal(src.response_count, 1);

  // --- incremental re-ingest is a dedup no-op for requests ---
  const reRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-ingest" },
    body: JSON.stringify({ dir: dumpDir, watch_id: watchId, agent: "Claude Code", workspace: "/tmp/ws" }),
  });
  const re = await reRes.json();
  assert.equal(re.ingested, 0, "re-ingest inserts nothing new");
  assert.equal(re.total, 2, "still sees both captures");

  // --- a later OTel wrapper can append to the same watch ---
  const continuedDumpDir = path.join(tmp, "continued-dump");
  fs.mkdirSync(continuedDumpDir, { recursive: true });
  dump(
    "c3.request.json",
    3000,
    {
      model: "claude-opus-4-8",
      system: [{ type: "text", text: "S1" }, { type: "text", text: "S2" }],
      messages: [{ role: "user", content: "continued" }],
      tools: [{ name: "Bash" }, { name: "Read" }],
      metadata: meta,
    },
    continuedDumpDir,
  );
  dump(
    "req_3.response.json",
    3001,
    {
      id: "req_3",
      content: [{ type: "text", text: "continued response" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4200, output_tokens: 8 },
    },
    continuedDumpDir,
  );
  const continuedRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-ingest" },
    body: JSON.stringify({ dir: continuedDumpDir, watch_id: watchId, agent: "Claude Code", workspace: "/tmp/ws" }),
  });
  const continued = await continuedRes.json();
  assert.equal(continued.source_id, ingest.source_id, "continued OTel run keeps the same source");
  assert.equal(continued.ingested, 1, "continued OTel run appends one request");

  const continuedView = await (await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(ingest.source_id)}`)).json();
  assert.equal(continuedView.requests.length, 3, "continued source contains all requests");
  assert.deepEqual(
    continuedView.requests.map((request) => request.request_index),
    [1, 2, 3],
    "continued OTel request indexes remain monotonic",
  );

  const continuedSources = await (await fetch(`${viewer.url}/api/sources`)).json();
  const continuedSource = (Array.isArray(continuedSources) ? continuedSources : continuedSources.sources || []).find((source) => source.id === ingest.source_id);
  assert.equal(continuedSource.request_count, 3);
  assert.equal(continuedSource.response_count, 2);

  // --- bad input rejected ---
  const badRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-ingest" },
    body: JSON.stringify({ watch_id: watchId }),
  });
  const bad = await badRes.json();
  assert.ok(bad.error && /dump dir/.test(bad.error), "missing dir rejected");

  console.log("otel-ingest smoke: OK (ingest, response pairing, dedup, same-watch continuation, monotonic indexes, bad input)");
} catch (error) {
  failed = true;
  console.error("otel-ingest smoke FAILED:", error.message);
} finally {
  await viewer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

function otelPayload(logRecords) {
  return { resourceLogs: [{ scopeLogs: [{ logRecords }] }] };
}

function logRecord(eventName, bodyRef, traceId, spanId, sequence) {
  return {
    traceId,
    spanId,
    body: { stringValue: eventName },
    attributes: [
      attribute("event.name", eventName),
      attribute("event.sequence", String(sequence), "intValue"),
      attribute("prompt.id", "prompt-1"),
      attribute("query_source", "sdk"),
      attribute("body_ref", bodyRef),
    ],
  };
}

function attribute(key, value, type = "stringValue") {
  return { key, value: { [type]: value } };
}
