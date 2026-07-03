#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-agent-trace-"));
const evidenceDir = path.join(tmpDir, "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

const watchId = "agent-trace-view-smoke";
const conversationId = "agent-trace-view-smoke-session";

const parentPrompt = "Inspect this project with three parallel Explore subagents.";
const spawnCalls = [
  agentCall("call_agent_a", "Inspect trace viewer", "src/trace-viewer.js"),
  agentCall("call_agent_b", "Inspect agent flow", "src/agent-flow.js"),
  agentCall("call_agent_c", "Inspect notes", "docs/agent-trace-notes.md"),
];
const captures = [
  capture({
    index: 1,
    messages: [{ role: "user", content: parentPrompt }],
    response: messageResponse({ id: "msg_parent_spawn", content: [{ type: "text", text: "Launching subagents." }, ...spawnCalls], stop_reason: "tool_use" }),
  }),
  childCapture({
    index: 2,
    agentId: "agent-a",
    prompt: "Read trace viewer.",
    response: messageResponse({ id: "msg_a_read", content: [toolUse("read_a", "Read", { file_path: "src/trace-viewer.js" })], stop_reason: "tool_use" }),
  }),
  childCapture({
    index: 3,
    agentId: "agent-a",
    prompt: "Read trace viewer.",
    messages: [
      { role: "assistant", content: [toolUse("read_a", "Read", { file_path: "src/trace-viewer.js" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read_a", content: "trace viewer source" }] },
    ],
    response: messageResponse({ id: "msg_a_done", content: [{ type: "text", text: "Trace viewer summary." }], stop_reason: "end_turn" }),
  }),
  childCapture({
    index: 4,
    agentId: "agent-b",
    prompt: "Read agent flow.",
    response: messageResponse({
      id: "msg_b_read",
      content: [toolUse("read_b1", "Read", { file_path: "src/agent-flow.js" }), toolUse("read_b2", "Read", { file_path: "docs/agent-trace-notes.md" })],
      stop_reason: "tool_use",
    }),
  }),
  childCapture({
    index: 5,
    agentId: "agent-b",
    prompt: "Read agent flow.",
    messages: [
      { role: "assistant", content: [toolUse("read_b1", "Read", { file_path: "src/agent-flow.js" }), toolUse("read_b2", "Read", { file_path: "docs/agent-trace-notes.md" })] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "read_b1", content: "agent flow source" },
          { type: "tool_result", tool_use_id: "read_b2", content: "notes source" },
        ],
      },
    ],
    response: messageResponse({ id: "msg_b_done", content: [{ type: "text", text: "Agent flow summary." }], stop_reason: "end_turn" }),
  }),
  childCapture({
    index: 6,
    agentId: "agent-c",
    prompt: "Read notes.",
    response: messageResponse({ id: "msg_c_read", content: [toolUse("read_c", "Read", { file_path: "docs/agent-trace-notes.md" })], stop_reason: "tool_use" }),
  }),
  childCapture({
    index: 7,
    agentId: "agent-c",
    prompt: "Read notes.",
    messages: [
      { role: "assistant", content: [toolUse("read_c", "Read", { file_path: "docs/agent-trace-notes.md" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read_c", content: "notes source" }] },
    ],
    response: messageResponse({ id: "msg_c_done", content: [{ type: "text", text: "Notes summary." }], stop_reason: "end_turn" }),
  }),
  capture({
    index: 8,
    messages: [
      { role: "user", content: parentPrompt },
      { role: "assistant", content: spawnCalls },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_agent_a", content: [{ type: "text", text: "Trace viewer summary." }] },
          { type: "tool_result", tool_use_id: "call_agent_b", content: [{ type: "text", text: "Agent flow summary." }] },
          { type: "tool_result", tool_use_id: "call_agent_c", content: [{ type: "text", text: "Notes summary." }] },
        ],
      },
    ],
    response: messageResponse({ id: "msg_parent_final", content: [{ type: "text", text: "All subagents returned." }], stop_reason: "end_turn" }),
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
      { source: "agent:builtin:Explore" },
      { source: "agent:builtin:Explore" },
      { source: "agent:builtin:Explore" },
      { source: "agent:builtin:Explore" },
      { source: "sdk" },
    ],
    null,
    2,
  )}\n`,
);

const viewer = await startViewerServer({ cwd: process.cwd(), evidencePath: evidenceDir });
try {
  const view = await fetchJson(`${viewer.url}/api/view?source=custom`);
  assert.equal(view.stats.request_count, 8);
  assert.equal(view.stats.subagent_count, 6);
  assert.equal(view.stats.subagent_instance_count, 3);
  assert.equal(view.agent_trace.branch_count, 3);
  assert.equal(view.agent_trace.spawn_count, 3);
  assert.equal(view.agent_trace.return_count, 3);
  assert.deepEqual(
    view.agent_trace.branches.map((branch) => branch.request_indexes),
    [
      [2, 3],
      [4, 5],
      [6, 7],
    ],
  );
  assert.deepEqual(
    view.agent_trace.branches.map((branch) => branch.status),
    ["returned", "returned", "returned"],
  );
  assert.equal(view.agent_trace.branches[0].steps[0].response_tool_calls[0].id, "read_a");
  assert.equal(view.agent_trace.branches[0].steps[1].request_tool_results[0].id, "read_a");
  assert.equal(view.agent_trace.branches[2].return.spawn_id, "call_agent_c");
  assert.deepEqual(
    view.requests.filter((request) => request.trace?.claude_agent_id).map((request) => request.trace?.agent_branch?.index),
    [1, 1, 2, 2, 3, 3],
  );
  assert.deepEqual(
    view.requests.filter((request) => request.trace?.claude_agent_id).map((request) => request.trace?.agent_branch?.id),
    ["branch-1-agent-a", "branch-1-agent-a", "branch-2-agent-b", "branch-2-agent-b", "branch-3-agent-c", "branch-3-agent-c"],
  );
  assert.ok(view.turns.some((turn) => turn.agent_branch_count === 3));
  console.log("agent-trace-view smoke passed");
} finally {
  await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function agentCall(id, description, filePath) {
  return toolUse(id, "Agent", {
    description,
    prompt: `Please inspect ${filePath}.`,
    subagent_type: "Explore",
  });
}

function childCapture({ index, agentId, prompt, messages = [], response }) {
  return capture({
    index,
    headers: { "x-claude-code-agent-id": agentId },
    messages: [{ role: "user", content: prompt }, ...messages],
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
      "x-claude-code-session-id": "session-smoke",
      ...headers,
    },
    body: {
      model: headers["x-claude-code-agent-id"] ? "deepseek-v4-flash" : "deepseek-v4-pro",
      messages,
      tools: Array.from({ length: headers["x-claude-code-agent-id"] ? 17 : 27 }, (_, toolIndex) => ({ name: `tool_${toolIndex + 1}` })),
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
  const body = {
    id,
    type: "message",
    role: "assistant",
    model: "deepseek-v4-pro",
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 3 },
  };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body_json: body,
    body_text: JSON.stringify(body),
    raw_body_length: JSON.stringify(body).length,
    captured_body_length: JSON.stringify(body).length,
    received_at: new Date().toISOString(),
    duration_ms: 42,
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
