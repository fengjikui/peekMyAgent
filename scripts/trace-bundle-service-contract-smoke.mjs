#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_LIMITS,
  TraceBundleService,
  parseTraceBundle,
  redactTraceExportValue,
  validateTraceBundle,
} from "../src/server/trace-bundle-service.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-trace-bundle-service-"));
const importsDir = path.join(root, "imports");
const fixedDate = new Date("2026-07-12T08:00:00.000Z");
const source = {
  id: "live-contract",
  label: "Contract trace",
  agent: "Claude Code",
  kind: "live_capture",
  confidence: "high",
  available: true,
  workspace: "/safe/workspace",
  conversation_id: "conversation-contract",
};
const captures = [
  {
    capture_id: "capture-contract-1",
    watch_id: "watch-contract",
    request_index: 1,
    received_at: "2026-07-12T07:59:00.000Z",
    headers: { authorization: "Bearer contract-secret-token", "x-claude-code-agent-id": "child-a" },
    body: {
      messages: [{ role: "user", content: "inspect this trace" }],
      metadata: { api_key: "plain-secret", nested: { password: "also-secret" } },
    },
    response: { status: 200, body_json: { content: [{ type: "text", text: "done" }] } },
  },
];
let rawReadCount = 0;
const repository = {
  list() {
    return [source, ...importedSources()];
  },
  resolve(id, { sources = this.list() } = {}) {
    const found = sources.find((item) => item.id === id);
    if (!found) throw statusError(404, `Source not found: ${id}`);
    return found;
  },
};
const service = new TraceBundleService({
  repository,
  captureReader: {
    readAll(resolved) {
      assert.equal(resolved.id, source.id);
      rawReadCount += 1;
      return { captures };
    },
  },
  importsDir,
  importedSourceFromDir(dir, idPart) {
    return { id: `imported-${idPart}`, label: idPart, kind: "imported_trace", available: true, readonly: true, path: dir };
  },
  sanitizeTitle(value, fallback) {
    return String(value || fallback).replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  },
  sanitizeSourceId(value) {
    return String(value || "").trim();
  },
  errors: {
    client: (message) => statusError(400, message),
    tooLarge: (message) => statusError(413, message),
  },
  clock: () => fixedDate,
  randomUUID: () => "generated-capture-id",
});

try {
  assert.throws(() => service.export(""), (error) => error.statusCode === 400);
  assert.throws(() => service.export("missing"), (error) => error.statusCode === 404);

  const exported = service.export(source.id);
  assert.equal(rawReadCount, 1, "export uses the raw capture reader exactly once");
  assert.match(exported.filename, /^peekmyagent-trace-[a-f0-9]{12}-2026-07-12\.peektrace\.json\.gz$/);
  const bundle = JSON.parse(zlib.gunzipSync(exported.buffer).toString("utf8"));
  const bundleText = JSON.stringify(bundle);
  assert.equal(bundle.format, TRACE_BUNDLE_FORMAT);
  assert.equal(bundle.manifest.request_count, 1);
  assert.equal(bundle.manifest.response_count, 1);
  assert.equal(bundle.manifest.subagent_count, 1);
  assert.equal(bundle.manifest.export_kind, "sanitized_share_bundle");
  assert.equal(bundleText.includes("contract-secret-token"), false);
  assert.equal(bundleText.includes("plain-secret"), false);
  assert.equal(bundleText.includes("also-secret"), false);
  assert.match(bundleText, /REDACTED/);

  const imported = service.import(exported.buffer);
  assert.equal(imported.ok, true);
  assert.equal(imported.request_count, 1);
  assert.ok(imported.source_id.startsWith("imported-"));
  assert.equal(imported.sources.some((item) => item.id === imported.source_id), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(imported.source.path).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(imported.source.path, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(imported.source.path, "proxy-captures.json")).mode & 0o777, 0o600);
  }

  const legacy = Buffer.from(
    JSON.stringify({
      format: TRACE_BUNDLE_FORMAT,
      manifest: { trace_id: "..", title: "unsafe\u0000 title" },
      captures: [{ body: { messages: [{ role: "user", content: "legacy" }] } }],
    }),
  );
  const importedLegacy = service.import(legacy);
  assert.equal(path.dirname(importedLegacy.source.path), path.resolve(importsDir));
  assert.notEqual(path.resolve(importedLegacy.source.path), path.resolve(importsDir));
  const legacyCapture = JSON.parse(fs.readFileSync(path.join(importedLegacy.source.path, "proxy-captures.json"), "utf8"))[0];
  assert.equal(legacyCapture.capture_id, "generated-capture-id");
  assert.equal(legacyCapture.provenance.transport, "trace_import");
  assert.equal(legacyCapture.provenance.response.fidelity, "missing");

  assert.throws(() => parseTraceBundle(Buffer.from("not-json")), /must be a peekMyAgent/);
  assert.throws(() => validateTraceBundle({ format: "future.trace.v2", captures: [{}] }), /Unsupported trace bundle format/);
  assert.throws(
    () => validateTraceBundle({ captures: [{ provenance: { schema_version: 99 } }] }),
    /Invalid capture provenance/,
  );
  assert.throws(
    () => validateTraceBundle({ captures: Array.from({ length: TRACE_BUNDLE_LIMITS.captures + 1 }, () => ({})) }, { tooLarge: (message) => statusError(413, message) }),
    (error) => error.statusCode === 413,
  );

  const redactedDepth = redactTraceExportValue(deepObject("secret", TRACE_BUNDLE_LIMITS.redactionDepth + 3));
  assert.equal(JSON.stringify(redactedDepth.value).includes("[REDACTED:trace_export_max_depth]"), true);

  console.log("trace bundle service contract smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function importedSources() {
  if (!fs.existsSync(importsDir)) return [];
  return fs
    .readdirSync(importsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(importsDir, entry.name, "proxy-captures.json")))
    .map((entry) => ({
      id: `imported-${entry.name}`,
      label: entry.name,
      kind: "imported_trace",
      available: true,
      readonly: true,
      path: path.join(importsDir, entry.name),
    }));
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function deepObject(value, depth) {
  let output = value;
  for (let index = 0; index < depth; index += 1) output = { next: output };
  return output;
}
