#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importedTraceSourceFromDir, listImportedTraceSources, traceManifestStats } from "../src/server/imported-trace-source-provider.mjs";
import { sanitizeSourceText } from "../src/server/source-text.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peek-imported-provider-"));
try {
  assert.deepEqual(listImportedTraceSources({ importsDir: path.join(root, "missing") }), []);

  const ignored = path.join(root, "ignored");
  fs.mkdirSync(ignored);
  fs.writeFileSync(path.join(ignored, "manifest.json"), "{}\n");

  const manifestDir = path.join(root, "manifest-source");
  fs.mkdirSync(manifestDir);
  fs.writeFileSync(path.join(manifestDir, "proxy-captures.json"), "[]\n");
  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    `${JSON.stringify({
      title: "  <wrapper>Shared trace</wrapper>  ",
      imported_at: "2026-07-12T00:00:00.000Z",
      request_count: 3,
      response_count: 2,
      subagent_count: 1,
      raw_body_bytes: 4096,
      source: { agent: "Claude Code", workspace: "/tmp/work", conversation_id: "conversation-1" },
    })}\n`,
  );

  let fallbackCalls = 0;
  const cleanText = (value) => String(value || "").replace(/<\/?wrapper>/g, "");
  const manifestSource = importedTraceSourceFromDir(manifestDir, "manifest-id", {
    cleanText,
    summarizeDirectory() {
      fallbackCalls += 1;
      return { request_count: 99 };
    },
  });
  assert.equal(manifestSource.id, "imported-manifest-id");
  assert.equal(manifestSource.label, "Shared trace");
  assert.equal(manifestSource.request_count, 3);
  assert.equal(manifestSource.response_count, 2);
  assert.equal(manifestSource.workspace, "/tmp/work");
  assert.equal(manifestSource.readonly, true);
  assert.equal(fallbackCalls, 0, "manifest statistics avoid parsing the capture file");

  const legacyDir = path.join(root, "legacy-source");
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, "proxy-captures.json"), "[]\n");
  fs.writeFileSync(path.join(legacyDir, "manifest.json"), "{ malformed\n");
  const listed = listImportedTraceSources({
    importsDir: root,
    cleanText,
    summarizeDirectory(dir) {
      fallbackCalls += 1;
      return { request_count: 7, response_count: 6, subagent_count: 2, raw_body_bytes: 512, workspace: `${dir}/workspace` };
    },
  });
  assert.deepEqual(
    listed.map((source) => source.id).sort(),
    ["imported-legacy-source", "imported-manifest-source"],
  );
  const legacy = listed.find((source) => source.id === "imported-legacy-source");
  assert.equal(legacy.request_count, 7);
  assert.equal(legacy.agent, "Imported Trace");
  assert.match(legacy.workspace, /legacy-source\/workspace$/);
  assert.equal(fallbackCalls, 1);

  assert.equal(traceManifestStats({ request_count: 0 }), null);
  assert.equal(traceManifestStats({ request_count: 2.9, response_count: -1 }).request_count, 2);
  assert.equal(sanitizeSourceText("a\n\tb", { limit: 20 }), "a b");
  assert.equal(sanitizeSourceText("", { fallback: "fallback", limit: 20 }), "fallback");
  assert.equal(sanitizeSourceText("123456789", { limit: 6 }), "123...");

  console.log("imported source provider smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
