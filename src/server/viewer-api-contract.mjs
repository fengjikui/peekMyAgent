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
