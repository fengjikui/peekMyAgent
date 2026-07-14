import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defaultStateDir, defaultStorePath as resolveDefaultStorePath } from "./app-paths.mjs";
import { buildOrderedRequestTree, reconstructFromRequestTree } from "./request-tree.mjs";
import { sourceIdForWatch } from "./source-identifiers.mjs";
import { migratePersistenceStore, persistenceSchemaVersion } from "../persistence/migrations/index.mjs";

export { sourceIdForWatch, watchIdFromSourceId } from "./source-identifiers.mjs";

const require = createRequire(import.meta.url);
const PRIVATE_STORE_FILE_MODE = 0o600;
const STORE_RAW_BODY_ENV = "PEEKMYAGENT_STORE_RAW_BODY_JSON";

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
    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migration = migratePersistenceStore(this.db);
      this.db.exec("PRAGMA journal_mode = WAL");
      restrictStoreFilePermissions(storePath);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the schema/migration error if SQLite close also fails.
      }
      throw error;
    }
  }

  close() {
    restrictStoreFilePermissions(this.path);
    this.db.close();
  }

  vacuum() {
    this.db.exec("VACUUM");
    restrictStoreFilePermissions(this.path);
  }

  schemaVersion() {
    return persistenceSchemaVersion(this.db);
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
    const storeRawBodyJson = shouldStoreRawBodyJson();
    const rawBodyJson = storeRawBodyJson ? JSON.stringify(body) : null;
    const bodySource = storeRawBodyJson ? "original" : "reconstructed";
    const captureForStore = { ...capture, body: null, response: null };

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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          rawBodyJson,
          JSON.stringify(captureForStore),
          bodySource,
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
      if (capture.response) {
        const responseForStore = this.storeResponseBlob(capture.capture_id, capture.response);
        this.db
          .prepare("UPDATE model_requests SET capture_json = ? WHERE request_id = ?")
          .run(JSON.stringify({ ...captureForStore, response: responseForStore }), capture.capture_id);
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

  nextRequestIndex(watchId) {
    if (!watchId) return 1;
    const row = this.db.prepare("SELECT COALESCE(MAX(request_index), 0) + 1 AS next_index FROM model_requests WHERE watch_id = ?").get(watchId);
    return Math.max(1, Number(row?.next_index) || 1);
  }

  loadWatch(watchId) {
    const normalized = normalizeWatchId(watchId);
    if (!normalized) return null;
    return this.watchRecordFromRow(
      this.db
        .prepare(
          `
            SELECT
              w.*,
              COUNT(r.request_id) AS request_count,
              COALESCE(MAX(r.request_index), 0) AS last_request_index
            FROM watches w
            LEFT JOIN model_requests r ON r.watch_id = w.watch_id
            WHERE w.watch_id = ?
            GROUP BY w.watch_id
            LIMIT 1
          `,
        )
        .get(normalized),
    );
  }

  findReusableWatch({ agent, mode, workspace, conversationId } = {}) {
    if (!agent || !workspace) return null;
    const clauses = ["w.agent = ?", "w.workspace = ?"];
    const params = [agent, workspace];
    if (mode) {
      clauses.push("(w.mode = ? OR w.mode IS NULL)");
      params.push(mode);
    }
    if (conversationId) {
      clauses.push("w.conversation_id = ?");
      params.push(conversationId);
    }
    return this.watchRecordFromRow(
      this.db
        .prepare(
          `
            SELECT
              w.*,
              COUNT(r.request_id) AS request_count,
              COALESCE(MAX(r.request_index), 0) AS last_request_index
            FROM watches w
            LEFT JOIN model_requests r ON r.watch_id = w.watch_id
            WHERE ${clauses.join(" AND ")}
            GROUP BY w.watch_id
            ORDER BY COALESCE(w.last_seen, w.created_at) DESC, w.updated_at DESC
            LIMIT 1
          `,
        )
        .get(...params),
    );
  }

  watchRecordFromRow(row) {
    if (!row) return null;
    return {
      watch_id: row.watch_id,
      label: row.label || null,
      title: row.title || null,
      agent: row.agent || null,
      mode: row.mode || null,
      confidence: row.confidence || "exact",
      kind: row.kind || "proxy_capture",
      workspace: row.workspace || null,
      conversation_id: row.conversation_id || null,
      status: row.status || "stored",
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      last_seen: row.last_seen || null,
      request_count: Number(row.request_count) || 0,
      last_request_index: Number(row.last_request_index) || 0,
    };
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
      source: capture.source ?? stored.source ?? null,
      provenance: capture.provenance ?? stored.provenance ?? null,
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
          SUM(
            CASE
              WHEN json_type(r.capture_json, '$.response') IS NOT NULL
                AND json_type(r.capture_json, '$.response') != 'null'
              THEN 1
              ELSE 0
            END
          ) AS response_count,
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

  loadCapturePage(watchId, { offset = 0, limit = 32 } = {}) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 32));
    return this.db
      .prepare(
        `
          SELECT *
          FROM model_requests
          WHERE watch_id = ?
          ORDER BY request_index, received_at
          LIMIT ? OFFSET ?
        `,
      )
      .all(watchId, safeLimit, safeOffset)
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
    capture.body_source = row.raw_body_json ? row.body_source || "original" : row.body_source || "reconstructed";
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

  compactRawBodies({ watchId = null, limit = 10000 } = {}) {
    const safeLimit = Math.max(1, Math.min(100000, Number(limit) || 10000));
    const rows = watchId
      ? this.db
          .prepare(
            `
              SELECT request_id, LENGTH(raw_body_json) AS raw_body_json_bytes
              FROM model_requests
              WHERE watch_id = ?
                AND raw_body_json IS NOT NULL
                AND EXISTS (SELECT 1 FROM request_tree_nodes WHERE request_tree_nodes.request_id = model_requests.request_id)
              ORDER BY request_index, received_at
              LIMIT ?
            `,
          )
          .all(watchId, safeLimit)
      : this.db
          .prepare(
            `
              SELECT request_id, LENGTH(raw_body_json) AS raw_body_json_bytes
              FROM model_requests
              WHERE raw_body_json IS NOT NULL
                AND EXISTS (SELECT 1 FROM request_tree_nodes WHERE request_tree_nodes.request_id = model_requests.request_id)
              ORDER BY received_at
              LIMIT ?
            `,
          )
          .all(safeLimit);
    const clear = this.db.prepare("UPDATE model_requests SET raw_body_json = NULL, body_source = 'reconstructed' WHERE request_id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) clear.run(row.request_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      compacted: rows.length,
      cleared_raw_body_json_bytes: rows.reduce((sum, row) => sum + (Number(row.raw_body_json_bytes) || 0), 0),
      limit: safeLimit,
      watch_id: watchId || null,
    };
  }

  storageStats() {
    const model = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS request_count,
            SUM(COALESCE(raw_body_length, 0)) AS logical_raw_body_bytes,
            SUM(COALESCE(LENGTH(raw_body_json), 0)) AS stored_raw_body_json_bytes,
            SUM(COALESCE(LENGTH(capture_json), 0)) AS stored_capture_json_bytes
          FROM model_requests
        `,
      )
      .get();
    const blobs = this.db.prepare("SELECT COUNT(*) AS count, SUM(byte_size) AS bytes, SUM(ref_count) AS refs FROM content_blobs").get();
    return {
      request_count: Number(model?.request_count) || 0,
      logical_raw_body_bytes: Number(model?.logical_raw_body_bytes) || 0,
      stored_raw_body_json_bytes: Number(model?.stored_raw_body_json_bytes) || 0,
      stored_capture_json_bytes: Number(model?.stored_capture_json_bytes) || 0,
      content_blob_count: Number(blobs?.count) || 0,
      content_blob_bytes: Number(blobs?.bytes) || 0,
      content_blob_refs: Number(blobs?.refs) || 0,
    };
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

  updateConversationTitle(agent, conversationId, title) {
    const cleanAgent = String(agent || "").trim();
    const cleanConversationId = String(conversationId || "").trim();
    if (!cleanAgent || !cleanConversationId) return { updated: 0 };
    const value = String(title || "").trim() || null;
    const result = this.db
      .prepare("UPDATE watches SET title = ?, updated_at = ? WHERE agent = ? AND conversation_id = ?")
      .run(value, new Date().toISOString(), cleanAgent, cleanConversationId);
    return { updated: Number(result.changes) || 0 };
  }

  conversationTitle(agent, conversationId) {
    const cleanAgent = String(agent || "").trim();
    const cleanConversationId = String(conversationId || "").trim();
    if (!cleanAgent || !cleanConversationId) return null;
    const row = this.db
      .prepare(
        `
          SELECT title
          FROM watches
          WHERE agent = ? AND conversation_id = ? AND title IS NOT NULL AND title <> ''
          ORDER BY updated_at DESC, last_seen DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(cleanAgent, cleanConversationId);
    return row?.title || null;
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

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

function normalizeWatchId(value) {
  const text = String(value || "");
  if (text.startsWith("stored-")) return text.slice("stored-".length);
  if (text.startsWith("live-")) return text.slice("live-".length);
  return text;
}

function hashPayload(kind, value) {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(`${kind}\0${JSON.stringify(value ?? null)}`).digest("hex");
}

function shouldStoreRawBodyJson(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env[STORE_RAW_BODY_ENV] || ""));
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

function restrictStoreFilePermissions(storePath) {
  for (const filePath of storeRelatedFiles(storePath)) {
    try {
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, PRIVATE_STORE_FILE_MODE);
    } catch {
      // Best-effort hardening: Windows ACLs and unusual filesystems may ignore chmod.
    }
  }
}

function storeRelatedFiles(storePath) {
  return [storePath, `${storePath}-wal`, `${storePath}-shm`];
}
