import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { captureProvenanceOr, importedTraceProvenance } from "../core/provenance.mjs";
import { redactText } from "../core/redaction.mjs";

export const TRACE_BUNDLE_FORMAT = "peekmyagent.trace.v1";
export const TRACE_BUNDLE_LIMITS = Object.freeze({
  importBytes: 64 * 1024 * 1024,
  unzippedBytes: 256 * 1024 * 1024,
  captures: 5000,
  redactionDepth: 64,
  redactionNodes: 200000,
});

export class TraceBundleService {
  constructor({ repository, captureReader, importsDir, importedSourceFromDir, sanitizeTitle, sanitizeSourceId, errors, clock, randomUUID } = {}) {
    this.repository = requiredObject(repository, "repository");
    this.captureReader = requiredObject(captureReader, "captureReader");
    this.importsDir = requiredText(importsDir, "importsDir");
    this.importedSourceFromDir = requiredFunction(importedSourceFromDir, "importedSourceFromDir");
    this.sanitizeTitle = requiredFunction(sanitizeTitle, "sanitizeTitle");
    this.sanitizeSourceId = requiredFunction(sanitizeSourceId, "sanitizeSourceId");
    this.errors = errors || {};
    this.clock = typeof clock === "function" ? clock : () => new Date();
    this.randomUUID = typeof randomUUID === "function" ? randomUUID : () => crypto.randomUUID();
  }

  export(sourceId) {
    const requested = this.sanitizeSourceId(sourceId);
    if (!requested) throw this.clientError("Trace export requires a source id.");
    const sources = this.repository.list({ includeStats: false });
    if (!sources.length) throw new Error("No viewer sources configured");
    const source = this.repository.resolve(requested, { requireSource: true, sources });
    const captures = this.captureReader.readAll(source).captures;
    const bundle = buildTraceBundle({ source, captures }, { now: this.clock() });
    const fileBase = safeFileName(`peekmyagent-trace-${bundle.manifest.trace_id}-${bundle.manifest.exported_at.slice(0, 10)}`);
    const payload = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return {
      bundle,
      filename: `${fileBase}.peektrace.json.gz`,
      buffer: zlib.gzipSync(payload),
    };
  }

  import(buffer) {
    const bundle = parseTraceBundle(buffer, { tooLarge: (message) => this.tooLarge(message) });
    const captures = validateTraceBundle(bundle, {
      tooLarge: (message) => this.tooLarge(message),
      randomUUID: this.randomUUID,
    });
    fs.mkdirSync(this.importsDir, { recursive: true, mode: 0o700 });
    const traceId = safeFileName(bundle.manifest?.trace_id || traceIdForCaptures(captures));
    const dir = uniqueImportDir(this.importsDir, traceId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const title = this.sanitizeTitle(bundle.manifest?.title || bundle.source?.label, `Imported trace ${traceId}`);
    const manifest = {
      ...(bundle.manifest || {}),
      trace_id: traceId,
      imported_at: this.clock().toISOString(),
      title,
      source: bundle.source || {},
      format: bundle.format || TRACE_BUNDLE_FORMAT,
    };
    writePrivateJson(path.join(dir, "manifest.json"), manifest);
    writePrivateJson(path.join(dir, "proxy-captures.json"), captures);
    const source = this.importedSourceFromDir(dir, path.basename(dir));
    return {
      ok: true,
      imported: true,
      source,
      source_id: source?.id || null,
      request_count: captures.length,
      sources: this.repository.list(),
    };
  }

  clientError(message) {
    return typeof this.errors.client === "function" ? this.errors.client(message) : new Error(message);
  }

  tooLarge(message) {
    return typeof this.errors.tooLarge === "function" ? this.errors.tooLarge(message) : new Error(message);
  }
}

export function buildTraceBundle(data, { now = new Date() } = {}) {
  const rawCaptures = (data.captures || []).filter(Boolean);
  const exportRedaction = redactTraceExportValue(rawCaptures);
  const captures = exportRedaction.value;
  const traceId = crypto.createHash("sha256").update(JSON.stringify(captures.map((capture) => capture.capture_id || capture.request_index || ""))).digest("hex").slice(0, 12);
  const stats = traceBundleStats(captures);
  return {
    format: TRACE_BUNDLE_FORMAT,
    manifest: {
      trace_id: traceId,
      exported_at: now.toISOString(),
      title: data.source?.label || data.source?.id || "peekMyAgent Trace",
      source_id: data.source?.id || null,
      request_count: captures.length,
      response_count: stats.response_count,
      subagent_count: stats.subagent_count,
      raw_body_bytes: stats.raw_body_bytes,
      export_kind: "sanitized_share_bundle",
      redaction: {
        applied: true,
        strategy: "secret-patterns-in-string-values",
        count: exportRedaction.redactions.length,
      },
      privacy_notice: "This portable trace is sanitized for common secret/token patterns, but may still contain private prompts, code, file paths, tool results, or business data. Review before sharing.",
      note: "Portable peekMyAgent trace bundle. Import in the dashboard for readonly viewing.",
    },
    source: {
      id: data.source?.id || null,
      label: data.source?.label || null,
      agent: data.source?.agent || null,
      confidence: data.source?.confidence || null,
      kind: data.source?.kind || null,
      workspace: data.source?.workspace || null,
      conversation_id: data.source?.conversation_id || null,
    },
    captures,
  };
}

export function parseTraceBundle(buffer, { tooLarge = (message) => new Error(message) } = {}) {
  if (!buffer?.length) throw new Error("Trace bundle is empty.");
  if (buffer.length > TRACE_BUNDLE_LIMITS.importBytes) throw tooLarge(`Trace bundle is too large. Limit is ${formatBytes(TRACE_BUNDLE_LIMITS.importBytes)}.`);
  let payload;
  try {
    payload = isGzipBuffer(buffer) ? zlib.gunzipSync(buffer, { maxOutputLength: TRACE_BUNDLE_LIMITS.unzippedBytes }) : buffer;
  } catch (error) {
    if (/maxOutputLength|too large|buffer/i.test(error?.message || "")) {
      throw tooLarge(`Trace bundle expands beyond ${formatBytes(TRACE_BUNDLE_LIMITS.unzippedBytes)}.`);
    }
    throw error;
  }
  if (payload.length > TRACE_BUNDLE_LIMITS.unzippedBytes) throw tooLarge(`Trace bundle expands beyond ${formatBytes(TRACE_BUNDLE_LIMITS.unzippedBytes)}.`);
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Trace bundle must be a peekMyAgent .peektrace.json.gz or JSON file.");
  }
}

export function validateTraceBundle(bundle, { tooLarge = (message) => new Error(message), randomUUID = () => crypto.randomUUID() } = {}) {
  if (!bundle || typeof bundle !== "object") throw new Error("Invalid trace bundle.");
  if (bundle.format && bundle.format !== TRACE_BUNDLE_FORMAT) throw new Error(`Unsupported trace bundle format: ${bundle.format}`);
  const captures = Array.isArray(bundle.captures) ? bundle.captures : Array.isArray(bundle["proxy-captures"]) ? bundle["proxy-captures"] : null;
  if (!captures?.length) throw new Error("Trace bundle does not contain captures.");
  if (captures.length > TRACE_BUNDLE_LIMITS.captures) throw tooLarge(`Trace bundle contains too many captures. Limit is ${TRACE_BUNDLE_LIMITS.captures}.`);
  for (const [index, capture] of captures.entries()) {
    if (!capture || typeof capture !== "object") throw new Error(`Invalid capture at index ${index}.`);
    capture.capture_id ||= randomUUID();
    capture.watch_id ||= bundle.source?.id || bundle.manifest?.trace_id || "imported-trace";
    capture.request_index ||= index + 1;
    capture.provenance = captureProvenanceOr(capture.provenance, () => importedTraceProvenance(capture));
  }
  return captures;
}

export function redactTraceExportValue(value, pathParts = [], context = { nodes: 0 }) {
  const fieldPath = pathParts.length ? pathParts.join(".") : "trace";
  if (pathParts.length && isSensitiveTraceExportField(pathParts[pathParts.length - 1])) {
    return redactedTraceExportMarker(fieldPath, "trace_export_sensitive_field");
  }
  if (pathParts.length > TRACE_BUNDLE_LIMITS.redactionDepth) {
    return redactedTraceExportMarker(fieldPath, "trace_export_max_depth");
  }
  if (context.nodes >= TRACE_BUNDLE_LIMITS.redactionNodes) {
    return redactedTraceExportMarker(fieldPath, "trace_export_node_budget");
  }
  context.nodes += 1;
  if (typeof value === "string") return redactText(value, fieldPath);
  if (Array.isArray(value)) return redactArray(value, pathParts, fieldPath, context);
  if (value && typeof value === "object") return redactObject(value, pathParts, fieldPath, context);
  return { value, redactions: [] };
}

function redactArray(value, pathParts, fieldPath, context) {
  const redactions = [];
  const output = [];
  for (const [index, item] of value.entries()) {
    if (context.nodes >= TRACE_BUNDLE_LIMITS.redactionNodes) {
      const child = redactedTraceExportMarker(fieldPath, "trace_export_node_budget");
      redactions.push(...child.redactions);
      output.push(child.value);
      break;
    }
    const child = redactTraceExportValue(item, [...pathParts, String(index)], context);
    redactions.push(...child.redactions);
    output.push(child.value);
  }
  return { value: output, redactions };
}

function redactObject(value, pathParts, fieldPath, context) {
  const redactions = [];
  const output = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (context.nodes >= TRACE_BUNDLE_LIMITS.redactionNodes) {
      const child = redactedTraceExportMarker(fieldPath, "trace_export_node_budget");
      redactions.push(...child.redactions);
      output.__peekmyagent_redacted__ = child.value;
      break;
    }
    const child = redactTraceExportValue(childValue, [...pathParts, key], context);
    redactions.push(...child.redactions);
    output[key] = child.value;
  }
  return { value: output, redactions };
}

function traceBundleStats(captures) {
  return {
    response_count: captures.filter((capture) => capture?.response).length,
    subagent_count: captures.filter((capture) => headerValue(capture?.headers, "x-claude-code-agent-id")).length,
    raw_body_bytes: captures.reduce((sum, capture) => sum + (Number(capture?.raw_body_length) || byteLength(capture?.body)), 0),
  };
}

function traceIdForCaptures(captures) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(captures.map((capture) => [capture.capture_id, capture.request_index, capture.received_at])))
    .digest("hex")
    .slice(0, 12);
}

function uniqueImportDir(root, traceId) {
  const resolvedRoot = path.resolve(root || "");
  const safeTraceId = safeFileName(traceId);
  let candidate = safeImportChildDir(resolvedRoot, safeTraceId);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = safeImportChildDir(resolvedRoot, `${safeTraceId}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function safeImportChildDir(root, childName) {
  const target = path.resolve(root, childName);
  const relative = path.relative(root, target);
  if (!root || !relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to create an imported trace outside the imports directory.");
  }
  return target;
}

function safeFileName(value) {
  const text = String(value || "trace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return text || "trace";
}

function redactedTraceExportMarker(fieldPath, reason) {
  return { value: `[REDACTED:${reason}]`, redactions: [{ field_path: fieldPath, reason }] };
}

function isSensitiveTraceExportField(fieldName) {
  return /authorization|api[-_]?key|x-api-key|cookie|token|secret|password|credential|session[-_]?id/i.test(String(fieldName || ""));
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isGzipBuffer(buffer) {
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} is required`);
  return value;
}

function requiredText(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} is required`);
  return String(value);
}
