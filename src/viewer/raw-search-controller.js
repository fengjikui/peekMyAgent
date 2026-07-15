import {
  clampRawSearchIndex,
  escapeRawSearchRegExp,
  nextRawSearchIndex,
  normalizeRawSearchQuery,
} from "./raw-search-model.js";

export class RawSearchController {
  constructor({ root, render, getContext, translate, delay = 120, scheduler = globalThis }) {
    if (!root) throw new Error("RawSearchController root is required");
    if (typeof render !== "function") throw new Error("RawSearchController render is required");
    if (typeof getContext !== "function") throw new Error("RawSearchController getContext is required");
    this.root = root;
    this.render = render;
    this.getContext = getContext;
    this.translate = translate || ((key) => key);
    this.delay = delay;
    this.scheduler = scheduler;
    this.query = "";
    this.composing = false;
    this.activeIndex = 0;
    this.revealPending = false;
    this.timer = 0;
    this.bound = false;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("input", (event) => this.onInput(event));
    this.root.addEventListener("compositionstart", (event) => this.onCompositionStart(event));
    this.root.addEventListener("compositionend", (event) => this.onCompositionEnd(event));
    this.root.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  normalizedQuery() {
    return normalizeRawSearchQuery(this.query);
  }

  isComposing() {
    return this.composing;
  }

  contextChanged() {
    this.activeIndex = 0;
    this.revealPending = Boolean(this.normalizedQuery());
  }

  modeChanged() {
    this.contextChanged();
  }

  position(matchCount) {
    const count = Math.max(0, Number(matchCount) || 0);
    return count ? `${Math.min(this.activeIndex + 1, count)}/${count}` : "0/0";
  }

  decorate() {
    const query = this.normalizedQuery();
    if (!query) return;
    const targets = [...this.root.querySelectorAll("[data-raw-search-target]")];
    targets.forEach((target) => highlightRawSearchText(target, query));
    const matches = this.visibleMarks();
    this.activeIndex = clampRawSearchIndex(this.activeIndex, matches.length);
    this.syncActiveMatch(matches, this.revealPending);
    this.revealPending = false;
  }

  navigate(delta) {
    const matches = this.visibleMarks();
    if (!matches.length) return;
    this.activeIndex = nextRawSearchIndex(this.activeIndex, delta, matches.length);
    this.syncActiveMatch(matches, true);
  }

  clear() {
    this.cancelScheduledRender();
    this.query = "";
    this.activeIndex = 0;
    this.revealPending = false;
    this.renderCurrent();
  }

  onClick(event) {
    const navigation = event.target?.closest?.("[data-raw-search-nav]");
    if (navigation && this.root.contains(navigation)) {
      this.navigate(navigation.dataset.rawSearchNav === "previous" ? -1 : 1);
      return;
    }
    const clearButton = event.target?.closest?.("[data-raw-search-clear]");
    if (clearButton && this.root.contains(clearButton)) this.clear();
  }

  onInput(event) {
    const input = this.searchInput(event.target);
    if (!input) return;
    this.query = input.value || "";
    if (event.isComposing || this.composing) return;
    this.activeIndex = 0;
    this.revealPending = true;
    this.scheduleRender();
  }

  onCompositionStart(event) {
    if (!this.searchInput(event.target)) return;
    this.composing = true;
    this.cancelScheduledRender();
  }

  onCompositionEnd(event) {
    const input = this.searchInput(event.target);
    if (!input) return;
    this.composing = false;
    this.query = input.value || "";
    this.activeIndex = 0;
    this.revealPending = true;
    this.scheduleRender();
  }

  onKeyDown(event) {
    if (!this.searchInput(event.target)) return;
    if (event.key === "Enter" && !event.isComposing && !this.composing) event.preventDefault();
  }

  scheduleRender() {
    if (!this.getContext()?.requestId) return;
    this.cancelScheduledRender();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = 0;
      this.renderCurrent();
      this.scheduler.requestAnimationFrame?.(() => this.restoreInputFocus());
    }, this.delay);
  }

  cancelScheduledRender() {
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    this.timer = 0;
  }

  renderCurrent() {
    const context = this.getContext();
    if (!context?.requestId) return;
    this.render(context);
  }

  restoreInputFocus() {
    const input = this.root.querySelector("[data-raw-search]");
    if (!input) return;
    input.focus();
    const cursor = input.value.length;
    input.setSelectionRange(cursor, cursor);
  }

  searchInput(target) {
    const input = target?.closest?.("[data-raw-search]");
    return input && this.root.contains(input) ? input : null;
  }

  visibleMarks() {
    const matches = [...this.root.querySelectorAll("mark")].filter((mark) => mark.getClientRects().length > 0);
    matches.forEach((mark) => mark.classList.add("raw-search-highlight"));
    return matches;
  }

  syncActiveMatch(matches, scroll) {
    this.root.querySelectorAll(".raw-search-highlight-active").forEach((mark) => mark.classList.remove("raw-search-highlight-active"));
    this.root.querySelectorAll(".raw-search-target-active").forEach((target) => target.classList.remove("raw-search-target-active"));
    const active = matches[this.activeIndex];
    active?.classList.add("raw-search-highlight-active");
    active?.closest("[data-raw-search-target]")?.classList.add("raw-search-target-active");
    const position = this.root.querySelector("[data-raw-search-position]");
    if (position) {
      position.textContent = this.position(matches.length);
      position.title = this.translate("rawSearchResultCount", { count: matches.length });
    }
    const navigation = this.root.querySelector(".raw-search-navigation");
    if (navigation) navigation.setAttribute("aria-label", this.translate("rawSearchResultCount", { count: matches.length }));
    this.root.querySelectorAll("[data-raw-search-nav]").forEach((button) => {
      button.disabled = !matches.length;
    });
    if (scroll && active) active.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
  }
}

function highlightRawSearchText(root, query) {
  const documentObject = root.ownerDocument;
  const nodeFilter = documentObject.defaultView?.NodeFilter || globalThis.NodeFilter;
  const matcher = new RegExp(escapeRawSearchRegExp(query), "gi");
  const walker = documentObject.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue || !matcher.test(node.nodeValue)) {
        matcher.lastIndex = 0;
        return nodeFilter.FILTER_REJECT;
      }
      matcher.lastIndex = 0;
      if (parent.closest("button, input, textarea, script, style, mark, details:not([open]), .raw-sticky-controls")) return nodeFilter.FILTER_REJECT;
      return nodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const text = node.nodeValue || "";
    const fragment = documentObject.createDocumentFragment();
    let cursor = 0;
    for (const match of text.matchAll(new RegExp(escapeRawSearchRegExp(query), "gi"))) {
      const index = match.index || 0;
      if (index > cursor) fragment.append(documentObject.createTextNode(text.slice(cursor, index)));
      const mark = documentObject.createElement("mark");
      mark.className = "raw-search-highlight";
      mark.textContent = match[0];
      fragment.append(mark);
      cursor = index + match[0].length;
    }
    if (cursor < text.length) fragment.append(documentObject.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}
