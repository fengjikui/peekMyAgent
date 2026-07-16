import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { correlationKey } from "./otel-events.mjs";
import { createCaptureProvenance } from "./provenance.mjs";

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
const DEFAULT_MAX_SCAN_FILES = 2000;
const DEFAULT_MAX_SCAN_DIRS = 2000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

// Environment variables that make Claude Code dump raw API bodies to `dir`.
export function otelTelemetryEnv(dir, { logsEndpoint, tracesEndpoint, headers } = {}) {
  if (!dir) throw new Error("otelTelemetryEnv requires a directory");
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOG_RAW_API_BODIES: `file:${dir}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };
  if (!logsEndpoint || !tracesEndpoint) return { ...env, OTEL_LOGS_EXPORTER: "console" };
  return {
    ...env,
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logsEndpoint,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
    OTEL_TRACES_EXPORT_INTERVAL: "1000",
    ...(headers ? { OTEL_EXPORTER_OTLP_HEADERS: headers } : {}),
  };
}

function byteLength(value) {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text, "utf8");
}

function safeReadJson(filePath, { maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxFileBytes) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return { raw, json: JSON.parse(raw) };
  } catch {
    return null;
  }
}

// List request/response dump files under `dir`, sorted by write time so that
// the Nth request can be paired with the Nth response (Claude Code writes them
// in send/receive order).
export function scanOtelDir(dir, { maxFiles = DEFAULT_MAX_SCAN_FILES, maxDirs = DEFAULT_MAX_SCAN_DIRS } = {}) {
  if (!dir || !fs.existsSync(dir)) return { requests: [], responses: [] };
  const requests = [];
  const responses = [];
  const stack = [dir];
  let visitedDirs = 0;
  while (stack.length && visitedDirs < maxDirs && requests.length + responses.length < maxFiles) {
    const current = stack.pop();
    visitedDirs += 1;
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
      if (requests.length + responses.length >= maxFiles) break;
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
export function otelRequestFileToCapture(requestFile, ctx = {}, responseFile = null, association = null) {
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
    provenance: createCaptureProvenance({
      transport: OTEL_CAPTURE_METHOD,
      request: { origin: "agent_telemetry", fidelity: "exact", artifact: requestFile.name },
      response: responseFile
        ? { origin: "agent_telemetry", fidelity: "exact", artifact: responseFile.name }
        : { origin: null, fidelity: "missing", artifact: null },
      association: association || { method: "none", confidence: "none" },
    }),
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

// Turn a whole dump directory into ordered capture records. OTel trace/span
// evidence is preferred; positional pairing is an explicit legacy fallback.
export function otelDirToCaptures(dir, ctx = {}, { events = [], allowHeuristicPairing = true } = {}) {
  const { requests, responses } = scanOtelDir(dir);
  const pairs = pairOtelDumpFiles(requests, responses, { events, allowHeuristicPairing });
  const captures = [];
  requests.forEach((requestFile, index) => {
    const pair = pairs.get(requestFile.path) || null;
    const responseFile = pair?.responseFile || null;
    const capture = otelRequestFileToCapture(
      requestFile,
      { ...ctx, requestIndex: index + 1 },
      responseFile,
      pair?.association || null,
    );
    if (capture) captures.push(capture);
  });
  return captures;
}

export function pairOtelDumpFiles(requests, responses, { events = [], allowHeuristicPairing = true } = {}) {
  const pairs = new Map();
  const responseByName = new Map((responses || []).map((file) => [file.name, file]));
  const requestByName = new Map((requests || []).map((file) => [file.name, file]));
  const requestEventsByCorrelation = new Map();
  const responseEventsByCorrelation = new Map();

  for (const event of events || []) {
    const key = correlationKey(event);
    if (!key) continue;
    const target = event.event_name === "api_request_body" ? requestEventsByCorrelation : responseEventsByCorrelation;
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(event);
  }

  const usedResponses = new Set();
  for (const [key, responseEvents] of responseEventsByCorrelation) {
    const requestEvents = requestEventsByCorrelation.get(key) || [];
    const availableRequests = dedupeEventsByBodyRef(requestEvents.filter((event) => requestByName.has(event.body_ref)));
    const availableResponses = dedupeEventsByBodyRef(responseEvents.filter((event) => responseByName.has(event.body_ref)));
    if (!availableRequests.length || !availableResponses.length) continue;
    availableRequests.sort(compareEventOrder);
    availableResponses.sort(compareEventOrder);
    for (const responseEvent of availableResponses) {
      const candidates = availableRequests.filter((event) => !pairs.has(requestByName.get(event.body_ref).path) && eventBeforeResponse(event, responseEvent));
      const requestEvent = candidates.at(-1);
      if (!requestEvent) continue;
      const requestFile = requestByName.get(requestEvent.body_ref);
      const responseFile = responseByName.get(responseEvent.body_ref);
      if (usedResponses.has(responseFile.path)) continue;
      const retryAmbiguous = candidates.length > 1;
      const retryOrderKnown = retryAmbiguous && candidates.every((event) => Number.isFinite(event.event_sequence)) && Number.isFinite(responseEvent.event_sequence);
      pairs.set(requestFile.path, {
        responseFile,
        association: {
          method: retryAmbiguous ? (retryOrderKnown ? "otel_trace_span_last_attempt" : "otel_trace_span_ambiguous_attempt") : "otel_trace_span",
          confidence: retryAmbiguous ? (retryOrderKnown ? "high" : "heuristic") : "exact",
          evidence: {
            trace_id: requestEvent.trace_id,
            span_id: requestEvent.span_id,
            request_event_sequence: requestEvent.event_sequence,
            response_event_sequence: responseEvent.event_sequence,
            prompt_id: requestEvent.prompt_id || responseEvent.prompt_id,
            query_source: requestEvent.query_source || responseEvent.query_source,
          },
        },
      });
      usedResponses.add(responseFile.path);
    }
  }

  if (allowHeuristicPairing) {
    const remainingRequests = (requests || []).filter((file) => !pairs.has(file.path));
    const remainingResponses = (responses || []).filter((file) => !usedResponses.has(file.path));
    remainingRequests.forEach((requestFile, index) => {
      const responseFile = remainingResponses[index];
      if (!responseFile) return;
      pairs.set(requestFile.path, {
        responseFile,
        association: {
          method: "file_write_order",
          confidence: "heuristic",
          evidence: { request_ordinal: index + 1, response_ordinal: index + 1 },
        },
      });
      usedResponses.add(responseFile.path);
    });
  }

  return pairs;
}

function compareEventOrder(a, b) {
  const aSequence = Number.isFinite(a?.event_sequence) ? a.event_sequence : Number.MAX_SAFE_INTEGER;
  const bSequence = Number.isFinite(b?.event_sequence) ? b.event_sequence : Number.MAX_SAFE_INTEGER;
  return aSequence - bSequence || String(a?.body_ref || "").localeCompare(String(b?.body_ref || ""));
}

function dedupeEventsByBodyRef(events) {
  const byBodyRef = new Map();
  for (const event of events || []) byBodyRef.set(event.body_ref, event);
  return [...byBodyRef.values()];
}

function eventBeforeResponse(requestEvent, responseEvent) {
  if (!Number.isFinite(requestEvent?.event_sequence) || !Number.isFinite(responseEvent?.event_sequence)) return true;
  return requestEvent.event_sequence < responseEvent.event_sequence;
}
