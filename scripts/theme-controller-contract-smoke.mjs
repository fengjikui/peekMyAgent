#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { ViewerClientStore } from "../src/viewer/client-store.js";
import {
  normalizeTheme,
  SUPPORTED_THEMES,
  THEME_STORAGE_KEY,
  ThemeController,
} from "../src/viewer/theme-controller.js";
import { UI_I18N } from "../src/viewer/ui-i18n.js";

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
assert.deepEqual(SUPPORTED_THEMES, ["system", "light", "studio", "dark"]);
assert.equal(UI_I18N["zh-CN"].theme_light, "Codex");
assert.equal(UI_I18N["zh-CN"].theme_studio, "Claude");
assert.equal(UI_I18N["zh-CN"].theme_dark, "暗夜");

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

const stylesSource = fs.readFileSync(new URL("../src/viewer/styles.css", import.meta.url), "utf8");
assert.match(stylesSource, /\.main-panel\s*\{[\s\S]*?background:\s*var\(--panel\);/, "the timeline should use the shared workspace surface");
assert.match(stylesSource, /\.raw-panel\s*\{[\s\S]*?background:\s*var\(--panel\);/, "the evidence pane should use the shared workspace surface");
assert.match(stylesSource, /\.topbar,[\s\S]*?\.raw-header\s*\{[\s\S]*?background:\s*var\(--panel\);/, "both pane headers should share one surface token");
assert.match(stylesSource, /--user-bubble:/, "every theme should expose a coordinated message-bubble surface");
assert.match(stylesSource, /:root\[data-theme="studio"\][\s\S]*?--canvas:\s*rgb\(249 249 247\);/, "the Claude theme should use the sampled neutral-warm canvas");
assert.match(stylesSource, /:root\[data-theme="studio"\][\s\S]*?--surface:\s*rgb\(249 249 247\);/, "the Claude timeline and evidence panes should use the sampled primary surface");
assert.match(stylesSource, /:root\[data-theme="studio"\][\s\S]*?--accent:\s*oklch\(66\.7% 0\.1081 42\);/, "the Claude theme should preserve the sampled terracotta accent");
assert.match(stylesSource, /:root\[data-theme="studio"\][\s\S]*?--accent-soft:\s*oklch\(96\.41% 0\.0126 228\.9\);/, "the Claude theme should use the sampled pale blue interaction surface");
assert.match(stylesSource, /:root\[data-theme="studio"\][\s\S]*?--user-bubble:\s*rgb\(242 242 240\);/, "the Claude theme should keep large message surfaces neutral and distinct");
assert.match(stylesSource, /--pane-divider:/, "every theme should provide one crisp pane divider color");

console.log("theme controller contract smoke passed");
