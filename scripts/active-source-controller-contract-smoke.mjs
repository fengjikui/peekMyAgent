#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ActiveSourceController,
  preferredSource,
  sourceCatalogSignature,
  sourceDataSignature,
  sourceRequiresRefresh,
} from "../src/viewer/active-source-controller.js";

function testPureSourceModel() {
  const sources = [source("offline", { available: false }), source("ready", { available: true })];
  assert.equal(preferredSource(sources, "offline").id, "ready");
  assert.equal(preferredSource(sources, "ready").id, "ready");
  assert.equal(preferredSource([source("only", { available: false })]).id, "only");
  assert.equal(preferredSource([]), null);

  assert.equal(sourceRequiresRefresh(source("a"), source("a")), false);
  assert.equal(sourceRequiresRefresh(source("a"), source("a", { request_count: 2 })), true);
  assert.equal(sourceRequiresRefresh(source("a"), source("a"), { force: true }), true);
  assert.equal(sourceRequiresRefresh(null, null), false);

  const catalogBefore = [source("a", { label: "A", request_count: 1 })];
  assert.equal(sourceCatalogSignature(catalogBefore), sourceCatalogSignature(structuredClone(catalogBefore)));
  assert.notEqual(
    sourceCatalogSignature(catalogBefore),
    sourceCatalogSignature([source("a", { label: "Renamed", request_count: 1 })]),
  );

  const dataBefore = view("a", [request(1)]);
  assert.equal(sourceDataSignature(dataBefore), sourceDataSignature(structuredClone(dataBefore)));
  assert.notEqual(
    sourceDataSignature(dataBefore),
    sourceDataSignature(view("a", [request(1), request(2)])),
  );
}

async function testInitializationAndProgressiveLoad() {
  const context = { sources: [], activeSourceId: null, data: null };
  const events = [];
  const timeline = new FakeTimeline();
  timeline.loadResults.set("large", {
    token: 1,
    sourceId: "large",
    data: view("large", [request(1)], { has_more: true, next_cursor: "next" }),
    hasMore: true,
  });
  timeline.continueResults.set("large", view("large", [request(1), request(2)]));
  const controller = controllerHarness({
    context,
    timeline,
    sources: [source("missing", { available: false }), source("large", { available: true, request_count: 80 })],
    events,
  });

  const selected = await controller.initialize("missing");
  assert.equal(selected.id, "large", "an unavailable requested source must fall back to an available source");
  assert.deepEqual(timeline.loadCalls, [["large", { progressive: true }]]);
  await eventually(() => events.some((event) => event[0] === "translations"));
  assert.equal(context.activeSourceId, "large");
  assert.equal(context.data.requests.length, 2, "background pages must replace the first compact snapshot");
  assert.ok(
    events.some((event) => event[0] === "present-loaded" && event[2].preserveScroll === true),
    "cursor pages must preserve the current scroll position",
  );
  assert.ok(events.some((event) => event[0] === "refresh-raw"));

  timeline.loadResults.set("small", {
    token: 2,
    sourceId: "small",
    data: view("small", [request(9)]),
    hasMore: false,
  });
  context.sources.push(source("small", { available: true, request_count: 1 }));
  await controller.loadSource("small", { preserveScroll: true });
  assert.deepEqual(timeline.loadCalls.at(-1), ["small", { progressive: false }]);
  assert.ok(events.some((event) => event[0] === "reset" && event[1].previousSourceId === "large"));
}

async function testRefreshAndStaleTranslationGuard() {
  const previousData = view("active", [request(1)]);
  const context = {
    sources: [source("active", { available: true, request_count: 1 })],
    activeSourceId: "active",
    data: previousData,
  };
  const events = [];
  const timeline = new FakeTimeline();
  const translation = deferred();
  const controller = controllerHarness({ context, timeline, events, translationPromise: translation.promise });

  timeline.refreshResult = {
    token: 4,
    sourceId: "active",
    data: view("active", [request(1), request(2)]),
  };
  timeline.currentToken = 4;
  timeline.currentSourceId = "active";
  const refreshing = controller.refreshActiveSource(context.sources[0]);
  await eventually(() => context.data.requests.length === 2);
  context.activeSourceId = "other";
  timeline.currentSourceId = "other";
  translation.resolve();
  assert.equal(await refreshing, null, "a source switch during translation must reject the old refresh render");
  assert.equal(events.some((event) => event[0] === "present-refreshed"), false);

  context.activeSourceId = "active";
  context.data = view("active", [request(1), request(2)]);
  timeline.currentSourceId = "active";
  timeline.refreshResult = {
    token: 4,
    sourceId: "active",
    data: structuredClone(context.data),
  };
  const translationCount = events.filter((event) => event[0] === "translations").length;
  const unchanged = await controller.refreshActiveSource(context.sources[0]);
  assert.equal(unchanged.rendered, false);
  assert.equal(events.filter((event) => event[0] === "translations").length, translationCount);

  const failureContext = {
    sources: [source("failure", { available: true, request_count: 2 })],
    activeSourceId: "failure",
    data: view("failure", [request(1)]),
  };
  const failureEvents = [];
  const failureTimeline = new FakeTimeline();
  failureTimeline.currentData = failureContext.data;
  failureTimeline.currentToken = 5;
  failureTimeline.currentSourceId = "failure";
  failureTimeline.refreshResult = {
    token: 5,
    sourceId: "failure",
    data: view("failure", [request(1), request(2)]),
  };
  const failureController = controllerHarness({
    context: failureContext,
    timeline: failureTimeline,
    events: failureEvents,
    translationPromise: Promise.reject(new Error("translation unavailable")),
  });
  const translatedFailure = await failureController.refreshActiveSource(failureContext.sources[0]);
  assert.equal(translatedFailure.rendered, true, "translation failure must not hide fresh Source data");
  assert.ok(failureEvents.some((event) => event[0] === "present-refreshed"));
  assert.ok(
    failureEvents.some(
      (event) => event[0] === "warning" && event[1] === "translation load failed" && event[2] === "translation unavailable",
    ),
  );
}

async function testPollingAndTimerLifecycle() {
  const context = {
    sources: [source("live", { available: true, request_count: 1 })],
    activeSourceId: "live",
    data: view("live", [request(1)]),
  };
  const events = [];
  const timeline = new FakeTimeline();
  timeline.refreshResult = {
    token: 8,
    sourceId: "live",
    data: view("live", [request(1), request(2)]),
  };
  timeline.currentToken = 8;
  timeline.currentSourceId = "live";
  let hidden = true;
  let sources = [source("live", { available: true, request_count: 2 })];
  let listCalls = 0;
  const scheduled = [];
  const cancelled = [];
  const controller = controllerHarness({
    context,
    timeline,
    events,
    listSources: async () => {
      listCalls += 1;
      return sources;
    },
    isHidden: () => hidden,
    scheduleInterval: (callback, delay) => {
      scheduled.push([callback, delay]);
      return 17;
    },
    cancelInterval: (timer) => cancelled.push(timer),
  });

  assert.equal(await controller.refreshLiveData(), false);
  assert.equal(listCalls, 0, "hidden documents must not poll the server");
  hidden = false;
  assert.equal(await controller.refreshLiveData(), true);
  assert.equal(context.data.requests.length, 2);
  assert.ok(events.some((event) => event[0] === "present-refreshed"));

  controller.startAutoRefresh();
  controller.startAutoRefresh();
  assert.deepEqual(scheduled.map((entry) => entry[1]), [1200, 1200]);
  assert.deepEqual(cancelled, [17]);
  controller.stopAutoRefresh();
  assert.deepEqual(cancelled, [17, 17]);

  sources = [];
  await controller.refreshSources();
  assert.deepEqual(context.sources, []);

  const lateCatalog = deferred();
  const staleController = controllerHarness({
    context,
    timeline,
    events,
    listSources: () => lateCatalog.promise,
  });
  const stalePoll = staleController.refreshLiveData();
  staleController.acceptSources([source("mutation")], { reason: "mutation-response" });
  lateCatalog.resolve([source("stale")]);
  assert.equal(await stalePoll, false);
  assert.equal(context.sources[0].id, "mutation", "a late poll must not overwrite a mutation response catalog");
}

function testClientAssemblyBoundary() {
  const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
  const controllerSource = fs.readFileSync(new URL("../src/viewer/active-source-controller.js", import.meta.url), "utf8");
  assert.match(clientSource, /import \{ ActiveSourceController \} from "\.\/active-source-controller\.js";/);
  assert.match(clientSource, /const activeSourceController = new ActiveSourceController\(/);
  assert.doesNotMatch(clientSource, /function (?:refreshLiveData|refreshActiveSource|loadSourcePagesInBackground)\b/);
  assert.doesNotMatch(clientSource, /autoRefresh(?:Timer|InFlight)/);
  assert.doesNotMatch(controllerSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bfetch\s*\(/);
  assert.doesNotMatch(controllerSource, /new TimelineEntityStore|next_cursor|refresh_cursor/);
}

function controllerHarness({
  context,
  timeline,
  sources = context.sources,
  events = [],
  translationPromise = Promise.resolve(),
  listSources = async () => sources,
  isHidden = () => false,
  scheduleInterval,
  cancelInterval,
} = {}) {
  return new ActiveSourceController({
    timeline,
    listSources,
    getContext: () => context,
    setSources(nextSources, options) {
      context.sources = nextSources;
      events.push(["sources", nextSources, options]);
    },
    resetSourceContext: (details) => events.push(["reset", details]),
    captureScroll: () => ({ scrollTop: 64, nearBottom: false }),
    setData(data, options) {
      context.data = data;
      events.push(["set-data", data, options]);
    },
    presentLoadedData(data, options) {
      context.data = data;
      context.activeSourceId = data.source.id;
      events.push(["present-loaded", data, options]);
    },
    presentRefreshedData(data, options) {
      context.data = data;
      events.push(["present-refreshed", data, options]);
    },
    async loadTranslations() {
      events.push(["translations"]);
      await translationPromise;
    },
    refreshRaw: () => events.push(["refresh-raw"]),
    renderData: (options) => events.push(["render-data", options]),
    isHidden,
    scheduleInterval: scheduleInterval || (() => 1),
    cancelInterval: cancelInterval || (() => {}),
    onWarning: (message, error) => events.push(["warning", message, error.message]),
  });
}

class FakeTimeline {
  constructor() {
    this.loadResults = new Map();
    this.continueResults = new Map();
    this.loadCalls = [];
    this.refreshResult = null;
    this.currentToken = null;
    this.currentSourceId = null;
    this.currentData = null;
  }

  shouldLoadProgressively(sourceValue, { preserveScroll = false } = {}) {
    return !preserveScroll && Number(sourceValue?.request_count || 0) >= 72;
  }

  async loadSource(sourceId, options) {
    this.loadCalls.push([sourceId, options]);
    const result = this.loadResults.get(sourceId) || {
      token: this.loadCalls.length,
      sourceId,
      data: view(sourceId, [request(this.loadCalls.length)]),
      hasMore: false,
    };
    this.currentToken = result.token;
    this.currentSourceId = result.sourceId;
    this.currentData = result.data;
    return result;
  }

  async continueSourceLoad(load, { onPage } = {}) {
    const result = this.continueResults.get(load.sourceId) || load.data;
    onPage?.(result);
    this.currentData = result;
    return result;
  }

  async refreshSource() {
    if (this.refreshResult?.data) this.currentData = this.refreshResult.data;
    return this.refreshResult;
  }

  snapshot() {
    return this.currentData;
  }

  isCurrent(token, sourceId) {
    return token === this.currentToken && sourceId === this.currentSourceId;
  }
}

function source(id, extra = {}) {
  return {
    id,
    label: id,
    available: true,
    request_count: 1,
    response_count: 1,
    live_status: "watching",
    last_seen: "2026-07-14T00:00:00Z",
    last_response_seen: "2026-07-14T00:00:00Z",
    ...extra,
  };
}

function view(sourceId, requests, partial = {}) {
  return {
    source: { id: sourceId, live_status: "watching" },
    requests,
    turns: [],
    agent_trace: { branches: [], spawns: [], returns: [] },
    stats: { request_count: requests.length },
    partial,
  };
}

function request(index, extra = {}) {
  return {
    id: `request-${index}`,
    request_index: index,
    captured_at: `2026-07-14T00:00:0${index}Z`,
    summary: { response: { captured: true, received_at: `2026-07-14T00:00:0${index}Z` } },
    ...extra,
  };
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

async function eventually(predicate, { attempts = 50 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached before timeout");
}

testPureSourceModel();
await testInitializationAndProgressiveLoad();
await testRefreshAndStaleTranslationGuard();
await testPollingAndTimerLifecycle();
testClientAssemblyBoundary();

console.log("active source controller contract smoke passed");
