#!/usr/bin/env node
import assert from "node:assert/strict";
import { TraceTimelineController, timelineAction } from "../src/viewer/trace-timeline-controller.js";

class FakeRoot {
  constructor() {
    this.listeners = new Map();
    this.queries = new Map();
    this.innerHTML = "";
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.length || 0;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  contains(element) {
    return element?.root === this;
  }

  querySelector(selector) {
    const value = this.queries.get(selector);
    return Array.isArray(value) ? value[0] || null : value || null;
  }

  querySelectorAll(selector) {
    const value = this.queries.get(selector);
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }
}

const queryRoot = new FakeRoot();
const timelineRoot = new FakeRoot();
const calls = [];
let pendingTimer = null;
const windowRef = {
  setTimeout(callback) {
    pendingTimer = callback;
    return 1;
  },
  clearTimeout() {
    pendingTimer = null;
  },
  requestAnimationFrame(callback) {
    callback();
  },
};
const callbacks = Object.fromEntries(
  [
    "onQueryChange",
    "onRenderRequested",
    "onFilter",
    "onShowMore",
    "onResponseToggle",
    "onUpstreamToggle",
    "onUpstreamPanelToggle",
    "onTurnWindowJump",
    "onRaw",
    "onAgentJump",
    "onAgentBranchJump",
    "onAgentBranchToggle",
    "onSupportingTimelineToggle",
    "onAgentDashboardToggle",
    "onAgentBranchMore",
    "onAgentStatusFilter",
    "onSystemDiff",
  ].map((name) => [name, (...args) => calls.push([name, ...args])]),
);
const controller = new TraceTimelineController({
  queryElement: queryRoot,
  timelineElement: timelineRoot,
  searchDelay: 10,
  windowRef,
  ...callbacks,
});
controller.bind();
controller.bind();
assert.equal(queryRoot.listenerCount("input"), 1, "binding must be idempotent");
assert.equal(timelineRoot.listenerCount("click"), 1, "Timeline must use one delegated click listener");

const activeTurn = fakeToggleNode({ turnGroup: "turn-2" });
const inactiveTurn = fakeToggleNode({ turnGroup: "turn-1" });
const activeRequest = fakeToggleNode({ card: "request-2" });
timelineRoot.queries.set("[data-turn-group]", [inactiveTurn, activeTurn]);
timelineRoot.queries.set("[data-card]", [activeRequest]);
controller.render({ queryHtml: "query", timelineHtml: "timeline", activeTurnId: "turn-2", activeRequestId: "request-2" });
assert.equal(queryRoot.innerHTML, "query");
assert.equal(timelineRoot.innerHTML, "timeline");
assert.deepEqual(inactiveTurn.toggles, [["active", false]]);
assert.deepEqual(activeTurn.toggles, [["active", true]]);
assert.deepEqual(activeRequest.toggles, [["active", true]]);

const searchInput = fakeElement("[data-trace-search]", { value: "上下文" }, queryRoot);
searchInput.value = "上下文";
searchInput.focused = false;
searchInput.selection = null;
searchInput.focus = () => {
  searchInput.focused = true;
};
searchInput.setSelectionRange = (start, end) => {
  searchInput.selection = [start, end];
};
queryRoot.queries.set("[data-trace-search]", searchInput);
queryRoot.emit("compositionstart", eventFor(searchInput));
queryRoot.emit("input", eventFor(searchInput, { isComposing: true }));
assert.equal(pendingTimer, null, "IME composition must not redraw the query field");
queryRoot.emit("compositionend", eventFor(searchInput));
assert.equal(typeof pendingTimer, "function");
pendingTimer();
assert.deepEqual(
  calls.filter(([name]) => name === "onQueryChange").map(([, value]) => value),
  ["上下文", "上下文"],
  "the query state should follow composition without converting the text",
);
assert.equal(calls.some(([name]) => name === "onRenderRequested"), true);
assert.equal(searchInput.focused, true);
assert.deepEqual(searchInput.selection, [3, 3]);

const filterButton = fakeElement("[data-trace-filter]", { traceFilter: "tools" }, queryRoot);
queryRoot.emit("click", eventFor(filterButton));
const moreButton = fakeElement("[data-trace-more]", {}, queryRoot);
queryRoot.emit("click", eventFor(moreButton));
assert.equal(calls.some(([name, value]) => name === "onFilter" && value === "tools"), true);
assert.equal(calls.some(([name]) => name === "onShowMore"), true);

const rawButton = fakeElement("[data-raw]", { raw: "request-7", rawSection: "system", rawMode: "request" }, timelineRoot);
timelineRoot.emit("click", eventFor(rawButton));
assert.deepEqual(calls.find(([name]) => name === "onRaw"), [
  "onRaw",
  { type: "raw", requestId: "request-7", section: "system", mode: "request" },
]);
const statusButton = fakeElement(
  "[data-agent-status-filter]",
  { agentStatusFilter: "turn-3", agentFilterValue: "returned" },
  timelineRoot,
);
timelineRoot.emit("click", eventFor(statusButton));
assert.deepEqual(calls.find(([name]) => name === "onAgentStatusFilter"), [
  "onAgentStatusFilter",
  { type: "agent-status-filter", turnId: "turn-3", filter: "returned" },
]);
const panel = fakeElement("[data-upstream-panel]", { upstreamPanel: "request-9" }, timelineRoot);
timelineRoot.emit("toggle", eventFor(panel));
assert.deepEqual(calls.find(([name]) => name === "onUpstreamPanelToggle"), ["onUpstreamPanelToggle", panel]);

assert.deepEqual(
  timelineAction(fakeElement("[data-agent-branch-jump]", { agentBranchJump: "branch-1" }, timelineRoot), timelineRoot),
  { type: "agent-branch-jump", branchId: "branch-1" },
);
assert.equal(timelineAction(fakeElement("[data-raw]", { raw: "outside" }, queryRoot), timelineRoot), null, "actions outside the Timeline root must be ignored");

console.log("trace timeline controller contract smoke passed");

function fakeElement(selector, dataset, root) {
  return {
    root,
    dataset,
    closest(candidate) {
      return candidate === selector ? this : null;
    },
  };
}

function fakeToggleNode(dataset) {
  const toggles = [];
  return {
    dataset,
    toggles,
    classList: {
      toggle(name, value) {
        toggles.push([name, value]);
      },
    },
  };
}

function eventFor(target, extra = {}) {
  return {
    target,
    key: "",
    isComposing: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...extra,
  };
}
