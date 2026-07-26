#!/usr/bin/env node
import assert from "node:assert/strict";
import { annotateRequestContextChanges, createContextDeltaState, requestContextChainKey } from "../src/trace/context-delta.mjs";

const user = (text) => ({ role: "user", content: text });
const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } }] };
const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }] };
const requests = [
  request(1, [user("hello")], { responseToolCalls: [{ id: "call-1", name: "Bash", arguments: { command: "pwd" } }] }),
  request(2, [user("hello"), toolUse, toolResult]),
  request(3, [user("child task")], { agentId: "agent-a" }),
  request(4, [user("child task"), { role: "assistant", content: "done" }], { agentId: "agent-a" }),
];

const semantics = {
  extractToolCalls(messages) {
    return messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "tool_use");
  },
  extractToolResults(messages) {
    return messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "tool_result")
      .map((part) => ({ id: part.tool_use_id, content: part.content }));
  },
  classifyMessage(message) {
    if (Array.isArray(message.content) && message.content.some((part) => part.type === "tool_use")) return "tool_use";
    if (Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result")) return "tool_result";
    return "message";
  },
  previewMessage: (message) => ({ role: message.role, kind: "message", text: String(message.content) }),
  previewText: (value, limit) => String(value || "").slice(0, limit),
  isInternalRequest: (item) => ["metadata", "background"].includes(item.source_hint?.type),
  responseToolCalls: (item) => item.summary.response?.tool_calls || [],
  isRealUserMessage: (message) => message.role === "user" && !Array.isArray(message.content),
};

annotateRequestContextChanges(requests, semantics);
assert.equal(requests[0].context_delta.baseline, true);
assert.equal(requests[0].summary.current_tool_calls.length, 0, "downstream response calls are not upstream context events");
assert.equal(requests[0].summary.response.tool_calls.length, 1);
assert.equal(requests[1].context_delta.previous_request_index, 1);
assert.equal(requests[1].context_delta.reused_messages, 1);
assert.equal(requests[1].context_delta.new_messages, 2);
assert.equal(requests[1].context_delta.new_tool_calls, 1);
assert.equal(requests[1].context_delta.new_tool_results, 1);
assert.equal(requests[1].summary.current_tool_calls.length, 0, "the previous model response call is not repeated as new upstream data");
assert.equal(requests[1].summary.current_tool_results[0].id, "call-1");
assert.equal(requests[2].context_delta.baseline, true, "child context starts with its own baseline");
assert.equal(requests[3].context_delta.previous_request_index, 3);
assert.equal(requests[3].context_delta.reused_messages, 1);
assert.equal(requestContextChainKey(requests[2]), "agent:conversation-1:agent-a");
assert.equal(requests[1].summary.history_stack[0].context_status, "reused");
assert.equal(requests[1].summary.history_stack[1].context_status, "new");

const changingLeadingContext = [
  request(1, [
    { role: "system", content: "stable instructions with skill path ~/.agents/skills/example" },
    user("first question"),
  ]),
  request(2, [
    { role: "system", content: "stable instructions with skill path ~/.claude/skills/example" },
    user("first question"),
    { role: "assistant", content: "first answer" },
    user("second question"),
  ]),
];
changingLeadingContext[0].fingerprints.system = "system-agents";
changingLeadingContext[1].fingerprints.system = "system-claude";
annotateRequestContextChanges(changingLeadingContext, semantics);
assert.equal(changingLeadingContext[1].context_delta.reused_messages, 2);
assert.equal(changingLeadingContext[1].context_delta.new_messages, 2);
assert.deepEqual(changingLeadingContext[1].context_delta.new_roles, { assistant: 1, user: 1 });
assert.equal(changingLeadingContext[1].context_delta.new_tool_calls, 0);
assert.equal(changingLeadingContext[1].context_delta.new_tool_results, 0);
assert.equal(changingLeadingContext[1].context_delta.fixed_context.system, "changed");
assert.equal(changingLeadingContext[1].summary.current_tool_calls.length, 0);
assert.equal(changingLeadingContext[1].summary.current_tool_results.length, 0);

const pagedRequests = [
  request(1, [user("hello")], { responseToolCalls: [{ id: "call-1", name: "Bash", arguments: { command: "pwd" } }] }),
  request(2, [user("hello"), toolUse, toolResult]),
  request(3, [user("child task")], { agentId: "agent-a" }),
  request(4, [user("child task"), { role: "assistant", content: "done" }], { agentId: "agent-a" }),
];
const pagedState = createContextDeltaState();
annotateRequestContextChanges(pagedRequests.slice(0, 3), semantics, { state: pagedState });
annotateRequestContextChanges(pagedRequests.slice(3), semantics, { state: pagedState });
assert.deepEqual(
  pagedRequests.map(contextSnapshot),
  requests.map(contextSnapshot),
  "shared context state must make paged annotation equivalent to one-pass annotation",
);
assert.equal(pagedState.previousByContextKey.size, 2, "state retains only the latest request for each main/subagent context chain");
assert.throws(
  () => annotateRequestContextChanges([], semantics, { state: { previousByContextKey: {} } }),
  /previousByContextKey must be a Map/,
);

const backgroundInterleaving = [
  request(37, [user("main prompt"), toolUse, toolResult, user("continue")]),
  request(38, [user("Analyze this rollout"), toolUse, toolResult], {
    sourceType: "background",
    operation: "codex_memory_extraction",
  }),
  request(39, [user("main prompt"), toolUse, toolResult, user("continue"), { role: "assistant", content: "done" }, user("next")]),
];
annotateRequestContextChanges(backgroundInterleaving, semantics);
assert.equal(backgroundInterleaving[1].context_delta.baseline, true, "background memory extraction owns an independent baseline");
assert.equal(backgroundInterleaving[2].context_delta.previous_request_index, 37, "the next main request skips an interleaved background task");
assert.equal(backgroundInterleaving[2].trace.previous_context_request_index, 37);
assert.equal(backgroundInterleaving[2].context_delta.new_tool_calls, 0, "historical tool calls do not become current activity after a background task");
assert.equal(backgroundInterleaving[2].context_delta.new_tool_results, 0, "historical tool results do not become current activity after a background task");
assert.equal(requestContextChainKey(backgroundInterleaving[1]), "side:conversation-1:codex_memory_extraction");

console.log("context delta contract smoke passed");

function request(index, messages, { agentId = "", responseToolCalls = [], sourceType = "", operation = "" } = {}) {
  const type = sourceType || (agentId ? "subagent" : "main");
  return {
    id: `request-${index}`,
    request_index: index,
    watch_id: "watch-1",
    conversation_id: "conversation-1",
    source_hint: { type, ...(operation ? { operation } : {}) },
    trace: { actor_type: agentId ? "child" : type === "background" ? "side" : "main", claude_agent_id: agentId },
    raw: { body: { messages } },
    fingerprints: { system: "system", tools: "tools", params: "params" },
    counts: { messages: messages.length, tools: 1, raw_body_bytes: index * 100 },
    summary: {
      tool_calls: [],
      tool_results: [],
      response: { tool_calls: responseToolCalls },
      history_stack: messages.map((message, messageIndex) => ({ index: messageIndex + 1, role: message.role })),
    },
  };
}

function contextSnapshot(item) {
  return {
    request_index: item.request_index,
    changes: item.changes,
    context_delta: item.context_delta,
    current_tool_calls: item.summary.current_tool_calls,
    current_tool_results: item.summary.current_tool_results,
  };
}
