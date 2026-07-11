#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-internal-turn-"));
const evidenceDir = path.join(tmpDir, "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const prompt = "演示一下工具的调用。";
const captures = [
  capture({
    index: 1,
    messages: [{ role: "user", content: "hello Write the title in 简体中文. Keep technical terms and code identifiers in their original form." }],
    response: messageResponse({ id: "msg_hello", content: [{ type: "text", text: "你好！" }], stop_reason: "end_turn" }),
  }),
  capture({
    index: 2,
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: `<session>\n${prompt}\n</session>` }] }],
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session.\nReturn JSON with a single \"title\" field." },
    ],
    tools: [],
    output_config: { format: { type: "json_schema", schema: { type: "object", properties: { title: { type: "string" } } } } },
    response: errorResponse(),
  }),
  capture({
    index: 3,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "你好！" }] },
      { role: "user", content: prompt },
    ],
    response: messageResponse({
      id: "msg_tool_use",
      content: [{ type: "text", text: "我来演示 WebSearch。" }, toolUse("call_search", "WebSearch", { query: "Claude Code CLI tool features 2026" })],
      stop_reason: "tool_use",
    }),
  }),
  capture({
    index: 4,
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Perform a web search for the query: Claude Code CLI tool features 2026" }],
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "You are an assistant for performing a web search tool use" },
    ],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    tool_choice: { type: "tool", name: "web_search" },
    response: errorResponse(),
  }),
  capture({
    index: 5,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "你好！" }] },
      { role: "user", content: prompt },
      { role: "assistant", content: [{ type: "text", text: "我来演示 WebSearch。" }, toolUse("call_search", "WebSearch", { query: "Claude Code CLI tool features 2026" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_search", content: "API Error: web_search unavailable" }] },
    ],
    response: messageResponse({ id: "msg_final", content: [{ type: "text", text: "WebSearch 工具不可用，已捕获错误。" }], stop_reason: "end_turn" }),
  }),
  capture({
    index: 6,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "你好！" }] },
      { role: "user", content: prompt },
      { role: "assistant", content: [{ type: "text", text: "WebSearch 工具不可用，已捕获错误。" }] },
      {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: /tmp/skills/example\n\n# Example Skill\nUse this harness-provided workflow." }],
      },
    ],
    response: messageResponse({ id: "msg_skill", content: [{ type: "text", text: "Skill 已加载。" }], stop_reason: "end_turn" }),
  }),
];

fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(captures, null, 2)}\n`);

const viewer = await startViewerServer({ cwd: process.cwd(), evidencePath: evidenceDir });
try {
  const view = await fetchJson(`${viewer.url}/api/view?source=custom`);
  assert.equal(view.requests[1].source_hint.type, "metadata");
  assert.equal(view.requests[1].source_hint.label, "生成会话标题");
  assert.equal(view.requests[3].source_hint.type, "metadata");
  assert.equal(view.requests[3].source_hint.label, "WebSearch 内部请求");
  assert.equal(view.requests[5].summary.entry.kind, "harness_injection");
  assert.equal(view.requests[5].summary.entry.label, "Skill / Harness 注入");
  assert.deepEqual(
    view.turns.map((turn) => ({ input: turn.user_input, indexes: turn.request_indexes })),
    [
      { input: "hello", indexes: [1] },
      { input: prompt, indexes: [2, 3, 4, 5, 6] },
    ],
  );
  assert.equal(view.turns.some((turn) => turn.user_input.startsWith("Perform a web search")), false);
  assert.equal(view.turns.some((turn) => turn.user_input.startsWith("Base directory for this skill")), false);
  console.log("claude internal request turn smoke passed");
} finally {
  await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function capture({ index, model = "deepseek-v4-pro", messages, system = [], tools = [], tool_choice = undefined, output_config = undefined, response }) {
  const body = {
    model,
    messages,
    system,
    tools,
    metadata: { user_id: "internal-request-turn-smoke" },
    max_tokens: 32000,
    thinking: { type: model.includes("flash") ? "disabled" : "enabled" },
    stream: true,
  };
  if (tool_choice) body.tool_choice = tool_choice;
  if (output_config) body.output_config = output_config;
  return {
    capture_id: `capture-${index}`,
    watch_id: "internal-request-turn-smoke",
    request_index: index,
    agent_profile: "Claude Code",
    workspace: tmpDir,
    conversation_id: "internal-request-turn-smoke-session",
    received_at: new Date(1780000000000 + index * 1000).toISOString(),
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json", "x-claude-code-session-id": "internal-request-turn-smoke-session" },
    body,
    raw_body_length: JSON.stringify(body).length,
    upstream_status: response.status,
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
    body_json: { id, type: "message", role: "assistant", model: "deepseek-v4-pro", content, stop_reason, usage: { input_tokens: 100, output_tokens: 10 } },
    raw_body_length: JSON.stringify(content).length,
    captured_body_length: JSON.stringify(content).length,
    duration_ms: 100,
  };
}

function errorResponse() {
  return {
    status: 400,
    headers: { "content-type": "application/json" },
    body_json: { error: { message: "thinking options type cannot be disabled when reasoning_effort is set", type: "invalid_request_error" } },
    body_text: JSON.stringify({ error: { message: "thinking options type cannot be disabled when reasoning_effort is set", type: "invalid_request_error" } }),
    raw_body_length: 120,
    captured_body_length: 120,
    duration_ms: 20,
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
