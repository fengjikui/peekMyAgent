#!/usr/bin/env node
import assert from "node:assert/strict";
import { mergeTimelinePage } from "../src/viewer/timeline-page-merge.js";

const current = {
  source: { id: "source-1", label: "before" },
  stats: { request_count: 3 },
  partial: { has_more: true, next_cursor: "cursor-1" },
  requests: [request("request-1", 1, "turn-1"), request("request-2", 2, "turn-1")],
  turns: [{ id: "turn-1", request_ids: ["request-1", "request-2"], request_count: 2 }],
  agent_trace: {
    version: 1,
    branch_count: 1,
    spawn_count: 1,
    return_count: 0,
    confidence: "medium",
    signals: { child: "header" },
    branches: [{ id: "branch-1", status: "running", request_ids: ["request-2"] }],
    spawns: [{ id: "spawn-1", label: "worker" }],
    returns: [],
  },
};
current.requests[1].trace.stale_branch_marker = true;

const page = {
  source: { id: "source-1", label: "after" },
  stats: { request_count: 4 },
  partial: { has_more: false, next_cursor: null, refresh_cursor: "cursor-1" },
  requests: [request("request-3", 3, "turn-2")],
  request_patches: [{ id: "request-2", turn_id: "turn-2", trace: { keep: true, branch_id: "branch-1" } }],
  turn_updates: [
    { id: "turn-1", request_ids: ["request-1"], request_count: 1 },
    { id: "turn-2", request_ids: ["request-2", "request-3"], request_count: 2 },
  ],
  removed_turn_ids: [],
  agent_trace_delta: {
    version: 1,
    branch_count: 1,
    spawn_count: 1,
    return_count: 1,
    confidence: "high",
    signals: { child: "header" },
    branch_updates: [{ id: "branch-1", status: "returned", request_ids: ["request-2", "request-3"] }],
    removed_branch_ids: [],
    spawn_updates: [],
    removed_spawn_ids: [],
    return_updates: [{ spawn_id: "spawn-1", result_preview: "done" }],
    removed_return_spawn_ids: [],
  },
};

const merged = mergeTimelinePage(current, page);
assert.equal(merged.source.label, "after");
assert.deepEqual(merged.requests.map((item) => item.id), ["request-1", "request-2", "request-3"]);
assert.equal(merged.requests[1].turn_id, "turn-2");
assert.equal(merged.requests[1].trace.keep, true, "request patches preserve unrelated trace evidence");
assert.equal(merged.requests[1].trace.branch_id, "branch-1");
assert.equal(merged.requests[1].trace.stale_branch_marker, undefined, "request trace annotations are replaced atomically");
assert.deepEqual(merged.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
assert.deepEqual(merged.turns[0].request_ids, ["request-1"]);
assert.equal(merged.agent_trace.branches[0].status, "returned");
assert.equal(merged.agent_trace.returns[0].spawn_id, "spawn-1");
assert.equal(merged.partial.refresh_cursor, "cursor-1");
assert.equal("turn_updates" in merged, false, "wire-only turn deltas do not leak into application state");

const removed = mergeTimelinePage(merged, {
  source: { id: "source-1" },
  requests: [],
  request_patches: [],
  turn_updates: [],
  removed_turn_ids: ["turn-1"],
  agent_trace_delta: {
    branch_count: 0,
    spawn_count: 0,
    return_count: 0,
    confidence: "none",
    branch_updates: [],
    removed_branch_ids: ["branch-1"],
    spawn_updates: [],
    removed_spawn_ids: ["spawn-1"],
    return_updates: [],
    removed_return_spawn_ids: ["spawn-1"],
  },
});
assert.deepEqual(removed.turns.map((turn) => turn.id), ["turn-2"]);
assert.equal(removed.agent_trace.branches.length, 0);
assert.equal(removed.agent_trace.spawns.length, 0);
assert.equal(removed.agent_trace.returns.length, 0);

assert.throws(() => mergeTimelinePage(current, { source: { id: "other" } }), /source mismatch/);
console.log("timeline page merge contract smoke passed");

function request(id, requestIndex, turnId) {
  return { id, request_index: requestIndex, turn_id: turnId, trace: { keep: true } };
}
