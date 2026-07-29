export const THEME_STORAGE_KEY = "peekmyagent.theme";
// Keep the persisted ids stable: light = Codex, studio = Claude, dark = Dark.
export const SUPPORTED_THEMES = Object.freeze(["system", "light", "studio", "dark"]);

export class ThemeController {
  constructor({
    store,
    storage,
    documentTarget,
    select = null,
    translate = (key) => key,
    escapeHtml = escapeHtmlText,
  } = {}) {
    if (!store?.state || typeof store.setAppearance !== "function") {
      throw new TypeError("ThemeController requires a ViewerClientStore-compatible store");
    }
    if (!storage?.getItem || !storage?.setItem) {
      throw new TypeError("ThemeController requires a storage adapter");
    }
    if (!documentTarget?.documentElement) {
      throw new TypeError("ThemeController requires a document adapter");
    }
    this.store = store;
    this.storage = storage;
    this.documentTarget = documentTarget;
    this.select = select;
    this.translate = translate;
    this.escapeHtml = escapeHtml;
    this.bound = false;
  }

  readPreference() {
    return { theme: normalizeTheme(this.storage.getItem(THEME_STORAGE_KEY)) };
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.select?.addEventListener("change", (event) => this.setTheme(event.target.value));
  }

  setTheme(value) {
    const theme = normalizeTheme(value);
    this.store.setAppearance({ theme }, { reason: "set-theme" });
    this.applyCurrentTheme();
    this.renderSelector();
    return theme;
  }

  applyCurrentTheme({ persist = true } = {}) {
    const theme = normalizeTheme(this.store.state.theme);
    this.documentTarget.documentElement.dataset.theme = theme;
    if (persist) this.storage.setItem(THEME_STORAGE_KEY, theme);
    return theme;
  }

  renderSelector() {
    if (!this.select) return;
    const selected = normalizeTheme(this.store.state.theme);
    this.select.innerHTML = SUPPORTED_THEMES.map(
      (theme) =>
        `<option value="${this.escapeHtml(theme)}" ${theme === selected ? "selected" : ""}>${this.escapeHtml(
          this.translate(`theme_${theme}`),
        )}</option>`,
    ).join("");
    this.select.setAttribute("aria-label", this.translate("themeSelectAria"));
  }
}

export function normalizeTheme(value) {
  return SUPPORTED_THEMES.includes(value) ? value : "system";
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
