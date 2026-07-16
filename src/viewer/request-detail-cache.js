export class RequestDetailCache {
  constructor({ loadDetail, onLoaded = (detail) => detail, onCached = (detail) => detail } = {}) {
    if (typeof loadDetail !== "function") throw new Error("loadDetail is required");
    if (typeof onLoaded !== "function") throw new Error("onLoaded must be a function");
    if (typeof onCached !== "function") throw new Error("onCached must be a function");
    this.loadDetail = loadDetail;
    this.onLoaded = onLoaded;
    this.onCached = onCached;
    this.details = new Map();
    this.promises = new Map();
    this.errors = new Map();
    this.generation = 0;
  }

  clear() {
    this.generation += 1;
    this.details.clear();
    this.promises.clear();
    this.errors.clear();
  }

  errorFor(requestId) {
    return this.errors.get(requestId) || null;
  }

  detailFor(requestId) {
    return this.details.get(requestId) || null;
  }

  ensure(sourceId, request) {
    if (!request) return Promise.resolve(null);
    if (!requestNeedsDetail(request)) return Promise.resolve(request);
    const requestId = request.id;
    if (this.details.has(requestId)) return Promise.resolve(this.onCached(this.details.get(requestId)));
    if (this.promises.has(requestId)) return this.promises.get(requestId);

    const generation = this.generation;
    const promise = Promise.resolve(this.loadDetail(sourceId, requestId))
      .then((detail) => normalizeRequestDetail(detail))
      .then(async (detail) => {
        if (generation !== this.generation) return detail;
        this.details.set(requestId, detail);
        this.errors.delete(requestId);
        return this.onLoaded(detail);
      })
      .catch((error) => {
        if (generation === this.generation) this.errors.set(requestId, error);
        throw error;
      })
      .finally(() => {
        if (this.promises.get(requestId) === promise) this.promises.delete(requestId);
      });
    this.promises.set(requestId, promise);
    return promise;
  }
}

export function requestNeedsDetail(request) {
  return Boolean(request?.detail_omitted || request?.raw?.detail_omitted || request?.summary?.history_stack_omitted);
}

export function normalizeRequestDetail(request) {
  const normalized = { ...(request || {}), detail_omitted: false };
  if (normalized.raw && typeof normalized.raw === "object") {
    normalized.raw = { ...normalized.raw, detail_omitted: false };
    delete normalized.raw.body_omitted;
  }
  if (normalized.summary && typeof normalized.summary === "object") {
    normalized.summary = { ...normalized.summary };
    delete normalized.summary.history_stack_omitted;
  }
  return normalized;
}
