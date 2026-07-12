import { readUserVersion, runMigrations } from "./runner.mjs";

const INITIAL_SCHEMA_SQL = `
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
`;

const STORE_MIGRATIONS = [
  {
    version: 1,
    name: "initial_content_addressed_store",
    up(db) {
      db.exec(INITIAL_SCHEMA_SQL);
    },
  },
];

export const CURRENT_STORE_SCHEMA_VERSION = STORE_MIGRATIONS.at(-1).version;

const REQUIRED_COLUMNS = {
  watches: [
    "watch_id",
    "label",
    "agent",
    "mode",
    "confidence",
    "kind",
    "workspace",
    "conversation_id",
    "status",
    "created_at",
    "updated_at",
    "last_seen",
    "title",
  ],
  model_requests: [
    "request_id",
    "watch_id",
    "request_index",
    "conversation_id",
    "agent_profile",
    "workspace",
    "received_at",
    "method",
    "path",
    "model",
    "raw_body_length",
    "raw_body_json",
    "capture_json",
    "body_source",
    "tree_schema_version",
  ],
  content_blobs: ["hash", "kind", "content_type", "payload_json", "byte_size", "first_seen_at", "last_seen_at", "ref_count"],
  request_tree_nodes: ["request_id", "node_id", "parent_node_id", "node_type", "object_key", "array_index", "order_index", "blob_hash", "json_path", "scalar_json"],
  response_blobs: ["request_id", "blob_hash", "content_type", "byte_size", "created_at"],
};

export function migratePersistenceStore(db) {
  return runMigrations(db, { migrations: STORE_MIGRATIONS, validate: validatePersistenceSchema });
}

export function persistenceSchemaVersion(db) {
  return readUserVersion(db);
}

export function validatePersistenceSchema(db) {
  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const actualColumns = new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((column) => column.name));
    const missing = expectedColumns.filter((column) => !actualColumns.has(column));
    if (missing.length) {
      throw new Error(`peekMyAgent store schema is missing ${table}.${missing.join(`, ${table}.`)}`);
    }
  }
}
