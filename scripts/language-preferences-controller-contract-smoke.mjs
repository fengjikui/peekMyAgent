#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { ViewerClientStore } from "../src/viewer/client-store.js";
import {
  LANGUAGE_STORAGE_KEYS,
  LanguagePreferencesController,
} from "../src/viewer/language-preferences-controller.js";
import {
  defaultTranslationLanguage,
  normalizeTranslationLanguage,
  recommendTranslationLanguage,
  resolveTranslationLanguage,
  SUPPORTED_TRANSLATION_LANGUAGES,
  translationLanguageLabel,
} from "../src/viewer/translation-language-catalog.js";

function testLanguageCatalog() {
  assert.ok(SUPPORTED_TRANSLATION_LANGUAGES.length >= 150, "the full translation target catalog must remain available");
  assert.equal(resolveTranslationLanguage("Japanese")?.value, "ja");
  assert.equal(resolveTranslationLanguage("日本語 · ja")?.value, "ja");
  assert.equal(resolveTranslationLanguage("en-US")?.value, "en");
  assert.equal(resolveTranslationLanguage("zh-Hant")?.value, "zh-TW");
  assert.equal(resolveTranslationLanguage("not-a-language"), null);
  assert.equal(normalizeTranslationLanguage("missing", "fr"), "fr");
  assert.equal(translationLanguageLabel("ja"), "日本語");
  assert.equal(recommendTranslationLanguage(["zh-HK", "en-US"]), "zh-TW");
  assert.equal(recommendTranslationLanguage(["pt-BR"]), "pt");
  assert.equal(recommendTranslationLanguage(["unknown"]), "");
  assert.equal(defaultTranslationLanguage(["unknown"]), "zh-CN");
}

async function testPreferenceLifecycle() {
  const storage = new FakeStorage({
    [LANGUAGE_STORAGE_KEYS.uiLanguage]: "invalid-ui",
  });
  const store = new ViewerClientStore();
  const uiSelect = new FakeSelect();
  const translationSelect = new FakeSelect();
  const staticText = new FakeNode({ i18n: "sessionsLabel" });
  const staticTitle = new FakeNode({ i18nTitle: "toggleSidebarTitle" });
  const staticAria = new FakeNode({ i18nAriaLabel: "toggleSidebarAria" });
  const documentTarget = new FakeDocument({ staticText, staticTitle, staticAria });
  const lifecycle = [];
  const controller = new LanguagePreferencesController({
    store,
    storage,
    documentTarget,
    navigatorTarget: { languages: ["ja-JP", "en-US"] },
    uiSelect,
    translationSelect,
    onUiLanguageChanged: async ({ uiLanguage }) => lifecycle.push(`ui:${uiLanguage}`),
    onTargetLanguageChanging: ({ previous, next }) => lifecycle.push(`before:${previous}->${next}`),
    onTargetLanguageChanged: async ({ previous, next }) => lifecycle.push(`after:${previous}->${next}`),
  });

  const hydrated = controller.readPreferences();
  assert.deepEqual(hydrated, {
    uiLanguage: "zh-CN",
    targetTranslationLanguage: "ja",
    translationMode: "source",
  });
  store.update(hydrated, { reason: "hydrate", silent: true });
  controller.applyStaticI18n();
  controller.renderSelectors();
  assert.equal(documentTarget.documentElement.lang, "zh-CN");
  assert.equal(staticText.textContent, "会话");
  assert.equal(staticTitle.attributes.title, "折叠会话栏");
  assert.equal(staticAria.attributes["aria-label"], "切换会话栏");
  assert.match(uiSelect.innerHTML, /value="zh-CN" selected/);
  assert.match(translationSelect.innerHTML, /value="ja" selected/);
  assert.equal(translationSelect.title, "搜索目标语言");

  await controller.setUiLanguage("en-US");
  assert.equal(store.state.uiLanguage, "en-US");
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEYS.uiLanguage), "en-US");
  assert.equal(documentTarget.documentElement.lang, "en-US");
  assert.equal(staticText.textContent, "Sessions");
  assert.equal(translationSelect.title, "Search language");

  assert.equal(await controller.setTargetTranslationLanguage("ja-JP"), false, "same normalized language is idempotent");
  assert.deepEqual(lifecycle, ["ui:en-US"]);

  assert.equal(await controller.setTargetTranslationLanguage("French"), true);
  assert.equal(store.state.targetTranslationLanguage, "fr");
  assert.equal(store.state.translationMode, "fr");
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEYS.targetTranslationLanguage), "fr");
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEYS.translationMode), "fr");
  assert.deepEqual(lifecycle, ["ui:en-US", "before:ja->fr", "after:ja->fr"]);
  assert.equal(controller.currentTargetLanguageLabel(), "French");

  assert.equal(controller.setTranslationMode("source"), "source");
  assert.equal(store.state.translationMode, "source");
  assert.equal(controller.setTranslationMode("fr"), "fr");
  assert.equal(store.state.translationMode, "fr");

  translationSelect.value = "not-a-language";
  assert.equal(await controller.setTargetLanguageFromSelect(), false);
  assert.equal(store.state.targetTranslationLanguage, "fr");
}

async function testBoundSelectEvents() {
  const warnings = [];
  const storage = new FakeStorage({
    [LANGUAGE_STORAGE_KEYS.targetTranslationLanguage]: "zh-CN",
  });
  const store = new ViewerClientStore({ targetTranslationLanguage: "zh-CN" });
  const uiSelect = new FakeSelect();
  const translationSelect = new FakeSelect();
  const controller = new LanguagePreferencesController({
    store,
    storage,
    documentTarget: new FakeDocument(),
    navigatorTarget: { language: "en-US" },
    uiSelect,
    translationSelect,
    onWarning: (message, error) => warnings.push([message, error]),
  });
  controller.bind();
  controller.bind();
  assert.equal(uiSelect.listenerCount("change"), 1, "bind must be idempotent");
  assert.equal(translationSelect.listenerCount("change"), 1, "bind must be idempotent");

  uiSelect.value = "en-US";
  uiSelect.dispatch("change");
  translationSelect.value = "Japanese";
  translationSelect.dispatch("change");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.state.uiLanguage, "en-US");
  assert.equal(store.state.targetTranslationLanguage, "ja");
  assert.deepEqual(warnings, []);
}

function testClientAssemblyBoundary() {
  const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
  assert.match(clientSource, /import \{ LanguagePreferencesController \} from "\.\/language-preferences-controller\.js";/);
  assert.match(clientSource, /const languagePreferencesController = new LanguagePreferencesController\(/);
  assert.doesNotMatch(clientSource, /const SUPPORTED_TRANSLATION_LANGUAGES/);
  assert.doesNotMatch(clientSource, /localStorage\.setItem\("peekmyagent\.(uiLanguage|targetTranslationLanguage|translationMode)"/);
}

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

class FakeSelect {
  constructor() {
    this.innerHTML = "";
    this.title = "";
    this.value = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this });
  }
}

class FakeNode {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.textContent = "";
    this.attributes = {};
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

class FakeDocument {
  constructor({ staticText = null, staticTitle = null, staticAria = null } = {}) {
    this.documentElement = { lang: "" };
    this.nodes = {
      "[data-i18n]": staticText ? [staticText] : [],
      "[data-i18n-title]": staticTitle ? [staticTitle] : [],
      "[data-i18n-aria-label]": staticAria ? [staticAria] : [],
    };
  }

  querySelectorAll(selector) {
    return this.nodes[selector] || [];
  }
}

testLanguageCatalog();
await testPreferenceLifecycle();
await testBoundSelectEvents();
testClientAssemblyBoundary();

console.log("language preferences controller contract smoke passed");
