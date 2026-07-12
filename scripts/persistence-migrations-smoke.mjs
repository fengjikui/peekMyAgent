import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
import { CURRENT_STORE_SCHEMA_VERSION } from "../src/persistence/migrations/index.mjs";
import { readUserVersion, runMigrations } from "../src/persistence/migrations/runner.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-migrations-"));

try {
  const newPath = path.join(tmpDir, "new.sqlite");
  const created = openPersistenceStore(newPath);
  assert.equal(created.schemaVersion(), CURRENT_STORE_SCHEMA_VERSION);
  assert.deepEqual(created.migration.applied, [{ version: 1, name: "initial_content_addressed_store" }]);
  created.upsertWatch({ watch_id: "migration-new", label: "new store" });
  created.close();

  const reopened = openPersistenceStore(newPath);
  assert.equal(reopened.schemaVersion(), CURRENT_STORE_SCHEMA_VERSION);
  assert.deepEqual(reopened.migration.applied, [], "reopening the current schema is idempotent");
  assert.equal(reopened.listSources()[0].store_watch_id, "migration-new", "reopen preserves persisted rows");
  reopened.close();

  const legacyPath = path.join(tmpDir, "legacy.sqlite");
  const legacySeed = openPersistenceStore(legacyPath);
  legacySeed.upsertWatch({ watch_id: "migration-legacy", label: "legacy store" });
  legacySeed.close();
  const legacyDb = new DatabaseSync(legacyPath);
  legacyDb.exec("PRAGMA user_version = 0");
  legacyDb.close();

  const migratedLegacy = openPersistenceStore(legacyPath);
  assert.equal(migratedLegacy.migration.from_version, 0);
  assert.equal(migratedLegacy.migration.to_version, CURRENT_STORE_SCHEMA_VERSION);
  assert.equal(migratedLegacy.listSources()[0].store_watch_id, "migration-legacy", "baseline migration preserves an unversioned store");
  migratedLegacy.close();

  const futurePath = path.join(tmpDir, "future.sqlite");
  const futureDb = new DatabaseSync(futurePath);
  futureDb.exec(`PRAGMA user_version = ${CURRENT_STORE_SCHEMA_VERSION + 1}`);
  futureDb.close();
  assert.throws(
    () => openPersistenceStore(futurePath),
    /newer than this peekMyAgent build supports/,
    "an older build must not mutate a newer store",
  );
  const futureCheck = new DatabaseSync(futurePath);
  assert.equal(readUserVersion(futureCheck), CURRENT_STORE_SCHEMA_VERSION + 1);
  futureCheck.close();

  const invalidVersionDb = new DatabaseSync(":memory:");
  invalidVersionDb.exec("PRAGMA user_version = -1");
  assert.throws(() => readUserVersion(invalidVersionDb), /Invalid SQLite user_version/);
  invalidVersionDb.close();

  const rollbackDb = new DatabaseSync(":memory:");
  assert.throws(
    () =>
      runMigrations(rollbackDb, {
        migrations: [
          { version: 1, name: "create_probe", up: (db) => db.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('before failure')") },
          {
            version: 2,
            name: "fail_probe",
            up: () => {
              throw new Error("intentional migration failure");
            },
          },
        ],
      }),
    /intentional migration failure/,
  );
  assert.equal(readUserVersion(rollbackDb), 0, "failed migrations roll user_version back");
  assert.equal(
    rollbackDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'probe'").get().count,
    0,
  );
  rollbackDb.close();

  console.log("persistence migrations smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
