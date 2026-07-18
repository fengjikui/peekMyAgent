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
    const stateDbAvailable = this.files.existsSync(this.stateDbPath);
    if (this.explicitSelectedThreadIds?.length) {
      if (!stateDbAvailable) return [];
      const rows = this.readThreadRows({ threadIds: this.explicitSelectedThreadIds, includeArchived: true, limit: this.explicitSelectedThreadIds.length });
      return rows.map((row) => this.sourceFromThread(row)).filter(Boolean);
    }
    const selection = this.readSelection();
    const observation = normalizeObservation(selection?.active_observation);
    if (observation) {
      if (!observation.thread_id) {
        const bound = stateDbAvailable ? this.autoBindObservation(observation) : null;
        return [bound || this.pendingSource(observation)];
      }
      if (!stateDbAvailable) return [];
      const rows = this.readThreadRows({ threadIds: [observation.thread_id], includeArchived: true, limit: 1 });
      return rows
        .map((row) => this.sourceFromThread(row, { id: observation.source_id, observation }))
        .filter(Boolean);
    }
    if (!stateDbAvailable) return [];
    const selectedThreadIds = cleanThreadIds(selection?.thread_ids);
    if (!selectedThreadIds.length) return [];
    const rows = this.readThreadRows({ threadIds: selectedThreadIds, includeArchived: true, limit: selectedThreadIds.length });
    return rows.map((row) => this.sourceFromThread(row)).filter(Boolean);
  }

  listCandidates({ workspace = null, includeArchived = this.includeArchived, limit = this.sourceLimit } = {}) {
    if (!this.files.existsSync(this.stateDbPath)) return [];
    return this.readThreadRows({ workspace, includeArchived, limit }).map((row) => this.sourceFromThread(row)).filter(Boolean);
  }

  findCandidate(threadId) {
    const normalized = cleanText(threadId);
    if (!normalized || !this.files.existsSync(this.stateDbPath)) return null;
    const row = this.readThreadRows({ threadIds: [normalized], includeArchived: true, limit: 1 })[0];
    return row ? this.sourceFromThread(row) : null;
  }

  selectedThreadIds() {
    if (this.explicitSelectedThreadIds) return [...this.explicitSelectedThreadIds];
    const selection = this.readSelection();
    const observedThreadId = normalizeObservation(selection?.active_observation)?.thread_id;
    return observedThreadId ? [observedThreadId] : cleanThreadIds(selection?.thread_ids);
  }

  selectThread(threadId) {
    const normalized = cleanText(threadId);
    if (!normalized) throw new Error("Codex thread id is required.");
    const matches = this.readThreadRows({ threadIds: [normalized], includeArchived: true, limit: 1 });
    if (!matches.length) throw new Error(`Codex session not found: ${normalized}`);
    this.writeSelection({
      schema_version: 1,
      thread_ids: [normalized],
      updated_at: new Date().toISOString(),
    });
    return this.sourceFromThread(matches[0]);
  }

  beginObservation({ sourceId, workspace, baselineThreadIds = [], mode = "new", captureMode = "rollout", fallbackReason = null } = {}) {
    const source_id = cleanSourceId(sourceId);
    const normalizedWorkspace = cleanText(workspace);
    if (!source_id) throw new Error("Codex observation source id is required.");
    if (!normalizedWorkspace) throw new Error("Codex observation workspace is required.");
    const observation = {
      source_id,
      thread_id: null,
      status: "waiting",
      mode: cleanText(mode) || "new",
      capture_mode: cleanText(captureMode) || "rollout",
      fallback_reason: cleanText(fallbackReason) || null,
      workspace: normalizedWorkspace,
      baseline_thread_ids: cleanThreadIds(baselineThreadIds, 200),
      started_at: new Date().toISOString(),
    };
    this.writeSelection({
      schema_version: 2,
      thread_ids: [],
      active_observation: observation,
      updated_at: observation.started_at,
    });
    return this.pendingSource(observation);
  }

  bindObservation(sourceId, threadId) {
    const source_id = cleanSourceId(sourceId);
    const normalizedThreadId = cleanText(threadId);
    if (!source_id || !normalizedThreadId) throw new Error("Codex observation source id and thread id are required.");
    const selection = this.readSelection();
    const observation = normalizeObservation(selection?.active_observation);
    if (!observation || observation.source_id !== source_id) {
      throw new Error(`Codex observation is no longer active: ${source_id}`);
    }
    const rows = this.readThreadRows({ threadIds: [normalizedThreadId], includeArchived: true, limit: 1 });
    if (!rows.length) throw new Error(`Codex session not found: ${normalizedThreadId}`);
    const bound = {
      ...observation,
      thread_id: normalizedThreadId,
      status: "observing",
      bound_at: new Date().toISOString(),
    };
    this.writeSelection({
      schema_version: 2,
      thread_ids: [normalizedThreadId],
      active_observation: bound,
      updated_at: bound.bound_at,
    });
    return this.sourceFromThread(rows[0], { id: source_id, observation: bound });
  }

  autoBindObservation(observation) {
    const baseline = new Set(observation.baseline_thread_ids);
    const source = this.listCandidates({ workspace: observation.workspace, includeArchived: false, limit: 100 })
      .find((candidate) => candidate.available && !baseline.has(candidate.conversation_id));
    return source ? this.bindObservation(observation.source_id, source.conversation_id) : null;
  }

  clearSelection() {
    this.files.rmSync(this.selectionPath, { force: true });
  }

  cancelObservation(sourceId) {
    const selection = this.readSelection();
    const observation = normalizeObservation(selection?.active_observation);
    if (!observation || observation.source_id !== cleanSourceId(sourceId)) return false;
    this.clearSelection();
    return true;
  }

  sourceFromThread(row, { id = null, observation = null } = {}) {
    const threadId = cleanText(row?.id);
    const rolloutPath = cleanText(row?.rollout_path);
    if (!threadId || !rolloutPath) return null;
    const workspace = cleanText(row.cwd) || null;
    const title = sourceTitle(row);
    return {
      id: cleanSourceId(id) || codexSourceId(threadId),
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
      observation_mode: cleanText(observation?.mode) || null,
      capture_fallback_reason: cleanText(observation?.fallback_reason) || null,
      live_status: observation ? "observing" : null,
      stream_live: Boolean(observation),
      note: observation?.fallback_reason
        ? `Read-only semantic trace reconstructed from Codex Desktop rollout events; exact Desktop proxy was unavailable: ${cleanText(observation.fallback_reason)}`
        : "Read-only semantic trace reconstructed from Codex Desktop rollout events; not an exact wire request.",
    };
  }

  pendingSource(observation) {
    return {
      id: observation.source_id,
      label: "Waiting for a new Codex session",
      title: "Waiting for a new Codex session",
      agent: "Codex",
      confidence: "semantic",
      kind: "codex_rollout_pending",
      transport: "codex_rollout_local",
      path: null,
      available: true,
      read_only: true,
      deletable: false,
      request_count: 0,
      response_count: 0,
      conversation_id: null,
      workspace: observation.workspace,
      project: observation.workspace ? path.basename(observation.workspace) : null,
      observation_mode: observation.mode,
      capture_fallback_reason: observation.fallback_reason,
      live_status: "waiting",
      stream_live: true,
      created_at: observation.started_at,
      updated_at: observation.started_at,
      note: observation.fallback_reason
        ? `Waiting for the first new Codex Desktop thread in this workspace. Capture mode: semantic rollout fallback (${observation.fallback_reason}).`
        : "Waiting for the first new Codex Desktop thread in this workspace.",
    };
  }

  readSelection() {
    try {
      return JSON.parse(this.files.readFileSync(this.selectionPath, "utf8"));
    } catch {
      return null;
    }
  }

  writeSelection(payload) {
    this.files.mkdirSync(path.dirname(this.selectionPath), { recursive: true, mode: 0o700 });
    this.files.writeFileSync(this.selectionPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  readThreadRows({ threadIds = null, workspace = null, includeArchived = this.includeArchived, limit = this.sourceLimit } = {}) {
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
      const normalizedWorkspace = cleanText(workspace);
      if (normalizedWorkspace && columns.has("cwd")) predicates.push("cwd = ?");
      const orderColumn = columns.has("updated_at") ? "updated_at" : columns.has("created_at") ? "created_at" : "rowid";
      const statement = db.prepare(
        `SELECT ${selectColumns.join(", ")} FROM threads WHERE ${predicates.join(" AND ")} ORDER BY ${orderColumn} DESC LIMIT ?`,
      );
      return statement.all(...selected, ...(normalizedWorkspace && columns.has("cwd") ? [normalizedWorkspace] : []), positiveInteger(limit, this.sourceLimit, 200));
    } finally {
      db.close();
    }
  }
}

function cleanThreadIds(values, limit = 20) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanText).filter(Boolean))].slice(0, positiveInteger(limit, 20, 200));
}

function cleanSourceId(value) {
  const text = cleanText(value);
  return /^[A-Za-z0-9._:-]{1,160}$/.test(text) ? text : "";
}

function normalizeObservation(value) {
  if (!value || typeof value !== "object") return null;
  const source_id = cleanSourceId(value.source_id);
  const workspace = cleanText(value.workspace);
  if (!source_id || !workspace) return null;
  return {
    source_id,
    workspace,
    thread_id: cleanText(value.thread_id) || null,
    status: cleanText(value.status) || (value.thread_id ? "observing" : "waiting"),
    mode: cleanText(value.mode) || "new",
    capture_mode: cleanText(value.capture_mode) || "rollout",
    fallback_reason: cleanText(value.fallback_reason) || null,
    baseline_thread_ids: cleanThreadIds(value.baseline_thread_ids, 200),
    started_at: cleanText(value.started_at) || null,
    bound_at: cleanText(value.bound_at) || null,
  };
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
