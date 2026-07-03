import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { redactHeaders } from "./redaction.mjs";

export const DEFAULT_WATCH_ID = "default";
const MAX_CAPTURED_RESPONSE_BYTES = 4 * 1024 * 1024;

export function listen(server, host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address());
    });
  });
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function resolveRequestAttribution(req, fallback = {}) {
  const parsed = new URL(req.url || "/", "http://127.0.0.1");
  const agentRoute = parseAgentRoutePath(parsed.pathname);
  if (agentRoute) {
    const watchId = fallback.watchId || `${agentRoute.agentSlug}-${agentRoute.installId}`;
    return {
      watchId,
      forwardPath: `${agentRoute.forwardPath}${parsed.search}`,
      originalUrl: req.url || `${agentRoute.forwardPath}${parsed.search}`,
      agentRoute,
      agentProfile: firstHeader(req.headers["x-peek-agent-profile"]) || fallback.agentProfile || null,
      workspace: firstHeader(req.headers["x-peek-workspace"]) || fallback.workspace || null,
      conversationId:
        firstHeader(req.headers["x-peek-conversation-id"]) ||
        firstHeader(req.headers["x-claude-code-session-id"]) ||
        fallback.conversationId ||
        null,
    };
  }
  const pathWatch = parsed.pathname.match(/^\/watch\/([^/]+)(\/.*)?$/);
  const headerWatchId = firstHeader(req.headers["x-peek-watch-id"]);
  const watchId = safeDecode(pathWatch?.[1] || headerWatchId || fallback.watchId || DEFAULT_WATCH_ID);
  const strippedPath = pathWatch ? pathWatch[2] || "/" : parsed.pathname;
  const forwardPath = `${strippedPath}${parsed.search}`;

  return {
    watchId,
    forwardPath,
    originalUrl: req.url || forwardPath,
    agentProfile: firstHeader(req.headers["x-peek-agent-profile"]) || fallback.agentProfile || null,
    workspace: firstHeader(req.headers["x-peek-workspace"]) || fallback.workspace || null,
    conversationId:
      firstHeader(req.headers["x-peek-conversation-id"]) ||
      firstHeader(req.headers["x-claude-code-session-id"]) ||
      fallback.conversationId ||
      null,
    agentRoute: null,
  };
}

export function buildCaptureRecord({
  req,
  bodyText,
  attribution,
  requestIndex,
  captureId = crypto.randomUUID(),
  receivedAt = new Date().toISOString(),
}) {
  const { headers, redactions } = redactHeaders(req.headers || {});
  return {
    capture_id: captureId,
    watch_id: attribution.watchId,
    request_index: requestIndex,
    agent_profile: attribution.agentProfile,
    workspace: attribution.workspace,
    conversation_id: attribution.conversationId,
    received_at: receivedAt,
    method: req.method,
    path: attribution.forwardPath,
    original_url: attribution.originalUrl,
    headers,
    header_redactions: redactions,
    body: parseJson(bodyText),
    raw_body_length: Buffer.byteLength(bodyText),
  };
}

export async function startCaptureProxy({
  targetBaseUrl,
  host = "127.0.0.1",
  port = 0,
  captures: captureStore,
  defaultAttribution = {},
  preserveTargetPathPrefix = false,
  shouldCapture,
  onCapture,
  onCaptureUpdate,
  onCaptureSkipped,
} = {}) {
  if (!targetBaseUrl) throw new Error("targetBaseUrl is required");
  const captures = captureStore || [];
  const requestCounters = requestCountersFromCaptures(captures);
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    const attribution = resolveRequestAttribution(req, defaultAttribution);
    const shouldCaptureRequest = shouldCapture ? shouldCapture(attribution) !== false : true;
    const capture = shouldCaptureRequest
      ? buildCaptureRecord({ req, bodyText, attribution, requestIndex: nextRequestIndex(requestCounters, attribution.watchId) })
      : null;
    if (capture) {
      captures.push(capture);
      if (onCapture) await onCapture(capture);
    } else if (onCaptureSkipped) {
      await onCaptureSkipped(attribution);
    }

    const upstreamUrl = resolveUpstreamUrl(targetBaseUrl, attribution.forwardPath, preserveTargetPathPrefix);
    const client = upstreamUrl.protocol === "https:" ? https : http;
    const upstreamReq = client.request(
      upstreamUrl,
      {
        method: req.method,
        headers: upstreamHeaders(req.headers, upstreamUrl.host),
      },
      (upstreamRes) => proxyUpstreamResponse({ upstreamRes, downstreamRes: res, capture, onCaptureUpdate }),
    );
    upstreamReq.on("error", (error) => {
      if (capture) {
        capture.upstream_error = error.message;
        capture.response = buildErrorResponseRecord(error);
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
      if (capture && onCaptureUpdate) Promise.resolve(onCaptureUpdate(capture)).catch(() => {});
    });
    upstreamReq.end(bodyText);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const address = await listen(server, host, port);
  return {
    server,
    captures,
    baseUrl: `http://${address.address}:${address.port}`,
    addCaptures(seedCaptures = []) {
      for (const capture of seedCaptures) {
        if (!capture?.capture_id || captures.some((existing) => existing.capture_id === capture.capture_id)) continue;
        captures.push(capture);
        if (capture.watch_id) {
          const current = requestCounters.get(capture.watch_id) || 0;
          requestCounters.set(capture.watch_id, Math.max(current, Number(capture.request_index) || 0));
        }
      }
    },
    urlForWatch(watchId) {
      return `${this.baseUrl}/watch/${encodeURIComponent(watchId)}`;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      });
    },
  };
}

export async function startSharedCaptureProxy({
  host = "127.0.0.1",
  port = 0,
  captures: captureStore,
  getWatch,
  getWatchForAgentRoute,
  onCapture,
  onCaptureUpdate,
  onCaptureSkipped,
} = {}) {
  if (typeof getWatch !== "function") throw new Error("getWatch is required");
  const captures = captureStore || [];
  const requestCounters = requestCountersFromCaptures(captures);
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    const initialAttribution = resolveRequestAttribution(req, {});
    const watch = initialAttribution.agentRoute
      ? await getWatchForAgentRoute?.({
          route: initialAttribution.agentRoute,
          req,
          body: parseJson(bodyText),
          bodyText,
          attribution: initialAttribution,
        })
      : await getWatch(initialAttribution.watchId);
    if (!watch?.target_base_url) {
      res.writeHead(404, { "content-type": "application/json" });
      const label = initialAttribution.agentRoute
        ? `${initialAttribution.agentRoute.agentSlug}/${initialAttribution.agentRoute.installId}`
        : initialAttribution.watchId;
      res.end(JSON.stringify({ error: `Unknown or inactive watch: ${label}` }));
      return;
    }

    const attribution = resolveRequestAttribution(req, {
      watchId: watch.watch_id,
      agentProfile: watch.agent,
      workspace: watch.workspace,
      conversationId: watch.conversation_id,
    });
    const shouldCapture = watch.status !== "paused";
    const capture = shouldCapture
      ? buildCaptureRecord({ req, bodyText, attribution, requestIndex: nextRequestIndex(requestCounters, attribution.watchId) })
      : null;
    if (capture) {
      captures.push(capture);
      if (onCapture) await onCapture(capture, watch);
    } else if (onCaptureSkipped) {
      await onCaptureSkipped(watch);
    }

    const upstreamUrl = resolveUpstreamUrl(watch.target_base_url, attribution.forwardPath, true);
    const client = upstreamUrl.protocol === "https:" ? https : http;
    const upstreamReq = client.request(
      upstreamUrl,
      {
        method: req.method,
        headers: upstreamHeaders(req.headers, upstreamUrl.host),
      },
      (upstreamRes) => proxyUpstreamResponse({ upstreamRes, downstreamRes: res, capture, watch, onCaptureUpdate }),
    );
    upstreamReq.on("error", (error) => {
      if (capture) {
        capture.upstream_error = error.message;
        capture.response = buildErrorResponseRecord(error);
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
      if (capture && onCaptureUpdate) Promise.resolve(onCaptureUpdate(capture, watch)).catch(() => {});
    });
    upstreamReq.end(bodyText);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const address = await listen(server, host, port);
  return {
    server,
    captures,
    baseUrl: `http://${address.address}:${address.port}`,
    addCaptures(seedCaptures = []) {
      for (const capture of seedCaptures) {
        if (!capture?.capture_id || captures.some((existing) => existing.capture_id === capture.capture_id)) continue;
        captures.push(capture);
        if (capture.watch_id) {
          const current = requestCounters.get(capture.watch_id) || 0;
          requestCounters.set(capture.watch_id, Math.max(current, Number(capture.request_index) || 0));
        }
      }
    },
    urlForWatch(watchId) {
      return `${this.baseUrl}/watch/${encodeURIComponent(watchId)}`;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      });
    },
  };
}

function parseAgentRoutePath(pathname) {
  const match = pathname.match(/^\/agent\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    agentSlug: safeDecode(match[1]),
    installId: safeDecode(match[2]),
    protocol: safeDecode(match[3]),
    forwardPath: match[4] || "/",
  };
}

function proxyUpstreamResponse({ upstreamRes, downstreamRes, capture, watch, onCaptureUpdate }) {
  const startedAt = Date.now();
  const chunks = [];
  let capturedBytes = 0;
  let rawBytes = 0;
  if (capture) capture.upstream_status = upstreamRes.statusCode || null;
  downstreamRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
  upstreamRes.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (capture) rawBytes += buffer.length;
    if (capture && capturedBytes < MAX_CAPTURED_RESPONSE_BYTES) {
      const available = MAX_CAPTURED_RESPONSE_BYTES - capturedBytes;
      const kept = buffer.length > available ? buffer.subarray(0, available) : buffer;
      chunks.push(Buffer.from(kept));
      capturedBytes += kept.length;
    }
    downstreamRes.write(chunk);
  });
  upstreamRes.on("end", () => {
    if (capture) {
      capture.response = buildResponseRecord({
        upstreamRes,
        bodyText: Buffer.concat(chunks).toString("utf8"),
        rawBytes,
        capturedBytes,
        startedAt,
      });
    }
    downstreamRes.end();
    if (capture && onCaptureUpdate) Promise.resolve(onCaptureUpdate(capture, watch)).catch(() => {});
  });
  upstreamRes.on("error", (error) => {
    if (capture) {
      capture.upstream_error = error.message;
      capture.response = buildErrorResponseRecord(error, { rawBytes, capturedBytes, startedAt });
    }
    downstreamRes.destroy(error);
    if (capture && onCaptureUpdate) Promise.resolve(onCaptureUpdate(capture, watch)).catch(() => {});
  });
}

function buildResponseRecord({ upstreamRes, bodyText, rawBytes, capturedBytes, startedAt }) {
  return {
    status: upstreamRes.statusCode || null,
    headers: upstreamRes.headers || {},
    received_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    raw_body_length: rawBytes,
    captured_body_length: capturedBytes,
    truncated: rawBytes > capturedBytes,
    body_text: bodyText,
    body_json: parseJson(bodyText),
  };
}

function buildErrorResponseRecord(error, { rawBytes = 0, capturedBytes = 0, startedAt = Date.now() } = {}) {
  return {
    status: 502,
    headers: { "content-type": "application/json" },
    received_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    raw_body_length: rawBytes,
    captured_body_length: capturedBytes,
    truncated: false,
    body_text: JSON.stringify({ error: error.message }),
    body_json: { error: error.message },
    error: error.message,
  };
}

export function resolveUpstreamUrl(targetBaseUrl, forwardPath, preserveTargetPathPrefix = false) {
  const base = new URL(targetBaseUrl);
  if (!preserveTargetPathPrefix) return new URL(forwardPath, base);
  const basePath = base.pathname.replace(/\/$/, "");
  const requestUrl = new URL(forwardPath, "http://peek.local");
  base.pathname = `${basePath}${requestUrl.pathname}`;
  base.search = requestUrl.search;
  return base;
}

function nextRequestIndex(counters, watchId) {
  const current = counters.get(watchId) || 0;
  const next = current + 1;
  counters.set(watchId, next);
  return next;
}

function requestCountersFromCaptures(captures) {
  const counters = new Map();
  for (const capture of captures || []) {
    if (!capture?.watch_id) continue;
    const current = counters.get(capture.watch_id) || 0;
    counters.set(capture.watch_id, Math.max(current, Number(capture.request_index) || 0));
  }
  return counters;
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0];
  return value || null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function upstreamHeaders(headers, host) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase().startsWith("x-peek-")) continue;
    output[key] = value;
  }
  output.host = host;
  return output;
}
