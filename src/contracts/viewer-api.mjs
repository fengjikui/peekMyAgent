export const VIEWER_API_DTO_CONTRACT_VERSION = 1;
export const SOURCE_SUMMARY_CONTRACT_VERSION = 1;
export const TRACE_REQUEST_DETAIL_CONTRACT_VERSION = 1;
export const TRACE_TIMELINE_RESPONSE_CONTRACT_VERSION = 1;

export const VIEWER_API_LIMITS = Object.freeze({
  sourceIdChars: 512,
  requestIdChars: 256,
  cursorChars: 128,
  initialRequests: 32,
  maxInitialRequests: 120,
});

export const VIEWER_API_ROUTES = Object.freeze(
  [
    ["/api/sources", "GET"],
    ["/api/translations", "GET"],
    ["/api/trace/export", "GET"],
    ["/api/watch/status", "GET"],
    ["/api/daemon/ping", "GET"],
    ["/api/daemon/status", "GET"],
    ["/api/view", "GET"],
    ["/api/request", "GET"],
    ["/api/translations/generate", "POST"],
    ["/api/watch/start", "POST"],
    ["/api/watch/stop", "POST"],
    ["/api/watch/pause", "POST"],
    ["/api/agent/send", "POST"],
    ["/api/source/update", "POST"],
    ["/api/trace/import", "POST"],
    ["/api/capture/otel", "POST"],
    ["/api/capture/otel/events", "POST"],
    ["/api/capture/otel/traces", "POST"],
    ["/api/daemon/shutdown", "POST"],
  ].map(([pathname, method]) => Object.freeze({ pathname, method })),
);

const API_METHODS = new Map(VIEWER_API_ROUTES.map(({ pathname, method }) => [pathname, method]));

export function expectedViewerApiMethod(pathname) {
  return API_METHODS.get(pathname) || "";
}

export function sanitizeApiLookupId(value, { limit = VIEWER_API_LIMITS.sourceIdChars } = {}) {
  const text = String(value || "")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const maxChars = Math.max(16, Number(limit) || VIEWER_API_LIMITS.sourceIdChars);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

export function validateSourceSummary(source) {
  const errors = [];
  if (!isRecord(source)) return { ok: false, errors: ["source must be an object"] };
  if (!nonEmptyText(source.id)) errors.push("id is required");
  if (!nonEmptyText(source.label)) errors.push("label is required");
  if (!nonEmptyText(source.kind)) errors.push("kind is required");
  if (typeof source.available !== "boolean") errors.push("available must be boolean");
  if (source.request_count != null && (!Number.isFinite(Number(source.request_count)) || Number(source.request_count) < 0)) {
    errors.push("request_count must be a non-negative number");
  }
  return { ok: errors.length === 0, errors };
}

export function assertSourceSummary(source, name = "source") {
  return assertContract(source, validateSourceSummary(source), name);
}

export function validateSourceSummaryList(value) {
  if (!Array.isArray(value)) return { ok: false, errors: ["response must be an array"] };
  const errors = [];
  value.forEach((source, index) => {
    const validation = validateSourceSummary(source);
    errors.push(...validation.errors.map((error) => `source[${index}].${error}`));
  });
  return { ok: errors.length === 0, errors };
}

export function assertSourceSummaryList(value, name = "Viewer API source list") {
  return assertContract(value, validateSourceSummaryList(value), name);
}

export function validateTraceRequestDetailResponse(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["response must be an object"] };

  const sourceValidation = validateSourceSummary(value.source);
  errors.push(...sourceValidation.errors.map((error) => `source.${error}`));

  if (!isRecord(value.request)) {
    errors.push("request must be an object");
  } else {
    if (!nonEmptyText(value.request.id)) errors.push("request.id is required");
    if (!positiveInteger(value.request.request_index)) errors.push("request.request_index must be a positive integer");
    if (value.request.detail_scope !== "request_window") errors.push("request.detail_scope must be request_window");
  }
  if (!nonEmptyText(value.generated_at)) errors.push("generated_at is required");
  if (value.detail_scope !== "request_window") errors.push("detail_scope must be request_window");
  return { ok: errors.length === 0, errors };
}

export function assertTraceRequestDetailResponse(value, name = "Viewer API request detail") {
  return assertContract(value, validateTraceRequestDetailResponse(value), name);
}

export function validateTraceTimelineResponse(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["response must be an object"] };

  const sourceValidation = validateSourceSummary(value.source);
  errors.push(...sourceValidation.errors.map((error) => `source.${error}`));
  if (!nonEmptyText(value.generated_at)) errors.push("generated_at is required");
  if (!isRecord(value.stats)) errors.push("stats must be an object");
  validateTimelineRequests(value.requests, "requests", errors);

  const pageScope = value.page_scope;
  if (pageScope != null && pageScope !== "timeline_cursor_delta") {
    errors.push("page_scope must be timeline_cursor_delta when present");
  }

  if (pageScope === "timeline_cursor_delta") {
    validateCursorTimelineResponse(value, errors);
  } else {
    validateTimelineEntities(value.turns, "turns", errors);
    validateAgentTrace(value.agent_trace, "agent_trace", errors);
    if (value.partial != null) validateInitialPartial(value.partial, errors);
  }

  return { ok: errors.length === 0, errors };
}

export function assertTraceTimelineResponse(value, name = "Viewer API timeline response") {
  return assertContract(value, validateTraceTimelineResponse(value), name);
}

function validateCursorTimelineResponse(value, errors) {
  validateTimelineEntities(value.request_patches, "request_patches", errors);
  validateTimelineEntities(value.turn_updates, "turn_updates", errors);
  validateIdList(value.removed_turn_ids, "removed_turn_ids", errors);
  validateCursorPartial(value.partial, errors);

  if (value.turns != null) validateTimelineEntities(value.turns, "turns", errors);
  if (value.agent_trace != null) validateAgentTrace(value.agent_trace, "agent_trace", errors);
  if (value.agent_trace_delta != null && !isRecord(value.agent_trace_delta)) {
    errors.push("agent_trace_delta must be an object or null");
  }
}

function validateTimelineRequests(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((request, index) => {
    if (!isRecord(request)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    if (!nonEmptyText(request.id)) errors.push(`${path}[${index}].id is required`);
    if (!positiveInteger(request.request_index)) {
      errors.push(`${path}[${index}].request_index must be a positive integer`);
    }
  });
}

function validateTimelineEntities(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((entity, index) => {
    if (!isRecord(entity)) {
      errors.push(`${path}[${index}] must be an object`);
    } else if (!nonEmptyText(entity.id)) {
      errors.push(`${path}[${index}].id is required`);
    }
  });
}

function validateAgentTrace(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of ["branches", "spawns", "returns"]) {
    if (!Array.isArray(value[key])) errors.push(`${path}.${key} must be an array`);
  }
}

function validateInitialPartial(value, errors) {
  if (!isRecord(value)) {
    errors.push("partial must be an object");
    return;
  }
  if (value.mode !== "initial") errors.push("partial.mode must be initial");
  if (!positiveInteger(value.request_limit)) errors.push("partial.request_limit must be a positive integer");
  validateTimelineCounts(value, errors);
}

function validateCursorPartial(value, errors) {
  if (!isRecord(value)) {
    errors.push("partial must be an object");
    return;
  }
  if (value.mode !== "cursor") errors.push("partial.mode must be cursor");
  validateTimelineCounts(value, errors);
  for (const key of ["page_offset", "page_request_count"]) {
    if (!nonNegativeInteger(value[key])) errors.push(`partial.${key} must be a non-negative integer`);
  }
  if (value.has_more && !nonEmptyText(value.next_cursor)) {
    errors.push("partial.next_cursor is required when more pages are available");
  }
  if (!value.has_more && value.next_cursor != null) {
    errors.push("partial.next_cursor must be null when no more pages are available");
  }
  for (const key of ["next_cursor", "refresh_cursor"]) {
    if (value[key] != null && !nonEmptyText(value[key])) errors.push(`partial.${key} must be text or null`);
  }
}

function validateTimelineCounts(value, errors) {
  for (const key of ["loaded_request_count", "total_request_count"]) {
    if (!nonNegativeInteger(value[key])) errors.push(`partial.${key} must be a non-negative integer`);
  }
  if (typeof value.has_more !== "boolean") errors.push("partial.has_more must be boolean");
  if (
    nonNegativeInteger(value.loaded_request_count) &&
    nonNegativeInteger(value.total_request_count) &&
    value.total_request_count < value.loaded_request_count
  ) {
    errors.push("partial.total_request_count must not be smaller than loaded_request_count");
  }
}

function validateIdList(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((id, index) => {
    if (!nonEmptyText(id)) errors.push(`${path}[${index}] must be non-empty text`);
  });
}

function assertContract(value, validation, name) {
  if (!validation.ok) throw new Error(`Invalid ${name}: ${validation.errors.join("; ")}`);
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0;
}
