import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { codexHomeDir, codexObservationSelectionPath, codexStateDbPath } from "../core/app-paths.mjs";

const require = createRequire(import.meta.url);
const DEFAULT_SOURCE_LIMIT = 40;

export class CodexDesktopDiscovery {
  constructor({ env = process.env, platform = process.platform, stateDbPath, selectionPath, selectedThreadIds, sourceLimit, includeArchived, files = fs } = {}) {
    this.env = env;
    this.platform = platform;
    this.home = codexHomeDir({ env, platform });
    this.stateDbPath = stateDbPath || codexStateDbPath({ env, platform });
    this.selectionPath = selectionPath || codexObservationSelectionPath({ env, platform });
    this.explicitSelectedThreadIds = Array.isArray(selectedThreadIds) ? cleanThreadIds(selectedThreadIds) : null;
    this.sourceLimit = positiveInteger(sourceLimit ?? env.PEEKMYAGENT_CODEX_SOURCE_LIMIT, DEFAULT_SOURCE_LIMIT, 200);
    this.includeArchived = includeArchived ?? truthy(env.PEEKMYAGENT_CODEX_INCLUDE_ARCHIVED);
    this.files = files;
  }

  listSources() {
    if (!this.files.existsSync(this.stateDbPath)) return [];
    const selectedThreadIds = this.selectedThreadIds();
    if (!selectedThreadIds.length) return [];
    const rows = this.readThreadRows({ threadIds: selectedThreadIds, includeArchived: true, limit: selectedThreadIds.length });
    return rows.map((row) => this.sourceFromThread(row)).filter(Boolean);
  }

  listCandidates() {
    if (!this.files.existsSync(this.stateDbPath)) return [];
    return this.readThreadRows().map((row) => this.sourceFromThread(row)).filter(Boolean);
  }

  selectedThreadIds() {
    if (this.explicitSelectedThreadIds) return [...this.explicitSelectedThreadIds];
    try {
      const value = JSON.parse(this.files.readFileSync(this.selectionPath, "utf8"));
      return cleanThreadIds(value?.thread_ids);
    } catch {
      return [];
    }
  }

  selectThread(threadId) {
    const normalized = cleanText(threadId);
    if (!normalized) throw new Error("Codex thread id is required.");
    const matches = this.readThreadRows({ threadIds: [normalized], includeArchived: true, limit: 1 });
    if (!matches.length) throw new Error(`Codex session not found: ${normalized}`);
    const payload = {
      schema_version: 1,
      thread_ids: [normalized],
      updated_at: new Date().toISOString(),
    };
    this.files.mkdirSync(path.dirname(this.selectionPath), { recursive: true, mode: 0o700 });
    this.files.writeFileSync(this.selectionPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return this.sourceFromThread(matches[0]);
  }

  clearSelection() {
    this.files.rmSync(this.selectionPath, { force: true });
  }

  sourceFromThread(row) {
    const threadId = cleanText(row?.id);
    const rolloutPath = cleanText(row?.rollout_path);
    if (!threadId || !rolloutPath) return null;
    const workspace = cleanText(row.cwd) || null;
    const title = sourceTitle(row);
    return {
      id: codexSourceId(threadId),
      label: title || `Codex ${shortId(threadId)}`,
      title: title || null,
      agent: "Codex",
      confidence: "semantic",
      kind: "codex_rollout_local",
      transport: "codex_rollout_local",
      path: rolloutPath,
      available: this.files.existsSync(rolloutPath),
      read_only: true,
      deletable: false,
      request_count: null,
      conversation_id: threadId,
      workspace,
      project: workspace ? path.basename(workspace) : null,
      model: cleanText(row.model) || null,
      model_provider: cleanText(row.model_provider) || null,
      cli_version: cleanText(row.cli_version) || null,
      thread_source: normalizeThreadSource(row.thread_source, row.source),
      archived: Boolean(Number(row.archived) || 0),
      updated_at: unixTimestampToIso(row.updated_at),
      created_at: unixTimestampToIso(row.created_at),
      token_count: finiteNumber(row.tokens_used),
      note: "Read-only semantic trace reconstructed from Codex Desktop rollout events; not an exact wire request.",
    };
  }

  readThreadRows({ threadIds = null, includeArchived = this.includeArchived, limit = this.sourceLimit } = {}) {
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(this.stateDbPath, { readOnly: true });
    try {
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
      if (!columns.has("id") || !columns.has("rollout_path")) return [];
      const selectColumns = [
        "id",
        "rollout_path",
        "created_at",
        "updated_at",
        "source",
        "model_provider",
        "cwd",
        "title",
        "tokens_used",
        "archived",
        "cli_version",
        "first_user_message",
        "model",
        "thread_source",
      ].filter((name) => columns.has(name));
      const predicates = ["rollout_path IS NOT NULL", "TRIM(rollout_path) <> ''"];
      if (columns.has("thread_source")) predicates.push("COALESCE(thread_source, 'user') <> 'subagent'");
      if (columns.has("archived") && !includeArchived) predicates.push("COALESCE(archived, 0) = 0");
      const selected = cleanThreadIds(threadIds);
      if (selected.length) predicates.push(`id IN (${selected.map(() => "?").join(", ")})`);
      const orderColumn = columns.has("updated_at") ? "updated_at" : columns.has("created_at") ? "created_at" : "rowid";
      const statement = db.prepare(
        `SELECT ${selectColumns.join(", ")} FROM threads WHERE ${predicates.join(" AND ")} ORDER BY ${orderColumn} DESC LIMIT ?`,
      );
      return statement.all(...selected, positiveInteger(limit, this.sourceLimit, 200));
    } finally {
      db.close();
    }
  }
}

function cleanThreadIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanText).filter(Boolean))].slice(0, 20);
}

export function listCodexDesktopSources(options = {}) {
  return new CodexDesktopDiscovery(options).listSources();
}

export function codexSourceId(threadId) {
  return `codex-${String(threadId || "").trim()}`;
}

export function codexThreadIdFromSource(source) {
  if (source?.conversation_id) return String(source.conversation_id);
  const id = String(source?.id || "");
  return id.startsWith("codex-") ? id.slice("codex-".length) : "";
}

function sourceTitle(row) {
  return textPreview(cleanText(row?.title) || cleanText(row?.first_user_message), 96);
}

function normalizeThreadSource(threadSource, source) {
  const explicit = cleanText(threadSource);
  if (explicit) return explicit;
  const raw = cleanText(source);
  if (!raw) return "user";
  try {
    return JSON.parse(raw)?.subagent ? "subagent" : "user";
  } catch {
    return raw;
  }
}

function unixTimestampToIso(value) {
  const number = finiteNumber(value);
  if (number == null) return null;
  const milliseconds = number > 10_000_000_000 ? number : number * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return String(value ?? "").replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
}

function textPreview(value, limit) {
  const text = cleanText(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function loadNodeSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredSqliteWarning(warning, ...args) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (String(message || "").includes("SQLite is an experimental feature")) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
