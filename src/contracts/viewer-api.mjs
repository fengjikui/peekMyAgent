export const VIEWER_API_DTO_CONTRACT_VERSION = 1;
export const SOURCE_SUMMARY_CONTRACT_VERSION = 1;
export const TRACE_REQUEST_DETAIL_CONTRACT_VERSION = 1;

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
