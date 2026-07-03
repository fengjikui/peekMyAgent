#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const strict = process.argv.includes("--strict");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-timeline-display-"));
const evidenceDir = path.join(tmpDir, "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const watchId = "timeline-display-invariants";
const conversationId = "timeline-display-invariants-session";
const parentPrompt = "请演示两个子agent调用";
const secondPrompt = "hello";
const spawnCalls = [
  agentCall("call_agent_a", "统计项目文件数量"),
  agentCall("call_agent_b", "分析磁盘使用情况"),
];

const captures = [
  capture({
    index: 1,
    messages: [{ role: "user", content: parentPrompt }],
    response: messageResponse({
      id: "msg_parent_spawn",
      content: [{ type: "text", text: "我会启动两个子 Agent。" }, ...spawnCalls],
      stop_reason: "tool_use",
    }),
  }),
  childCapture({
    index: 2,
    agentId: "agent-a",
    prompt: "子任务 A：统计项目文件数量",
    response: messageResponse({ id: "msg_a_done", content: [{ type: "text", text: "项目有 128 个文件。" }], stop_reason: "end_turn" }),
  }),
  childCapture({
    index: 3,
    agentId: "agent-b",
    prompt: "子任务 B：分析磁盘使用情况",
    response: messageResponse({ id: "msg_b_done", content: [{ type: "text", text: "磁盘可用空间充足。" }], stop_reason: "end_turn" }),
  }),
  capture({
    index: 4,
    messages: [
      { role: "user", content: parentPrompt },
      { role: "assistant", content: spawnCalls },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_agent_a", content: [{ type: "text", text: "项目有 128 个文件。" }] },
          { type: "tool_result", tool_use_id: "call_agent_b", content: [{ type: "text", text: "磁盘可用空间充足。" }] },
        ],
      },
    ],
    response: messageResponse({
      id: "msg_parent_final",
      content: [{ type: "text", text: "两个子 Agent 已完成。" }],
      stop_reason: "end_turn",
    }),
  }),
  capture({
    index: 5,
    messages: [
      { role: "user", content: parentPrompt },
      { role: "assistant", content: [{ type: "text", text: "两个子 Agent 已完成。" }] },
      { role: "user", content: secondPrompt },
    ],
    response: messageResponse({
      id: "msg_second",
      content: [{ type: "text", text: "你好！" }],
      stop_reason: "end_turn",
    }),
  }),
];

fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(captures, null, 2)}\n`);
fs.writeFileSync(
  path.join(evidenceDir, "debug-api-sources.json"),
  `${JSON.stringify(
    [
      { source: "sdk" },
      { source: "agent:builtin:Explore" },
      { source: "agent:builtin:Explore" },
      { source: "sdk" },
      { source: "sdk" },
    ],
    null,
    2,
  )}\n`,
);

const viewer = await startViewerServer({ cwd: process.cwd(), evidencePath: evidenceDir });
try {
  const view = await fetchJson(`${viewer.url}/api/view?source=custom`);
  const report = buildReport(view);
  console.log(JSON.stringify(report, null, 2));
  if (strict && report.violations.length) process.exitCode = 1;
} finally {
  await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function buildReport(view) {
  const branchTurns = view.turns.filter((turn) => (turn.agent_branch_count || 0) > 0);
  const realUserTurns = view.turns.filter((turn) => clean(turn.user_input));
  const secondTurn = view.turns.find((turn) => clean(turn.user_input) === secondPrompt);
  const subagentRequests = view.requests.filter((request) => request.is_subagent);
  const subagentTurnIds = new Set(subagentRequests.map((request) => request.turn_id));
  const violations = [];

  if (view.agent_trace?.branch_count !== 2) violations.push(`expected 2 agent branches, got ${view.agent_trace?.branch_count ?? "missing"}`);
  if (branchTurns.length !== 1) violations.push(`agent branch board should attach to exactly 1 user task turn, got ${branchTurns.length}`);
  if (!secondTurn) violations.push("second user input 'hello' is not preserved as its own turn");
  if (secondTurn?.agent_branch_count) violations.push("second plain user turn unexpectedly contains agent branch board");
  if (realUserTurns.length !== 2) violations.push(`expected 2 real user turns, got ${realUserTurns.length}`);
  if (subagentTurnIds.size > 1 || [...subagentTurnIds][0] !== branchTurns[0]?.id) {
    violations.push(`subagent requests should stay under parent task turn, got turn ids: ${[...subagentTurnIds].join(", ") || "none"}`);
  }

  return {
    source: "synthetic two-subagent flow followed by plain user input",
    request_count: view.requests.length,
    agent_trace: {
      branches: view.agent_trace?.branch_count || 0,
      spawns: view.agent_trace?.spawn_count || 0,
      returns: view.agent_trace?.return_count || 0,
      confidence: view.agent_trace?.confidence || null,
    },
    turns: view.turns.map((turn) => ({
      id: turn.id,
      input: clean(turn.user_input),
      request_indexes: turn.request_indexes,
      agent_branch_count: turn.agent_branch_count || 0,
      subagent_count: turn.subagent_count || 0,
      internal_request_count: turn.internal_request_count || 0,
    })),
    subagent_requests: subagentRequests.map((request) => ({
      index: request.request_index,
      turn_id: request.turn_id,
      current_user: clean(request.summary?.current_user),
      branch_index: request.trace?.agent_branch?.index || null,
    })),
    violations,
  };
}

function clean(value) {
  return String(value || "").trim();
}

function agentCall(id, description) {
  return toolUse(id, "Agent", {
    description,
    prompt: `请完成：${description}`,
    subagent_type: "Explore",
  });
}

function childCapture({ index, agentId, prompt, response }) {
  return capture({
    index,
    headers: { "x-claude-code-agent-id": agentId },
    messages: [{ role: "user", content: prompt }],
    response,
  });
}

function capture({ index, headers = {}, messages, response }) {
  return {
    capture_id: `capture-${index}`,
    watch_id: watchId,
    request_index: index,
    agent_profile: "Claude Code",
    workspace: tmpDir,
    conversation_id: conversationId,
    received_at: new Date(1780000000000 + index * 1000).toISOString(),
    method: "POST",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": "timeline-display-session",
      ...headers,
    },
    body: {
      model: headers["x-claude-code-agent-id"] ? "deepseek-v4-flash" : "deepseek-v4-pro",
      messages,
      tools: Array.from({ length: headers["x-claude-code-agent-id"] ? 8 : 16 }, (_, toolIndex) => ({ name: `tool_${toolIndex + 1}` })),
    },
    raw_body_length: JSON.stringify(messages).length,
    upstream_status: 200,
    response,
  };
}

function toolUse(id, name, input) {
  return { type: "tool_use", id, name, input };
}

function messageResponse({ id, content, stop_reason }) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body_json: {
      id,
      type: "message",
      role: "assistant",
      model: "deepseek-v4-pro",
      content,
      stop_reason,
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
