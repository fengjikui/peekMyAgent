export class TranslationCacheController {
  constructor({
    loadCache,
    buildLookup,
    schedule = (callback) => queueMicrotask(callback),
    onAutoRefresh = () => {},
    isGenerationBusy = () => false,
    onWarning = () => {},
  } = {}) {
    if (typeof loadCache !== "function") throw new Error("loadCache is required");
    if (typeof buildLookup !== "function") throw new Error("buildLookup is required");
    if (typeof schedule !== "function") throw new Error("schedule must be a function");
    if (typeof onAutoRefresh !== "function") throw new Error("onAutoRefresh must be a function");
    if (typeof isGenerationBusy !== "function") throw new Error("isGenerationBusy must be a function");
    if (typeof onWarning !== "function") throw new Error("onWarning must be a function");
    this.loadCache = loadCache;
    this.buildLookup = buildLookup;
    this.schedule = schedule;
    this.onAutoRefresh = onAutoRefresh;
    this.isGenerationBusy = isGenerationBusy;
    this.onWarning = onWarning;
    this.context = null;
    this.contextEpoch = 0;
    this.loadSequence = 0;
    this.lookupSequence = 0;
    this.lookupRevision = 0;
    this.activeLoad = null;
    this.pendingLookupRequests = null;
    this.cache = null;
    this.lookup = new Map();
    this.autoRefreshAttempts = new Set();
    this.autoRefreshTokens = new Map();
  }

  get translations() {
    return this.cache;
  }

  get translationLookup() {
    return this.lookup;
  }

  get available() {
    return Boolean(this.cache?.available);
  }

  async loadContext(
    { sourceId = "", targetLanguage = "", agents = [], requests = [], getRequests = null } = {},
    { autoRefresh = true } = {},
  ) {
    const context = this.activateContext({ sourceId, targetLanguage, agents });
    const epoch = this.contextEpoch;
    const sequence = ++this.loadSequence;
    this.lookupSequence += 1;
    const load = { epoch, sequence, key: context.key };
    this.activeLoad = load;
    this.pendingLookupRequests = null;
    const currentRequests = () => (typeof getRequests === "function" ? getRequests() : requests);

    try {
      if (!context.agents.length) {
        if (!this.isLoadCurrent(load)) return null;
        this.commitUnavailable(null);
        return this.snapshot();
      }

      const attempts = [];
      for (const agent of context.agents) {
        const cache = await this.loadCache(agent, context.targetLanguage);
        if (!this.isLoadCurrent(load)) return null;
        attempts.push(cache);
        if (!cache?.available) continue;
        while (this.isLoadCurrent(load)) {
          const revision = this.lookupRevision;
          const lookupRequests = this.pendingLookupRequests || currentRequests() || [];
          this.pendingLookupRequests = null;
          const lookup = await this.buildLookup(lookupRequests, cache);
          if (!this.isLoadCurrent(load)) return null;
          if (revision !== this.lookupRevision || this.pendingLookupRequests !== null) continue;
          this.commitAvailable(cache, lookup);
          return this.snapshot();
        }
        return null;
      }

      if (!this.isLoadCurrent(load)) return null;
      this.commitUnavailable(
        attempts[0] || {
          available: false,
          target_language: context.targetLanguage,
          entries: {},
        },
      );
      if (autoRefresh) this.scheduleAutoRefresh(context, context.agents[0]);
      return this.snapshot();
    } catch (error) {
      if (!this.isLoadCurrent(load)) return null;
      this.commitUnavailable({
        available: false,
        error: error.message,
        target_language: context.targetLanguage,
        entries: {},
      });
      this.onWarning("translation cache unavailable", error);
      return this.snapshot();
    } finally {
      if (this.activeLoad?.epoch === epoch && this.activeLoad?.sequence === sequence) this.activeLoad = null;
    }
  }

  async refreshLookup(requests) {
    if (!this.context) return null;
    if (this.isCurrentContextLoading()) {
      this.lookupRevision += 1;
      this.pendingLookupRequests = requests || [];
      return null;
    }
    if (!this.cache?.available) return null;
    const cache = this.cache;
    const epoch = this.contextEpoch;
    const key = this.context.key;
    const sequence = ++this.lookupSequence;
    const lookup = await this.buildLookup(requests || [], cache);
    if (epoch !== this.contextEpoch || key !== this.context?.key || cache !== this.cache || sequence !== this.lookupSequence) {
      return null;
    }
    this.lookup = normalizeLookup(lookup);
    return this.lookup;
  }

  clearAutoRefreshAttempts() {
    this.autoRefreshAttempts.clear();
    this.autoRefreshTokens.clear();
  }

  invalidate() {
    this.contextEpoch += 1;
    this.loadSequence += 1;
    this.lookupSequence += 1;
    this.context = null;
    this.activeLoad = null;
    this.lookupRevision += 1;
    this.pendingLookupRequests = null;
    this.cache = null;
    this.lookup = new Map();
    this.clearAutoRefreshAttempts();
  }

  captureOperation({ sourceId = "", targetLanguage = "", agent = "" } = {}) {
    const key = translationContextKey({ sourceId, targetLanguage });
    if (key !== this.context?.key) return null;
    const normalizedAgent = String(agent || "").trim();
    if (normalizedAgent && this.context.agents.length && !this.context.agents.includes(normalizedAgent)) return null;
    return {
      epoch: this.contextEpoch,
      key,
      sourceId: String(sourceId || ""),
      targetLanguage: String(targetLanguage || ""),
      agent: normalizedAgent,
    };
  }

  isOperationCurrent(operation) {
    if (!operation || operation.epoch !== this.contextEpoch || operation.key !== this.context?.key) return false;
    return !operation.agent || !this.context.agents.length || this.context.agents.includes(operation.agent);
  }

  snapshot() {
    return {
      context: this.context ? { ...this.context, agents: [...this.context.agents] } : null,
      translations: this.cache,
      translationLookup: this.lookup,
    };
  }

  activateContext({ sourceId, targetLanguage, agents }) {
    const context = {
      sourceId: String(sourceId || ""),
      targetLanguage: String(targetLanguage || ""),
      agents: uniqueStrings(agents),
    };
    context.key = translationContextKey(context);
    if (context.key !== this.context?.key) {
      this.contextEpoch += 1;
      this.loadSequence += 1;
      this.lookupSequence += 1;
      this.activeLoad = null;
      this.lookupRevision += 1;
      this.pendingLookupRequests = null;
      this.cache = null;
      this.lookup = new Map();
      this.clearAutoRefreshAttempts();
    }
    this.context = context;
    return context;
  }

  isLoadCurrent(load) {
    return (
      load.epoch === this.contextEpoch &&
      load.sequence === this.loadSequence &&
      load.key === this.context?.key
    );
  }

  isCurrentContextLoading() {
    return Boolean(
      this.activeLoad &&
        this.activeLoad.epoch === this.contextEpoch &&
        this.activeLoad.sequence === this.loadSequence &&
        this.activeLoad.key === this.context?.key,
    );
  }

  commitAvailable(cache, lookup) {
    this.lookupSequence += 1;
    this.cache = cache;
    this.lookup = normalizeLookup(lookup);
    this.pendingLookupRequests = null;
  }

  commitUnavailable(cache) {
    this.lookupSequence += 1;
    this.cache = cache;
    this.lookup = new Map();
    this.pendingLookupRequests = null;
  }

  scheduleAutoRefresh(context, agent) {
    const sourceId = context.sourceId;
    const attemptKey = [sourceId, agent, context.targetLanguage].join("\0");
    if (!sourceId || !agent || this.autoRefreshAttempts.has(attemptKey) || this.isGenerationBusy()) return;
    this.autoRefreshAttempts.add(attemptKey);
    const token = {};
    this.autoRefreshTokens.set(attemptKey, token);
    const epoch = this.contextEpoch;
    this.schedule(() => {
      if (this.autoRefreshTokens.get(attemptKey) !== token) return;
      this.autoRefreshTokens.delete(attemptKey);
      if (
        epoch !== this.contextEpoch ||
        context.key !== this.context?.key ||
        agent !== this.context?.agents[0] ||
        this.available ||
        this.isCurrentContextLoading() ||
        this.isGenerationBusy()
      ) {
        this.autoRefreshAttempts.delete(attemptKey);
        return;
      }
      this.onAutoRefresh({
        sourceId,
        targetLanguage: context.targetLanguage,
        agent,
      });
    });
  }
}

export function translationAgentCandidatesForData(data) {
  const values = [];
  add(data?.source?.agent);
  add(data?.source?.id);
  add(data?.source?.store_watch_id);
  for (const request of data?.requests || []) {
    add(request.agent_profile);
    add(request.raw?.agent_profile);
    add(request.watch_id);
    add(request.raw?.watch_id);
    add(request.raw?.body?.metadata?.agent);
  }
  if (values.some((value) => /claude-code|claude|anthropic|\bcc\b/i.test(value))) add("Claude Code");
  if (values.some((value) => /trae-cn|trae/i.test(value))) add("Trae CN");
  return values;

  function add(value) {
    const normalized = String(value || "").trim();
    if (normalized && !values.includes(normalized)) values.push(normalized);
  }
}

export async function buildTranslationLookup({
  requests,
  translations,
  collectMaterials,
  hashMaterial,
  lookupKey,
  normalizeText = (value) => String(value || "").trim(),
} = {}) {
  const entries = translations?.entries || {};
  if (
    !translations?.available ||
    !Object.keys(entries).length ||
    typeof collectMaterials !== "function" ||
    typeof hashMaterial !== "function" ||
    typeof lookupKey !== "function"
  ) {
    return new Map();
  }

  const unique = new Map();
  for (const request of requests || []) {
    for (const item of collectMaterials(request) || []) {
      const sourceText = normalizeText(item.source_text);
      if (!sourceText) continue;
      unique.set(lookupKey(item.kind, sourceText), { ...item, source_text: sourceText });
    }
  }
  const pairs = await Promise.all(
    [...unique.values()].map(async (item) => {
      const hash = await hashMaterial(item.kind, item.source_text);
      const entry = entries[hash];
      return entry?.translated_text ? [lookupKey(item.kind, item.source_text), entry] : null;
    }),
  );
  return new Map(pairs.filter(Boolean));
}

export function translationContextKey({ sourceId = "", targetLanguage = "" } = {}) {
  return `${String(sourceId)}\0${String(targetLanguage)}`;
}

function normalizeLookup(value) {
  return value instanceof Map ? value : new Map();
}

function uniqueStrings(values) {
  const output = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (normalized && !output.includes(normalized)) output.push(normalized);
  }
  return output;
}
