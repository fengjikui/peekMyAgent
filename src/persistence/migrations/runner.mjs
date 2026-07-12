export function readUserVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const version = Number(row?.user_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid SQLite user_version: ${row?.user_version}`);
  }
  return version;
}

export function runMigrations(db, { migrations, validate } = {}) {
  if (!db) throw new Error("runMigrations requires a database connection");
  const ordered = validateMigrationSequence(migrations || []);
  const latestVersion = ordered.at(-1)?.version || 0;
  const fromVersion = readUserVersion(db);
  if (fromVersion > latestVersion) {
    throw new Error(
      `Database schema version ${fromVersion} is newer than this peekMyAgent build supports (${latestVersion}). Upgrade peekMyAgent before opening this store.`,
    );
  }

  const pending = ordered.filter((migration) => migration.version > fromVersion);
  if (!pending.length) {
    validate?.(db);
    return { from_version: fromVersion, to_version: fromVersion, applied: [] };
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    validate?.(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure when SQLite has already aborted the transaction.
    }
    throw error;
  }

  return {
    from_version: fromVersion,
    to_version: latestVersion,
    applied: pending.map(({ version, name }) => ({ version, name })),
  };
}

function validateMigrationSequence(migrations) {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  ordered.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration?.version !== expectedVersion || typeof migration.name !== "string" || typeof migration.up !== "function") {
      throw new Error(`Invalid database migration at position ${expectedVersion}; expected a named migration with version ${expectedVersion}.`);
    }
  });
  return ordered;
}
