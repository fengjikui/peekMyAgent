#!/usr/bin/env node
import assert from "node:assert/strict";
import { OtelIngestService } from "../src/server/otel-ingest-service.mjs";

const persistedIds = new Set(["capture-existing"]);
const persisted = [];
const responseUpdates = [];
const store = {
  nextRequestIndex(watchId) {
    assert.equal(watchId, "watch-a");
    return 5;
  },
  hasRequest(captureId) {
    return persistedIds.has(captureId);
  },
  upsertCapture(input) {
    persisted.push(input);
    const inserted = !persistedIds.has(input.capture.capture_id);
    persistedIds.add(input.capture.capture_id);
    return { inserted };
  },
  updateCaptureResponse(capture) {
    responseUpdates.push(capture.capture_id);
    return { updated: true };
  },
};

const conversionCalls = [];
const bodyEvents = new Map();
const service = new OtelIngestService({
  store,
  cwd: "/default/workspace",
  bodyEvents,
  limits: { eventWatches: 3, eventsPerWatch: 4 },
  extractEvents(payload, options) {
    assert.equal(options.maxEvents, 4);
    return payload.events || [];
  },
  mergeEvents(existing, incoming, options) {
    assert.equal(options.maxEvents, 4);
    return [...existing, ...incoming].slice(-options.maxEvents);
  },
  toCaptures(dir, context, options) {
    conversionCalls.push({ dir, context, options });
    return [
      { capture_id: "capture-new", request_index: 1 },
      { capture_id: "capture-existing", request_index: 2, response: { status: 200 } },
    ];
  },
  sourceId: (watchId) => `source:${watchId}`,
  sanitizeTitle: (value) => String(value || "").trim().toUpperCase(),
  conversationTitle: ({ agent, conversation_id }) => `${agent}:${conversation_id}`,
});

const eventResult = await service.ingestEvents({
  watchId: "watch-a",
  payload: { events: [{ body_ref: "request.json" }, { body_ref: "response.json" }] },
});
assert.deepEqual(eventResult, { accepted: 2, indexed: 2 });
assert.equal(bodyEvents.get("watch-a").length, 2);

const ingestResult = await service.ingestCaptures({
  dir: " /tmp/otel-dump ",
  watch_id: " watch-a ",
  agent: "Claude Code",
  conversation_id: "conversation-a",
  event_correlation_enabled: true,
});
assert.deepEqual(ingestResult, {
  ok: true,
  watch_id: "watch-a",
  source_id: "source:watch-a",
  total: 2,
  ingested: 1,
  responses: 1,
  event_correlations: 2,
});
assert.equal(conversionCalls[0].dir, "/tmp/otel-dump");
assert.deepEqual(conversionCalls[0].context, {
  watchId: "watch-a",
  workspace: "/default/workspace",
  agent: "Claude Code",
  conversationId: "conversation-a",
});
assert.equal(conversionCalls[0].options.events.length, 2);
assert.equal(conversionCalls[0].options.allowHeuristicPairing, false, "correlated incremental ingest waits for exact response evidence");
assert.equal(persisted[0].capture.request_index, 5, "new capture receives the store's next monotonic index");
assert.equal(persisted[1].capture.request_index, 2, "existing capture keeps its original index during response refresh");
assert.equal(persisted[0].watch.title, "CLAUDE CODE:CONVERSATION-A");
assert.equal(persisted[0].watch.kind, "otel_raw_body");
assert.deepEqual(responseUpdates, ["capture-existing"]);

await service.ingestCaptures({
  dir: "/tmp/otel-dump",
  watch_id: "watch-a",
  event_correlation_enabled: true,
  final: true,
});
assert.equal(conversionCalls.at(-1).options.allowHeuristicPairing, true, "final ingest permits positional fallback for legacy/missing events");
assert.equal(bodyEvents.has("watch-a"), false, "final ingest releases per-watch correlation events");

await assert.rejects(() => service.ingestCaptures({ watch_id: "watch-a" }), /dump dir/);
await assert.rejects(() => service.ingestCaptures({ dir: "/tmp/otel-dump" }), /watch_id/);
await assert.rejects(
  () => service.ingestEvents({ payload: {} }),
  (error) => error.statusCode === 400 && /watch_id/.test(error.message),
  "event ingest reports a bad request when watch identity is absent",
);

const evictionEvents = new Map();
const evictionService = new OtelIngestService({
  store,
  bodyEvents: evictionEvents,
  limits: { eventWatches: 2, eventsPerWatch: 2 },
  extractEvents: (payload) => payload.events,
  mergeEvents: (existing, incoming, { maxEvents }) => [...existing, ...incoming].slice(-maxEvents),
});
await evictionService.ingestEvents({ watchId: "oldest", payload: { events: [{ id: 1 }] } });
await evictionService.ingestEvents({ watchId: "newer", payload: { events: [{ id: 2 }] } });
await evictionService.ingestEvents({ watchId: "newest", payload: { events: [{ id: 3 }] } });
assert.deepEqual([...evictionEvents.keys()], ["newer", "newest"], "event buffer evicts the oldest watch at its configured bound");
await evictionService.ingestEvents({ watchId: "newer", payload: { events: [{ id: 4 }, { id: 5 }] } });
assert.deepEqual([...evictionEvents.keys()], ["newest", "newer"], "refreshing a watch also refreshes its eviction order");
assert.deepEqual(evictionEvents.get("newer").map((event) => event.id), [4, 5], "per-watch event bound is enforced by the merge port");

assert.throws(() => new OtelIngestService(), /store is required/);

console.log("OTel ingest service contract smoke passed");
