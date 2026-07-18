#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildTurnTimeline } from "../src/trace/turn-timeline.mjs";

const requests = [
  request(1, "first question", "main", { new_messages: 1 }, { responseToolCalls: [{ id: "call-1" }] }),
  request(2, "child task", "subagent", { new_messages: 2, new_tool_calls: 1 }, { currentToolCalls: [{ id: "call-1" }] }),
  request(3, "first question", "main", { new_messages: 1, new_tool_results: 1 }),
  request(4, "second question", "main", { new_messages: 1 }),
];
const semantics = {
  normalizeUserKey: (text) => String(text || "").trim(),
  isInternalRequest: (requestItem) => requestItem.source_hint.type === "subagent",
  titleFor: (text) => text || "untitled",
  cleanUserText: (text) => String(text || "").trim(),
  previewText: (text, limit) => String(text || "").slice(0, limit),
  responseToolCalls: (requestItem) => requestItem.summary.response?.tool_calls || [],
};

const turns = buildTurnTimeline(requests, semantics);
assert.equal(turns.length, 2);
assert.deepEqual(turns[0].request_indexes, [1, 2, 3]);
assert.equal(turns[0].main_request_count, 2);
assert.equal(turns[0].internal_request_count, 1);
assert.equal(turns[0].subagent_count, 1);
assert.equal(turns[0].tool_call_count, 1);
assert.equal(turns[0].tool_result_count, 1);
assert.equal(turns[0].context_delta.new_messages, 4);
assert.equal(turns[0].has_internal_requests, true);
assert.equal(turns[0].has_tool_exchange, true);
assert.deepEqual(turns[1].request_indexes, [4]);
assert.equal(requests[1].turn_id, "turn-1");
assert.equal(requests[3].turn_id, "turn-2");

console.log("turn timeline contract smoke passed");

function request(index, currentUser, type, delta, { currentToolCalls = null, responseToolCalls = [] } = {}) {
  return {
    id: `request-${index}`,
    request_index: index,
    captured_at: `2026-07-12T00:00:0${index}.000Z`,
    source_hint: { type },
    is_subagent: type === "subagent",
    counts: { raw_body_bytes: 100 },
    context_delta: { new_roles: {}, new_tool_calls: 0, new_tool_results: 0, ...delta },
    summary: {
      current_user: currentUser,
      current_tool_calls: currentToolCalls || (delta.new_tool_calls ? [{}] : []),
      current_tool_results: delta.new_tool_results ? [{}] : [],
      response: { tool_calls: responseToolCalls },
    },
  };
}
