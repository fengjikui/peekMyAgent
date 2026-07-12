import fs from "node:fs";
import path from "node:path";
import { SOURCE_TEXT_LIMITS, sanitizeSourceText } from "./source-text.mjs";

export function listImportedTraceSources({ importsDir, summarizeDirectory, cleanText } = {}) {
  if (!importsDir || !fs.existsSync(importsDir)) return [];
  return fs
    .readdirSync(importsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => importedTraceSourceFromDir(path.join(importsDir, entry.name), entry.name, { summarizeDirectory, cleanText }))
    .filter(Boolean);
}

export function importedTraceSourceFromDir(dir, idPart = path.basename(dir), { summarizeDirectory, cleanText } = {}) {
  if (!hasCaptureFile(dir)) return null;
  const manifest = readOptionalJson(path.join(dir, "manifest.json")) || {};
  const source = manifest.source && typeof manifest.source === "object" ? manifest.source : {};
  const stats = traceManifestStats(manifest) || summarizeFallback(dir, summarizeDirectory);
  const clean = typeof cleanText === "function" ? cleanText : undefined;
  const label = sanitizeSourceText(manifest.title || source.label, {
    fallback: path.basename(dir) || "Imported trace",
    limit: SOURCE_TEXT_LIMITS.traceTitle,
    clean,
  });
  const agent = sanitizeSourceText(source.agent || manifest.agent, {
    fallback: "Imported Trace",
    limit: SOURCE_TEXT_LIMITS.agent,
    clean,
  });
  const workspace = sanitizeSourceText(source.workspace || stats.workspace, { limit: SOURCE_TEXT_LIMITS.workspace, clean }) || null;
  const conversationId = sanitizeSourceText(source.conversation_id, { limit: SOURCE_TEXT_LIMITS.conversation, clean }) || null;
  return {
    id: `imported-${idPart}`,
    label,
    original_label: label,
    agent,
    confidence: "imported",
    kind: "imported_trace",
    path: dir,
    available: true,
    readonly: true,
    imported: true,
    note: "导入的 peekMyAgent Trace 包；只读查看，不绑定本机实时监听。",
    created_at: manifest.imported_at || manifest.exported_at || null,
    ...stats,
    workspace,
    conversation_id: conversationId,
  };
}

export function traceManifestStats(manifest) {
  const requestCount = boundedManifestCount(manifest?.request_count);
  if (requestCount <= 0) return null;
  return {
    request_count: requestCount,
    response_count: boundedManifestCount(manifest.response_count),
    subagent_count: boundedManifestCount(manifest.subagent_count),
    raw_body_bytes: boundedManifestCount(manifest.raw_body_bytes),
  };
}

function summarizeFallback(dir, summarizeDirectory) {
  if (typeof summarizeDirectory !== "function") {
    return { request_count: 0, response_count: 0, subagent_count: 0, raw_body_bytes: 0 };
  }
  const stats = summarizeDirectory(dir);
  return stats && typeof stats === "object" ? stats : { request_count: 0, response_count: 0, subagent_count: 0, raw_body_bytes: 0 };
}

function hasCaptureFile(dir) {
  return fs.existsSync(path.join(dir, "proxy-captures.json"));
}

function readOptionalJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function boundedManifestCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER);
}
