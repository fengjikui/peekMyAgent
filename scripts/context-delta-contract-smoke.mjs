#!/usr/bin/env node
import assert from "node:assert/strict";
import { annotateRequestContextChanges, createContextDeltaState, requestContextChainKey } from "../src/trace/context-delta.mjs";

const user = (text) => ({ role: "user", content: text });
const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } }] };
const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }] };
const requests = [
  request(1, [user("hello")]),
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
  isInternalRequest: () => false,
  isRealUserMessage: (message) => message.role === "user" && !Array.isArray(message.content),
};

annotateRequestContextChanges(requests, semantics);
assert.equal(requests[0].context_delta.baseline, true);
assert.equal(requests[1].context_delta.previous_request_index, 1);
assert.equal(requests[1].context_delta.reused_messages, 1);
assert.equal(requests[1].context_delta.new_messages, 2);
assert.equal(requests[1].context_delta.new_tool_calls, 1);
assert.equal(requests[1].context_delta.new_tool_results, 1);
assert.equal(requests[1].summary.current_tool_calls.length, 1);
assert.equal(requests[1].summary.current_tool_results[0].id, "call-1");
assert.equal(requests[2].context_delta.baseline, true, "child context starts with its own baseline");
assert.equal(requests[3].context_delta.previous_request_index, 3);
assert.equal(requests[3].context_delta.reused_messages, 1);
assert.equal(requestContextChainKey(requests[2]), "agent:conversation-1:agent-a");
assert.equal(requests[1].summary.history_stack[0].context_status, "reused");
assert.equal(requests[1].summary.history_stack[1].context_status, "new");

const pagedRequests = [
  request(1, [user("hello")]),
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

console.log("context delta contract smoke passed");

function request(index, messages, { agentId = "" } = {}) {
  return {
    id: `request-${index}`,
    request_index: index,
    watch_id: "watch-1",
    conversation_id: "conversation-1",
    source_hint: { type: agentId ? "subagent" : "main" },
    trace: { actor_type: agentId ? "child" : "main", claude_agent_id: agentId },
    raw: { body: { messages } },
    fingerprints: { system: "system", tools: "tools", params: "params" },
    counts: { messages: messages.length, tools: 1, raw_body_bytes: index * 100 },
    summary: {
      tool_calls: [],
      tool_results: [],
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
