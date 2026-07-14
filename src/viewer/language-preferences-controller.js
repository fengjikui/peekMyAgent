import { translateUi } from "./ui-i18n.js";
import {
  defaultTranslationLanguage,
  normalizeTranslationLanguage,
  normalizeUiLanguage,
  resolveTranslationLanguage,
  SUPPORTED_TRANSLATION_LANGUAGES,
  SUPPORTED_UI_LANGUAGES,
  translationLanguageLabel,
} from "./translation-language-catalog.js";

export const LANGUAGE_STORAGE_KEYS = Object.freeze({
  uiLanguage: "peekmyagent.uiLanguage",
  targetTranslationLanguage: "peekmyagent.targetTranslationLanguage",
  translationMode: "peekmyagent.translationMode",
});

export class LanguagePreferencesController {
  constructor({
    store,
    storage,
    documentTarget,
    navigatorTarget = {},
    uiSelect = null,
    translationSelect = null,
    escapeHtml = escapeHtmlText,
    onUiLanguageChanged = async () => {},
    onTargetLanguageChanging = () => {},
    onTargetLanguageChanged = async () => {},
    onWarning = () => {},
  } = {}) {
    if (!store?.state || typeof store.setLanguage !== "function") {
      throw new TypeError("LanguagePreferencesController requires a ViewerClientStore-compatible store");
    }
    if (!storage?.getItem || !storage?.setItem) {
      throw new TypeError("LanguagePreferencesController requires a storage adapter");
    }
    if (!documentTarget?.documentElement || typeof documentTarget.querySelectorAll !== "function") {
      throw new TypeError("LanguagePreferencesController requires a document adapter");
    }
    this.store = store;
    this.storage = storage;
    this.documentTarget = documentTarget;
    this.navigatorTarget = navigatorTarget;
    this.uiSelect = uiSelect;
    this.translationSelect = translationSelect;
    this.escapeHtml = escapeHtml;
    this.onUiLanguageChanged = onUiLanguageChanged;
    this.onTargetLanguageChanging = onTargetLanguageChanging;
    this.onTargetLanguageChanged = onTargetLanguageChanged;
    this.onWarning = onWarning;
    this.bound = false;
  }

  get state() {
    return this.store.state;
  }

  translate(key, vars = {}) {
    return translateUi(this.state.uiLanguage, key, vars);
  }

  currentTargetLanguage() {
    return normalizeTranslationLanguage(this.state.targetTranslationLanguage);
  }

  currentTargetLanguageLabel() {
    return translationLanguageLabel(this.currentTargetLanguage());
  }

  readPreferences() {
    const storedTargetLanguage = this.storage.getItem(LANGUAGE_STORAGE_KEYS.targetTranslationLanguage);
    const targetTranslationLanguage = storedTargetLanguage
      ? normalizeTranslationLanguage(storedTargetLanguage)
      : defaultTranslationLanguage(this.browserLanguages());
    return {
      uiLanguage: normalizeUiLanguage(this.storage.getItem(LANGUAGE_STORAGE_KEYS.uiLanguage)),
      targetTranslationLanguage,
      translationMode:
        this.storage.getItem(LANGUAGE_STORAGE_KEYS.translationMode) === targetTranslationLanguage
          ? targetTranslationLanguage
          : "source",
    };
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.uiSelect?.addEventListener("change", (event) => {
      void this.setUiLanguage(event.target.value).catch((error) => this.onWarning("UI language change failed", error));
    });
    this.translationSelect?.addEventListener("change", () => {
      void this.setTargetLanguageFromSelect().catch((error) => this.onWarning("translation language change failed", error));
    });
  }

  renderSelectors() {
    if (this.uiSelect) {
      this.uiSelect.innerHTML = this.renderOptions(SUPPORTED_UI_LANGUAGES, this.state.uiLanguage);
    }
    if (this.translationSelect) {
      this.translationSelect.innerHTML = this.renderOptions(
        SUPPORTED_TRANSLATION_LANGUAGES,
        this.currentTargetLanguage(),
      );
      this.translationSelect.title = this.translate("translationLanguageSearchPlaceholder");
    }
  }

  applyStaticI18n() {
    this.documentTarget.documentElement.lang = this.state.uiLanguage;
    for (const node of this.documentTarget.querySelectorAll("[data-i18n]")) {
      node.textContent = this.translate(node.dataset.i18n);
    }
    for (const node of this.documentTarget.querySelectorAll("[data-i18n-title]")) {
      node.setAttribute("title", this.translate(node.dataset.i18nTitle));
    }
    for (const node of this.documentTarget.querySelectorAll("[data-i18n-aria-label]")) {
      node.setAttribute("aria-label", this.translate(node.dataset.i18nAriaLabel));
    }
  }

  async setUiLanguage(value) {
    const uiLanguage = normalizeUiLanguage(value);
    this.store.setLanguage({ uiLanguage }, { reason: "set-ui-language" });
    this.storage.setItem(LANGUAGE_STORAGE_KEYS.uiLanguage, uiLanguage);
    this.applyStaticI18n();
    this.renderSelectors();
    await this.onUiLanguageChanged({ uiLanguage });
  }

  async setTargetTranslationLanguage(value) {
    const next = normalizeTranslationLanguage(value);
    const previous = this.currentTargetLanguage();
    if (next === previous) {
      this.renderSelectors();
      return false;
    }
    this.onTargetLanguageChanging({ previous, next });
    this.store.setLanguage(
      { targetTranslationLanguage: next, translationMode: next },
      { reason: "set-translation-language" },
    );
    this.storage.setItem(LANGUAGE_STORAGE_KEYS.targetTranslationLanguage, next);
    this.storage.setItem(LANGUAGE_STORAGE_KEYS.translationMode, next);
    await this.onTargetLanguageChanged({ previous, next });
    this.renderSelectors();
    return true;
  }

  async setTargetLanguageFromSelect() {
    const resolved = resolveTranslationLanguage(this.translationSelect?.value);
    if (!resolved) {
      this.renderSelectors();
      return false;
    }
    return this.setTargetTranslationLanguage(resolved.value);
  }

  setTranslationMode(mode, { reason = "set-translation-mode" } = {}) {
    const targetLanguage = this.currentTargetLanguage();
    const translationMode = mode === targetLanguage ? targetLanguage : "source";
    this.store.setLanguage({ translationMode }, { reason });
    this.storage.setItem(LANGUAGE_STORAGE_KEYS.translationMode, translationMode);
    return translationMode;
  }

  browserLanguages() {
    if (Array.isArray(this.navigatorTarget.languages) && this.navigatorTarget.languages.length) {
      return this.navigatorTarget.languages;
    }
    return [this.navigatorTarget.language];
  }

  renderOptions(options, selected) {
    return options
      .map(
        (option) =>
          `<option value="${this.escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${this.escapeHtml(option.label)}</option>`,
      )
      .join("");
  }
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
