import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defaultStateDir, defaultStorePath as resolveDefaultStorePath } from "./app-paths.mjs";
import { buildOrderedRequestTree, reconstructFromRequestTree } from "./request-tree.mjs";

const require = createRequire(import.meta.url);

export function defaultStorePath() {
  return resolveDefaultStorePath();
}

export function defaultStoreDir() {
  return defaultStateDir();
}

export function openPersistenceStore(storePath = defaultStorePath()) {
  return new PersistenceStore(storePath);
}

export class PersistenceStore {
  constructor(storePath) {
    this.path = storePath;
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(storePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watches (
        watch_id TEXT PRIMARY KEY,
        label TEXT,
        agent TEXT,
        mode TEXT,
        confidence TEXT,
        kind TEXT,
        workspace TEXT,
        conversation_id TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_seen TEXT,
        title TEXT
      );

      CREATE TABLE IF NOT EXISTS model_requests (
        request_id TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL,
        request_index INTEGER,
        conversation_id TEXT,
        agent_profile TEXT,
        workspace TEXT,
        received_at TEXT,
        method TEXT,
        path TEXT,
        model TEXT,
        raw_body_length INTEGER,
        raw_body_json TEXT,
        capture_json TEXT NOT NULL,
        body_source TEXT NOT NULL DEFAULT 'original',
        tree_schema_version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (watch_id) REFERENCES watches(watch_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_model_requests_watch ON model_requests(watch_id, request_index, received_at);

      CREATE TABLE IF NOT EXISTS content_blobs (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ref_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS request_tree_nodes (
        request_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        parent_node_id TEXT,
        node_type TEXT NOT NULL,
        object_key TEXT,
        array_index INTEGER,
        order_index INTEGER,
        blob_hash TEXT,
        json_path TEXT,
        scalar_json TEXT,
        PRIMARY KEY (request_id, node_id),
        FOREIGN KEY (request_id) REFERENCES model_requests(request_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_request_tree_parent ON request_tree_nodes(request_id, parent_node_id);
      CREATE INDEX IF NOT EXISTS idx_request_tree_blob ON request_tree_nodes(blob_hash);

      CREATE TABLE IF NOT EXISTS response_blobs (
        request_id TEXT PRIMARY KEY,
        blob_hash TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES model_requests(request_id) ON DELETE CASCADE,
        FOREIGN KEY (blob_hash) REFERENCES content_blobs(hash)
      );

      CREATE INDEX IF NOT EXISTS idx_response_blobs_hash ON response_blobs(blob_hash);
    `);
  }

  close() {
    this.db.close();
  }

  upsertWatch(watch) {
    if (!watch?.watch_id) throw new Error("watch.watch_id is required for persistence");
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO watches (
          watch_id, label, agent, mode, confidence, kind, workspace, conversation_id,
          status, created_at, updated_at, last_seen, title
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(watch_id) DO UPDATE SET
          label = COALESCE(excluded.label, watches.label),
          agent = COALESCE(excluded.agent, watches.agent),
          mode = COALESCE(excluded.mode, watches.mode),
          confidence = COALESCE(excluded.confidence, watches.confidence),
          kind = COALESCE(excluded.kind, watches.kind),
          workspace = COALESCE(excluded.workspace, watches.workspace),
          conversation_id = COALESCE(excluded.conversation_id, watches.conversation_id),
          status = COALESCE(excluded.status, watches.status),
          updated_at = excluded.updated_at,
          last_seen = COALESCE(excluded.last_seen, watches.last_seen),
          title = COALESCE(excluded.title, watches.title)
      `)
      .run(
        watch.watch_id,
        watch.label || null,
        watch.agent || null,
        watch.mode || null,
        watch.confidence || "exact",
        watch.kind || "proxy_capture",
        watch.workspace || null,
        watch.conversation_id || null,
        watch.status || "watching",
        watch.created_at || now,
        now,
        watch.last_seen || watch.created_at || now,
        watch.title || null,
      );
    return { upserted: true, watch_id: watch.watch_id };
  }

  upsertCapture({ watch, capture }) {
    if (!capture?.capture_id) throw new Error("capture.capture_id is required for persistence");
    if (this.hasRequest(capture.capture_id)) return { inserted: false, request_id: capture.capture_id };

    const now = new Date().toISOString();
    const body = capture.body ?? null;
    const tree = buildOrderedRequestTree(body, { requestId: capture.capture_id });
    const captureForStore = { ...capture, body: null };

    const tx = this.db.prepare(`
      INSERT INTO watches (
        watch_id, label, agent, mode, confidence, kind, workspace, conversation_id,
        status, created_at, updated_at, last_seen, title
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(watch_id) DO UPDATE SET
        label = COALESCE(excluded.label, watches.label),
        agent = COALESCE(excluded.agent, watches.agent),
        mode = COALESCE(excluded.mode, watches.mode),
        confidence = COALESCE(excluded.confidence, watches.confidence),
        kind = COALESCE(excluded.kind, watches.kind),
        workspace = COALESCE(excluded.workspace, watches.workspace),
        conversation_id = COALESCE(excluded.conversation_id, watches.conversation_id),
        status = COALESCE(excluded.status, watches.status),
        updated_at = excluded.updated_at,
        last_seen = COALESCE(excluded.last_seen, watches.last_seen),
        title = COALESCE(excluded.title, watches.title)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      tx.run(
        capture.watch_id,
        watch?.label || null,
        capture.agent_profile || watch?.agent || null,
        watch?.mode || null,
        watch?.confidence || "exact",
        watch?.kind || "proxy_capture",
        capture.workspace || watch?.workspace || null,
        capture.conversation_id || watch?.conversation_id || null,
        watch?.status || "watching",
        watch?.created_at || now,
        now,
        capture.received_at || now,
        watch?.title || null,
      );

      this.db
        .prepare(`
          INSERT INTO model_requests (
            request_id, watch_id, request_index, conversation_id, agent_profile, workspace,
            received_at, method, path, model, raw_body_length, raw_body_json, capture_json, body_source
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'original')
        `)
        .run(
          capture.capture_id,
          capture.watch_id,
          Number(capture.request_index) || null,
          capture.conversation_id || null,
          capture.agent_profile || watch?.agent || null,
          capture.workspace || watch?.workspace || null,
          capture.received_at || now,
          capture.method || "POST",
          capture.path || null,
          body?.model || null,
          Number(capture.raw_body_length) || byteLength(body),
          JSON.stringify(body),
          JSON.stringify(captureForStore),
        );

      const insertBlob = this.db.prepare(`
        INSERT INTO content_blobs (hash, kind, content_type, payload_json, byte_size, first_seen_at, last_seen_at, ref_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `);
      const incrementBlob = this.db.prepare("UPDATE content_blobs SET ref_count = ref_count + 1 WHERE hash = ?");
      for (const blob of tree.blobs) {
        insertBlob.run(blob.hash, blob.kind, blob.content_type, blob.payload_json, blob.byte_size, now, now);
      }
      for (const node of tree.nodes) {
        if (node.blob_hash) incrementBlob.run(node.blob_hash);
      }

      const insertNode = this.db.prepare(`
        INSERT INTO request_tree_nodes (
          request_id, node_id, parent_node_id, node_type, object_key, array_index,
          order_index, blob_hash, json_path, scalar_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of tree.nodes) {
        insertNode.run(
          node.request_id,
          node.node_id,
          node.parent_node_id,
          node.node_type,
          node.object_key,
          node.array_index,
          node.order_index,
          node.blob_hash,
          node.json_path,
          node.scalar_json,
        );
      }
      this.db.exec("COMMIT");
      return { inserted: true, request_id: capture.capture_id, blob_count: tree.blobs.length, node_count: tree.nodes.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasRequest(requestId) {
    return Boolean(this.db.prepare("SELECT 1 FROM model_requests WHERE request_id = ?").get(requestId));
  }

  updateCaptureResponse(capture) {
    if (!capture?.capture_id || !this.hasRequest(capture.capture_id)) return { updated: false };
    const row = this.db.prepare("SELECT capture_json FROM model_requests WHERE request_id = ?").get(capture.capture_id);
    const stored = row?.capture_json ? JSON.parse(row.capture_json) : {};
    const responseForStore = capture.response ? this.storeResponseBlob(capture.capture_id, capture.response) : null;
    const next = {
      ...stored,
      upstream_status: capture.upstream_status ?? stored.upstream_status ?? null,
      upstream_error: capture.upstream_error ?? stored.upstream_error ?? null,
      response: responseForStore ?? stored.response ?? null,
    };
    this.db.prepare("UPDATE model_requests SET capture_json = ? WHERE request_id = ?").run(JSON.stringify(next), capture.capture_id);
    if (capture.watch_id && capture.response?.received_at) {
      this.db
        .prepare("UPDATE watches SET updated_at = ?, last_seen = ? WHERE watch_id = ?")
        .run(capture.response.received_at, capture.response.received_at, capture.watch_id);
    }
    return { updated: true, request_id: capture.capture_id };
  }

  storeResponseBlob(requestId, response) {
    const bodyText = response.body_text;
    if (typeof bodyText !== "string") return response;
    const now = response.received_at || new Date().toISOString();
    const contentType = headerValue(response.headers, "content-type") || "text/plain";
    const hash = hashPayload("response_body", bodyText);
    const byteSize = Buffer.byteLength(bodyText, "utf8");
    this.db
      .prepare(
        `
          INSERT INTO content_blobs (hash, kind, content_type, payload_json, byte_size, first_seen_at, last_seen_at, ref_count)
          VALUES (?, 'response_body', ?, ?, ?, ?, ?, 0)
          ON CONFLICT(hash) DO UPDATE SET last_seen_at = excluded.last_seen_at
        `,
      )
      .run(hash, contentType, JSON.stringify(bodyText), byteSize, now, now);
    this.db
      .prepare(
        `
          INSERT INTO response_blobs (request_id, blob_hash, content_type, byte_size, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(request_id) DO UPDATE SET
            blob_hash = excluded.blob_hash,
            content_type = excluded.content_type,
            byte_size = excluded.byte_size
        `,
      )
      .run(requestId, hash, contentType, byteSize, now);
    this.recomputeBlobRefCounts();
    return {
      ...response,
      body_text: null,
      body_ref: {
        hash,
        kind: "response_body",
        content_type: contentType,
        byte_size: byteSize,
      },
    };
  }

  listSources() {
    return this.db
      .prepare(`
        SELECT
          w.watch_id,
          w.label,
          w.agent,
          w.mode,
          w.confidence,
          w.kind,
          w.workspace,
          w.conversation_id,
          w.status,
          w.created_at,
          w.last_seen,
          w.title,
          COUNT(r.request_id) AS request_count,
          SUM(CASE WHEN instr(r.capture_json, '"response"') > 0 THEN 1 ELSE 0 END) AS response_count,
          SUM(COALESCE(r.raw_body_length, 0)) AS raw_body_bytes
        FROM watches w
        LEFT JOIN model_requests r ON r.watch_id = w.watch_id
        GROUP BY w.watch_id
        ORDER BY COALESCE(w.last_seen, w.created_at) DESC
      `)
      .all()
      .map((row) => ({
        id: sourceIdForWatch(row.watch_id),
        label: row.title || row.label || row.watch_id,
        user_title: row.title || null,
        agent: row.agent || "Unknown Agent",
        mode: row.mode || null,
        confidence: row.confidence || "exact",
        kind: "persisted_capture",
        available: true,
        note: "本地 SQLite 持久化捕获；Raw 会优先使用原始 body，缺失时由 request tree 重建。",
        store_watch_id: row.watch_id,
        workspace: row.workspace || null,
        conversation_id: row.conversation_id || null,
        live_status: row.status || "stored",
        request_count: Number(row.request_count) || 0,
        response_count: Number(row.response_count) || 0,
        raw_body_bytes: Number(row.raw_body_bytes) || 0,
        created_at: row.created_at || null,
        last_seen: row.last_seen || null,
        last_response_seen: row.last_seen || null,
      }));
  }

  loadCaptures(watchId) {
    return this.db
      .prepare("SELECT * FROM model_requests WHERE watch_id = ? ORDER BY request_index, received_at")
      .all(watchId)
      .map((row) => this.captureFromRow(row));
  }

  loadInitialCaptures(watchId, { limit = 5 } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 5));
    return this.db
      .prepare(
        `
          SELECT *
          FROM model_requests
          WHERE watch_id = ?
          ORDER BY request_index, received_at
          LIMIT ?
        `,
      )
      .all(watchId, safeLimit)
      .map((row) => this.captureFromRow(row));
  }

  loadCaptureWindow(watchId, requestId, { previousCount = 1 } = {}) {
    const target = this.findCaptureRow(watchId, requestId);
    if (!target) return [];
    const previous = this.previousCaptureRows(watchId, target, previousCount);
    return [...previous.reverse(), target].map((row) => this.captureFromRow(row));
  }

  findCaptureRow(watchId, requestId) {
    const id = String(requestId || "");
    const index = Number(id);
    if (Number.isFinite(index) && id.trim()) {
      return (
        this.db
          .prepare(
            `
              SELECT *
              FROM model_requests
              WHERE watch_id = ? AND (request_id = ? OR request_index = ?)
              ORDER BY CASE WHEN request_id = ? THEN 0 ELSE 1 END
              LIMIT 1
            `,
          )
          .get(watchId, id, index, id) || null
      );
    }
    return this.db.prepare("SELECT * FROM model_requests WHERE watch_id = ? AND request_id = ? LIMIT 1").get(watchId, id) || null;
  }

  previousCaptureRows(watchId, targetRow, previousCount) {
    const limit = Math.max(0, Number(previousCount) || 0);
    if (!limit) return [];
    if (targetRow.request_index != null) {
      return this.db
        .prepare(
          `
            SELECT *
            FROM model_requests
            WHERE watch_id = ? AND request_index < ?
            ORDER BY request_index DESC, received_at DESC
            LIMIT ?
          `,
        )
        .all(watchId, targetRow.request_index, limit);
    }
    if (targetRow.received_at) {
      return this.db
        .prepare(
          `
            SELECT *
            FROM model_requests
            WHERE watch_id = ? AND received_at < ?
            ORDER BY received_at DESC
            LIMIT ?
          `,
        )
        .all(watchId, targetRow.received_at, limit);
    }
    return [];
  }

  captureFromRow(row) {
    const capture = JSON.parse(row.capture_json);
    capture.body = row.raw_body_json ? JSON.parse(row.raw_body_json) : this.reconstructBody(row.request_id);
    capture.response = this.hydrateResponse(row.request_id, capture.response);
    capture.body_source = row.raw_body_json ? "original" : "reconstructed";
    capture.capture_id = row.request_id;
    capture.watch_id = row.watch_id;
    capture.request_index = row.request_index;
    capture.conversation_id = row.conversation_id || capture.conversation_id || null;
    capture.agent_profile = row.agent_profile || capture.agent_profile || null;
    capture.workspace = row.workspace || capture.workspace || null;
    capture.received_at = row.received_at || capture.received_at || null;
    capture.method = row.method || capture.method || "POST";
    capture.path = row.path || capture.path || null;
    capture.raw_body_length = row.raw_body_length || byteLength(capture.body);
    return capture;
  }

  hydrateResponse(requestId, response) {
    if (!response?.body_ref?.hash || typeof response.body_text === "string") return response || null;
    const blob = this.db.prepare("SELECT payload_json FROM content_blobs WHERE hash = ?").get(response.body_ref.hash);
    if (!blob) return response;
    return { ...response, body_text: JSON.parse(blob.payload_json) };
  }

  reconstructBody(requestId) {
    const nodes = this.db.prepare("SELECT * FROM request_tree_nodes WHERE request_id = ? ORDER BY node_id").all(requestId);
    if (!nodes.length) throw new Error(`No request tree found for ${requestId}`);
    const hashes = [...new Set(nodes.map((node) => node.blob_hash).filter(Boolean))];
    const blobs = hashes.map((hash) => {
      const blob = this.db.prepare("SELECT hash, kind, content_type, payload_json, byte_size FROM content_blobs WHERE hash = ?").get(hash);
      if (!blob) throw new Error(`Missing content blob: ${hash}`);
      return blob;
    });
    return reconstructFromRequestTree({
      request_id: requestId,
      root_node_id: "n1",
      nodes,
      blobs,
    });
  }

  clearRawBody(requestId) {
    this.db.prepare("UPDATE model_requests SET raw_body_json = NULL, body_source = 'reconstructed' WHERE request_id = ?").run(requestId);
  }

  blobStats() {
    return this.db
      .prepare("SELECT kind, COUNT(*) AS count, SUM(ref_count) AS refs, SUM(byte_size) AS bytes FROM content_blobs GROUP BY kind ORDER BY kind")
      .all()
      .map((row) => ({
        kind: row.kind,
        count: Number(row.count) || 0,
        refs: Number(row.refs) || 0,
        bytes: Number(row.bytes) || 0,
      }));
  }

  updateWatchStatus(watchId, status) {
    this.db
      .prepare("UPDATE watches SET status = ?, updated_at = ?, last_seen = COALESCE(last_seen, ?) WHERE watch_id = ?")
      .run(status, new Date().toISOString(), new Date().toISOString(), watchId);
  }

  updateWatchTitle(watchId, title) {
    const value = String(title || "").trim() || null;
    this.db.prepare("UPDATE watches SET title = ?, updated_at = ? WHERE watch_id = ?").run(value, new Date().toISOString(), watchId);
  }

  deleteWatch(watchId) {
    this.db.prepare("DELETE FROM watches WHERE watch_id = ?").run(watchId);
    this.recomputeBlobRefCounts();
    this.deleteUnreferencedBlobs();
  }

  recomputeBlobRefCounts() {
    this.db.exec(`
      UPDATE content_blobs
      SET ref_count = (
        SELECT COUNT(*)
        FROM request_tree_nodes
        WHERE request_tree_nodes.blob_hash = content_blobs.hash
      ) + (
        SELECT COUNT(*)
        FROM response_blobs
        WHERE response_blobs.blob_hash = content_blobs.hash
      )
    `);
  }

  deleteUnreferencedBlobs() {
    this.db.exec(`
      DELETE FROM content_blobs
      WHERE hash NOT IN (
        SELECT DISTINCT blob_hash FROM request_tree_nodes WHERE blob_hash IS NOT NULL
        UNION
        SELECT DISTINCT blob_hash FROM response_blobs
      )
    `);
  }
}

export function sourceIdForWatch(watchId) {
  return `stored-${watchId}`;
}

export function watchIdFromSourceId(sourceId) {
  return sourceId?.startsWith("stored-") ? sourceId.slice("stored-".length) : null;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function hashPayload(kind, value) {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(`${kind}\0${JSON.stringify(value ?? null)}`).digest("hex");
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
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
