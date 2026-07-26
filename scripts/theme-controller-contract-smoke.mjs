#!/usr/bin/env node
import assert from "node:assert/strict";
import { ViewerClientStore } from "../src/viewer/client-store.js";
import {
  normalizeTheme,
  THEME_STORAGE_KEY,
  ThemeController,
} from "../src/viewer/theme-controller.js";

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

class FakeSelect {
  constructor() {
    this.innerHTML = "";
    this.attributes = {};
    this.listeners = [];
  }

  addEventListener(type, listener) {
    if (type === "change") this.listeners.push(listener);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  dispatch(value) {
    for (const listener of this.listeners) listener({ target: { value } });
  }
}

assert.equal(normalizeTheme("dark"), "dark");
assert.equal(normalizeTheme("unknown"), "system");

const storage = new FakeStorage({ [THEME_STORAGE_KEY]: "studio" });
const store = new ViewerClientStore();
const select = new FakeSelect();
const documentTarget = { documentElement: { dataset: {} } };
const controller = new ThemeController({
  store,
  storage,
  documentTarget,
  select,
  translate: (key) => `translated:${key}`,
});

store.update(controller.readPreference(), { reason: "hydrate", silent: true });
assert.equal(store.state.theme, "studio");
controller.applyCurrentTheme({ persist: false });
controller.renderSelector();
assert.equal(documentTarget.documentElement.dataset.theme, "studio");
assert.match(select.innerHTML, /value="studio" selected/);
assert.match(select.innerHTML, /translated:theme_dark/);
assert.equal(select.attributes["aria-label"], "translated:themeSelectAria");

controller.bind();
controller.bind();
assert.equal(select.listeners.length, 1);
select.dispatch("dark");
assert.equal(store.state.theme, "dark");
assert.equal(documentTarget.documentElement.dataset.theme, "dark");
assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark");

console.log("theme controller contract smoke passed");
