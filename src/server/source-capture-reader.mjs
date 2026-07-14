import path from "node:path";
import { watchIdFromSourceId } from "../core/source-identifiers.mjs";

export class SourceCaptureReader {
  constructor({ watches, store, files, fileIndex, runtime, errors } = {}) {
    this.watches = watches || new Map();
    this.store = store || null;
    this.files = files || {};
    this.fileIndex = fileIndex || null;
    this.runtime = runtime || {};
    this.errors = errors || {};
  }

  read(source, { limit = 0, includeCompanions = true } = {}) {
    this.assertAvailable(source);
    if (source.live_watch_id) return this.readLive(source, { limit, includeCompanions });
    if (source.kind === "persisted_capture") return this.readPersisted(source, { limit });
    return this.readFile(source, { limit, includeCompanions });
  }

  readAll(source) {
    return this.read(source, { includeCompanions: false });
  }

  readPage(source, { cursor = 0, limit = 32, includeCompanions = true } = {}) {
    this.assertAvailable(source);
    const offset = pageOffset(cursor);
    const pageLimit = pageSize(limit);
    if (source.live_watch_id) return this.readLivePage(source, { offset, limit: pageLimit, includeCompanions });
    if (source.kind === "persisted_capture") return this.readPersistedPage(source, { offset, limit: pageLimit });
    return this.readFilePage(source, { offset, limit: pageLimit, includeCompanions });
  }

  readRequestWindow(source, requestId, { previousCount = 1 } = {}) {
    this.assertAvailable(source);
    if (source.live_watch_id) return this.readLiveWindow(source, requestId, { previousCount });
    if (source.kind === "persisted_capture") return this.readPersistedWindow(source, requestId, { previousCount });
    return this.readFileWindow(source, requestId, { previousCount });
  }

  readLive(source, { limit, includeCompanions }) {
    const watch = this.resolveWatch(source);
    const allCaptures = this.capturesForWatch(watch);
    const captures = limit ? allCaptures.slice(0, limit) : allCaptures;
    return {
      captures,
      debugSources: [],
      command: includeCompanions ? this.runtime.commandForWatch?.(watch) || null : null,
      totalCount: allCaptures.length,
      startIndex: 0,
    };
  }

  readPersisted(source, { limit }) {
    const watchId = this.persistedWatchId(source);
    const captures = limit ? this.store?.loadInitialCaptures(watchId, { limit }) || [] : this.store?.loadCaptures(watchId) || [];
    return {
      captures,
      debugSources: [],
      command: null,
      totalCount: Number(source.request_count) || captures.length,
      startIndex: 0,
    };
  }

  readFile(source, { limit, includeCompanions }) {
    const capturePath = path.join(source.path, "proxy-captures.json");
    if (limit && this.fileIndex) {
      const page = this.fileIndex.readPage(capturePath, { offset: 0, limit });
      return {
        captures: page.items,
        debugSources: includeCompanions
          ? this.readOptionalIndexedPage(path.join(source.path, "debug-api-sources.json"), { offset: 0, limit: page.items.length })
          : [],
        command: includeCompanions ? this.readOptionalJson(path.join(source.path, "command.json")) : null,
        totalCount: page.totalCount,
        startIndex: 0,
      };
    }
    const allCaptures = this.readJson(capturePath);
    const captures = limit ? allCaptures.slice(0, limit) : allCaptures;
    return {
      captures,
      debugSources: includeCompanions
        ? (this.readOptionalJson(path.join(source.path, "debug-api-sources.json")) || []).slice(0, captures.length)
        : [],
      command: includeCompanions ? this.readOptionalJson(path.join(source.path, "command.json")) : null,
      totalCount: allCaptures.length,
      startIndex: 0,
    };
  }

  readLivePage(source, { offset, limit, includeCompanions }) {
    const watch = this.resolveWatch(source);
    const allCaptures = this.capturesForWatch(watch);
    return pageResult({
      captures: allCaptures.slice(offset, offset + limit),
      totalCount: allCaptures.length,
      offset,
      limit,
      command: includeCompanions && offset === 0 ? this.runtime.commandForWatch?.(watch) || null : null,
    });
  }

  readPersistedPage(source, { offset, limit }) {
    const captures = this.store?.loadCapturePage(this.persistedWatchId(source), { offset, limit }) || [];
    return pageResult({
      captures,
      totalCount: Math.max(Number(source.request_count) || 0, offset + captures.length),
      offset,
      limit,
    });
  }

  readFilePage(source, { offset, limit, includeCompanions }) {
    const capturePath = path.join(source.path, "proxy-captures.json");
    const indexedPage = this.fileIndex?.readPage(capturePath, { offset, limit }) || null;
    const allCaptures = indexedPage ? null : this.readJson(capturePath);
    const captures = indexedPage?.items || allCaptures.slice(offset, offset + limit);
    const debugSources = includeCompanions
      ? indexedPage
        ? this.readOptionalIndexedPage(path.join(source.path, "debug-api-sources.json"), { offset, limit: captures.length })
        : this.readOptionalJson(path.join(source.path, "debug-api-sources.json")) || []
      : [];
    return pageResult({
      captures,
      debugSources: indexedPage ? debugSources : debugSources.slice(offset, offset + captures.length),
      command: includeCompanions && offset === 0 ? this.readOptionalJson(path.join(source.path, "command.json")) : null,
      totalCount: indexedPage?.totalCount ?? allCaptures.length,
      offset,
      limit,
    });
  }

  readLiveWindow(source, requestId, { previousCount }) {
    const captures = this.capturesForWatch(this.resolveWatch(source));
    return captureWindow(captures, requestId, { previousCount, notFound: (id) => this.requestNotFound(id) });
  }

  readPersistedWindow(source, requestId, { previousCount }) {
    const captures = this.store?.loadCaptureWindow(this.persistedWatchId(source), requestId, { previousCount }) || [];
    if (!captures.length) throw this.requestNotFound(requestId);
    return { captures, debugSources: [], command: null, totalCount: Number(source.request_count) || 0, startIndex: captureStartIndex(captures) };
  }

  readFileWindow(source, requestId, { previousCount }) {
    const indexedWindow = this.fileIndex?.readWindow(path.join(source.path, "proxy-captures.json"), requestId, { previousCount }) || null;
    if (this.fileIndex && !indexedWindow) throw this.requestNotFound(requestId);
    const captures = indexedWindow ? null : this.readJson(path.join(source.path, "proxy-captures.json"));
    const window = indexedWindow
      ? { captures: indexedWindow.items, totalCount: indexedWindow.totalCount, startIndex: indexedWindow.startIndex }
      : captureWindow(captures, requestId, { previousCount, notFound: (id) => this.requestNotFound(id) });
    const debugSources = indexedWindow
      ? this.readOptionalIndexedPage(path.join(source.path, "debug-api-sources.json"), {
          offset: window.startIndex,
          limit: window.captures.length,
        })
      : this.readOptionalJson(path.join(source.path, "debug-api-sources.json")) || [];
    return {
      ...window,
      debugSources: indexedWindow ? debugSources : debugSources.slice(window.startIndex, window.startIndex + window.captures.length),
      command: this.readOptionalJson(path.join(source.path, "command.json")),
    };
  }

  readOptionalIndexedPage(filePath, { offset, limit }) {
    try {
      return this.fileIndex?.readPage(filePath, { offset, limit }).items || [];
    } catch {
      return [];
    }
  }

  resolveWatch(source) {
    const watch = [...(this.watches?.values() || [])].find((item) => item.watch_id === source.live_watch_id || item.id === source.id);
    if (!watch) throw new Error(`Live watch not found: ${source.live_watch_id || source.id}`);
    return watch;
  }

  capturesForWatch(watch) {
    if (typeof this.runtime.capturesForWatch !== "function") throw new Error("capturesForWatch is required");
    return this.runtime.capturesForWatch(watch) || [];
  }

  persistedWatchId(source) {
    const watchId = source.store_watch_id || watchIdFromSourceId(source.id);
    if (!watchId) throw new Error(`Invalid persisted source id: ${source.id}`);
    return watchId;
  }

  readJson(filePath) {
    if (typeof this.files.readJson !== "function") throw new Error("file readJson is required");
    return this.files.readJson(filePath);
  }

  readOptionalJson(filePath) {
    return typeof this.files.readOptionalJson === "function" ? this.files.readOptionalJson(filePath) : null;
  }

  assertAvailable(source) {
    if (!source) throw new Error("source is required");
    if (!source.available) throw new Error(`Evidence not found: ${source.path}`);
  }

  requestNotFound(requestId) {
    return typeof this.errors.requestNotFound === "function"
      ? this.errors.requestNotFound(requestId)
      : new Error(`Request not found: ${requestId}`);
  }
}

export function captureWindow(captures, requestId, { previousCount = 1, notFound } = {}) {
  const targetIndex = captures.findIndex((capture) => captureMatchesRequestId(capture, requestId));
  if (targetIndex < 0) throw (typeof notFound === "function" ? notFound(requestId) : new Error(`Request not found: ${requestId}`));
  const startIndex = Math.max(0, targetIndex - Math.max(0, Number(previousCount) || 0));
  return {
    captures: captures.slice(startIndex, targetIndex + 1),
    debugSources: [],
    command: null,
    totalCount: captures.length,
    startIndex,
  };
}

function captureMatchesRequestId(capture, requestId) {
  return capture?.capture_id === requestId || String(capture?.request_index) === String(requestId);
}

function captureStartIndex(captures) {
  const requestIndex = Number(captures[0]?.request_index);
  return Number.isFinite(requestIndex) && requestIndex > 0 ? requestIndex - 1 : 0;
}

function pageResult({ captures, debugSources = [], command = null, totalCount, offset, limit }) {
  const loadedCount = captures.length;
  const nextOffset = offset + loadedCount;
  const hasMore = nextOffset < totalCount;
  return {
    captures,
    debugSources,
    command,
    totalCount,
    startIndex: offset,
    page: {
      cursor: String(offset),
      next_cursor: hasMore ? String(nextOffset) : null,
      offset,
      limit,
      loaded_count: loadedCount,
      total_count: totalCount,
      has_more: hasMore,
    },
  };
}

function pageOffset(cursor) {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("capture page cursor must be a non-negative integer");
  return value;
}

function pageSize(limit) {
  const value = Number(limit) || 32;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("capture page limit must be a positive integer");
  return Math.min(100, value);
}
