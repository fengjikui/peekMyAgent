import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// OTel raw-body capture for Claude Code subscription (OAuth) mode.
//
// Subscription logins cannot be captured through a rewriting proxy: Anthropic
// returns 403 "Request not allowed" for OAuth credentials that arrive via any
// local middle layer. Instead Claude Code can dump the exact request/response
// bodies to disk when `OTEL_LOG_RAW_API_BODIES=file:<dir>` is set, while still
// connecting directly to the official endpoint. This module turns those dumped
// files into the same capture records the proxy path feeds to the store, so the
// existing request-tree / display pipeline is reused unchanged.

export const OTEL_WATCH_KIND = "otel_raw_body";
export const OTEL_CAPTURE_METHOD = "otel_raw_body";

const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";

// Environment variables that make Claude Code dump raw API bodies to `dir`.
export function otelTelemetryEnv(dir) {
  if (!dir) throw new Error("otelTelemetryEnv requires a directory");
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "console",
    OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };
}

function byteLength(value) {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text, "utf8");
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return { raw, json: JSON.parse(raw) };
  } catch {
    return null;
  }
}

// List request/response dump files under `dir`, sorted by write time so that
// the Nth request can be paired with the Nth response (Claude Code writes them
// in send/receive order).
export function scanOtelDir(dir) {
  if (!dir || !fs.existsSync(dir)) return { requests: [], responses: [] };
  const requests = [];
  const responses = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (entry.name.endsWith(REQUEST_SUFFIX)) {
        requests.push({ path: full, name: entry.name, mtimeMs, id: entry.name.slice(0, -REQUEST_SUFFIX.length) });
      } else if (entry.name.endsWith(RESPONSE_SUFFIX)) {
        responses.push({ path: full, name: entry.name, mtimeMs, id: entry.name.slice(0, -RESPONSE_SUFFIX.length) });
      }
    }
  }
  const byTime = (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name);
  requests.sort(byTime);
  responses.sort(byTime);
  return { requests, responses };
}

// Claude Code stores `metadata.user_id` as a JSON string holding device/account
// /session ids. The session id is a stable per-conversation handle and the best
// native conversation_id candidate available from OTel.
function conversationIdFromBody(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== "string") return null;
  try {
    const parsed = JSON.parse(userId);
    return parsed?.session_id || null;
  } catch {
    return null;
  }
}

function responseRecord(responseFile, receivedAt) {
  const read = safeReadJson(responseFile.path);
  if (!read) return null;
  // OTel dumps the aggregated (non-SSE) response as a complete JSON message.
  // The display layer's non-stream path reads response.body_json, so we must
  // provide it (matching the proxy path's buildResponseRecord shape) — otherwise
  // the response is stored but never rendered.
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body_text: read.raw,
    body_json: read.json,
    received_at: receivedAt,
  };
}

// Convert one request dump file (+ optional paired response) into a capture
// record shaped exactly like the proxy path's buildCaptureRecord output.
export function otelRequestFileToCapture(requestFile, ctx = {}, responseFile = null) {
  const read = safeReadJson(requestFile.path);
  if (!read) return null;
  const body = read.json;
  const receivedAt = new Date(requestFile.mtimeMs || Date.now()).toISOString();
  const capture = {
    capture_id: requestFile.id || crypto.randomUUID(),
    watch_id: ctx.watchId || null,
    request_index: ctx.requestIndex ?? null,
    agent_profile: ctx.agent || "Claude Code",
    workspace: ctx.workspace || null,
    conversation_id: ctx.conversationId || conversationIdFromBody(body) || null,
    received_at: receivedAt,
    method: "POST",
    path: "/v1/messages",
    original_url: "/v1/messages",
    headers: {},
    header_redactions: [],
    body,
    raw_body_length: byteLength(read.raw),
    capture_method: OTEL_CAPTURE_METHOD,
    capture_confidence: "exact",
    source: {
      type: "otel_raw_body_file",
      request_file: requestFile.name,
      response_file: responseFile?.name || null,
      request_sha256: crypto.createHash("sha256").update(read.raw).digest("hex"),
    },
  };
  if (responseFile) {
    const response = responseRecord(responseFile, receivedAt);
    if (response) {
      capture.response = response;
      capture.upstream_status = 200;
    }
  }
  return capture;
}

// Turn a whole dump directory into ordered capture records, pairing requests
// with responses positionally. ctx supplies watch_id / workspace / agent etc.
export function otelDirToCaptures(dir, ctx = {}) {
  const { requests, responses } = scanOtelDir(dir);
  const captures = [];
  requests.forEach((requestFile, index) => {
    const responseFile = responses[index] || null;
    const capture = otelRequestFileToCapture(
      requestFile,
      { ...ctx, requestIndex: index + 1 },
      responseFile,
    );
    if (capture) captures.push(capture);
  });
  return captures;
}
