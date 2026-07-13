#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  renderEmptyTimeline,
  renderTimelineWindowEdge,
  renderTraceNoResults,
  renderTraceQueryBar,
  renderTurnTimeline,
} from "../src/viewer/trace-timeline-renderer.js";

const translate = (key, values = {}) =>
  `${key}${Object.keys(values).length ? `:${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")}` : ""}`;
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const queryHtml = renderTraceQueryBar({
  timelineView: {
    filterCounts: { all: 72, issues: 3, slow: 4, tools: 17, subagents: 7 },
    matchCount: 40,
    shownCount: 24,
    queryActive: true,
  },
  query: '<Agent id="1">',
  filter: "tools",
  resultPageSize: 24,
  translate,
  escapeHtml,
});
assert.match(queryHtml, /value="&lt;Agent id=&quot;1&quot;&gt;"/, "the query value must be escaped");
assert.match(queryHtml, /data-trace-filter="tools"[^>]*aria-pressed="true"/, "the active filter must be explicit");
assert.match(queryHtml, /traceMatchCount:shown=24,total=40/, "the visible and total match counts must remain distinct");
assert.match(queryHtml, /traceShowMore:count=16/, "show-more must be capped by the remaining results");

const noResults = renderTraceNoResults({ translate, escapeHtml });
assert.match(noResults, /traceNoResultsTitle/);
assert.match(noResults, /traceNoResultsBody/);

const empty = renderEmptyTimeline({
  summary: { status: "watching", watch_ids: ["watch-1"], capture_label: "exact proxy capture" },
  translate,
  escapeHtml,
});
assert.match(empty, /empty-timeline/);
assert.match(empty, /watch-1/);
assert.match(empty, /exact proxy capture/);

const allTurns = Array.from({ length: 40 }, (_, index) => ({ id: `turn-${index + 1}`, index: index + 1, request_ids: [`request-${index + 1}`] }));
const requests = allTurns.map((turn, index) => ({ id: turn.request_ids[0], request_index: index + 1 }));
const timelineHtml = renderTurnTimeline({
  turnWindowOrTurns: {
    turns: allTurns.slice(8, 32),
    allTurns,
    start: 8,
    end: 32,
    total: allTurns.length,
    windowed: true,
  },
  requests,
  requestExcerpt: (request) => `request ${request.request_index}`,
  renderTurnGroup: (turn, requestMap) => `<article data-rendered-turn="${turn.id}">${requestMap.get(turn.request_ids[0]).id}</article>`,
  translate,
  escapeHtml,
});
assert.match(timelineHtml, /timelineWindowBefore:count=8/);
assert.match(timelineHtml, /timelineWindowAfter:count=8/);
assert.match(timelineHtml, /data-turn-window-jump="turn-1"/);
assert.match(timelineHtml, /data-turn-window-jump="turn-40"/);
assert.match(timelineHtml, /data-rendered-turn="turn-9"/);
assert.doesNotMatch(timelineHtml, /data-rendered-turn="turn-8"/);

const beforeEdge = renderTimelineWindowEdge({
  turnWindow: { allTurns, start: 8, end: 32, total: 40, windowed: true },
  edge: "before",
  translate,
  escapeHtml,
});
assert.match(beforeEdge, /timelineWindowSummary:start=9,end=32,total=40/);
assert.equal(
  renderTimelineWindowEdge({
    turnWindow: { allTurns, start: 0, end: 40, total: 40, windowed: false },
    edge: "before",
    translate,
    escapeHtml,
  }),
  "",
);

const fallbackHtml = renderTurnTimeline({
  turnWindowOrTurns: { turns: [], allTurns: [], start: 0, end: 0, total: 0, windowed: false },
  requests: [{ id: "request-a", request_index: 1, summary: { current_user: "hello" } }],
  requestExcerpt: () => "hello",
  renderTurnGroup: (turn) => `<article>${turn.id}</article>`,
  translate,
  escapeHtml,
});
assert.match(fallbackHtml, /<article>turn-1<\/article>/, "legacy traces without turns must retain the fallback path");

console.log("trace timeline renderer contract smoke passed");
