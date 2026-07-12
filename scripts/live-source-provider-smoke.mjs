#!/usr/bin/env node
import assert from "node:assert/strict";
import { listLiveSources, liveSourceSummary } from "../src/server/live-source-provider.mjs";

const captures = [
  {
    watch_id: "watch-1",
    received_at: "2026-07-12T01:00:00.000Z",
    raw_body_length: 120,
    headers: { "X-Claude-Code-Agent-Id": "subagent-1" },
    body: { messages: [{ role: "user", content: "hello" }] },
    response: { received_at: "2026-07-12T01:00:02.000Z" },
  },
  {
    watch_id: "watch-1",
    received_at: "2026-07-12T01:00:03.000Z",
    headers: {},
    body: { value: "fallback bytes" },
    response: { received_at: "2026-07-12T01:00:05.000Z" },
  },
];
const watch = {
  id: "live-watch-1",
  watch_id: "watch-1",
  title: "Manual live title",
  label: "Claude Code · 监控一个会话",
  agent: "Claude Code",
  mode: "single_session",
  confidence: "exact",
  kind: "proxy_capture",
  base_url: "http://127.0.0.1:43111/watch/watch-1",
  status: "paused",
  conversation_id: "conversation-1",
  provider_id: "provider-1",
  config_patched: true,
  note: "live",
  workspace: "/tmp/project",
  created_at: "2026-07-12T00:59:00.000Z",
  paused_at: "2026-07-12T01:00:04.000Z",
  skipped_while_paused: "2",
};

const summary = liveSourceSummary(watch, {
  capturesForWatch: () => captures,
  resolveLabel: (item, items) => `${item.title} (${items.length})`,
});
assert.equal(summary.label, "Manual live title (2)");
assert.equal(summary.user_title, "Manual live title");
assert.equal(summary.request_count, 2);
assert.equal(summary.response_count, 2);
assert.equal(summary.subagent_count, 1);
assert.equal(summary.raw_body_bytes, 120 + Buffer.byteLength(JSON.stringify(captures[1].body)));
assert.equal(summary.last_seen, captures[1].received_at);
assert.equal(summary.last_response_seen, "2026-07-12T01:00:05.000Z");
assert.equal(summary.live_status, "paused");
assert.equal(summary.skipped_while_paused, 2);
assert.equal(summary.paused_at, watch.paused_at);
assert.equal(summary.resumed_at, null);

const explicitTimes = liveSourceSummary(
  { ...watch, id: "live-watch-2", watch_id: "watch-2", last_seen: "2026-07-12T02:00:00.000Z", last_response_seen: "2026-07-12T02:00:01.000Z" },
  { capturesForWatch: () => captures, resolveLabel: () => "" },
);
assert.equal(explicitTimes.label, watch.label, "empty title policy falls back to the watch label");
assert.equal(explicitTimes.last_seen, "2026-07-12T02:00:00.000Z");
assert.equal(explicitTimes.last_response_seen, "2026-07-12T02:00:01.000Z");

const listed = listLiveSources({
  watches: new Map([
    [watch.id, watch],
    [explicitTimes.id, { ...watch, id: explicitTimes.id, watch_id: "watch-2" }],
  ]),
  capturesForWatch: (item) => captures.filter((capture) => capture.watch_id === item.watch_id),
  resolveLabel: (item) => item.title,
});
assert.deepEqual(listed.map((item) => item.id), ["live-watch-1", "live-watch-2"]);
assert.equal(listed[1].request_count, 0);
assert.deepEqual(listLiveSources({ watches: null, capturesForWatch: () => [] }), []);
assert.throws(() => listLiveSources({ watches: new Map() }), /capturesForWatch is required/);

console.log("live source provider smoke passed");
