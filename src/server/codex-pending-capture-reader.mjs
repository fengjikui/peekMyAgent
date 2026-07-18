export class CodexPendingCaptureReader {
  read(source) {
    return emptyResult(source);
  }

  readPage(source, { cursor = 0, limit = 32 } = {}) {
    const offset = nonNegativeInteger(cursor);
    const pageLimit = positiveInteger(limit, 32, 100);
    return {
      ...emptyResult(source),
      startIndex: offset,
      page: {
        cursor: String(offset),
        next_cursor: null,
        offset,
        limit: pageLimit,
        loaded_count: 0,
        total_count: 0,
        has_more: false,
      },
    };
  }

  readRequestWindow(_source, requestId) {
    throw new Error(`Request not found while the Codex observation is waiting: ${requestId}`);
  }
}

function emptyResult(source) {
  return {
    captures: [],
    debugSources: [],
    command: {
      generated_at: source?.updated_at || source?.created_at || null,
      cwd: source?.workspace || null,
      conversation_id: null,
      mode: "codex_rollout_pending",
      agent: "Codex",
      evidence_mode: "local_rollout",
      exact_wire_request: false,
      status: "waiting",
    },
    totalCount: 0,
    startIndex: 0,
  };
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("Codex pending cursor must be a non-negative integer");
  return number;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}
