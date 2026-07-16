#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { PaneLayoutController } from "../src/viewer/pane-layout-controller.js";
import {
  clampRawPanelWidth,
  clampSidebarWidth,
  contentPanelWidth,
  maximumRawPanelWidth,
  maximumSidebarWidth,
  panelContentShare,
} from "../src/viewer/pane-layout-model.js";

assert.equal(maximumRawPanelWidth({ shellWidth: 1400, sidebarOpen: true, sidebarWidth: 300 }), 568);
assert.equal(maximumRawPanelWidth({ shellWidth: 1400, sidebarOpen: false, sidebarWidth: 300 }), 760);
assert.equal(maximumSidebarWidth({ shellWidth: 1400, rawOpen: true, rawWidth: 400 }), 420);
assert.equal(maximumSidebarWidth({ shellWidth: 1000, rawOpen: true, rawWidth: 320 }), 220);
assert.equal(clampRawPanelWidth(900, { shellWidth: 1400, sidebarOpen: true, sidebarWidth: 300 }), 568);
assert.equal(clampSidebarWidth(100, { shellWidth: 1400, rawOpen: true, rawWidth: 400 }), 220);
assert.equal(contentPanelWidth({ shellWidth: 1400, sidebarOpen: true, sidebarWidth: 300, rawOpen: true }), 1088);
assert.equal(panelContentShare(400, 1000), 0.4);
assert.equal(panelContentShare(400, 0), 0);

const appShell = fakeElement({ left: 0, right: 1400, width: 1400 });
const rawPanel = fakeElement({ width: 400 });
rawPanel.getBoundingClientRect = () => ({
  left: 0,
  right: 0,
  width: Number.parseFloat(appShell.style.value("--raw-width")) || 400,
});
const rawResizer = fakeElement();
const rawToggle = fakeElement();
const sidebarResizer = fakeElement();
const sidebarToggle = fakeElement();
const documentTarget = fakeEventTarget();
const windowTarget = fakeEventTarget({
  innerWidth: 1400,
  matchMedia: () => ({ matches: false }),
  getComputedStyle: () => ({ getPropertyValue: () => "300px" }),
});
const storageValues = new Map([
  ["peekmyagent.rawOpen", "true"],
  ["peekmyagent.rawWidth", "500"],
  ["peekmyagent.sidebarOpen", "true"],
  ["peekmyagent.sidebarWidth", "300"],
]);
const storage = {
  getItem(key) {
    return storageValues.get(key) ?? null;
  },
  setItem(key, value) {
    storageValues.set(key, String(value));
  },
};
const state = { rawOpen: true, rawWidth: 0, sidebarOpen: true, sidebarWidth: 0 };
const changes = [];
let layoutNotifications = 0;
let windowResizeNotifications = 0;
const controller = new PaneLayoutController({
  appShell,
  rawPanel,
  rawResizer,
  rawToggle,
  sidebarResizer,
  sidebarToggle,
  documentTarget,
  windowTarget,
  storage,
  getLayoutState: () => state,
  setLayout(patch, options) {
    Object.assign(state, patch);
    changes.push({ patch, options });
  },
  translate: (key) => `translated:${key}`,
  onLayoutChanged: () => layoutNotifications++,
  onWindowResize: () => windowResizeNotifications++,
});

assert.deepEqual(controller.readPreferences(), { rawOpen: true, rawWidth: 500, sidebarOpen: true, sidebarWidth: 300 });
Object.assign(state, controller.readPreferences());
controller.applyCurrentState({ persist: false });
assert.equal(appShell.style.value("--raw-width"), "500px");
assert.equal(appShell.style.value("--sidebar-width"), "300px");
assert.equal(rawToggle.attributes.get("aria-pressed"), "true");
assert.equal(sidebarToggle.title, "translated:toggleSidebarTitle");

controller.bind();
controller.bind();
assert.equal(rawToggle.listenerCount("click"), 1, "bind must be idempotent");
assert.equal(sidebarToggle.listenerCount("click"), 1);
assert.equal(documentTarget.listenerCount("mousemove"), 2, "both resizers share one document lifecycle each");
assert.equal(windowTarget.listenerCount("resize"), 1);

sidebarToggle.dispatch("click", event());
assert.equal(state.sidebarOpen, false);
assert.equal(storageValues.get("peekmyagent.sidebarOpen"), "false");
assert.equal(appShell.classList.contains("sidebar-collapsed"), true);
assert.equal(sidebarToggle.title, "translated:expandSidebarTitle");
assert.ok(state.rawWidth > 500, "the raw pane should preserve its content share when the sidebar collapses");

rawToggle.dispatch("click", event());
assert.equal(state.rawOpen, false);
assert.equal(appShell.style.value("--raw-width"), "0px");
assert.equal(rawToggle.title, "translated:expandRawTitle");

rawResizer.dispatch("keydown", event({ key: "ArrowLeft" }));
assert.equal(state.rawOpen, true);
assert.ok(Number(storageValues.get("peekmyagent.rawWidth")) >= 320);

sidebarResizer.dispatch("pointerdown", event({ clientX: 260, pointerId: 7 }));
assert.equal(appShell.classList.contains("resizing-sidebar"), true);
documentTarget.dispatch("mousemove", event({ clientX: 340 }));
sidebarResizer.dispatch("pointerup", event({ pointerId: 7 }));
assert.equal(appShell.classList.contains("resizing-sidebar"), false);
assert.equal(state.sidebarWidth, 340);
assert.equal(storageValues.get("peekmyagent.sidebarWidth"), "340");

windowTarget.dispatch("resize", event());
assert.equal(windowResizeNotifications, 1);
assert.ok(layoutNotifications > 0);
assert.ok(changes.some((change) => change.options.reason === "set-raw-panel-open"));
assert.ok(changes.some((change) => change.options.reason === "set-sidebar-width"));

const controllerSource = fs.readFileSync(new URL("../src/viewer/pane-layout-controller.js", import.meta.url), "utf8");
const modelSource = fs.readFileSync(new URL("../src/viewer/pane-layout-model.js", import.meta.url), "utf8");
assert.doesNotMatch(modelSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(controllerSource, /\blocalStorage\b|\bfetch\s*\(|\bstate\./);

controller.destroy();
assert.equal(rawToggle.listenerCount("click"), 0);
assert.equal(sidebarToggle.listenerCount("click"), 0);
assert.equal(documentTarget.listenerCount("mousemove"), 0);
assert.equal(windowTarget.listenerCount("resize"), 0);

console.log("pane layout controller contract smoke passed");

function event(overrides = {}) {
  return {
    key: "",
    shiftKey: false,
    clientX: 0,
    pointerId: 1,
    preventDefault() {},
    ...overrides,
  };
}

function fakeElement(rect = {}) {
  const target = fakeEventTarget();
  const classes = new Set();
  const attributes = new Map();
  const styles = new Map();
  return Object.assign(target, {
    title: "",
    attributes,
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) {
        styles.set(name, value);
      },
      removeProperty(name) {
        styles.delete(name);
      },
      value(name) {
        return styles.get(name);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getBoundingClientRect() {
      return { left: 0, right: 0, width: 0, ...rect };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  });
}

function fakeEventTarget(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, value) {
      for (const listener of listeners.get(type) || []) listener(value);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}
