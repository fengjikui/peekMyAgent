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

console.log("turn rail contract smoke passed");
