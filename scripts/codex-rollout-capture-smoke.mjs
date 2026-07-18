#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CodexDesktopDiscovery } from "../src/adapters/codex-desktop-discovery.mjs";
import {
  normalizeCodexRolloutTask,
} from "../src/adapters/codex-rollout-normalizer.mjs";
import { extractRequestMessages } from "../src/shared/request-payload.mjs";
import { CodexRolloutCaptureReader } from "../src/server/codex-rollout-capture-reader.mjs";
import { SourceCaptureReader } from "../src/server/source-capture-reader.mjs";
import { captureEvidenceProfile } from "../src/trace/evidence-profile.mjs";
import { codexAgentMessageSummary, isCodexAgentMessage, realUserVisibleText } from "../src/trace/message-semantics.mjs";
import { summarizeModelResponse } from "../src/trace/model-response-normalizer.mjs";
import { extractHarnessTranslationParts } from "../src/translation/request-materials.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "fixtures", "codex-rollout-sanitized.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-rollout-"));
const rolloutPath = path.join(tmpDir, "rollout.jsonl");
const stateDbPath = path.join(tmpDir, "state_5.sqlite");
fs.copyFileSync(fixturePath, rolloutPath);

try {
  const freshDiscovery = new CodexDesktopDiscovery({
    stateDbPath: path.join(tmpDir, "not-created-yet.sqlite"),
    selectionPath: path.join(tmpDir, "fresh-selection.json"),
  });
  freshDiscovery.beginObservation({
    sourceId: "codex-live-first-run",
    workspace: "/tmp/peekmyagent-first-run",
  });
  assert.equal(
    freshDiscovery.listSources()[0]?.kind,
    "codex_rollout_pending",
    "a first-run waiting Source must remain visible before Codex creates its state database",
  );

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
  const toolEvidence = captureEvidenceProfile(toolRequest);
  assert.equal(toolEvidence.sections.messages.scope, "observed_upstream_delta");
  assert.equal(toolEvidence.sections.messages.history_complete, false);
  assert.equal(toolEvidence.sections.tools.source, "session_metadata");
  assert.equal(toolEvidence.sections.tools.scope, "dynamic_tools_only");
  assert.equal(toolEvidence.sections.harness.derived, true);
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

  assert.equal("messages" in toolRequest.body, false, "Responses reconstruction keeps canonical input without a duplicate messages projection");
  const toolRequestMessages = extractRequestMessages(toolRequest.body);
  const visibleUsers = toolRequestMessages.filter((message) => message.role === "user").map(realUserVisibleText).filter(Boolean);
  assert.deepEqual(visibleUsers, ["请检查 fixture 文件并告诉我结果。"]);
  const harness = extractHarnessTranslationParts(toolRequestMessages);
  assert.deepEqual(harness.map((part) => part.kind), ["harness_codex_app", "harness_codex_environment"]);
  assert.deepEqual(harness.map((part) => part.tag), ["app-context", "environment_context"]);

  assert.equal(toolResultRequest.body.codex.exchange_index, 2);
  const toolResultMessages = extractRequestMessages(toolResultRequest.body);
  assert.deepEqual(toolResultMessages.map((message) => message.role), ["tool"]);
  assert.equal(toolResultMessages[0].tool_call_id, "call-fixture-1");
  assert.equal(toolResultRequest.response.body_json.finish_reason, "end_turn");
  assert.equal(summarizeModelResponse(toolResultRequest.response).text, "检查完成：fixture-ok。");

  assert.equal(activeRequest.body.codex.turn_id, "turn-2");
  assert.equal(activeRequest.response.body_json.status, "in_progress");
  assert.equal(activeRequest.response.body_json.finish_reason, null);
  assert.equal(result.command.mode, "codex_rollout_local");
  assert.equal(result.command.exact_wire_request, false);

  const compaction = normalizeCodexRolloutTask({
    source: { conversation_id: "thread-compact", workspace: "/tmp/compact" },
    sessionMeta: { id: "thread-compact", base_instructions: "not part of a lifecycle event" },
    turn: {
      turnId: "turn-compact",
      entries: [
        rolloutRecord("event_msg", { type: "task_started", turn_id: "turn-compact" }),
        rolloutRecord("compacted", {
          previous_window_id: "window-1",
          window_id: "window-2",
          first_window_id: "window-1",
          window_number: 2,
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
            { type: "compaction", encrypted_content: "opaque-history" },
          ],
        }),
        rolloutRecord("event_msg", {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 60000 },
            last_token_usage: { total_tokens: 6222 },
            model_context_window: 258400,
          },
        }),
        rolloutRecord("event_msg", { type: "context_compacted" }),
        rolloutRecord("event_msg", { type: "task_complete", turn_id: "turn-compact" }),
      ],
    },
  });
  assert.equal(compaction.length, 1);
  assert.equal(compaction[0].method, "EVENT");
  assert.equal(compaction[0].path, "/codex/rollout/context_compacted");
  assert.equal("response" in compaction[0], false, "compaction is a Harness lifecycle event, not a fake model response");
  assert.equal("messages" in compaction[0].body, false);
  assert.equal("system" in compaction[0].body, false);
  assert.equal("tools" in compaction[0].body, false);
  assert.deepEqual(compaction[0].semantic_event.data, {
    window_id: "window-2",
    previous_window_id: "window-1",
    first_window_id: "window-1",
    window_number: 2,
    replacement_item_count: 2,
    retained_message_count: 1,
    retained_message_roles: { user: 1 },
    opaque_compaction_count: 1,
    replacement_item_types: { "message:user": 1, compaction: 1 },
    history_effect: "replace_live_history",
    post_compaction_estimated_context_tokens: 6222,
    token_estimate_kind: "local_coarse_estimate",
    model_context_window: 258400,
    notification_present: true,
    message: null,
  });
  const compactionEvidence = captureEvidenceProfile(compaction[0]);
  assert.equal(compactionEvidence.kind, "semantic_event");
  assert.equal(compactionEvidence.request.exact, true, "the rollout lifecycle event itself is exactly observed");
  assert.equal(compactionEvidence.response.available, false);
  assert.deepEqual(compactionEvidence.limitations, ["exact_wire_unavailable"]);

  const [agentMessage] = extractRequestMessages({
    input: [{
      type: "agent_message",
      author: "/root/context_probe",
      recipient: "/root",
      content: [
        {
          type: "input_text",
          text: "Message Type: FINAL_ANSWER\nSender: /root/context_probe\nPayload:\nContext inherited.",
        },
      ],
    }],
  });
  assert.equal(isCodexAgentMessage(agentMessage), true);
  assert.equal(codexAgentMessageSummary(agentMessage).status, "completed");
  assert.equal(codexAgentMessageSummary(agentMessage).result, "Context inherited.");

  fs.appendFileSync(
    rolloutPath,
    `${JSON.stringify({ timestamp: "2026-07-18T01:01:02.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2", completed_at: "2026-07-18T01:01:02.000Z" } })}\n`,
  );
  const refreshed = reader.read(source);
  assert.equal(refreshed.captures.length, 3, "appending task completion updates the stable capture instead of duplicating it");
  assert.equal(refreshed.captures[2].capture_id, activeRequest.capture_id);
  assert.equal(refreshed.captures[2].response.body_json.status, "completed");
  assert.equal(refreshed.captures[2].response.body_json.finish_reason, "end_turn");

  const pending = discovery.beginObservation({
    sourceId: "codex-live-fixture",
    workspace: "/tmp/peekmyagent-codex-fixture",
    baselineThreadIds: ["thread-fixture"],
    mode: "new",
    captureMode: "rollout",
    fallbackReason: "fixture exact proxy unavailable",
  });
  assert.equal(pending.kind, "codex_rollout_pending");
  assert.equal(discovery.listSources()[0].id, "codex-live-fixture");
  const secondRolloutPath = path.join(tmpDir, "rollout-new.jsonl");
  fs.copyFileSync(fixturePath, secondRolloutPath);
  insertStateThread(stateDbPath, "thread-new", secondRolloutPath, 1_752_800_600);
  const autoBound = discovery.listSources()[0];
  assert.equal(autoBound.id, "codex-live-fixture", "pending and bound observations keep one stable dashboard source id");
  assert.equal(autoBound.conversation_id, "thread-new");
  assert.equal(autoBound.live_status, "observing");
  assert.match(autoBound.note, /fixture exact proxy unavailable/);

  console.log("codex rollout capture smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function insertStateThread(filePath, id, rolloutPath, updatedAt) {
  const db = new DatabaseSync(filePath);
  try {
    db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        tokens_used, archived, cli_version, first_user_message, model, thread_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      rolloutPath,
      updatedAt - 1,
      updatedAt,
      "desktop",
      "openai",
      "/tmp/peekmyagent-codex-fixture",
      "New fixture Codex trace",
      128,
      0,
      "0.fixture",
      "new fixture message",
      "gpt-fixture",
      "user",
    );
  } finally {
    db.close();
  }
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

function rolloutRecord(type, payload) {
  return { timestamp: "2026-07-18T01:00:00.000Z", type, payload };
}
