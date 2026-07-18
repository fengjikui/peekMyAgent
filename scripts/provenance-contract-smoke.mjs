#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { startCaptureProxy } from "../src/core/capture-proxy.mjs";
import {
  captureProvenanceOr,
  importedTraceProvenance,
  proxyCaptureProvenance,
  validateCaptureProvenance,
} from "../src/core/provenance.mjs";
import { captureEvidenceProfile } from "../src/trace/evidence-profile.mjs";

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "response-1", output: [{ type: "message", role: "assistant", content: "ok" }] }));
});

const initialCaptures = [];
let proxy;
try {
  const targetBaseUrl = await listen(upstream);
  proxy = await startCaptureProxy({
    targetBaseUrl,
    defaultAttribution: { watchId: "provenance-watch", agentProfile: "OpenClaw" },
    onCapture(capture) {
      initialCaptures.push(structuredClone(capture));
    },
  });

  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "smoke-model", input: "hello" }),
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(initialCaptures.length, 1);
  assert.equal(initialCaptures[0].provenance.transport, "capture_proxy");
  assert.equal(initialCaptures[0].provenance.request.fidelity, "exact");
  assert.equal(initialCaptures[0].provenance.response.fidelity, "missing");
  assert.equal(initialCaptures[0].provenance.association.confidence, "none");

  const completed = proxy.captures[0];
  assert.equal(completed.provenance.response.fidelity, "exact");
  assert.equal(completed.provenance.association.method, "capture_lifecycle");
  assert.equal(completed.provenance.association.confidence, "exact");
  assert.equal(completed.provenance.association.evidence.capture_id, completed.capture_id);
  assert.equal(validateCaptureProvenance(completed.provenance).ok, true);
  assert.deepEqual(captureEvidenceProfile(completed), {
    schema_version: 1,
    kind: "request_response",
    transport: "capture_proxy",
    request: { origin: "network_proxy", fidelity: "exact", artifact: "http_request", exact: true, available: true },
    response: { origin: "network_proxy", fidelity: "exact", artifact: "http_response", exact: true, available: true },
    sections: {
      system: { source: "request", origin: "network_proxy", fidelity: "exact", scope: "complete_request", available: true },
      tools: { source: "request", origin: "network_proxy", fidelity: "exact", scope: "complete_request", available: true },
      messages: {
        source: "request",
        origin: "network_proxy",
        fidelity: "exact",
        scope: "complete_request",
        available: true,
        history_complete: true,
      },
      harness: {
        source: "pma_semantic_projection",
        origin: "network_proxy",
        fidelity: "exact",
        scope: "complete_request",
        available: true,
        derived: true,
      },
    },
    association: { method: "capture_lifecycle", confidence: "exact" },
    limitations: [],
  });

  const normalized = normalizeOpenClawProxyCapture(completed);
  assert.deepEqual(normalized.provenance, completed.provenance, "OpenClaw normalization preserves proxy provenance");

  const legacyNormalized = normalizeOpenClawProxyCapture({
    capture_id: "legacy-proxy",
    watch_id: "legacy-watch",
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: "legacy-model", messages: [{ role: "user", content: "hello" }] },
    response: { status: 200, truncated: true },
  });
  assert.equal(legacyNormalized.provenance.transport, "capture_proxy");
  assert.equal(legacyNormalized.provenance.response.fidelity, "partial");
  assert.equal(legacyNormalized.provenance.association.confidence, "exact");

  const imported = importedTraceProvenance({
    capture_id: "legacy-import",
    body: { messages: [] },
    response: { status: 200 },
  });
  assert.equal(imported.transport, "trace_import");
  assert.equal(imported.request.fidelity, "exact");
  assert.equal(imported.response.fidelity, "exact");
  assert.equal(imported.association.method, "imported_capture_record");
  assert.equal(imported.association.confidence, "high");

  const missingImported = importedTraceProvenance({ capture_id: "request-only" });
  assert.equal(missingImported.request.fidelity, "missing");
  assert.equal(missingImported.response.fidelity, "missing");
  assert.equal(missingImported.association.confidence, "none");

  assert.throws(
    () => captureProvenanceOr({ schema_version: 1, transport: "proxy" }, () => proxyCaptureProvenance({})),
    /Invalid capture provenance/,
    "malformed provenance must not silently become trusted evidence",
  );

  console.log("provenance contract smoke passed");
} finally {
  if (proxy) await proxy.close();
  await close(upstream);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("error", reject);
  });
}
