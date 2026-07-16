import crypto from "node:crypto";

const DEFAULT_PAGE_SIZE = 32;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 8;

export class TimelineCursorService {
  constructor({ resolveSource, readPage, createAssembler, tokenFactory, now, ttlMs, maxSessions } = {}) {
    this.resolveSource = requiredFunction(resolveSource, "resolveSource");
    this.readPage = requiredFunction(readPage, "readPage");
    this.createAssembler = requiredFunction(createAssembler, "createAssembler");
    this.tokenFactory = tokenFactory || (() => crypto.randomUUID());
    this.now = now || (() => Date.now());
    this.ttlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS, Number.MAX_SAFE_INTEGER);
    this.maxSessions = positiveInteger(maxSessions, DEFAULT_MAX_SESSIONS, 64);
    this.sessions = new Map();
  }

  start({ sourceId, limit = DEFAULT_PAGE_SIZE } = {}) {
    this.prune();
    const source = this.resolveSource(sourceId);
    const pageSize = positiveInteger(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const pageResult = this.readPage(source, { cursor: 0, limit: pageSize });
    const assembler = this.createAssembler();
    const state = assembler.createState({ source, command: pageResult.command });
    const payload = assembler.append(state, pageResult);
    const retainSession = Boolean(pageResult.page?.has_more || isLiveSource(source));
    const token = retainSession ? this.createSession({ source, pageSize, pageResult, assembler, state, payload }) : null;
    return withCursorPartial(payload, pageResult, state.requests.length, {
      nextCursor: pageResult.page?.has_more ? token : null,
      refreshCursor: token,
    });
  }

  next({ sourceId, cursor, limit = null } = {}) {
    this.prune();
    const token = String(cursor || "");
    const session = this.sessions.get(token);
    if (!session) throw cursorError("Timeline cursor expired or not found", 410);
    if (sourceId && sourceId !== session.source.id) throw cursorError("Timeline cursor does not belong to this source", 409);

    const source = this.resolveSource(session.source.id);
    const pageSize = limit == null ? session.pageSize : positiveInteger(limit, session.pageSize, MAX_PAGE_SIZE);
    const pageResult = this.readPage(source, { cursor: session.readerCursor, limit: pageSize });
    session.touchedAt = this.now();
    session.source = source;
    session.state.source = source;

    if (!pageResult.captures.length) {
      session.readerCursor = String(pageResult.page?.offset ?? session.readerCursor ?? 0);
      const retainSession = isLiveSource(source);
      if (!retainSession) this.sessions.delete(token);
      return withCursorPartial(emptyPagePayload(session, pageResult), pageResult, session.state.requests.length, {
        nextCursor: null,
        refreshCursor: retainSession ? token : null,
      });
    }

    const payload = session.assembler.append(session.state, pageResult);
    session.lastPayload = payload;
    session.readerCursor = pageResult.page?.next_cursor || String((pageResult.page?.offset || 0) + pageResult.captures.length);
    const hasMore = Boolean(pageResult.page?.has_more && session.readerCursor);
    const retainSession = hasMore || isLiveSource(source);
    if (!retainSession) this.sessions.delete(token);
    return withCursorPartial(payload, pageResult, session.state.requests.length, {
      nextCursor: hasMore ? token : null,
      refreshCursor: retainSession ? token : null,
    });
  }

  clearSource(sourceId) {
    for (const [token, session] of this.sessions) {
      if (session.source.id === sourceId) this.sessions.delete(token);
    }
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(token);
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
  }

  createSession({ source, pageSize, pageResult, assembler, state, payload }) {
    let token = String(this.tokenFactory() || "");
    while (!token || this.sessions.has(token)) token = crypto.randomUUID();
    this.sessions.set(token, {
      source,
      pageSize,
      readerCursor: pageResult.page.next_cursor,
      assembler,
      state,
      lastPayload: payload,
      touchedAt: this.now(),
    });
    return token;
  }
}

function withCursorPartial(payload, pageResult, loadedCount, { nextCursor = null, refreshCursor = null } = {}) {
  const page = pageResult.page || {};
  const hasMore = Boolean(nextCursor && page.has_more);
  return {
    ...payload,
    partial: {
      mode: "cursor",
      loaded_request_count: loadedCount,
      total_request_count: Math.max(Number(page.total_count) || 0, loadedCount),
      page_offset: Number(page.offset) || 0,
      page_request_count: Number(page.loaded_count) || 0,
      has_more: hasMore,
      next_cursor: hasMore ? nextCursor : null,
      refresh_cursor: refreshCursor || null,
    },
  };
}

function emptyPagePayload(session, pageResult) {
  const previous = session.lastPayload || {};
  return {
    ...previous,
    generated_at: new Date().toISOString(),
    source: session.state.source,
    requests: [],
    request_patches: [],
    turn_updates: [],
    removed_turn_ids: [],
    agent_trace_delta: null,
    turns: undefined,
    agent_trace: undefined,
    page_scope: "timeline_cursor_delta",
    page: pageResult.page,
  };
}

function isLiveSource(source) {
  return Boolean(source?.live_watch_id);
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`timeline cursor ${name} is required`);
  return value;
}

function positiveInteger(value, fallback, maximum) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError("timeline cursor page limit must be a positive integer");
  return Math.min(maximum, parsed);
}

function cursorError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}
