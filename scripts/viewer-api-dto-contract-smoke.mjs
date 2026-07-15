#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  SOURCE_SUMMARY_CONTRACT_VERSION,
  TRACE_REQUEST_DETAIL_CONTRACT_VERSION,
  VIEWER_API_DTO_CONTRACT_VERSION,
  assertSourceSummaryList,
  assertTraceRequestDetailResponse,
  validateSourceSummary,
  validateTraceRequestDetailResponse,
} from "../src/contracts/viewer-api.mjs";

assert.equal(VIEWER_API_DTO_CONTRACT_VERSION, 1);
assert.equal(SOURCE_SUMMARY_CONTRACT_VERSION, 1);
assert.equal(TRACE_REQUEST_DETAIL_CONTRACT_VERSION, 1);

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
