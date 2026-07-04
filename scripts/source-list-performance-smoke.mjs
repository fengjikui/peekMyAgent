import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore, sourceIdForWatch } from "../src/core/persistence-store.mjs";
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

  const noisyImportDir = path.join(stateDir, "imports", "noisy-manifest-trace");
  fs.mkdirSync(noisyImportDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(noisyImportDir, "manifest.json"),
    JSON.stringify(
      {
        format: "peekmyagent.trace.v1",
        title: "Noisy manifest backed trace",
        exported_at: "2026-07-04T00:00:00.000Z",
        request_count: "3.8",
        response_count: "1e999",
        subagent_count: -5,
        raw_body_bytes: "90071992547409930",
        source: {
          label: "Noisy manifest backed trace",
          agent: `Noisy\nAgent\u0000${"x".repeat(120)}`,
          workspace: `/tmp/noisy\u0000workspace/${"x".repeat(600)}`,
          conversation_id: `conversation\nid\u007f${"x".repeat(300)}`,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(noisyImportDir, "proxy-captures.json"), "{ this intentionally is not parsed by /api/sources");

  const storePath = path.join(tmpDir, "store.sqlite");
  const store = openPersistenceStore(storePath);
  const genericWatch = {
    watch_id: "claude-code-source-list-smoke",
    label: "Claude Code · 监控一个会话",
    agent: "Claude Code",
    mode: "single_session",
    confidence: "exact",
    kind: "proxy_capture",
    workspace: "/tmp/source-list-smoke",
    conversation_id: "source-list-smoke-conversation",
    status: "stopped",
  };
  store.upsertWatch(genericWatch);
  const renamedGenericWatch = {
    ...genericWatch,
    watch_id: "claude-code-renamed-source-list-smoke",
    conversation_id: "renamed-source-list-smoke-conversation",
    title: "User renamed source",
  };
  store.upsertWatch(renamedGenericWatch);
  const noisyTitleWatch = {
    ...genericWatch,
    watch_id: "claude-code-noisy-title-source-list-smoke",
    conversation_id: "noisy-title-source-list-smoke-conversation",
    title: `  Noisy\nsource\u0000title ${"x".repeat(120)}  `,
  };
  store.upsertWatch(noisyTitleWatch);
  store.upsertCapture({
    watch: genericWatch,
    capture: {
      capture_id: "source-list-smoke-request-1",
      watch_id: genericWatch.watch_id,
      request_index: 1,
      conversation_id: genericWatch.conversation_id,
      agent_profile: "Claude Code",
      workspace: genericWatch.workspace,
      received_at: "2026-07-04T00:00:00.000Z",
      method: "POST",
      path: "/v1/messages",
      headers: {},
      body: {
        model: "mock",
        messages: [{ role: "user", content: "source list inferred title" }],
      },
    },
  });
  let initialLoadCount = 0;
  store.loadCaptures = () => {
    throw new Error("source list must not load all persisted captures");
  };
  const originalLoadInitialCaptures = store.loadInitialCaptures.bind(store);
  store.loadInitialCaptures = (...args) => {
    initialLoadCount += 1;
    return originalLoadInitialCaptures(...args);
  };

  const viewer = await startViewerServer({ cwd: process.cwd(), persistenceStore: store });
  try {
    const sources = await getJson(`${viewer.url}/api/sources`);
    const source = sources.find((item) => item.id === "imported-large-manifest-trace");
    assert.ok(source, "manifest-backed imported trace should be listed");
    assert.equal(source.request_count, 12000);
    assert.equal(source.response_count, 11999);
    assert.equal(source.subagent_count, 24);
    assert.equal(source.raw_body_bytes, 987654321);

    const noisySource = sources.find((item) => item.id === "imported-noisy-manifest-trace");
    assert.ok(noisySource, "noisy manifest-backed imported trace should be listed");
    assert.equal(noisySource.request_count, 3, "manifest request_count is floored to an integer");
    assert.equal(noisySource.response_count, 0, "non-finite manifest response_count is ignored");
    assert.equal(noisySource.subagent_count, 0, "negative manifest subagent_count is ignored");
    assert.equal(noisySource.raw_body_bytes, Number.MAX_SAFE_INTEGER, "huge manifest byte count is clamped");
    assert.equal(/[\x00-\x1F\x7F]/.test(noisySource.agent || ""), false, "manifest agent is stripped of control characters");
    assert.equal((noisySource.agent || "").length <= 80, true, "manifest agent is bounded");
    assert.equal(/[\x00-\x1F\x7F]/.test(noisySource.workspace || ""), false, "manifest workspace is stripped of control characters");
    assert.equal((noisySource.workspace || "").length <= 512, true, "manifest workspace is bounded");
    assert.equal(/[\x00-\x1F\x7F]/.test(noisySource.conversation_id || ""), false, "manifest conversation id is stripped of control characters");
    assert.equal((noisySource.conversation_id || "").length <= 256, true, "manifest conversation id is bounded");

    const persisted = sources.find((item) => item.id === sourceIdForWatch(genericWatch.watch_id));
    assert.ok(persisted, "generic persisted source should be listed");
    assert.equal(persisted.label, "source list inferred title", "generic persisted title uses a bounded initial capture sample");
    const renamedPersisted = sources.find((item) => item.id === sourceIdForWatch(renamedGenericWatch.watch_id));
    assert.ok(renamedPersisted, "renamed generic persisted source should be listed");
    assert.equal(renamedPersisted.label, "User renamed source", "user rename should not be replaced by inferred titles");
    assert.equal(renamedPersisted.user_title, "User renamed source", "user rename remains explicit metadata");
    const noisyTitlePersisted = sources.find((item) => item.id === sourceIdForWatch(noisyTitleWatch.watch_id));
    assert.ok(noisyTitlePersisted, "noisy persisted title source should be listed");
    assert.equal(/[\x00-\x1F\x7F]/.test(noisyTitlePersisted.user_title || ""), false, "persisted title is stripped of control characters before source list");
    assert.equal((noisyTitlePersisted.user_title || "").includes("\n"), false, "persisted title is normalized to one line before source list");
    assert.equal((noisyTitlePersisted.user_title || "").length <= 80, true, "persisted title is bounded before source list");
    assert.equal(initialLoadCount, 1, "generic title inference should only load a bounded initial sample");
  } finally {
    await viewer.close();
    store.close();
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
