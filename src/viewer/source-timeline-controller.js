import { TimelineEntityStore } from "./timeline-entity-store.js";

export class SourceTimelineController {
  constructor({
    loadView,
    detailFor = () => null,
    yieldControl = () => Promise.resolve(),
    initialLimit = 32,
    cursorLimit = 100,
    progressiveThreshold = 72,
    onWarning = () => {},
  } = {}) {
    if (typeof loadView !== "function") throw new Error("loadView is required");
    if (typeof detailFor !== "function") throw new Error("detailFor must be a function");
    if (typeof yieldControl !== "function") throw new Error("yieldControl must be a function");
    if (typeof onWarning !== "function") throw new Error("onWarning must be a function");
    this.loadView = loadView;
    this.detailFor = detailFor;
    this.yieldControl = yieldControl;
    this.initialLimit = initialLimit;
    this.cursorLimit = cursorLimit;
    this.progressiveThreshold = progressiveThreshold;
    this.onWarning = onWarning;
    this.store = new TimelineEntityStore();
    this.generation = 0;
    this.sourceId = null;
    this.targetSourceId = null;
    this.loading = false;
    this.progressiveLoading = false;
    this.refreshingToken = null;
    this.progressiveError = "";
  }

  get currentToken() {
    return this.generation;
  }

  get progressiveLoadError() {
    return this.progressiveError;
  }

  shouldLoadProgressively(source, { preserveScroll = false } = {}) {
    if (preserveScroll) return false;
    return Number(source?.request_count || 0) >= this.progressiveThreshold;
  }

  async loadSource(sourceId, { progressive = false } = {}) {
    if (!sourceId) throw new Error("sourceId is required");
    const token = this.startLoad(sourceId);
    try {
      const page = await this.loadView(
        sourceId,
        progressive ? { initial: true, limit: this.initialLimit } : {},
      );
      if (!this.isTargetCurrent(token, sourceId)) return null;
      const store = this.createStore(page);
      this.commitStore(store, sourceId);
      this.loading = false;
      const data = store.snapshot();
      return {
        token,
        sourceId,
        data,
        hasMore: Boolean(progressive && data.partial?.has_more),
      };
    } catch (error) {
      if (!this.isTargetCurrent(token, sourceId)) return null;
      this.loading = false;
      throw error;
    }
  }

  async continueSourceLoad(load, { onPage = null } = {}) {
    if (!load || !this.isCurrent(load.token, load.sourceId)) return null;
    const nextCursor = load.data?.partial?.next_cursor || null;
    if (!nextCursor) return load.data;
    this.progressiveLoading = true;
    try {
      const data = await this.continueCursor({
        sourceId: load.sourceId,
        token: load.token,
        store: this.store,
        cursor: nextCursor,
        onPage,
      });
      if (this.isCurrent(load.token, load.sourceId)) {
        this.progressiveLoading = false;
        this.progressiveError = "";
      }
      return data;
    } catch (error) {
      if (!this.isCurrent(load.token, load.sourceId)) return null;
      this.progressiveLoading = false;
      this.progressiveError = error.message;
      throw error;
    }
  }

  async refreshSource(source, previousData) {
    const sourceId = source?.id;
    if (!sourceId || this.isBusy() || !this.isCurrent(this.generation, sourceId)) return null;
    if (previousData?.source?.id !== sourceId) return null;

    const token = this.generation;
    this.refreshingToken = token;
    try {
      let result;
      if (previousData.partial?.refresh_cursor) {
        try {
          const store = this.createStore(previousData);
          const data = await this.continueCursor({
            sourceId,
            token,
            store,
            cursor: previousData.partial.refresh_cursor,
          });
          result = data ? { data, store } : null;
        } catch (error) {
          if (!this.isCurrent(token, sourceId)) return null;
          this.onWarning("timeline refresh cursor expired; rebuilding the compact timeline", error);
          result = await this.rebuildComplete(sourceId, token);
        }
      } else if (Number(source.request_count || 0) >= this.progressiveThreshold) {
        result = await this.rebuildComplete(sourceId, token);
      } else {
        const page = await this.loadView(sourceId, {});
        if (!this.isCurrent(token, sourceId)) return null;
        const store = this.createStore(page);
        result = { data: store.snapshot(), store };
      }

      if (!result || !this.isCurrent(token, sourceId)) return null;
      this.overlayCachedDetails(result.store, result.data?.requests);
      result.data = result.store.snapshot();
      this.commitStore(result.store, sourceId);
      this.progressiveError = "";
      return { token, sourceId, data: result.data };
    } finally {
      if (this.refreshingToken === token) this.refreshingToken = null;
    }
  }

  currentRequest(requestId) {
    return this.store.request(requestId);
  }

  hasRequest(requestId) {
    return this.store.hasRequest(requestId);
  }

  snapshot() {
    return this.sourceId ? this.store.snapshot() : null;
  }

  mergeRequestDetail(fullRequest) {
    if (!fullRequest?.id || !this.store.hasRequest(fullRequest.id)) {
      return { request: fullRequest, data: null };
    }
    const request = this.store.mergeRequestDetail(fullRequest);
    return { request, data: this.store.snapshot() };
  }

  isCurrent(token, sourceId) {
    return (
      token === this.generation &&
      sourceId === this.targetSourceId &&
      sourceId === this.sourceId &&
      sourceId === this.store.sourceId
    );
  }

  invalidate() {
    this.generation += 1;
    this.targetSourceId = null;
    this.loading = false;
    this.progressiveLoading = false;
    this.refreshingToken = null;
    this.progressiveError = "";
  }

  startLoad(sourceId) {
    const token = (this.generation += 1);
    this.targetSourceId = sourceId;
    this.loading = true;
    this.progressiveLoading = false;
    this.refreshingToken = null;
    this.progressiveError = "";
    return token;
  }

  isTargetCurrent(token, sourceId) {
    return token === this.generation && sourceId === this.targetSourceId;
  }

  isBusy() {
    return this.loading || this.progressiveLoading || this.refreshingToken === this.generation;
  }

  async rebuildComplete(sourceId, token) {
    const initialPage = await this.loadView(sourceId, { initial: true, limit: this.initialLimit });
    if (!this.isCurrent(token, sourceId)) return null;
    const store = this.createStore(initialPage);
    const initialData = store.snapshot();
    const data = await this.continueCursor({
      sourceId,
      token,
      store,
      cursor: initialData.partial?.next_cursor || null,
    });
    return data ? { data, store } : null;
  }

  async continueCursor({ sourceId, token, store, cursor, onPage = null }) {
    let data = store.snapshot();
    let nextCursor = cursor;
    while (nextCursor) {
      await this.yieldControl();
      if (!this.isCurrent(token, sourceId)) return null;
      const page = await this.loadView(sourceId, { cursor: nextCursor, limit: this.cursorLimit });
      if (!this.isCurrent(token, sourceId)) return null;
      data = this.applyPage(store, page);
      onPage?.(data);
      nextCursor = data.partial?.has_more ? data.partial.next_cursor : null;
    }
    return data;
  }

  createStore(data) {
    const store = new TimelineEntityStore(data);
    this.overlayCachedDetails(store, data?.requests);
    return store;
  }

  applyPage(store, page) {
    store.applyPage(page);
    this.overlayCachedDetails(store, page?.requests);
    return store.snapshot();
  }

  overlayCachedDetails(store, requests) {
    for (const request of requests || []) {
      const detail = this.detailFor(request.id);
      if (detail) store.mergeRequestDetail(detail);
    }
  }

  commitStore(store, sourceId) {
    this.store = store;
    this.sourceId = sourceId;
    this.targetSourceId = sourceId;
  }
}
