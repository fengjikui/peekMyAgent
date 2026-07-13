#!/usr/bin/env node
import assert from "node:assert/strict";
import { TimelineCursorService } from "../src/server/timeline-cursor-service.mjs";

let now = 1_000;
let tokenIndex = 0;
const sources = new Map([
  ["live", { id: "live", live_watch_id: "watch-live", available: true }],
  ["stored", { id: "stored", kind: "persisted_capture", available: true }],
]);
const captures = new Map([
  ["live", [capture(1), capture(2), capture(3)]],
  ["stored", [capture(1), capture(2), capture(3)]],
]);

const service = new TimelineCursorService({
  resolveSource(sourceId) {
    const source = sources.get(sourceId);
    if (!source) throw Object.assign(new Error("missing source"), { statusCode: 404 });
    return source;
  },
  readPage(source, { cursor, limit }) {
    const all = captures.get(source.id) || [];
    const offset = Number(cursor) || 0;
    const pageCaptures = all.slice(offset, offset + limit);
    const nextOffset = offset + pageCaptures.length;
    return {
      captures: pageCaptures,
      startIndex: offset,
      page: {
        offset,
        loaded_count: pageCaptures.length,
        total_count: all.length,
        has_more: nextOffset < all.length,
        next_cursor: nextOffset < all.length ? String(nextOffset) : null,
      },
    };
  },
  createAssembler: () => fakeAssembler(),
  tokenFactory: () => `opaque-${++tokenIndex}`,
  now: () => now,
  ttlMs: 50,
  maxSessions: 4,
});

const liveInitial = service.start({ sourceId: "live", limit: 2 });
assert.deepEqual(liveInitial.requests.map((item) => item.id), ["request-1", "request-2"]);
assert.equal(liveInitial.partial.next_cursor, "opaque-1");
assert.equal(liveInitial.partial.refresh_cursor, "opaque-1");
assert.notEqual(liveInitial.partial.next_cursor, "2", "reader offsets never cross the HTTP boundary");

const liveTail = service.next({ sourceId: "live", cursor: liveInitial.partial.next_cursor });
assert.deepEqual(liveTail.requests.map((item) => item.id), ["request-3"]);
assert.equal(liveTail.partial.has_more, false);
assert.equal(liveTail.partial.next_cursor, null);
assert.equal(liveTail.partial.refresh_cursor, "opaque-1", "live cursors remain resumable after catching up");

captures.get("live").push(capture(4));
const liveRefresh = service.next({ sourceId: "live", cursor: liveTail.partial.refresh_cursor });
assert.deepEqual(liveRefresh.requests.map((item) => item.id), ["request-4"]);
assert.equal(liveRefresh.partial.loaded_request_count, 4);
assert.equal(liveRefresh.partial.refresh_cursor, "opaque-1");

const liveNoop = service.next({ sourceId: "live", cursor: liveRefresh.partial.refresh_cursor });
assert.deepEqual(liveNoop.requests, []);
assert.deepEqual(liveNoop.turn_updates, []);
assert.equal(liveNoop.partial.refresh_cursor, "opaque-1");

const storedInitial = service.start({ sourceId: "stored", limit: 2 });
assert.equal(storedInitial.partial.next_cursor, "opaque-2");
const storedTail = service.next({ sourceId: "stored", cursor: storedInitial.partial.next_cursor });
assert.equal(storedTail.partial.has_more, false);
assert.equal(storedTail.partial.refresh_cursor, null, "completed stored cursors release their server session");
assert.throws(() => service.next({ sourceId: "stored", cursor: "opaque-2" }), /expired or not found/);
assert.throws(() => service.next({ sourceId: "stored", cursor: "opaque-1" }), /does not belong/);

now += 100;
assert.throws(() => service.next({ sourceId: "live", cursor: "opaque-1" }), /expired or not found/);
console.log("timeline cursor service contract smoke passed");

function fakeAssembler() {
  return {
    createState({ source }) {
      return { source, requests: [] };
    },
    append(state, page) {
      const requests = page.captures.map((item) => ({ ...item }));
      state.requests.push(...requests);
      return {
        source: state.source,
        stats: { request_count: state.requests.length },
        requests,
        request_patches: [],
        turns: state.requests.map((item) => ({ id: `turn-${item.request_index}`, request_ids: [item.id] })),
        agent_trace: null,
      };
    },
  };
}

function capture(index) {
  return { id: `request-${index}`, request_index: index };
}
