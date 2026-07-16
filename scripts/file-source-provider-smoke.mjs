#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_FILE_SOURCES, listFileSources } from "../src/server/file-source-provider.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peek-file-provider-"));
try {
  assert.deepEqual(listFileSources({ cwd: root }), [], "demo sources stay disabled unless explicitly requested");

  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), "[]\n");
  let statsCalls = 0;
  const custom = listFileSources({
    cwd: root,
    demo: "ignored-when-custom-evidence-is-set",
    evidencePath: "evidence",
    summarizeDirectory(dir) {
      statsCalls += 1;
      return { request_count: dir === evidenceDir ? 3 : 0, raw_body_bytes: 256 };
    },
  });
  assert.equal(custom.length, 1, "custom evidence takes precedence over demo definitions");
  assert.equal(custom[0].id, "custom");
  assert.equal(custom[0].path, evidenceDir);
  assert.equal(custom[0].available, true);
  assert.equal(custom[0].request_count, 3);
  assert.equal(statsCalls, 1);

  const customWithoutStats = listFileSources({
    cwd: root,
    evidencePath: "evidence",
    includeStats: false,
    summarizeDirectory() {
      statsCalls += 1;
      return { request_count: 99 };
    },
  });
  assert.equal(customWithoutStats[0].request_count, undefined);
  assert.equal(statsCalls, 1, "includeStats=false avoids parsing capture evidence");

  const demo = listFileSources({ cwd: root, demo: "openclaw-subagent", includeStats: false });
  assert.equal(demo.length, DEFAULT_FILE_SOURCES.length, "legacy demo mode exposes the full predefined evidence set");
  assert.equal(demo.every((source) => path.isAbsolute(source.path)), true);
  assert.equal(demo.every((source) => source.available === false), true);
  assert.equal(demo[0].id, "openclaw-subagent");

  const customDefinitions = listFileSources({
    cwd: root,
    demo: true,
    includeStats: false,
    definitions: [{ id: "fixture", label: "Fixture", agent: "Test", confidence: "exact", kind: "proxy_capture", path: "evidence" }],
  });
  assert.equal(customDefinitions[0].available, true);

  console.log("file source provider smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
