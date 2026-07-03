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

function dump(name, t, payload) {
  const f = path.join(dumpDir, name);
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

  // --- ingest ---
  const ingestRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: dumpDir, watch_id: watchId, agent: "Claude Code", workspace: "/tmp/ws" }),
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: dumpDir, watch_id: watchId, agent: "Claude Code", workspace: "/tmp/ws" }),
  });
  const re = await reRes.json();
  assert.equal(re.ingested, 0, "re-ingest inserts nothing new");
  assert.equal(re.total, 2, "still sees both captures");

  // --- bad input rejected ---
  const badRes = await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ watch_id: watchId }),
  });
  const bad = await badRes.json();
  assert.ok(bad.error && /dump dir/.test(bad.error), "missing dir rejected");

  console.log("otel-ingest smoke: OK (ingest 2, response 1, view+sources surfaced, dedup re-ingest, bad input rejected)");
} catch (error) {
  failed = true;
  console.error("otel-ingest smoke FAILED:", error.message);
} finally {
  await viewer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
