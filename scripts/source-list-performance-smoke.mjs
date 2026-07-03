import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-source-list-performance-"));
const originalStateDir = process.env.PEEKMYAGENT_STATE_DIR;

try {
  const stateDir = path.join(tmpDir, "state");
  process.env.PEEKMYAGENT_STATE_DIR = stateDir;
  const importDir = path.join(stateDir, "imports", "large-manifest-trace");
  fs.mkdirSync(importDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(importDir, "manifest.json"),
    JSON.stringify(
      {
        format: "peekmyagent.trace.v1",
        title: "Large manifest backed trace",
        exported_at: "2026-07-04T00:00:00.000Z",
        request_count: 12000,
        response_count: 11999,
        subagent_count: 24,
        raw_body_bytes: 987654321,
        source: {
          label: "Large manifest backed trace",
          agent: "Claude Code",
          workspace: "/tmp/huge-trace",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(importDir, "proxy-captures.json"), "{ this intentionally is not parsed by /api/sources");

  const viewer = await startViewerServer({ cwd: process.cwd(), storePath: path.join(tmpDir, "store.sqlite") });
  try {
    const sources = await getJson(`${viewer.url}/api/sources`);
    const source = sources.find((item) => item.id === "imported-large-manifest-trace");
    assert.ok(source, "manifest-backed imported trace should be listed");
    assert.equal(source.request_count, 12000);
    assert.equal(source.response_count, 11999);
    assert.equal(source.subagent_count, 24);
    assert.equal(source.raw_body_bytes, 987654321);
  } finally {
    await viewer.close();
  }

  console.log("source-list-performance smoke passed");
} finally {
  if (originalStateDir == null) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = originalStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
