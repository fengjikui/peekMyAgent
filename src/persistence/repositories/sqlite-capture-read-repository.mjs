import { reconstructFromRequestTree } from "../../core/request-tree.mjs";

export class SqliteCaptureReadRepository {
  constructor(db) {
    if (!db || typeof db.prepare !== "function") {
      throw new TypeError("SqliteCaptureReadRepository requires an open SQLite database");
    }
    this.db = db;
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
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}
