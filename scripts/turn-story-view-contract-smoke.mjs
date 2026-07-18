#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildTurnStoryView } from "../src/viewer/turn-story-model.js";
import { renderTurnStory } from "../src/viewer/turn-story-renderer.js";

const translate = (key, values = {}) =>
  `${key}${Object.keys(values).length ? `:${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")}` : ""}`;
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const toolTurn = { id: "turn-tool", request_ids: ["request-1", "request-2"] };
const toolRequests = [
  request("request-1", 1, {
    entry: { kind: "user_input", text: "inspect disk" },
    response: response({
      finishReason: "tool_use",
      text: "checking",
      toolCalls: [
        {
          id: "call-disk",
          name: "exec",
          semantic: { kind: "nested_tool_dispatch", nested_tool_names: ["exec_command"] },
        },
      ],
    }),
  }),
  request("request-2", 2, {
    entry: { kind: "tool_result" },
    toolResults: [{ id: "call-disk", content: "50% free" }],
    response: response({ text: "disk has space" }),
  }),
];
const toolView = buildTurnStoryView({ turn: toolTurn, requests: toolRequests, translate });
assert.deepEqual(
  toolView.steps.map((step) => [step.kind, step.label, step.requestIndex]),
  [
    ["user", "turnStoryUserRequest", 1],
    ["tool-call", "turnStoryCallTool:tool=exec_command", 1],
    ["tool-result", "turnStoryToolResult:tool=exec_command", 2],
    ["answer", "turnStoryFinalAnswer", 2],
  ],
);

const skillRequests = [
  request("skill-1", 6, {
    entry: { kind: "user_input" },
    response: response({
      finishReason: "tool_use",
      toolCalls: [
        {
          id: "call-skill",
          name: "exec",
          semantic: { kind: "skill_instruction_read", skill_name: "using-superpowers", nested_tool_names: ["exec_command"] },
        },
      ],
    }),
  }),
  request("skill-2", 7, {
    entry: { kind: "tool_result" },
    toolResults: [{ id: "call-skill" }],
    response: response({ text: "loaded" }),
  }),
];
const skillView = buildTurnStoryView({ turn: { id: "turn-skill" }, requests: skillRequests, translate });
assert.deepEqual(skillView.steps.map((step) => step.label), [
  "turnStoryUserRequest",
  "skillInstructionReadObserved:skill=using-superpowers",
  "turnStorySkillResult:skill=using-superpowers",
  "turnStoryFinalAnswer",
]);

const agentRequests = [
  request("agent-1", 11, { entry: { kind: "user_input" }, response: response({ finishReason: "tool_use" }) }),
  request("agent-2", 12, {
    entry: { kind: "tool_result" },
    response: response({ finishReason: "tool_use", toolCalls: [{ id: "spawn-a", name: "spawn_agent" }] }),
  }),
  request("agent-3", 13, {
    entry: { kind: "tool_result" },
    toolResults: [{ id: "spawn-a" }],
    response: response({ finishReason: "tool_use", toolCalls: [{ id: "wait-a", name: "wait_agent" }] }),
  }),
  request("agent-4", 14, {
    entry: { kind: "subagent_result" },
    toolResults: [{ id: "wait-a" }],
    response: response({ text: "done" }),
  }),
];
const agentTrace = {
  branches: [
    {
      id: "branch-a",
      spawn: { id: "spawn-a", parent_request_id: "agent-2", parent_request_index: 12 },
      launch: { parent_request_id: "agent-3", parent_request_index: 13 },
      return: { parent_request_id: "agent-4", parent_request_index: 14 },
    },
  ],
};
const agentView = buildTurnStoryView({
  turn: { id: "turn-agent", agent_branches: ["branch-a"] },
  requests: agentRequests,
  agentTrace,
  translate,
});
assert.deepEqual(agentView.steps.map((step) => step.label), [
  "turnStoryUserRequest",
  "turnStorySpawnAgents:count=1",
  "turnStoryAgentLaunches:count=1,total=1",
  "turnStoryAgentReturns:count=1,total=1",
  "turnStoryFinalAnswer",
]);
assert.equal(agentView.steps.some((step) => /spawn_agent|wait_agent/.test(step.label)), false);

const compactView = buildTurnStoryView({
  turn: { id: "turn-compact" },
  requests: [
    request("compact-1", 20, { entry: { kind: "user_input" }, response: response({ text: "I will compact" }) }),
    request("compact-2", 21, {
      entry: { kind: "compact", semantic_event: { type: "context_compacted" } },
      response: response({ captured: false }),
    }),
  ],
  translate,
});
assert.deepEqual(compactView.steps.map((step) => step.label), [
  "turnStoryUserRequest",
  "turnStoryFinalAnswer",
  "turnStoryContextCompacted",
]);

assert.equal(
  buildTurnStoryView({
    turn: { id: "turn-trivial" },
    requests: [request("trivial", 1, { entry: { kind: "user_input" }, response: response({ text: "hello" }) })],
    translate,
  }),
  null,
  "a simple one-request exchange should not gain decorative mechanism UI",
);
assert.equal(
  buildTurnStoryView({
    turn: { id: "turn-trivial-with-internal-request" },
    requests: [
      request("trivial-user", 1, { entry: { kind: "user_input" }, response: response({ text: "hello" }) }),
      request("trivial-internal", 2, { entry: { kind: "internal" }, response: response({ captured: false }) }),
    ],
    translate,
  }),
  null,
  "hidden Harness requests must not make a simple exchange look like a mechanism flow",
);

const html = renderTurnStory(
  { turnId: "turn-unsafe", steps: [{ kind: "tool-call", label: "Call <unsafe>", requestId: 'request-"1', requestIndex: 1 }] },
  { translate, escapeHtml },
);
assert.match(html, /turnStoryAria/);
assert.match(html, /data-request-jump="request-&quot;1"/);
assert.match(html, /Call &lt;unsafe&gt;/);
assert.match(html, /turn-story-segment/);
assert.doesNotMatch(html, /data-agent-jump/);

for (const file of ["turn-story-model.js", "turn-story-renderer.js"]) {
  const source = fs.readFileSync(new URL(`../src/viewer/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /agent_profile|provider|Claude|Codex|OpenClaw/, `${file} must stay Harness-neutral`);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./, `${file} must stay pure`);
}

console.log("turn story view contract smoke passed");

function request(id, requestIndex, { entry, response: responseValue, toolResults = [] }) {
  return {
    id,
    request_index: requestIndex,
    summary: {
      entry,
      response: responseValue,
      current_tool_results: toolResults,
    },
  };
}

function response({ captured = true, finishReason = "end_turn", text = "", toolCalls = [] } = {}) {
  return {
    captured,
    finish_reason: finishReason,
    text,
    tool_calls: toolCalls,
  };
}
