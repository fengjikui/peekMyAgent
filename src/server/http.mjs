import fs from "node:fs";

export const VIEWER_INTENT_HEADER = "x-peekmyagent-intent";

export const VIEWER_INTENTS = Object.freeze({
  traceExport: "trace-export",
  traceImport: "trace-import",
  agentSend: "agent-send",
  otelIngest: "otel-ingest",
  otelEventIngest: "otel-event-ingest",
  translationGenerate: "translation-generate",
  sourceUpdate: "source-update",
  daemonShutdown: "daemon-shutdown",
  watchStart: "watch-start",
  watchStop: "watch-stop",
  watchPause: "watch-pause",
});

const DEFAULT_MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RAW_BODY_BYTES = 64 * 1024 * 1024;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_METHODS = new Map([
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
]);

export function readJsonBody(req, { maxBytes = DEFAULT_MAX_JSON_BODY_BYTES } = {}) {
  const contentType = headerValue(req.headers || {}, "content-type");
  if (contentType && !isJsonContentType(contentType)) {
    throw httpError(415, "Expected application/json request body.");
  }
  return collectRequestBody(req, {
    maxBytes,
    tooLargeMessage: `JSON request body is too large. Limit is ${formatBytes(maxBytes)}.`,
  }).then((buffer) => {
    const text = buffer.toString("utf8");
    if (!text.trim()) return {};
    return JSON.parse(text);
  });
}

export function readRawBody(req, { maxBytes = DEFAULT_MAX_RAW_BODY_BYTES } = {}) {
  return collectRequestBody(req, {
    maxBytes,
    tooLargeMessage: `Request body is too large. Limit is ${formatBytes(maxBytes)}.`,
  });
}

export function validateLocalHttpRequest(req, url, { unsafeAllowRemote = false } = {}) {
  if (!url.pathname.startsWith("/api/")) return null;
  const hostHeader = headerValue(req.headers || {}, "host");
  const host = hostNameFromHeader(hostHeader);
  if (host && !unsafeAllowRemote && !isLoopbackHost(host)) {
    return { status: 403, message: "peekMyAgent dashboard only accepts loopback Host headers by default." };
  }
  for (const [headerName, value] of [
    ["Origin", headerValue(req.headers || {}, "origin")],
    ["Referer", headerValue(req.headers || {}, "referer")],
  ]) {
    if (!value) continue;
    const guard = validateBrowserSourceHeader(value, hostHeader, { unsafeAllowRemote, headerName });
    if (guard) return guard;
  }
  const secFetchSite = headerValue(req.headers || {}, "sec-fetch-site").toLowerCase();
  if (secFetchSite === "cross-site") return { status: 403, message: "Cross-site browser requests are not allowed." };
  const secFetchMode = headerValue(req.headers || {}, "sec-fetch-mode").toLowerCase();
  const secFetchDest = headerValue(req.headers || {}, "sec-fetch-dest").toLowerCase();
  if (secFetchMode === "no-cors" || (secFetchDest && secFetchDest !== "empty")) {
    return { status: 403, message: "Browser resource or navigation requests are not allowed for peekMyAgent APIs." };
  }
  const method = String(req.method || "").toUpperCase();
  const expectedMethod = expectedApiMethod(url.pathname);
  const knownWrongMethod = expectedMethod && method !== expectedMethod;
  if (STATE_CHANGING_METHODS.has(method) && !knownWrongMethod) {
    const contentType = headerValue(req.headers || {}, "content-type");
    const isTraceImport = url.pathname === "/api/trace/import" && isTraceImportContentType(contentType);
    if (!isJsonContentType(contentType) && !isTraceImport) {
      return { status: 415, message: "State-changing API calls require application/json or an accepted trace import content type." };
    }
  }
  return null;
}

export function expectedApiMethod(pathname) {
  return API_METHODS.get(pathname) || "";
}

export function validateRequestIntent(req, expected, message) {
  const intent = headerValue(req.headers || {}, VIEWER_INTENT_HEADER);
  if (intent === expected) return null;
  return { status: 403, message };
}

export const validateTraceExportIntent = intentValidator(VIEWER_INTENTS.traceExport, "Trace export requires an explicit dashboard export intent.");
export const validateTraceImportIntent = intentValidator(VIEWER_INTENTS.traceImport, "Trace import requires an explicit dashboard import intent.");
export const validateAgentSendIntent = intentValidator(VIEWER_INTENTS.agentSend, "Agent send requires an explicit dashboard send intent.");
export const validateOtelIngestIntent = intentValidator(VIEWER_INTENTS.otelIngest, "OTel ingest requires an explicit local wrapper ingest intent.");
export const validateOtelEventIngestIntent = intentValidator(VIEWER_INTENTS.otelEventIngest, "OTel event ingest requires an explicit local telemetry intent.");
export const validateTranslationGenerateIntent = intentValidator(
  VIEWER_INTENTS.translationGenerate,
  "Translation generation requires an explicit dashboard refresh intent.",
);
export const validateSourceUpdateIntent = intentValidator(VIEWER_INTENTS.sourceUpdate, "Source update requires an explicit dashboard source action intent.");
export const validateDaemonShutdownIntent = intentValidator(VIEWER_INTENTS.daemonShutdown, "Daemon shutdown requires an explicit local CLI shutdown intent.");
export const validateWatchStartIntent = intentValidator(VIEWER_INTENTS.watchStart, "Watch start requires an explicit local wrapper start intent.");
export const validateWatchStopIntent = intentValidator(VIEWER_INTENTS.watchStop, "Watch stop requires an explicit dashboard or CLI stop intent.");
export const validateWatchPauseIntent = intentValidator(VIEWER_INTENTS.watchPause, "Watch pause requires an explicit dashboard or CLI pause intent.");

export function rejectWrongMethod(req, res, method) {
  const actual = String(req.method || "GET").toUpperCase();
  const expected = String(method || "GET").toUpperCase();
  if (actual === expected) return false;
  res.setHeader("allow", expected);
  writeJson(res, 405, { error: `Method ${actual} is not allowed for this endpoint. Use ${expected}.` });
  return true;
}

export function assertSafeBindHost(host, { unsafeAllowRemote = false } = {}) {
  const normalized = String(host || "").trim();
  if (!normalized || isLoopbackHost(normalized) || unsafeAllowRemote || process.env.PEEKMYAGENT_UNSAFE_ALLOW_REMOTE === "1") return;
  throw new Error(`Refusing to bind peekMyAgent to non-loopback host ${normalized}. Use PEEKMYAGENT_UNSAFE_ALLOW_REMOTE=1 only on trusted networks.`);
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function serveFile(res, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { ...viewerSecurityHeaders(), "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

export function writeJson(res, status, value) {
  res.writeHead(status, { ...viewerSecurityHeaders(), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

export function viewerSecurityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=()",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

function collectRequestBody(req, { maxBytes, tooLargeMessage }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(httpError(413, tooLargeMessage));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function intentValidator(expected, message) {
  return (req) => validateRequestIntent(req, expected, message);
}

function validateBrowserSourceHeader(value, hostHeader, { unsafeAllowRemote = false, headerName = "Origin" } = {}) {
  if (unsafeAllowRemote) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { status: 403, message: `Invalid ${headerName} header.` };
  }
  if (!isLoopbackHost(parsed.hostname)) return { status: 403, message: "Cross-site browser requests are not allowed." };
  if (!browserSourceMatchesHost(parsed, hostHeader)) {
    return { status: 403, message: "Browser API requests must come from the active peekMyAgent dashboard origin." };
  }
  return null;
}

function browserSourceMatchesHost(parsedSource, hostHeader) {
  const request = hostParts(hostHeader);
  if (!request.hostname || parsedSource.protocol !== "http:") return false;
  if (!isLoopbackHost(request.hostname) || !isLoopbackHost(parsedSource.hostname)) return false;
  return normalizedPort(parsedSource.protocol, parsedSource.port) === request.port;
}

function hostParts(value) {
  const text = String(value || "").trim();
  if (!text) return { hostname: "", port: "" };
  try {
    const parsed = new URL(`http://${text}`);
    return { hostname: parsed.hostname, port: normalizedPort(parsed.protocol, parsed.port) };
  } catch {
    return { hostname: hostNameFromHeader(text), port: "" };
  }
}

function normalizedPort(protocol, port) {
  if (port) return String(port);
  return protocol === "https:" ? "443" : "80";
}

function hostNameFromHeader(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("[")) return text.slice(1, text.indexOf("]"));
  return text.split(":")[0];
}

function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "0:0:0:0:0:0:0:1";
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function isJsonContentType(value) {
  return /^application\/(?:json|[^;]+\+json)\b/i.test(String(value || ""));
}

function isTraceImportContentType(value) {
  return /^(application\/(?:octet-stream|gzip|json)|[^;]+\/[^;]+\+json)\b/i.test(String(value || ""));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
