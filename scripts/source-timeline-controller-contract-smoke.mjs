#!/usr/bin/env node
import assert from "node:assert/strict";
import { SourceTimelineController } from "../src/viewer/source-timeline-controller.js";

await testProgressiveLoadAndDetailOverlay();
await testStaleSourceAndCursorWork();
await testProgressiveFailureState();
await testRefreshPathsAndBusyGuard();
await testDetailOverlayDuringRefresh();

console.log("source timeline controller contract smoke passed");

async function testProgressiveLoadAndDetailOverlay() {
  const details = new Map([["request-1", request(1, { detail_omitted: false, raw: { body: "hydrated" } })]]);
  const calls = [];
  const controller = new SourceTimelineController({
    initialLimit: 2,
    cursorLimit: 3,
    progressiveThreshold: 2,
    detailFor: (requestId) => details.get(requestId) || null,
    yieldControl: async () => calls.push(["yield"]),
    loadView: async (sourceId, options) => {
      calls.push([sourceId, options]);
      if (options.initial) {
        return page(sourceId, [request(1, { detail_omitted: true }), request(2)], {
          has_more: true,
          next_cursor: "page-2",
          loaded_request_count: 2,
          total_request_count: 3,
        });
      }
      assert.equal(options.cursor, "page-2");
      return page(sourceId, [request(3)], {
        has_more: false,
        next_cursor: null,
        refresh_cursor: "refresh-1",
        loaded_request_count: 3,
        total_request_count: 3,
      });
    },
  });

  assert.equal(controller.shouldLoadProgressively({ request_count: 2 }), true);
  assert.equal(controller.shouldLoadProgressively({ request_count: 20 }, { preserveScroll: true }), false);
  const load = await controller.loadSource("source-a", { progressive: true });
  assert.equal(load.hasMore, true);
  assert.equal(load.data.requests[0].raw.body, "hydrated", "cached detail must overlay the compact first page");

  const snapshots = [];
  const complete = await controller.continueSourceLoad(load, { onPage: (data) => snapshots.push(data) });
  assert.equal(complete.requests.length, 3);
  assert.equal(snapshots.length, 1);
  assert.equal(controller.progressiveLoadError, "");
  assert.equal(controller.currentRequest("request-3").request_index, 3);
  assert.deepEqual(calls.at(-2), ["yield"]);
  assert.deepEqual(calls.at(-1), ["source-a", { cursor: "page-2", limit: 3 }]);

  const merged = controller.mergeRequestDetail(request(2, { detail_omitted: false, raw: { body: "request-2" } }));
  assert.equal(merged.request.raw.body, "request-2");
  assert.equal(merged.data.requests[1].raw.body, "request-2");
}

async function testStaleSourceAndCursorWork() {
  const slowInitial = deferred();
  const slowCursor = deferred();
  const controller = new SourceTimelineController({
    yieldControl: () => Promise.resolve(),
    loadView: (sourceId, options) => {
      if (sourceId === "slow") return slowInitial.promise;
      if (sourceId === "cursor-a" && options.cursor) return slowCursor.promise;
      if (sourceId === "cursor-a") {
        return Promise.resolve(page(sourceId, [request(1)], { has_more: true, next_cursor: "late-page" }));
      }
      return Promise.resolve(page(sourceId, [request(9)], { has_more: false }));
    },
  });

  const staleInitial = controller.loadSource("slow");
  const current = await controller.loadSource("fast");
  slowInitial.resolve(page("slow", [request(1)]));
  assert.equal(await staleInitial, null, "a late initial page must not replace a newer source");
  assert.equal(current.sourceId, "fast");
  assert.equal(controller.snapshot().source.id, "fast");

  const cursorLoad = await controller.loadSource("cursor-a", { progressive: true });
  let pageCommits = 0;
  const staleCursor = controller.continueSourceLoad(cursorLoad, { onPage: () => (pageCommits += 1) });
  await Promise.resolve();
  await controller.loadSource("cursor-b");
  slowCursor.resolve(page("cursor-a", [request(2)], { has_more: false }));
  assert.equal(await staleCursor, null, "a late cursor page must not mutate a newer source");
  assert.equal(pageCommits, 0);
  assert.equal(controller.snapshot().source.id, "cursor-b");
}

async function testProgressiveFailureState() {
  const controller = new SourceTimelineController({
    yieldControl: () => Promise.resolve(),
    loadView: async (sourceId, options) => {
      if (options.cursor) throw new Error("cursor unavailable");
      return page(sourceId, [request(1)], { has_more: true, next_cursor: "broken" });
    },
  });
  const load = await controller.loadSource("broken", { progressive: true });
  await assert.rejects(controller.continueSourceLoad(load), /cursor unavailable/);
  assert.equal(controller.progressiveLoadError, "cursor unavailable");

  await controller.loadSource("recovered");
  assert.equal(controller.progressiveLoadError, "", "a new source generation must clear the old progressive error");
}

async function testRefreshPathsAndBusyGuard() {
  const warnings = [];
  const calls = [];
  let stage = "load";
  const controller = new SourceTimelineController({
    initialLimit: 1,
    cursorLimit: 2,
    progressiveThreshold: 10,
    yieldControl: () => Promise.resolve(),
    onWarning: (message, error) => warnings.push([message, error.message]),
    loadView: async (sourceId, options) => {
      calls.push([stage, options]);
      if (stage === "load") {
        return page(sourceId, [request(1)], { has_more: false, refresh_cursor: "expired" });
      }
      if (stage === "fallback") {
        if (options.cursor === "expired") throw new Error("cursor expired");
        if (options.initial) return page(sourceId, [request(1)], { has_more: true, next_cursor: "rebuild-2" });
        if (options.cursor === "rebuild-2") {
          return page(sourceId, [request(2)], { has_more: false, refresh_cursor: "delta-2" });
        }
      }
      if (stage === "delta") {
        assert.equal(options.cursor, "delta-2");
        return page(sourceId, [request(3)], { has_more: false });
      }
      if (stage === "small") return page(sourceId, [request(1), request(2), request(3), request(4)]);
      if (stage === "large") {
        if (options.initial) return page(sourceId, [request(1)], { has_more: true, next_cursor: "large-2" });
        return page(sourceId, [request(2), request(3), request(4), request(5)], { has_more: false });
      }
      throw new Error(`unexpected stage ${stage}`);
    },
  });

  const initial = await controller.loadSource("refresh-source");
  stage = "fallback";
  const rebuilt = await controller.refreshSource({ id: "refresh-source", request_count: 2 }, initial.data);
  assert.equal(rebuilt.data.requests.length, 2);
  assert.deepEqual(warnings, [["timeline refresh cursor expired; rebuilding the compact timeline", "cursor expired"]]);

  stage = "delta";
  const delta = await controller.refreshSource({ id: "refresh-source", request_count: 3 }, rebuilt.data);
  assert.equal(delta.data.requests.length, 3);

  stage = "small";
  const small = await controller.refreshSource({ id: "refresh-source", request_count: 4 }, delta.data);
  assert.equal(small.data.requests.length, 4);
  assert.deepEqual(calls.at(-1), ["small", {}]);

  stage = "large";
  const large = await controller.refreshSource({ id: "refresh-source", request_count: 100 }, small.data);
  assert.equal(large.data.requests.length, 5);
  assert.equal(calls.at(-2)[1].initial, true);
  assert.equal(calls.at(-1)[1].cursor, "large-2");

  const pendingPage = deferred();
  const busyController = new SourceTimelineController({
    yieldControl: () => Promise.resolve(),
    loadView: (sourceId, options) => {
      if (options.cursor) return pendingPage.promise;
      return Promise.resolve(page(sourceId, [request(1)], { has_more: true, next_cursor: "pending" }));
    },
  });
  const busyLoad = await busyController.loadSource("busy", { progressive: true });
  const continuation = busyController.continueSourceLoad(busyLoad);
  await Promise.resolve();
  assert.equal(
    await busyController.refreshSource({ id: "busy", request_count: 2 }, busyLoad.data),
    null,
    "auto refresh must wait until progressive cursor loading finishes",
  );
  pendingPage.resolve(page("busy", [request(2)], { has_more: false }));
  await continuation;
}

async function testDetailOverlayDuringRefresh() {
  const pendingRefresh = deferred();
  const details = new Map();
  let loadingInitial = true;
  const controller = new SourceTimelineController({
    detailFor: (requestId) => details.get(requestId) || null,
    loadView: () => {
      if (loadingInitial) {
        loadingInitial = false;
        return Promise.resolve(page("detail-source", [request(1, { detail_omitted: true })]));
      }
      return pendingRefresh.promise;
    },
  });
  const initial = await controller.loadSource("detail-source");
  const refresh = controller.refreshSource({ id: "detail-source", request_count: 2 }, initial.data);
  const detail = request(1, { detail_omitted: false, raw: { body: "loaded while refreshing" } });
  details.set(detail.id, detail);
  controller.mergeRequestDetail(detail);
  pendingRefresh.resolve(page("detail-source", [request(1, { detail_omitted: true }), request(2)]));
  const result = await refresh;
  assert.equal(
    result.data.requests[0].raw.body,
    "loaded while refreshing",
    "refresh commit must preserve details hydrated while the network request was in flight",
  );
}

function page(sourceId, requests, partial = {}) {
  return {
    source: { id: sourceId, kind: "stored" },
    requests,
    turns: [],
    agent_trace: { branches: [], spawns: [], returns: [] },
    stats: { request_count: requests.length },
    partial,
  };
}

function request(index, extra = {}) {
  return { id: `request-${index}`, request_index: index, method: "POST", ...extra };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
