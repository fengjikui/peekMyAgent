export class ActiveSourceController {
  constructor({
    timeline,
    listSources,
    getContext,
    setSources,
    resetSourceContext,
    captureScroll,
    setData,
    presentLoadedData,
    presentRefreshedData,
    loadTranslations,
    refreshRaw,
    renderData,
    isHidden = () => false,
    scheduleInterval = (callback, delay) => setInterval(callback, delay),
    cancelInterval = (timer) => clearInterval(timer),
    refreshIntervalMs = 1200,
    onWarning = () => {},
  } = {}) {
    if (
      !timeline?.loadSource ||
      !timeline?.refreshSource ||
      !timeline?.continueSourceLoad ||
      !timeline?.shouldLoadProgressively ||
      !timeline?.isCurrent ||
      !timeline?.snapshot
    ) {
      throw new TypeError("ActiveSourceController requires a SourceTimelineController-compatible timeline");
    }
    for (const [name, port] of Object.entries({
      listSources,
      getContext,
      setSources,
      resetSourceContext,
      captureScroll,
      setData,
      presentLoadedData,
      presentRefreshedData,
      loadTranslations,
      refreshRaw,
      renderData,
      isHidden,
      scheduleInterval,
      cancelInterval,
      onWarning,
    })) {
      if (typeof port !== "function") throw new TypeError(`ActiveSourceController requires ${name}()`);
    }
    this.timeline = timeline;
    this.listSources = listSources;
    this.getContext = getContext;
    this.setSources = setSources;
    this.resetSourceContext = resetSourceContext;
    this.captureScroll = captureScroll;
    this.setData = setData;
    this.presentLoadedData = presentLoadedData;
    this.presentRefreshedData = presentRefreshedData;
    this.loadTranslations = loadTranslations;
    this.refreshRaw = refreshRaw;
    this.renderData = renderData;
    this.isHidden = isHidden;
    this.scheduleInterval = scheduleInterval;
    this.cancelInterval = cancelInterval;
    this.refreshIntervalMs = refreshIntervalMs;
    this.onWarning = onWarning;
    this.autoRefreshTimer = null;
    this.autoRefreshInFlight = false;
    this.catalogVersion = 0;
  }

  async initialize(requestedSourceId = "") {
    const catalogVersion = this.catalogVersion;
    const sources = await this.listSources();
    if (catalogVersion !== this.catalogVersion) return null;
    this.acceptSources(sources, { render: true, reason: "initialize-sources" });
    const source = preferredSource(sources, requestedSourceId);
    if (source) await this.loadSource(source.id);
    return source;
  }

  async loadSource(sourceId, { preserveScroll = false } = {}) {
    if (!sourceId) return null;
    const context = this.getContext();
    const scroll = this.captureScroll();
    const source = context.sources.find((item) => item.id === sourceId);
    const progressive = this.timeline.shouldLoadProgressively(source, { preserveScroll });
    if (context.activeSourceId && context.activeSourceId !== sourceId) {
      this.resetSourceContext({ previousSourceId: context.activeSourceId, sourceId });
    }
    const load = await this.timeline.loadSource(sourceId, { progressive });
    if (!load) return null;
    this.presentLoadedData(load.data, { preserveScroll, scrollTop: scroll.scrollTop });
    if (load.hasMore) void this.continueSourceLoad(load);
    else void this.loadTranslationsForSource(load);
    return load;
  }

  async refreshSources() {
    const previous = this.getContext();
    const catalogVersion = this.catalogVersion;
    const sources = await this.listSources();
    if (catalogVersion !== this.catalogVersion) return this.getContext().sources;
    this.acceptSources(sources, {
      render: sourceCatalogSignature(sources) !== sourceCatalogSignature(previous.sources),
      reason: "refresh-sources",
    });
    if (previous.activeSourceId && !sources.some((source) => source.id === previous.activeSourceId)) {
      const fallback = preferredSource(sources);
      if (fallback) await this.loadSource(fallback.id);
    }
    return sources;
  }

  acceptSources(sources, { render = true, reason = "accept-sources" } = {}) {
    const nextSources = Array.isArray(sources) ? sources : [];
    this.catalogVersion += 1;
    this.setSources(nextSources, { render, reason, catalogVersion: this.catalogVersion });
    return nextSources;
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.autoRefreshTimer = this.scheduleInterval(() => {
      void this.refreshLiveData();
    }, this.refreshIntervalMs);
    return this.autoRefreshTimer;
  }

  stopAutoRefresh() {
    if (this.autoRefreshTimer == null) return;
    this.cancelInterval(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  async refreshLiveData({ force = false } = {}) {
    if (this.autoRefreshInFlight || this.isHidden()) return false;
    const before = this.getContext();
    const activeBefore = sourceById(before.sources, before.activeSourceId);
    const catalogVersion = this.catalogVersion;
    this.autoRefreshInFlight = true;
    try {
      const sources = await this.listSources();
      if (catalogVersion !== this.catalogVersion) return false;
      this.acceptSources(sources, {
        render: sourceCatalogSignature(sources) !== sourceCatalogSignature(before.sources),
        reason: "poll-sources",
      });
      const current = this.getContext();
      const activeAfter = sourceById(sources, current.activeSourceId);
      if (!current.activeSourceId || !activeAfter?.available) return false;
      if (!sourceRequiresRefresh(activeBefore, activeAfter, { force })) return false;
      return Boolean(await this.refreshActiveSource(activeAfter));
    } catch (error) {
      this.onWarning("auto refresh failed", error);
      return false;
    } finally {
      this.autoRefreshInFlight = false;
    }
  }

  async refreshActiveSource(activeSource) {
    const previousData = this.timeline.snapshot() || this.getContext().data;
    const refresh = await this.timeline.refreshSource(activeSource, previousData);
    if (!refresh || this.getContext().activeSourceId !== refresh.sourceId) return null;
    const nextData = refresh.data;
    this.setData(nextData, { reason: "refresh-source-data" });
    if (sourceDataSignature(previousData) === sourceDataSignature(nextData)) {
      return { ...refresh, rendered: false };
    }

    const scroll = this.captureScroll();
    try {
      await this.loadTranslations(nextData);
    } catch (error) {
      if (!this.timeline.isCurrent(refresh.token, refresh.sourceId)) return null;
      this.onWarning("translation load failed", error);
    }
    if (!this.timeline.isCurrent(refresh.token, refresh.sourceId)) return null;
    if (this.getContext().activeSourceId !== refresh.sourceId) return null;
    this.presentRefreshedData(nextData, {
      scrollTop: scroll.scrollTop,
      wasNearBottom: scroll.nearBottom,
    });
    return { ...refresh, rendered: true };
  }

  async continueSourceLoad(load) {
    try {
      const data = await this.timeline.continueSourceLoad(load, {
        onPage: (page) => {
          const scroll = this.captureScroll();
          this.presentLoadedData(page, { preserveScroll: true, scrollTop: scroll.scrollTop });
        },
      });
      if (!data) return null;
      await this.loadTranslationsForSource(load, data);
      return data;
    } catch (error) {
      if (!this.timeline.isCurrent(load.token, load.sourceId)) return null;
      this.renderData({ reason: "progressive-load-error" });
      this.onWarning("timeline cursor load failed", error);
      return null;
    }
  }

  async loadTranslationsForSource(load, data = load?.data) {
    try {
      if (!this.timeline.isCurrent(load.token, load.sourceId)) return false;
      await this.loadTranslations(data);
      if (!this.timeline.isCurrent(load.token, load.sourceId)) return false;
      this.refreshRaw();
      return true;
    } catch (error) {
      if (!this.timeline.isCurrent(load.token, load.sourceId)) return false;
      this.onWarning("translation load failed", error);
      return false;
    }
  }
}

export function preferredSource(sources, requestedSourceId = "") {
  const list = Array.isArray(sources) ? sources : [];
  return (
    list.find((source) => source.id === requestedSourceId && source.available) ||
    list.find((source) => source.available) ||
    list[0] ||
    null
  );
}

export function sourceRequiresRefresh(before, after, { force = false } = {}) {
  if (force) return true;
  if (!after) return false;
  return (
    after.request_count !== before?.request_count ||
    after.response_count !== before?.response_count ||
    after.live_status !== before?.live_status ||
    after.last_seen !== before?.last_seen ||
    after.last_response_seen !== before?.last_response_seen ||
    after.updated_at !== before?.updated_at ||
    after.token_count !== before?.token_count ||
    after.conversation_id !== before?.conversation_id
  );
}

export function sourceDataSignature(data) {
  const requests = data?.requests || [];
  return [
    data?.source?.id || "",
    data?.source?.live_status || "",
    data?.source?.conversation_id || "",
    requests.length,
    requests.at(-1)?.id || "",
    requests.at(-1)?.captured_at || "",
    requests
      .map((request) =>
        [
          request.id,
          request.summary?.response?.captured ? "r" : "",
          request.summary?.response?.received_at || "",
          request.summary?.response?.raw_body_bytes || "",
          request.summary?.response?.truncated ? "truncated" : "",
        ].join(":"),
      )
      .join(","),
  ].join("|");
}

export function sourceCatalogSignature(sources) {
  return (sources || [])
    .map((source) =>
      [
        source.id,
        source.label || "",
        source.pinned ? "pinned" : "",
        source.live_status || "",
        source.request_count || 0,
        source.response_count || 0,
        source.last_seen || "",
        source.last_response_seen || "",
        source.conversation_id || "",
      ].join(":"),
    )
    .join("|");
}

function sourceById(sources, sourceId) {
  return (sources || []).find((source) => source.id === sourceId) || null;
}
