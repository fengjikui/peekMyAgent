#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CodexDesktopDiscovery } from "../src/adapters/codex-desktop-discovery.mjs";
import { CodexRolloutCaptureReader } from "../src/server/codex-rollout-capture-reader.mjs";
import { SourceCaptureReader } from "../src/server/source-capture-reader.mjs";
import { realUserVisibleText } from "../src/trace/message-semantics.mjs";
import { summarizeModelResponse } from "../src/trace/model-response-normalizer.mjs";
import { extractHarnessTranslationParts } from "../src/translation/request-materials.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "fixtures", "codex-rollout-sanitized.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-rollout-"));
const rolloutPath = path.join(tmpDir, "rollout.jsonl");
const stateDbPath = path.join(tmpDir, "state_5.sqlite");
fs.copyFileSync(fixturePath, rolloutPath);

try {
  createStateDb(stateDbPath, rolloutPath);
  const selectionPath = path.join(tmpDir, "codex-observation.json");
  const discovery = new CodexDesktopDiscovery({ stateDbPath, selectionPath, sourceLimit: 5 });
  assert.equal(discovery.listSources().length, 0, "Codex history is not exposed until the user selects a session");
  assert.equal(discovery.listCandidates().length, 1);
  discovery.selectThread("thread-fixture");
  const sources = discovery.listSources();
  assert.equal(sources.length, 1);
  const source = sources[0];
  assert.equal(source.id, "codex-thread-fixture");
  assert.equal(source.label, "Fixture Codex trace");
  assert.equal(source.kind, "codex_rollout_local");
  assert.equal(source.confidence, "semantic");
  assert.equal(source.available, true);
  assert.deepEqual(discovery.selectedThreadIds(), ["thread-fixture"]);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(selectionPath, "utf8"))).includes("rollout"), false, "selection stores only the thread id, never rollout content");

  const rolloutReader = new CodexRolloutCaptureReader({ chunkBytes: 127 });
  const reader = new SourceCaptureReader({
    customReaders: { codex_rollout_local: rolloutReader },
  });
  const firstPage = reader.readPage(source, { limit: 1 });
  assert.equal(firstPage.captures.length, 1);
  assert.equal(firstPage.page.next_cursor, "1");
  assert.equal(firstPage.page.has_more, true);

  const result = reader.read(source);
  assert.equal(result.captures.length, 3, "one tool loop becomes two exchanges and the active task remains one exchange");
  const [toolRequest, toolResultRequest, activeRequest] = result.captures;

  assert.equal(toolRequest.body.codex.turn_id, "turn-1");
  assert.equal(toolRequest.body.codex.exchange_index, 1);
  assert.equal(toolRequest.body.codex.input_scope, "observed_upstream_delta");
  assert.equal(toolRequest.body.codex.full_request_history_available, false);
  assert.equal(toolRequest.body.system[0].text, "You are Codex. Work carefully.");
  assert.equal(toolRequest.body.tools[0].name, "fixture_app__inspect");
  assert.equal(toolRequest.response.body_json.finish_reason, "tool_use");
  const firstSummary = summarizeModelResponse(toolRequest.response);
  assert.equal(firstSummary.tool_calls.length, 1);
  assert.equal(firstSummary.tool_calls[0].id, "call-fixture-1");
  assert.match(firstSummary.thinking, /inspect the fixture/);
  assert.equal(firstSummary.text, "我先检查文件。");
  assert.equal(JSON.stringify(toolRequest).includes("opaque-fixture-reasoning"), false, "opaque reasoning is never copied into the capture");
  assert.match(JSON.stringify(toolRequest), /opaque_encrypted_reasoning/);

  const visibleUsers = toolRequest.body.messages.filter((message) => message.role === "user").map(realUserVisibleText).filter(Boolean);
  assert.deepEqual(visibleUsers, ["请检查 fixture 文件并告诉我结果。"]);
  const harness = extractHarnessTranslationParts(toolRequest.body.messages);
  assert.deepEqual(harness.map((part) => part.kind), ["harness_codex_context", "harness_codex_context"]);
  assert.deepEqual(harness.map((part) => part.tag), [undefined, undefined]);

  assert.equal(toolResultRequest.body.codex.exchange_index, 2);
  assert.deepEqual(toolResultRequest.body.messages.map((message) => message.role), ["tool"]);
  assert.equal(toolResultRequest.body.messages[0].tool_call_id, "call-fixture-1");
  assert.equal(toolResultRequest.response.body_json.finish_reason, "end_turn");
  assert.equal(summarizeModelResponse(toolResultRequest.response).text, "检查完成：fixture-ok。");

  assert.equal(activeRequest.body.codex.turn_id, "turn-2");
  assert.equal(activeRequest.response.body_json.status, "in_progress");
  assert.equal(activeRequest.response.body_json.finish_reason, null);
  assert.equal(result.command.mode, "codex_rollout_local");
  assert.equal(result.command.exact_wire_request, false);

  fs.appendFileSync(
    rolloutPath,
    `${JSON.stringify({ timestamp: "2026-07-18T01:01:02.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2", completed_at: "2026-07-18T01:01:02.000Z" } })}\n`,
  );
  const refreshed = reader.read(source);
  assert.equal(refreshed.captures.length, 3, "appending task completion updates the stable capture instead of duplicating it");
  assert.equal(refreshed.captures[2].capture_id, activeRequest.capture_id);
  assert.equal(refreshed.captures[2].response.body_json.status, "completed");
  assert.equal(refreshed.captures[2].response.body_json.finish_reason, "end_turn");

  console.log("codex rollout capture smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function createStateDb(filePath, rolloutPath) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        model_provider TEXT,
        cwd TEXT,
        title TEXT,
        tokens_used INTEGER,
        archived INTEGER,
        cli_version TEXT,
        first_user_message TEXT,
        model TEXT,
        thread_source TEXT
      );
    `);
    db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        tokens_used, archived, cli_version, first_user_message, model, thread_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "thread-fixture",
      rolloutPath,
      1_752_800_400,
      1_752_800_500,
      "desktop",
      "openai",
      "/tmp/peekmyagent-codex-fixture",
      "Fixture Codex trace",
      192,
      0,
      "0.fixture",
      "请检查 fixture 文件并告诉我结果。",
      "gpt-fixture",
      "user",
    );
  } finally {
    db.close();
  }
}
