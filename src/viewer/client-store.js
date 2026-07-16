export const VIEWER_CLIENT_STATE_DEFAULTS = Object.freeze({
  activeSourceId: null,
  activeId: null,
  activeRequestId: null,
  activeRawSection: "full",
  activeRawMode: "request",
  rawMessagesMode: "organized",
  uiLanguage: "zh-CN",
  targetTranslationLanguage: "zh-CN",
  translationMode: "source",
  rawOpen: true,
  rawWidth: 0,
  sidebarOpen: true,
  sidebarWidth: 0,
  latestOnly: false,
});

const DOMAIN_KEYS = Object.freeze({
  selection: new Set(["activeSourceId", "activeId", "activeRequestId"]),
  rawView: new Set(["activeRawSection", "activeRawMode", "rawMessagesMode"]),
  language: new Set(["uiLanguage", "targetTranslationLanguage", "translationMode"]),
  layout: new Set(["rawOpen", "rawWidth", "sidebarOpen", "sidebarWidth"]),
  timeline: new Set(["latestOnly"]),
});
const MANAGED_KEYS = new Set(Object.values(DOMAIN_KEYS).flatMap((keys) => [...keys]));

export class ViewerClientStore {
  constructor(initial = {}) {
    this.state = { ...VIEWER_CLIENT_STATE_DEFAULTS };
    this.listeners = new Set();
    if (Object.keys(initial).length) this.update(initial, { reason: "initialize", silent: true });
  }

  snapshot() {
    return Object.freeze(Object.fromEntries([...MANAGED_KEYS].map((key) => [key, this.state[key]])));
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("ViewerClientStore listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch, { reason = "update", silent = false } = {}) {
    const entries = Object.entries(patch || {});
    for (const [key] of entries) {
      if (!MANAGED_KEYS.has(key)) throw new TypeError(`ViewerClientStore does not own state key: ${key}`);
    }
    const previous = {};
    const changedKeys = [];
    for (const [key, value] of entries) {
      if (Object.is(this.state[key], value)) continue;
      previous[key] = this.state[key];
      this.state[key] = value;
      changedKeys.push(key);
    }
    const change = {
      changed: changedKeys.length > 0,
      changedKeys: Object.freeze(changedKeys),
      previous: Object.freeze(previous),
      reason,
      state: this.snapshot(),
    };
    if (change.changed && !silent) {
      for (const listener of this.listeners) listener(change);
    }
    return change;
  }

  setSelection(patch, options = {}) {
    return this.updateDomain("selection", patch, options);
  }

  setRawView(patch, options = {}) {
    return this.updateDomain("rawView", patch, options);
  }

  setLanguage(patch, options = {}) {
    return this.updateDomain("language", patch, options);
  }

  setLayout(patch, options = {}) {
    return this.updateDomain("layout", patch, options);
  }

  setTimeline(patch, options = {}) {
    return this.updateDomain("timeline", patch, options);
  }

  setRawContext({ requestId, section, mode }, options = {}) {
    return this.update(
      {
        activeRequestId: requestId,
        activeRawSection: section,
        activeRawMode: mode,
      },
      options,
    );
  }

  updateDomain(domain, patch, options) {
    const allowed = DOMAIN_KEYS[domain];
    if (!allowed) throw new TypeError(`Unknown ViewerClientStore domain: ${domain}`);
    for (const key of Object.keys(patch || {})) {
      if (!allowed.has(key)) throw new TypeError(`ViewerClientStore ${domain} domain does not own state key: ${key}`);
    }
    return this.update(patch, options);
  }
}

export function viewerClientManagedKeys() {
  return [...MANAGED_KEYS];
}
