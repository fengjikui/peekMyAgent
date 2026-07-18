#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRolloutCaptureReader } from "../src/server/codex-rollout-capture-reader.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixturePath = path.join(projectRoot, "fixtures", "codex-rollout-sanitized.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-viewer-"));
const rolloutPath = path.join(tmpDir, "rollout.jsonl");
const storePath = path.join(tmpDir, "store.sqlite");
fs.copyFileSync(fixturePath, rolloutPath);

const source = {
  id: "codex-thread-fixture",
  label: "Fixture Codex trace",
  agent: "Codex",
  confidence: "semantic",
  kind: "codex_rollout_local",
  transport: "codex_rollout_local",
  path: rolloutPath,
  available: true,
  read_only: true,
  deletable: false,
  request_count: null,
  conversation_id: "thread-fixture",
  workspace: "/tmp/peekmyagent-codex-fixture",
  project: "peekmyagent-codex-fixture",
  model: "gpt-fixture",
  stream_live: true,
};

let viewer;
try {
  viewer = await startViewerServer({
    cwd: tmpDir,
    port: 0,
    storePath,
    codexLocal: true,
    codexDesktopDiscovery: { listSources: () => [source] },
    codexRolloutReader: new CodexRolloutCaptureReader({ chunkBytes: 127 }),
  });

  const sources = await getJson(`${viewer.url}/api/sources`);
  const codexSource = sources.find((item) => item.id === source.id);
  assert.ok(codexSource, "Codex local source should be available through the Viewer API");
  assert.equal(codexSource.agent, "Codex");
  assert.equal(codexSource.read_only, true);
  assert.equal(codexSource.deletable, false);
  assert.equal(codexSource.request_count, null);

  const timeline = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}&compact=1`);
  assert.equal(timeline.source.id, source.id);
  assert.equal(timeline.requests.length, 3);
  assert.equal(timeline.turns.length, 2, "the tool loop exchanges should remain in one Codex task turn");
  assert.equal(timeline.stats.request_count, 3);
  assert.equal(timeline.stats.tool_call_count, 1);
  assert.equal(timeline.stats.tool_result_count, 1);
  assert.equal(timeline.turns[0].tool_call_count, 1);
  assert.equal(timeline.turns[0].tool_result_count, 1);

  const firstRequest = timeline.requests[0];
  const secondRequest = timeline.requests[1];
  assert.equal(firstRequest.summary.response.tool_calls.length, 1);
  assert.equal(secondRequest.counts.tool_results, 1);

  const detail = await getJson(
    `${viewer.url}/api/request?source=${encodeURIComponent(source.id)}&request=${encodeURIComponent(firstRequest.id)}`,
  );
  assert.equal(detail.source.id, source.id);
  assert.equal(detail.request.id, firstRequest.id);
  assert.equal(detail.request.detail_scope, "request_window");
  assert.equal(detail.request.raw.provenance.transport, "codex_rollout_local");
  assert.equal(detail.request.raw.body.codex.input_scope, "observed_upstream_delta");
  assert.equal(detail.request.raw.body.codex.full_request_history_available, false);
  assert.equal(detail.request.raw.body.tools[0].name, "fixture_app__inspect");

  const cursorPage = await getJson(
    `${viewer.url}/api/view?source=${encodeURIComponent(source.id)}&compact=1&initial=1&limit=1`,
  );
  assert.equal(cursorPage.page_scope, "timeline_cursor_delta");
  assert.equal(cursorPage.requests.length, 1);
  assert.equal(cursorPage.partial.has_more, true);
  assert.ok(cursorPage.partial.next_cursor);

  console.log("Codex Viewer integration smoke passed");
} finally {
  await viewer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}
