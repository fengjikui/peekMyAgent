#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  SOURCE_SUMMARY_CONTRACT_VERSION,
  TRACE_REQUEST_DETAIL_CONTRACT_VERSION,
  TRACE_TIMELINE_RESPONSE_CONTRACT_VERSION,
  VIEWER_API_DTO_CONTRACT_VERSION,
  assertSourceSummaryList,
  assertTraceRequestDetailResponse,
  assertTraceTimelineResponse,
  validateSourceSummary,
  validateTraceRequestDetailResponse,
  validateTraceTimelineResponse,
} from "../src/contracts/viewer-api.mjs";

assert.equal(VIEWER_API_DTO_CONTRACT_VERSION, 1);
assert.equal(SOURCE_SUMMARY_CONTRACT_VERSION, 1);
assert.equal(TRACE_REQUEST_DETAIL_CONTRACT_VERSION, 1);
assert.equal(TRACE_TIMELINE_RESPONSE_CONTRACT_VERSION, 1);

const source = validSource();
const sources = [source];
assert.equal(assertSourceSummaryList(sources), sources, "assertions preserve DTO identity");
assert.equal(validateSourceSummary(source).ok, true);
assert.deepEqual(
  validateSourceSummary({ id: "broken" }).errors,
  ["label is required", "kind is required", "available must be boolean"],
);
assert.throws(
  () => assertSourceSummaryList([{ id: "broken" }]),
  /source\[0\]\.label is required.*source\[0\]\.kind is required.*source\[0\]\.available must be boolean/,
);

const detail = validRequestDetail(source);
assert.equal(assertTraceRequestDetailResponse(detail), detail);
assert.equal(validateTraceRequestDetailResponse(detail).ok, true);
assert.deepEqual(
  validateTraceRequestDetailResponse({ source, request: { id: "request-1" } }).errors,
  [
    "request.request_index must be a positive integer",
    "request.detail_scope must be request_window",
    "generated_at is required",
    "detail_scope must be request_window",
  ],
);
assert.throws(
  () => assertTraceRequestDetailResponse({ ...detail, source: { ...source, available: "yes" } }),
  /source\.available must be boolean/,
);

const snapshot = validTimelineSnapshot(source);
assert.equal(assertTraceTimelineResponse(snapshot), snapshot);
assert.equal(validateTraceTimelineResponse(snapshot).ok, true);

const initialPage = validCursorPage(source, { initial: true });
const deltaPage = validCursorPage(source);
assert.equal(assertTraceTimelineResponse(initialPage), initialPage);
assert.equal(assertTraceTimelineResponse(deltaPage), deltaPage);
assert.throws(
  () => assertTraceTimelineResponse({ ...deltaPage, partial: { ...deltaPage.partial, next_cursor: "stale" } }),
  /partial\.next_cursor must be null when no more pages are available/,
);
assert.throws(
  () => assertTraceTimelineResponse({ ...snapshot, requests: [{ id: "request-1", request_index: 0 }] }),
  /requests\[0\]\.request_index must be a positive integer/,
);

console.log("viewer API DTO contract smoke passed");

function validSource() {
  return {
    id: "live-claude-code-contract",
    label: "Contract trace",
    kind: "proxy_capture",
    available: true,
    request_count: 1,
  };
}

function validRequestDetail(source) {
  return {
    generated_at: "2026-07-15T00:00:00.000Z",
    source,
    request: {
      id: "request-1",
      request_index: 1,
      detail_scope: "request_window",
    },
    detail_scope: "request_window",
  };
}

function validTimelineSnapshot(source) {
  return {
    generated_at: "2026-07-15T00:00:00.000Z",
    source,
    stats: { request_count: 1 },
    requests: [{ id: "request-1", request_index: 1 }],
    turns: [{ id: "turn-1" }],
    agent_trace: { branches: [], spawns: [], returns: [] },
  };
}

function validCursorPage(source, { initial = false } = {}) {
  return {
    generated_at: "2026-07-15T00:00:00.000Z",
    source,
    stats: { request_count: 1 },
    requests: initial ? [{ id: "request-1", request_index: 1 }] : [],
    request_patches: [],
    turn_updates: [],
    removed_turn_ids: [],
    agent_trace_delta: null,
    ...(initial
      ? {
          turns: [{ id: "turn-1" }],
          agent_trace: { branches: [], spawns: [], returns: [] },
        }
      : {}),
    page_scope: "timeline_cursor_delta",
    partial: {
      mode: "cursor",
      loaded_request_count: 1,
      total_request_count: 1,
      page_offset: initial ? 0 : 1,
      page_request_count: initial ? 1 : 0,
      has_more: false,
      next_cursor: null,
      refresh_cursor: "opaque-refresh",
    },
  };
}
