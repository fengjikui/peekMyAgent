import {
  clampRawPanelWidth,
  clampSidebarWidth,
  contentPanelWidth,
  maximumRawPanelWidth,
  maximumSidebarWidth,
  panelContentShare,
  PANE_LAYOUT_LIMITS,
} from "./pane-layout-model.js";

const STORAGE_KEYS = Object.freeze({
  rawOpen: "peekmyagent.rawOpen",
  rawWidth: "peekmyagent.rawWidth",
  sidebarOpen: "peekmyagent.sidebarOpen",
  sidebarWidth: "peekmyagent.sidebarWidth",
});

export class PaneLayoutController {
  constructor({
    appShell,
    rawPanel,
    rawResizer,
    rawToggle,
    sidebarResizer,
    sidebarToggle,
    documentTarget,
    windowTarget,
    storage,
    getLayoutState,
    setLayout,
    translate = (key) => key,
    onLayoutChanged = () => {},
    onWindowResize = () => {},
    limits = PANE_LAYOUT_LIMITS,
  }) {
    this.appShell = appShell;
    this.rawPanel = rawPanel;
    this.rawResizer = rawResizer;
    this.rawToggle = rawToggle;
    this.sidebarResizer = sidebarResizer;
    this.sidebarToggle = sidebarToggle;
    this.documentTarget = documentTarget;
    this.windowTarget = windowTarget;
    this.storage = storage;
    this.getLayoutState = getLayoutState;
    this.setLayoutState = setLayout;
    this.translate = translate;
    this.onLayoutChanged = onLayoutChanged;
    this.onWindowResize = onWindowResize;
    this.limits = limits;
    this.bound = false;
    this.listeners = [];
  }

  readPreferences() {
    const rawOpen = this.storage.getItem(STORAGE_KEYS.rawOpen) !== "false";
    const sidebarOpen = this.storage.getItem(STORAGE_KEYS.sidebarOpen) !== "false";
    const candidate = { ...this.getLayoutState(), rawOpen, sidebarOpen };
    const storedSidebarWidth = storedPositiveNumber(this.storage.getItem(STORAGE_KEYS.sidebarWidth));
    const sidebarWidth = storedSidebarWidth ? this.clampSidebarWidth(storedSidebarWidth, candidate) : 0;
    const storedRawWidth = storedPositiveNumber(this.storage.getItem(STORAGE_KEYS.rawWidth));
    const rawWidth = storedRawWidth ? this.clampRawWidth(storedRawWidth, { ...candidate, sidebarWidth }) : 0;
    return { rawOpen, rawWidth, sidebarOpen, sidebarWidth };
  }

  applyCurrentState({ persist = false } = {}) {
    const layout = this.getLayoutState();
    if (layout.rawWidth) this.applyRawWidth(layout.rawWidth);
    if (layout.sidebarWidth) this.applySidebarWidth(layout.sidebarWidth);
    this.setRawOpen(layout.rawOpen, { persist, notify: false });
    this.setSidebarOpen(layout.sidebarOpen, { persist, notify: false });
    this.onLayoutChanged();
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.listen(this.rawToggle, "click", () => this.setRawOpen(!this.getLayoutState().rawOpen));
    this.listen(this.sidebarToggle, "click", () => this.setSidebarOpen(!this.getLayoutState().sidebarOpen));
    this.bindRawResizer();
    this.bindSidebarResizer();
    this.listen(this.windowTarget, "resize", () => this.handleWindowResize());
  }

  destroy() {
    for (const { target, type, listener } of this.listeners.splice(0)) target.removeEventListener(type, listener);
    this.bound = false;
    this.appShell?.classList.remove("resizing-raw", "resizing-sidebar");
  }

  refreshLabels() {
    const layout = this.getLayoutState();
    if (this.rawToggle) this.rawToggle.title = this.translate(layout.rawOpen ? "toggleRawTitle" : "expandRawTitle");
    if (this.sidebarToggle) this.sidebarToggle.title = this.translate(layout.sidebarOpen ? "toggleSidebarTitle" : "expandSidebarTitle");
  }

  setRawOpen(open, { persist = true, notify = true } = {}) {
    const nextOpen = Boolean(open);
    this.setLayoutState({ rawOpen: nextOpen }, { reason: "set-raw-panel-open" });
    const layout = this.getLayoutState();
    if (nextOpen) {
      if (layout.rawWidth) this.applyRawWidth(layout.rawWidth);
      else this.appShell?.style.removeProperty("--raw-width");
    } else {
      this.appShell?.style.setProperty("--raw-width", "0px");
    }
    this.appShell?.classList.toggle("raw-collapsed", !nextOpen);
    this.rawToggle?.classList.toggle("active", nextOpen);
    this.rawToggle?.setAttribute("aria-pressed", String(nextOpen));
    if (persist) this.storage.setItem(STORAGE_KEYS.rawOpen, String(nextOpen));
    this.refreshLabels();
    if (notify) this.onLayoutChanged();
  }

  setSidebarOpen(open, { persist = true, notify = true } = {}) {
    const rawShare = this.rawPanelContentShare();
    const nextOpen = Boolean(open);
    this.setLayoutState({ sidebarOpen: nextOpen }, { reason: "set-sidebar-open" });
    const layout = this.getLayoutState();
    if (nextOpen) {
      if (layout.sidebarWidth) this.applySidebarWidth(layout.sidebarWidth);
      else this.appShell?.style.removeProperty("--sidebar-width");
    } else {
      this.appShell?.style.setProperty("--sidebar-width", "0px");
    }
    this.appShell?.classList.toggle("sidebar-collapsed", !nextOpen);
    this.sidebarToggle?.classList.toggle("active", nextOpen);
    this.sidebarToggle?.setAttribute("aria-pressed", String(nextOpen));
    if (persist) this.storage.setItem(STORAGE_KEYS.sidebarOpen, String(nextOpen));
    if (layout.rawOpen && layout.rawWidth) this.setRawWidthFromContentShare(rawShare, { persist: false, notify: false });
    this.refreshLabels();
    if (notify) this.onLayoutChanged();
  }

  setRawWidth(width, { persist = true, notify = true } = {}) {
    const nextWidth = this.clampRawWidth(width);
    this.setLayoutState({ rawWidth: nextWidth }, { reason: "set-raw-panel-width" });
    this.applyRawWidth(nextWidth);
    if (persist) this.storage.setItem(STORAGE_KEYS.rawWidth, String(nextWidth));
    if (notify) this.onLayoutChanged();
    return nextWidth;
  }

  setSidebarWidth(width, { persist = true, notify = true } = {}) {
    const nextWidth = this.clampSidebarWidth(width);
    this.setLayoutState({ sidebarWidth: nextWidth }, { reason: "set-sidebar-width" });
    this.applySidebarWidth(nextWidth);
    if (persist) this.storage.setItem(STORAGE_KEYS.sidebarWidth, String(nextWidth));
    const layout = this.getLayoutState();
    if (layout.rawOpen && layout.rawWidth) this.setRawWidth(layout.rawWidth, { persist: false, notify: false });
    if (notify) this.onLayoutChanged();
    return nextWidth;
  }

  handleWindowResize() {
    const layout = this.getLayoutState();
    if (layout.sidebarWidth) this.setSidebarWidth(layout.sidebarWidth, { persist: false, notify: false });
    if (layout.rawWidth) this.setRawWidth(layout.rawWidth, { persist: false, notify: false });
    this.onWindowResize();
    this.onLayoutChanged();
  }

  bindRawResizer() {
    if (!this.rawResizer) return;
    this.listen(this.rawResizer, "pointerdown", (event) => {
      if (this.isCompactViewport()) return;
      event.preventDefault();
      this.setRawOpen(true);
      this.appShell.classList.add("resizing-raw");
      this.rawResizer.setPointerCapture?.(event.pointerId);
      this.updateRawWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.rawResizer, "mousedown", (event) => {
      if (this.appShell.classList.contains("resizing-raw") || this.isCompactViewport()) return;
      event.preventDefault();
      this.setRawOpen(true);
      this.appShell.classList.add("resizing-raw");
      this.updateRawWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.rawResizer, "pointermove", (event) => {
      if (this.appShell.classList.contains("resizing-raw")) this.updateRawWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.documentTarget, "mousemove", (event) => {
      if (this.appShell.classList.contains("resizing-raw")) this.updateRawWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.rawResizer, "pointerup", (event) => this.finishRawResize(event));
    this.listen(this.rawResizer, "pointercancel", (event) => this.finishRawResize(event));
    this.listen(this.documentTarget, "mouseup", (event) => this.finishRawResize(event));
    this.listen(this.rawResizer, "keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.setRawOpen(true);
      const step = event.shiftKey ? 80 : 24;
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      const layout = this.getLayoutState();
      this.setRawWidth((layout.rawWidth || this.currentRawWidth()) + direction * step);
    });
  }

  bindSidebarResizer() {
    if (!this.sidebarResizer) return;
    this.listen(this.sidebarResizer, "pointerdown", (event) => {
      if (this.isCompactViewport()) return;
      event.preventDefault();
      this.setSidebarOpen(true);
      this.appShell.classList.add("resizing-sidebar");
      this.sidebarResizer.setPointerCapture?.(event.pointerId);
      this.updateSidebarWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.sidebarResizer, "mousedown", (event) => {
      if (this.appShell.classList.contains("resizing-sidebar") || this.isCompactViewport()) return;
      event.preventDefault();
      this.setSidebarOpen(true);
      this.appShell.classList.add("resizing-sidebar");
      this.updateSidebarWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.sidebarResizer, "pointermove", (event) => {
      if (this.appShell.classList.contains("resizing-sidebar")) this.updateSidebarWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.documentTarget, "mousemove", (event) => {
      if (this.appShell.classList.contains("resizing-sidebar")) this.updateSidebarWidthFromPointer(event.clientX, { persist: false });
    });
    this.listen(this.sidebarResizer, "pointerup", (event) => this.finishSidebarResize(event));
    this.listen(this.sidebarResizer, "pointercancel", (event) => this.finishSidebarResize(event));
    this.listen(this.documentTarget, "mouseup", (event) => this.finishSidebarResize(event));
    this.listen(this.sidebarResizer, "keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.setSidebarOpen(true);
      const step = event.shiftKey ? 80 : 24;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const layout = this.getLayoutState();
      this.setSidebarWidth((layout.sidebarWidth || this.currentSidebarWidth()) + direction * step);
    });
  }

  finishRawResize(event) {
    if (!this.appShell?.classList.contains("resizing-raw")) return;
    this.appShell.classList.remove("resizing-raw");
    try {
      this.rawResizer?.releasePointerCapture?.(event.pointerId);
    } catch {
      // Browsers may release capture before pointercancel is delivered.
    }
    const width = this.getLayoutState().rawWidth;
    if (width) this.storage.setItem(STORAGE_KEYS.rawWidth, String(width));
    this.onLayoutChanged();
  }

  finishSidebarResize(event) {
    if (!this.appShell?.classList.contains("resizing-sidebar")) return;
    this.appShell.classList.remove("resizing-sidebar");
    try {
      this.sidebarResizer?.releasePointerCapture?.(event.pointerId);
    } catch {
      // Browsers may release capture before pointercancel is delivered.
    }
    const width = this.getLayoutState().sidebarWidth;
    if (width) this.storage.setItem(STORAGE_KEYS.sidebarWidth, String(width));
    this.onLayoutChanged();
  }

  updateRawWidthFromPointer(clientX, options) {
    const shellRect = this.appShell.getBoundingClientRect();
    return this.setRawWidth(shellRect.right - clientX, options);
  }

  updateSidebarWidthFromPointer(clientX, options) {
    const shellRect = this.appShell.getBoundingClientRect();
    return this.setSidebarWidth(clientX - shellRect.left, options);
  }

  applyRawWidth(width) {
    this.appShell?.style.setProperty("--raw-width", `${Math.round(width)}px`);
    this.rawResizer?.setAttribute("aria-valuenow", String(Math.round(width)));
    this.rawResizer?.setAttribute("aria-valuemin", String(this.limits.rawMin));
    this.rawResizer?.setAttribute("aria-valuemax", String(Math.round(this.maximumRawWidth())));
  }

  applySidebarWidth(width) {
    this.appShell?.style.setProperty("--sidebar-width", `${Math.round(width)}px`);
    this.sidebarResizer?.setAttribute("aria-valuenow", String(Math.round(width)));
    this.sidebarResizer?.setAttribute("aria-valuemin", String(this.limits.sidebarMin));
    this.sidebarResizer?.setAttribute("aria-valuemax", String(Math.round(this.maximumSidebarWidth())));
  }

  rawPanelContentShare() {
    if (!this.getLayoutState().rawOpen) return 0;
    return panelContentShare(this.currentRawWidth(), this.currentContentWidth());
  }

  setRawWidthFromContentShare(share, options) {
    const layout = this.getLayoutState();
    return this.setRawWidth(share ? this.currentContentWidth() * share : layout.rawWidth || this.currentRawWidth(), options);
  }

  currentContentWidth() {
    const layout = this.getLayoutState();
    return contentPanelWidth({
      shellWidth: this.shellWidth(),
      sidebarOpen: layout.sidebarOpen,
      sidebarWidth: layout.sidebarWidth || this.currentSidebarWidth(),
      rawOpen: layout.rawOpen,
    }, this.limits);
  }

  currentRawWidth() {
    return this.rawPanel?.getBoundingClientRect().width || Math.min(Math.max(this.windowTarget.innerWidth * 0.34, 380), 560);
  }

  currentSidebarWidth() {
    const value = this.windowTarget.getComputedStyle?.(this.appShell).getPropertyValue("--sidebar-width");
    return Number.parseFloat(value) || this.limits.sidebarMin;
  }

  clampRawWidth(width, layout = this.getLayoutState()) {
    return clampRawPanelWidth(width, {
      shellWidth: this.shellWidth(),
      sidebarOpen: layout.sidebarOpen,
      sidebarWidth: layout.sidebarWidth || this.currentSidebarWidth(),
    }, this.limits);
  }

  clampSidebarWidth(width, layout = this.getLayoutState()) {
    return clampSidebarWidth(width, {
      shellWidth: this.shellWidth(),
      rawOpen: layout.rawOpen,
      rawWidth: layout.rawWidth || this.currentRawWidth(),
    }, this.limits);
  }

  maximumRawWidth() {
    const layout = this.getLayoutState();
    return maximumRawPanelWidth({
      shellWidth: this.shellWidth(),
      sidebarOpen: layout.sidebarOpen,
      sidebarWidth: layout.sidebarWidth || this.currentSidebarWidth(),
    }, this.limits);
  }

  maximumSidebarWidth() {
    const layout = this.getLayoutState();
    return maximumSidebarWidth({
      shellWidth: this.shellWidth(),
      rawOpen: layout.rawOpen,
      rawWidth: layout.rawWidth || this.currentRawWidth(),
    }, this.limits);
  }

  shellWidth() {
    return this.appShell?.getBoundingClientRect().width || this.windowTarget.innerWidth;
  }

  isCompactViewport() {
    return Boolean(this.windowTarget.matchMedia?.("(max-width: 1080px)").matches);
  }

  listen(target, type, listener) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, listener });
  }
}

function storedPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
