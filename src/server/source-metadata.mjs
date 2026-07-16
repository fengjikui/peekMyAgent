import fs from "node:fs";
import path from "node:path";
import { safePathSegment } from "../core/app-paths.mjs";
import { sourceIdForWatch, watchIdFromSourceId } from "../core/source-identifiers.mjs";
import { SOURCE_TEXT_LIMITS, sanitizeSourceText } from "./source-text.mjs";

export const SOURCE_META_FILE = "source-meta.json";
export const SOURCE_META_VERSION = 1;

export function readSourceMeta(filePath, policy = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return new Map(
      Object.entries(raw.sources || raw || {})
        .filter(([, value]) => value && typeof value === "object")
        .map(([key, value]) => [key, sanitizeSourceMeta(value, policy)]),
    );
  } catch {
    return new Map();
  }
}

export function writeSourceMeta(filePath, sourceMeta, policy = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const sources = Object.fromEntries(
    [...sourceMeta.entries()]
      .map(([key, value]) => [key, sanitizeSourceMeta(value, policy)])
      .filter(([, value]) => hasSourceMeta(value)),
  );
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    `${JSON.stringify({ version: SOURCE_META_VERSION, updated_at: new Date().toISOString(), sources }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(tmpPath, filePath);
}

export function sanitizeSourceMeta(meta = {}, policy = {}) {
  const title = sanitizeTitle(meta.title, policy);
  return {
    ...(meta.hidden ? { hidden: true } : {}),
    ...(meta.pinned ? { pinned: true } : {}),
    ...(title ? { title } : {}),
  };
}

export function sourceMetaForSource(sourceMeta, source) {
  return mergedSourceMeta(sourceMeta, sourceMetaKeysForSource(source));
}

export function mergedSourceMeta(sourceMeta, keys) {
  if (!sourceMeta) return {};
  return keys.reduce((merged, key) => ({ ...merged, ...(sourceMeta.get(key) || {}) }), {});
}

export function setSourceMeta({ sourceMeta, sourceMetaPath, policy } = {}, keys, meta) {
  if (!sourceMeta) return;
  const sanitized = sanitizeSourceMeta(meta, policy);
  for (const key of uniqueKeys(keys)) {
    if (hasSourceMeta(sanitized)) sourceMeta.set(key, sanitized);
    else sourceMeta.delete(key);
  }
  if (sourceMetaPath) writeSourceMeta(sourceMetaPath, sourceMeta, policy);
}

export function deleteSourceMeta({ sourceMeta, sourceMetaPath, policy } = {}, keys) {
  if (!sourceMeta) return;
  for (const key of uniqueKeys(keys)) sourceMeta.delete(key);
  if (sourceMetaPath) writeSourceMeta(sourceMetaPath, sourceMeta, policy);
}

export function sourceMetaKeysForSource(source) {
  const keys = new Set([source?.id].filter(Boolean));
  const watchId = source?.live_watch_id || source?.store_watch_id;
  addWatchKeys(keys, watchId);
  for (const key of stableSourceMetaKeys(source)) keys.add(key);
  return [...keys];
}

export function sourceMetaKeysForSourceId(id, { source, liveWatch, persistedSource } = {}) {
  const keys = new Set([id].filter(Boolean));
  const watchId =
    liveWatch?.watch_id ||
    persistedSource?.store_watch_id ||
    source?.live_watch_id ||
    source?.store_watch_id ||
    watchIdFromSourceId(id) ||
    (String(id || "").startsWith("live-") ? String(id).slice("live-".length) : null);
  addWatchKeys(keys, watchId);
  for (const key of stableSourceMetaKeys(liveWatch || persistedSource || source)) keys.add(key);
  return [...keys];
}

export function stableSourceMetaKeys(source) {
  const agent = safePathSegment(source?.agent || "", "");
  const conversationId = safePathSegment(source?.conversation_id || "", "");
  if (!agent || !conversationId) return [];
  return [`conversation-${agent}-${conversationId}`];
}

export function manualConversationTitle(sourceMeta, source, policy = {}) {
  const meta = mergedSourceMeta(sourceMeta, stableSourceMetaKeys(source));
  return sanitizeTitle(meta.title, policy) || null;
}

export function decorateSource(source, meta = {}, policy = {}) {
  const originalLabel = source.original_label || source.label;
  const workspace = source.workspace || null;
  const userTitle = sanitizeTitle(meta?.title || source.user_title, policy) || null;
  const cleanLabel = typeof policy.cleanLabel === "function" ? policy.cleanLabel(source.label) : source.label;
  const projectName = typeof policy.projectName === "function" ? policy.projectName(workspace) : null;
  return {
    ...source,
    original_label: originalLabel,
    label: userTitle || cleanLabel || source.label,
    user_title: userTitle,
    pinned: Boolean(meta?.pinned),
    hidden: Boolean(meta?.hidden),
    workspace,
    project: source.project || projectName,
  };
}

export function decorateSources(sources, sourceMeta, policy = {}) {
  return sources
    .map((source, order) => ({
      ...decorateSource(source, sourceMetaForSource(sourceMeta, source), policy),
      source_order: order,
    }))
    .filter((source) => !source.hidden)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.source_order - b.source_order)
    .map(({ source_order, ...source }) => source);
}

function sanitizeTitle(value, policy) {
  if (typeof policy.sanitizeTitle === "function") return policy.sanitizeTitle(value);
  return sanitizeSourceText(value, { limit: SOURCE_TEXT_LIMITS.title });
}

function addWatchKeys(keys, watchId) {
  if (!watchId) return;
  keys.add(`live-${watchId}`);
  keys.add(sourceIdForWatch(watchId));
}

function hasSourceMeta(meta) {
  return Boolean(meta?.hidden || meta?.pinned || meta?.title);
}

function uniqueKeys(keys) {
  return [...new Set((keys || []).filter(Boolean))];
}
