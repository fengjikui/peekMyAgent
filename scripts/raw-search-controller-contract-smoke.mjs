#!/usr/bin/env node
import assert from "node:assert/strict";
import { RawSearchController } from "../src/viewer/raw-search-controller.js";

const listeners = new Map();
const scheduled = [];
let renderCount = 0;
let prevented = 0;
const input = fakeTarget("[data-raw-search]", { value: "Claude" });
const clearButton = fakeTarget("[data-raw-search-clear]");
const root = {
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  contains() {
    return true;
  },
  querySelector(selector) {
    return selector === "[data-raw-search]" ? input : null;
  },
  querySelectorAll() {
    return [];
  },
};
const scheduler = {
  setTimeout(callback) {
    scheduled.push(callback);
    return scheduled.length;
  },
  clearTimeout() {},
  requestAnimationFrame(callback) {
    callback();
  },
};
const controller = new RawSearchController({
  root,
  scheduler,
  getContext: () => ({ requestId: "request-1", section: "system", mode: "request" }),
  render: () => {
    renderCount += 1;
  },
});

controller.bind();
controller.bind();
assert.deepEqual([...listeners.keys()].sort(), ["click", "compositionend", "compositionstart", "input", "keydown"]);

listeners.get("input")({ target: input, isComposing: false });
assert.equal(controller.query, "Claude");
assert.equal(controller.activeIndex, 0);
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.equal(renderCount, 1);

listeners.get("compositionstart")({ target: input });
assert.equal(controller.isComposing(), true);
input.value = "中文";
listeners.get("input")({ target: input, isComposing: true });
assert.equal(scheduled.length, 0, "IME input must not render during composition");
listeners.get("compositionend")({ target: input });
assert.equal(controller.isComposing(), false);
assert.equal(controller.query, "中文");
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.equal(renderCount, 2);

listeners.get("keydown")({ target: input, key: "Enter", isComposing: false, preventDefault: () => (prevented += 1) });
assert.equal(prevented, 1);

listeners.get("click")({ target: clearButton });
assert.equal(controller.query, "");
assert.equal(controller.position(0), "0/0");
assert.equal(controller.position(3), "1/3");
assert.equal(renderCount, 3);

console.log("raw search controller contract smoke passed");

function fakeTarget(selector, properties = {}) {
  return {
    ...properties,
    dataset: selector === "[data-raw-search-clear]" ? { rawSearchClear: "true" } : {},
    closest(candidate) {
      return candidate === selector ? this : null;
    },
    focus() {},
    setSelectionRange() {},
  };
}
