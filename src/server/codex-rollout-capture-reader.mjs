import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { normalizeCodexRolloutRecord, normalizeCodexRolloutTask } from "../adapters/codex-rollout-normalizer.mjs";

const DEFAULT_CHUNK_BYTES = 512 * 1024;
const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;

export class CodexRolloutCaptureReader {
  constructor({ files = fs, chunkBytes = DEFAULT_CHUNK_BYTES, maxLineChars = DEFAULT_MAX_LINE_CHARS } = {}) {
    this.files = files;
    this.chunkBytes = positiveInteger(chunkBytes, DEFAULT_CHUNK_BYTES, 4 * 1024 * 1024);
    this.maxLineChars = positiveInteger(maxLineChars, DEFAULT_MAX_LINE_CHARS, 64 * 1024 * 1024);
    this.states = new Map();
  }

  read(source, { limit = 0 } = {}) {
    const state = this.stateFor(source);
    if (limit) this.scanUntil(state, source, limit + 1);
    else this.scanToCurrentEnd(state, source);
    const allCaptures = this.captureSnapshots(state, source);
    const captures = limit ? allCaptures.slice(0, limit) : allCaptures;
    return {
      captures,
      debugSources: [],
      command: sourceCommand(source, state.sessionMeta),
      totalCount: state.complete ? allCaptures.length : Math.max(allCaptures.length, captures.length + 1),
      startIndex: 0,
    };
  }

  readPage(source, { cursor = 0, limit = 32 } = {}) {
    const offset = nonNegativeInteger(cursor, "Codex rollout cursor");
    const pageLimit = positiveInteger(limit, 32, 100);
    const state = this.stateFor(source);
    this.scanUntil(state, source, offset + pageLimit + 1);
    const snapshots = this.captureSnapshots(state, source);
    const captures = snapshots.slice(offset, offset + pageLimit);
    const hasBufferedMore = snapshots.length > offset + captures.length;
    const hasMore = hasBufferedMore || !state.complete;
    const totalCount = state.complete ? snapshots.length : Math.max(snapshots.length, offset + captures.length + (hasMore ? 1 : 0));
    const nextOffset = offset + captures.length;
    return {
      captures,
      debugSources: [],
      command: offset === 0 ? sourceCommand(source, state.sessionMeta) : null,
      totalCount,
      startIndex: offset,
      page: {
        cursor: String(offset),
        next_cursor: hasMore && captures.length ? String(nextOffset) : null,
        offset,
        limit: pageLimit,
        loaded_count: captures.length,
        total_count: totalCount,
        has_more: Boolean(hasMore && captures.length),
      },
    };
  }

  readRequestWindow(source, requestId, { previousCount = 1 } = {}) {
    const state = this.stateFor(source);
    let snapshots = this.captureSnapshots(state, source);
    let targetIndex = findCaptureIndex(snapshots, requestId);
    while (targetIndex < 0 && !state.complete) {
      const previousOffset = state.readOffset;
      this.scanUntil(state, source, snapshots.length + 32);
      snapshots = this.captureSnapshots(state, source);
      targetIndex = findCaptureIndex(snapshots, requestId);
      if (state.readOffset === previousOffset) break;
    }
    if (targetIndex < 0) throw new Error(`Request not found: ${requestId}`);
    const startIndex = Math.max(0, targetIndex - Math.max(0, Number(previousCount) || 0));
    return {
      captures: snapshots.slice(startIndex, targetIndex + 1),
      debugSources: [],
      command: sourceCommand(source, state.sessionMeta),
      totalCount: state.complete ? snapshots.length : Math.max(snapshots.length, targetIndex + 1),
      startIndex,
    };
  }

  clear(sourcePath = null) {
    if (sourcePath) this.states.delete(String(sourcePath));
    else this.states.clear();
  }

  stateFor(source) {
    const filePath = String(source?.path || "");
    if (!filePath) throw new Error("Codex rollout source path is required");
    const stat = this.files.statSync(filePath);
    let state = this.states.get(filePath);
    if (!state || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.readOffset) {
      state = createState(filePath, stat);
      this.states.set(filePath, state);
    } else {
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      if (stat.size > state.readOffset) state.complete = false;
    }
    return state;
  }

  scanUntil(state, source, wantedCaptureCount) {
    const wanted = Math.max(0, Number(wantedCaptureCount) || 0);
    while (this.captureCount(state) < wanted && !state.complete) {
      const before = state.readOffset;
      this.scanChunk(state, source);
      if (state.readOffset === before) break;
    }
  }

  scanToCurrentEnd(state, source) {
    while (!state.complete) {
      const before = state.readOffset;
      this.scanChunk(state, source);
      if (state.readOffset === before) break;
    }
  }

  scanChunk(state, source) {
    const stat = this.files.statSync(state.filePath);
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    if (state.readOffset >= stat.size) {
      state.complete = true;
      return;
    }
    const remaining = stat.size - state.readOffset;
    const byteCount = Math.min(this.chunkBytes, remaining);
    const buffer = Buffer.allocUnsafe(byteCount);
    const fd = this.files.openSync(state.filePath, "r");
    let bytesRead = 0;
    try {
      bytesRead = this.files.readSync(fd, buffer, 0, byteCount, state.readOffset);
    } finally {
      this.files.closeSync(fd);
    }
    if (!bytesRead) {
      state.complete = true;
      return;
    }
    state.readOffset += bytesRead;
    this.consumeText(state, source, state.decoder.write(buffer.subarray(0, bytesRead)));
    state.complete = state.readOffset >= stat.size;
  }

  consumeText(state, source, text) {
    let value = text;
    while (value) {
      const newline = value.indexOf("\n");
      if (newline < 0) {
        if (state.skippingLongLine) {
          state.skippedLongLineChars += value.length;
        } else {
          state.pendingLine += value;
          if (state.pendingLine.length > this.maxLineChars) {
            state.skippingLongLine = true;
            state.skippedLongLineChars = state.pendingLine.length;
            state.pendingLine = "";
          }
        }
        return;
      }
      const segment = value.slice(0, newline);
      value = value.slice(newline + 1);
      if (state.skippingLongLine) {
        state.skippedLongLineChars += segment.length;
        this.consumeRecord(state, source, {
          timestamp: null,
          type: "rollout_line_omitted",
          payload: { type: "rollout_line_omitted", chars: state.skippedLongLineChars, reason: "line_too_large" },
        });
        state.skippingLongLine = false;
        state.skippedLongLineChars = 0;
        continue;
      }
      const line = `${state.pendingLine}${segment}`.trim();
      state.pendingLine = "";
      if (!line) continue;
      if (line.length > this.maxLineChars) {
        this.consumeRecord(state, source, {
          timestamp: null,
          type: "rollout_line_omitted",
          payload: { type: "rollout_line_omitted", chars: line.length, reason: "line_too_large" },
        });
        continue;
      }
      try {
        this.consumeRecord(state, source, JSON.parse(line));
      } catch (error) {
        this.consumeRecord(state, source, {
          timestamp: null,
          type: "rollout_parse_error",
          payload: { type: "rollout_parse_error", chars: line.length, error: String(error.message || error) },
        });
      }
    }
  }

  consumeRecord(state, source, rawRecord) {
    const record = normalizeCodexRolloutRecord(rawRecord);
    if (!record) return;
    if (record.type === "session_meta") {
      state.sessionMeta = record.payload || {};
      return;
    }
    const payloadType = record.payload?.type;
    if (record.type === "event_msg" && payloadType === "task_started") {
      if (state.currentTurn?.entries.length) this.finalizeTurn(state, source, { interrupted: true });
      state.currentTurn = createTurn(record);
      return;
    }
    if (!state.currentTurn) {
      state.threadEvents.push(record);
      return;
    }
    state.currentTurn.entries.push(record);
    if (record.type === "turn_context") {
      state.currentTurn.turnContext = record.payload || {};
      if (record.payload?.turn_id) state.currentTurn.turnId = record.payload.turn_id;
    }
    if (record.type === "event_msg" && payloadType === "task_complete") {
      state.currentTurn.completedEvent = record.payload;
      state.currentTurn.completedAt = record.payload?.completed_at || record.timestamp || null;
      this.finalizeTurn(state, source);
    } else if (record.type === "event_msg" && payloadType === "turn_aborted") {
      state.currentTurn.aborted = true;
      state.currentTurn.completedAt = record.timestamp || null;
      this.finalizeTurn(state, source);
    }
  }

  finalizeTurn(state, source, { interrupted = false } = {}) {
    if (!state.currentTurn?.entries.length) {
      state.currentTurn = null;
      return;
    }
    if (interrupted) state.currentTurn.interrupted = true;
    state.captures.push(
      ...normalizeCodexRolloutTask({
        source,
        sessionMeta: state.sessionMeta,
        turn: state.currentTurn,
        requestIndex: state.captures.length + 1,
      }),
    );
    state.currentTurn = null;
  }

  captureSnapshots(state, source) {
    if (!state.currentTurn?.entries.length) return state.captures;
    return [
      ...state.captures,
      ...normalizeCodexRolloutTask({
        source,
        sessionMeta: state.sessionMeta,
        turn: state.currentTurn,
        requestIndex: state.captures.length + 1,
      }),
    ];
  }

  captureCount(state) {
    return state.captures.length + (state.complete && state.currentTurn?.entries.length ? 1 : 0);
  }
}

function createState(filePath, stat) {
  return {
    filePath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    readOffset: 0,
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
    skippingLongLine: false,
    skippedLongLineChars: 0,
    complete: false,
    sessionMeta: {},
    threadEvents: [],
    currentTurn: null,
    captures: [],
  };
}

function createTurn(record) {
  return {
    turnId: record.payload?.turn_id || null,
    startedAt: record.payload?.started_at || record.timestamp || null,
    startedEvent: record.payload?.type === "task_started" ? record.payload : null,
    completedAt: null,
    completedEvent: null,
    turnContext: null,
    aborted: false,
    interrupted: false,
    entries: [record],
  };
}

function sourceCommand(source, sessionMeta) {
  return {
    generated_at: source.updated_at || source.created_at || null,
    cwd: source.workspace || sessionMeta?.cwd || null,
    conversation_id: source.conversation_id || sessionMeta?.id || sessionMeta?.session_id || null,
    mode: "codex_rollout_local",
    agent: "Codex",
    evidence_mode: "local_rollout",
    exact_wire_request: false,
    rollout_path: source.path,
  };
}

function findCaptureIndex(captures, requestId) {
  return captures.findIndex(
    (capture) => capture.capture_id === requestId || String(capture.request_index) === String(requestId),
  );
}

function nonNegativeInteger(value, name) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return number;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}
