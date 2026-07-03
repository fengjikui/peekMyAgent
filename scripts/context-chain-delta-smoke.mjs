#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-context-chain-"));
const evidenceDir = path.join(tmpDir, "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const watchId = "context-chain-delta";
const conversationId = "context-chain-delta-session";
const parentPrompt = "请启动两个子 Agent 并等待结果";
const childAPrompt = "子任务 A：统计文件";
const childBPrompt = "子任务 B：查看系统";

const captures = [
  capture({
    index: 1,
    messages: [{ role: "user", content: parentPrompt }],
    response: response("msg-parent-spawn", [{ type: "text", text: "开始启动子 Agent。" }], "tool_use"),
  }),
  capture({
    index: 2,
    agentId: "agent-a",
    messages: [{ role: "user", content: childAPrompt }],
    response: response("msg-agent-a-1", [{ type: "text", text: "我需要先读取目录。" }], "tool_use"),
  }),
  capture({
    index: 3,
    agentId: "agent-b",
    messages: [{ role: "user", content: childBPrompt }],
    response: response("msg-agent-b", [{ type: "text", text: "系统信息已获取。" }], "end_turn"),
  }),
  capture({
    index: 4,
    agentId: "agent-a",
    messages: [
      { role: "user", content: childAPrompt },
      { role: "assistant", content: "我需要先读取目录。" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-a", content: "src\nscripts" }] },
    ],
    response: response("msg-agent-a-2", [{ type: "text", text: "目录统计完成。" }], "end_turn"),
  }),
  capture({
    index: 5,
    messages: [
      { role: "user", content: parentPrompt },
      { role: "assistant", content: "开始启动子 Agent。" },
      { role: "user", content: "Agent A 和 Agent B 都已完成。" },
    ],
    response: response("msg-parent-final", [{ type: "text", text: "两个子 Agent 已完成。" }], "end_turn"),
  }),
];

fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(captures, null, 2)}\n`);

const viewer = await startViewerServer({ cwd: process.cwd(), evidencePath: evidenceDir });
try {
  const view = await fetchJson(`${viewer.url}/api/view?source=custom`);
  const byIndex = new Map(view.requests.map((request) => [request.request_index, request]));

  assert.equal(byIndex.get(1).context_delta.baseline, true);
  assert.equal(byIndex.get(2).context_delta.baseline, true);
  assert.equal(byIndex.get(3).context_delta.baseline, true);

  assert.equal(byIndex.get(4).context_delta.previous_request_index, 2);
  assert.match(byIndex.get(4).context_delta.comparison_key, /agent-a$/);
  assert.equal(byIndex.get(4).context_delta.reused_messages, 1);
  assert.equal(byIndex.get(4).context_delta.new_messages, 2);
  assert.equal(byIndex.get(4).summary.history_stack[0].context_status, "reused");

  assert.equal(byIndex.get(5).context_delta.previous_request_index, 1);
  assert.match(byIndex.get(5).context_delta.comparison_key, /^main:/);
  assert.equal(byIndex.get(5).context_delta.reused_messages, 1);
  assert.equal(byIndex.get(5).context_delta.new_messages, 2);
  assert.equal(byIndex.get(5).summary.history_stack[0].context_status, "reused");

  console.log("context-chain-delta smoke passed");
} finally {
  await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function capture({ index, agentId = "", messages, response: captureResponse }) {
  return {
    capture_id: `capture-${index}`,
    watch_id: watchId,
    conversation_id: conversationId,
    request_index: index,
    agent_profile: "Claude Code",
    workspace: tmpDir,
    received_at: new Date(1780001000000 + index * 1000).toISOString(),
    method: "POST",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": "context-chain-session",
      ...(agentId ? { "x-claude-code-agent-id": agentId } : {}),
    },
    body: {
      model: agentId ? "child-model" : "main-model",
      messages,
      tools: [{ name: "Bash" }],
    },
    raw_body_length: JSON.stringify(messages).length,
    upstream_status: 200,
    response: captureResponse,
  };
}

function response(id, content, stopReason) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body_json: {
      id,
      type: "message",
      role: "assistant",
      model: "mock",
      content,
      stop_reason: stopReason,
      usage: { input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 12 },
    },
    raw_body_length: JSON.stringify(content).length,
    captured_body_length: JSON.stringify(content).length,
    duration_ms: 120,
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
