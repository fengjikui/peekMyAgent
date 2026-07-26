#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildTurnTimeline } from "../src/trace/turn-timeline.mjs";

const requests = [
  request(1, "first question", "main", { new_messages: 1 }, { responseToolCalls: [{ id: "call-1" }] }),
  request(2, "child task", "subagent", { new_messages: 2, new_tool_calls: 1 }, { currentToolCalls: [{ id: "call-1" }] }),
  request(20, "first question", "background", { new_messages: 1 }),
  request(3, "first question", "main", { new_messages: 1, new_tool_results: 1 }),
  request(4, "second question", "main", { new_messages: 1 }),
];
const semantics = {
  normalizeUserKey: (text) => String(text || "").trim(),
  isInternalRequest: (requestItem) => requestItem.source_hint.type === "subagent",
  isIndependentRequest: (requestItem) => requestItem.source_hint.relation === "independent",
  titleFor: (text) => text || "untitled",
  cleanUserText: (text) => String(text || "").trim(),
  previewText: (text, limit) => String(text || "").slice(0, limit),
  responseToolCalls: (requestItem) => requestItem.summary.response?.tool_calls || [],
};

const turns = buildTurnTimeline(requests, semantics);
assert.equal(turns.length, 3);
assert.deepEqual(turns[0].request_indexes, [1, 2, 3]);
assert.equal(turns[0].main_request_count, 2);
assert.equal(turns[0].internal_request_count, 1);
assert.equal(turns[0].subagent_count, 1);
assert.equal(turns[0].tool_call_count, 1);
assert.equal(turns[0].tool_result_count, 1);
assert.equal(turns[0].context_delta.new_messages, 4);
assert.equal(turns[0].has_internal_requests, true);
assert.equal(turns[0].has_tool_exchange, true);
assert.equal(turns[1].kind, "independent_background");
assert.deepEqual(turns[1].request_indexes, [20]);
assert.equal(turns[1].index, null);
assert.deepEqual(turns[2].request_indexes, [4]);
assert.equal(requests[1].turn_id, "turn-1");
assert.equal(requests[2].turn_id, "background-request-20");
assert.equal(requests[4].turn_id, "turn-2");

const prewarm = request(30, "", "metadata", { new_messages: 0 });
prewarm.source_hint.turn_placement = "next_turn";
const firstUserTurn = request(31, "first visible question", "main", { new_messages: 1 });
const prewarmedTurns = buildTurnTimeline([prewarm, firstUserTurn], {
  ...semantics,
  isInternalRequest: (requestItem) => requestItem.source_hint.type === "metadata",
});
assert.equal(prewarmedTurns.length, 1, "a leading current-dialogue mechanism joins the first visible Turn");
assert.deepEqual(prewarmedTurns[0].request_indexes, [30, 31]);
assert.equal(prewarmedTurns[0].index, 1);
assert.equal(prewarmedTurns[0].internal_request_count, 1);
assert.equal(prewarmedTurns[0].main_request_count, 1);
assert.equal(prewarm.turn_id, "turn-1");
assert.equal(firstUserTurn.turn_id, "turn-1");

const initialTitleGeneration = request(39, "Generate the initial title", "metadata", { new_messages: 0 });
initialTitleGeneration.source_hint.turn_placement = "trigger_turn";
const titledFirstTurn = request(40, "first titled question", "main", { new_messages: 1 });
const titleGeneration = request(41, "Generate a title for this conversation", "metadata", { new_messages: 0 });
titleGeneration.source_hint.turn_placement = "trigger_turn";
const titledSecondTurn = request(42, "second visible question", "main", { new_messages: 1 });
const titleTurns = buildTurnTimeline([initialTitleGeneration, titledFirstTurn, titleGeneration, titledSecondTurn], {
  ...semantics,
  isInternalRequest: (requestItem) => requestItem.source_hint.type === "metadata",
});
assert.equal(titleTurns.length, 2, "title generation never creates or shifts a user Turn");
assert.deepEqual(titleTurns[0].request_indexes, [39, 40, 41]);
assert.deepEqual(titleTurns[1].request_indexes, [42]);
assert.equal(initialTitleGeneration.turn_id, "turn-1");
assert.equal(titleGeneration.turn_id, "turn-1");

console.log("turn timeline contract smoke passed");

function request(index, currentUser, type, delta, { currentToolCalls = null, responseToolCalls = [] } = {}) {
  return {
    id: `request-${index}`,
    request_index: index,
    captured_at: `2026-07-12T00:00:0${index}.000Z`,
    source_hint: { type, ...(type === "background" ? { relation: "independent" } : {}) },
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
