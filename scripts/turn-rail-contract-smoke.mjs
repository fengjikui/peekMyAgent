#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  TURN_RAIL_MAX_ITEMS,
  TURN_RAIL_MIN_ITEMS,
  TurnRailController,
  hoverClassForDistance,
  railMaxItems,
  visibleTurnWindow,
} from "../src/viewer/turn-rail.js";
import {
  REQUEST_RAIL_THRESHOLD,
  RequestRailController,
  visibleRequestWindow,
} from "../src/viewer/request-rail.js";

const turns = Array.from({ length: 100 }, (_, index) => ({ id: `turn-${index + 1}`, index: index + 1 }));

assert.equal(railMaxItems(400), TURN_RAIL_MIN_ITEMS, "short viewports should retain the minimum navigation density");
assert.equal(railMaxItems(780), 40, "ordinary viewports should derive the rail size from available height");
assert.equal(railMaxItems(2000), TURN_RAIL_MAX_ITEMS, "tall viewports should cap the number of rail marks");

assert.deepEqual(visibleTurnWindow(turns.slice(0, 12), "turn-6", 24), turns.slice(0, 12));
assert.deepEqual(visibleTurnWindow(turns, "turn-1", 24), turns.slice(0, 24), "the first turn should anchor the first window");
assert.deepEqual(visibleTurnWindow(turns, "turn-50", 24), turns.slice(37, 61), "the active turn should remain near the middle");
assert.deepEqual(visibleTurnWindow(turns, "turn-100", 24), turns.slice(76), "the last turn should anchor the final window");
assert.deepEqual(visibleTurnWindow(turns, "missing", 24), turns.slice(0, 24), "an unknown active turn should fail safely at the start");

assert.equal(hoverClassForDistance(0), "hover-center");
assert.equal(hoverClassForDistance(-1), "hover-near-1");
assert.equal(hoverClassForDistance(2), "hover-near-2");
assert.equal(hoverClassForDistance(-3), "hover-near-3");
assert.equal(hoverClassForDistance(4), "");
assert.equal(hoverClassForDistance(0, false), "");

const activeChanges = [];
let activeId = "turn-a";
const mainPanel = { scrollTop: 390, scrollHeight: 1300, clientHeight: 200, addEventListener() {} };
const groups = [
  { offsetTop: 0, dataset: { turnGroup: "turn-a" } },
  { offsetTop: 400, dataset: { turnGroup: "turn-b" } },
  { offsetTop: 800, dataset: { turnGroup: "turn-c" } },
];
const controller = new TurnRailController({
  element: null,
  mainPanel,
  getTurns: () => [],
  getActiveId: () => activeId,
  hasData: () => true,
  titleFor: () => "",
  excerptFor: () => "",
  translate: (key) => key,
  escapeHtml: String,
  onJump() {},
  onActiveChange(id, scroll) {
    activeChanges.push({ id, scroll });
    activeId = id;
  },
  documentRef: { querySelectorAll: () => groups },
  windowRef: { innerHeight: 800, requestAnimationFrame: (callback) => callback() },
});

controller.syncActiveFromScroll();
assert.deepEqual(activeChanges, [{ id: "turn-b", scroll: false }], "scroll position should activate the nearest rendered turn");
mainPanel.scrollTop = 1100;
controller.syncActiveFromScroll();
assert.deepEqual(activeChanges.at(-1), { id: "turn-c", scroll: false }, "the bottom snap should activate the final rendered turn");
controller.syncActiveFromScroll();
assert.equal(activeChanges.length, 2, "an already-active turn should not emit duplicate state changes");

const longTurnChanges = [];
let longTurnActiveId = "turn-long";
const longTurnPanel = { scrollTop: 1200, scrollHeight: 2800, clientHeight: 400, addEventListener() {} };
const longTurnController = new TurnRailController({
  element: null,
  mainPanel: longTurnPanel,
  getTurns: () => [],
  getActiveId: () => longTurnActiveId,
  hasData: () => true,
  titleFor: () => "",
  excerptFor: () => "",
  translate: (key) => key,
  escapeHtml: String,
  onJump() {},
  onActiveChange(id, scroll) {
    longTurnChanges.push({ id, scroll });
    longTurnActiveId = id;
  },
  documentRef: {
    querySelectorAll: () => [
      { offsetTop: 0, dataset: { turnGroup: "turn-long" } },
      { offsetTop: 2000, dataset: { turnGroup: "turn-next" } },
    ],
  },
  windowRef: { innerHeight: 800, requestAnimationFrame: (callback) => callback() },
});
longTurnController.syncActiveFromScroll();
assert.deepEqual(longTurnChanges, [], "a long Turn stays active until the next Turn heading reaches the activation line");
longTurnPanel.scrollTop = 1900;
longTurnController.syncActiveFromScroll();
assert.deepEqual(longTurnChanges, [{ id: "turn-next", scroll: false }]);

const requestChanges = [];
let activeRequestId = "request-a";
const activeTurnRequests = Array.from({ length: REQUEST_RAIL_THRESHOLD }, (_, index) => ({
  id: `request-${String.fromCharCode(97 + index)}`,
  request_index: index + 1,
}));
const requestCards = activeTurnRequests.map((request, index) => ({
  offsetTop: index * 140,
  dataset: { card: request.id },
}));
const activeGroup = {
  dataset: { turnGroup: "turn-active" },
  querySelectorAll: () => requestCards,
};
const requestPanel = { scrollTop: 180, scrollHeight: 900, clientHeight: 220, addEventListener() {} };
const requestController = new RequestRailController({
  element: null,
  mainPanel: requestPanel,
  getRequests: () => activeTurnRequests,
  getActiveId: () => activeRequestId,
  getActiveTurnId: () => "turn-active",
  titleFor: () => "",
  excerptFor: () => "",
  translate: (key) => key,
  escapeHtml: String,
  onJump() {},
  onActiveChange(id, scroll) {
    requestChanges.push({ id, scroll });
    activeRequestId = id;
  },
  documentRef: { querySelectorAll: () => [activeGroup] },
  windowRef: { innerHeight: 800, requestAnimationFrame: (callback) => callback() },
});
requestController.syncActiveFromScroll();
assert.deepEqual(requestChanges, [{ id: "request-c", scroll: false }], "request rail should track the nearest main request in the active Turn");
assert.deepEqual(visibleRequestWindow(activeTurnRequests, "request-c", 3), activeTurnRequests.slice(1, 4));
requestPanel.scrollTop = 680;
requestController.syncActiveFromScroll();
assert.deepEqual(requestChanges.at(-1), { id: "request-e", scroll: false }, "request rail should snap to the final request at the bottom");

console.log("turn rail contract smoke passed");
