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
  }

  clear() {
    this.details.clear();
    this.promises.clear();
    this.errors.clear();
  }

  errorFor(requestId) {
    return this.errors.get(requestId) || null;
  }

  mergeIntoData(data) {
    if (!data?.requests?.length || !this.details.size) return data;
    return {
      ...data,
      requests: data.requests.map((request) => this.details.get(request.id) || request),
    };
  }

  ensure(sourceId, request) {
    if (!request) return Promise.resolve(null);
    if (!requestNeedsDetail(request)) return Promise.resolve(request);
    const requestId = request.id;
    if (this.details.has(requestId)) return Promise.resolve(this.onCached(this.details.get(requestId)));
    if (this.promises.has(requestId)) return this.promises.get(requestId);

    const promise = Promise.resolve(this.loadDetail(sourceId, requestId))
      .then((detail) => normalizeRequestDetail(detail))
      .then(async (detail) => {
        this.details.set(requestId, detail);
        this.errors.delete(requestId);
        return this.onLoaded(detail);
      })
      .catch((error) => {
        this.errors.set(requestId, error);
        throw error;
      })
      .finally(() => {
        this.promises.delete(requestId);
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
