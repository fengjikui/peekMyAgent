#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  RequestDetailCache,
  normalizeRequestDetail,
  requestNeedsDetail,
} from "../src/viewer/request-detail-cache.js";

assert.equal(requestNeedsDetail({ detail_omitted: true }), true);
assert.equal(requestNeedsDetail({ raw: { detail_omitted: true } }), true);
assert.equal(requestNeedsDetail({ summary: { history_stack_omitted: true } }), true);
assert.equal(requestNeedsDetail({ id: "complete" }), false);

assert.deepEqual(
  normalizeRequestDetail({
    id: "request-1",
    detail_omitted: true,
    raw: { detail_omitted: true, body_omitted: true, body: { messages: [] } },
    summary: { history_stack_omitted: true, current_user: "hello" },
  }),
  {
    id: "request-1",
    detail_omitted: false,
    raw: { detail_omitted: false, body: { messages: [] } },
    summary: { current_user: "hello" },
  },
);

let resolveLoad;
let loadCount = 0;
let loadedCount = 0;
let cachedCount = 0;
const cache = new RequestDetailCache({
  loadDetail: async (sourceId, requestId) => {
    loadCount += 1;
    assert.equal(sourceId, "source-1");
    assert.equal(requestId, "request-1");
    return new Promise((resolve) => {
      resolveLoad = resolve;
    });
  },
  onLoaded(detail) {
    loadedCount += 1;
    return { ...detail, merged: "first-load" };
  },
  onCached(detail) {
    cachedCount += 1;
    return { ...detail, merged: "cache-hit" };
  },
});

const compactRequest = { id: "request-1", detail_omitted: true, summary: { history_stack_omitted: true } };
const first = cache.ensure("source-1", compactRequest);
const concurrent = cache.ensure("source-1", compactRequest);
assert.equal(loadCount, 1, "concurrent detail requests should share one loader call");
resolveLoad({ id: "request-1", detail_omitted: true, raw: { body_omitted: true, body: { system: "full" } } });
assert.deepEqual(await first, {
  id: "request-1",
  detail_omitted: false,
  raw: { detail_omitted: false, body: { system: "full" } },
  merged: "first-load",
});
assert.deepEqual(await concurrent, await first);
assert.equal(loadedCount, 1, "the first-load callback should run once for a shared promise");

const cached = await cache.ensure("source-1", compactRequest);
assert.equal(cached.merged, "cache-hit");
assert.equal(cachedCount, 1);
assert.equal(loadCount, 1);

const mergedData = cache.mergeIntoData({ requests: [compactRequest, { id: "request-2" }] });
assert.equal(mergedData.requests[0].raw.body.system, "full");
assert.equal(mergedData.requests[1].id, "request-2");

let failCount = 0;
const failure = new Error("detail unavailable");
const failingCache = new RequestDetailCache({
  loadDetail: async () => {
    failCount += 1;
    throw failure;
  },
});
await assert.rejects(() => failingCache.ensure("source-1", compactRequest), /detail unavailable/);
assert.equal(failingCache.errorFor("request-1"), failure);
await assert.rejects(() => failingCache.ensure("source-1", compactRequest), /detail unavailable/);
assert.equal(failCount, 2, "a failed request should be retryable after its in-flight promise clears");
failingCache.clear();
assert.equal(failingCache.errorFor("request-1"), null);

console.log("request detail cache contract smoke passed");
