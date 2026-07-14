import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const JSON_ARRAY_FILE_INDEX_FORMAT = "peekmyagent.json-array-file-index.v1";

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 100_000;

export class JsonArrayFileIndex {
  constructor({ cacheDir = null, chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
    this.cacheDir = cacheDir ? path.resolve(cacheDir) : null;
    this.chunkBytes = positiveInteger(chunkBytes, "chunkBytes");
    this.indexes = new Map();
  }

  readPage(filePath, { offset = 0, limit = 32 } = {}) {
    const pageOffset = nonNegativeInteger(offset, "offset");
    const pageLimit = positiveInteger(limit, "limit");
    return this.withIndexRetry(filePath, (index) => {
      const end = Math.min(index.entries.length, pageOffset + pageLimit);
      const entryIndexes = range(pageOffset, end);
      return {
        items: this.readItems(index, entryIndexes),
        totalCount: index.entries.length,
        startIndex: pageOffset,
      };
    });
  }

  readWindow(filePath, requestId, { previousCount = 1 } = {}) {
    const before = nonNegativeInteger(previousCount, "previousCount");
    const wanted = String(requestId ?? "");
    if (!wanted) throw new TypeError("requestId is required");
    return this.withIndexRetry(filePath, (index) => {
      const targetIndex = this.findRequestIndex(index, wanted);
      if (targetIndex < 0) return null;
      const startIndex = Math.max(0, targetIndex - before);
      return {
        items: this.readItems(index, range(startIndex, targetIndex + 1)),
        totalCount: index.entries.length,
        startIndex,
      };
    });
  }

  inspect(filePath) {
    const index = this.ensure(filePath);
    return {
      format: index.format,
      fingerprint: { ...index.fingerprint },
      entryCount: index.entries.length,
      indexPath: index.indexPath,
    };
  }

  invalidate(filePath) {
    const absolutePath = path.resolve(String(filePath || ""));
    this.indexes.delete(absolutePath);
    try {
      this.indexes.delete(fs.realpathSync(absolutePath));
    } catch {
      // The source may have disappeared after ensure(); invalidation must not mask the read error.
    }
  }

  ensure(filePath, { force = false } = {}) {
    const resolvedPath = resolveFile(filePath);
    const fingerprint = fingerprintFile(resolvedPath);
    const cached = this.indexes.get(resolvedPath);
    if (!force && cached && fingerprintsEqual(cached.fingerprint, fingerprint)) return cached;

    const indexPath = this.indexPath(resolvedPath, fingerprint);
    if (!force && indexPath) {
      const persisted = readPersistedIndex(indexPath, fingerprint);
      if (persisted) {
        const hydrated = hydrateIndex(persisted, resolvedPath, indexPath);
        this.indexes.set(resolvedPath, hydrated);
        return hydrated;
      }
    }

    const entries = buildObjectArrayIndex(resolvedPath, { chunkBytes: this.chunkBytes });
    const finalFingerprint = fingerprintFile(resolvedPath);
    if (!fingerprintsEqual(fingerprint, finalFingerprint)) {
      if (force) throw new Error(`JSON array file changed while indexing: ${resolvedPath}`);
      return this.ensure(resolvedPath, { force: true });
    }
    const data = {
      format: JSON_ARRAY_FILE_INDEX_FORMAT,
      fingerprint: finalFingerprint,
      entry_count: entries.length,
      entries,
    };
    const finalIndexPath = this.indexPath(resolvedPath, finalFingerprint);
    if (finalIndexPath) persistIndex(finalIndexPath, data, { pathPrefix: pathHash(resolvedPath) });
    const hydrated = hydrateIndex(data, resolvedPath, finalIndexPath);
    this.indexes.set(resolvedPath, hydrated);
    return hydrated;
  }

  withIndexRetry(filePath, operation) {
    let firstError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return operation(this.ensure(filePath, { force: attempt > 0 }));
      } catch (error) {
        firstError ||= error;
        this.invalidate(filePath);
      }
    }
    throw firstError;
  }

  readItems(index, entryIndexes) {
    const fd = fs.openSync(index.sourcePath, "r");
    try {
      return entryIndexes.map((entryIndex) => {
        const item = readIndexedItem(fd, index.entries[entryIndex], index.sourcePath);
        rememberRequestIdentity(index, item, entryIndex);
        return item;
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  findRequestIndex(index, requestId) {
    const known = index.requestIndexes.get(requestId);
    if (known !== undefined) return known;
    const fd = fs.openSync(index.sourcePath, "r");
    try {
      for (let entryIndex = 0; entryIndex < index.entries.length; entryIndex += 1) {
        if (index.scannedIdentities.has(entryIndex)) continue;
        const item = readIndexedItem(fd, index.entries[entryIndex], index.sourcePath);
        rememberRequestIdentity(index, item, entryIndex);
        if (index.requestIndexes.get(requestId) === entryIndex) return entryIndex;
      }
    } finally {
      fs.closeSync(fd);
    }
    return -1;
  }

  indexPath(resolvedPath, fingerprint) {
    if (!this.cacheDir) return null;
    const prefix = pathHash(resolvedPath);
    const version = crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 20);
    return path.join(this.cacheDir, `${prefix}-${version}.json`);
  }
}

export function buildObjectArrayIndex(filePath, { chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
  const resolvedPath = resolveFile(filePath);
  const fd = fs.openSync(resolvedPath, "r");
  const buffer = Buffer.allocUnsafe(positiveInteger(chunkBytes, "chunkBytes"));
  const entries = [];
  let position = 0;
  let state = "before_array";
  let allowArrayEnd = true;
  let inString = false;
  let escaped = false;
  let entryStart = -1;
  let stack = [];
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        const absolute = position + index;
        if (state === "before_array") {
          if (isWhitespace(byte)) continue;
          if (byte !== 0x5b) throw invalidArray(resolvedPath, absolute, "expected '['");
          state = "between_entries";
          continue;
        }
        if (state === "between_entries") {
          if (isWhitespace(byte)) continue;
          if (byte === 0x5d && allowArrayEnd) {
            state = "after_array";
            continue;
          }
          if (byte !== 0x7b) throw invalidArray(resolvedPath, absolute, "capture entries must be JSON objects");
          entryStart = absolute;
          stack = [0x7d];
          inString = false;
          escaped = false;
          state = "in_entry";
          continue;
        }
        if (state === "after_entry") {
          if (isWhitespace(byte)) continue;
          if (byte === 0x2c) {
            allowArrayEnd = false;
            state = "between_entries";
            continue;
          }
          if (byte === 0x5d) {
            state = "after_array";
            continue;
          }
          throw invalidArray(resolvedPath, absolute, "expected ',' or ']'");
        }
        if (state === "after_array") {
          if (!isWhitespace(byte)) throw invalidArray(resolvedPath, absolute, "unexpected trailing content");
          continue;
        }

        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
          continue;
        }
        if (byte === 0x22) {
          inString = true;
          continue;
        }
        if (byte === 0x7b) stack.push(0x7d);
        else if (byte === 0x5b) stack.push(0x5d);
        else if (byte === 0x7d || byte === 0x5d) {
          const expected = stack.pop();
          if (expected !== byte) throw invalidArray(resolvedPath, absolute, "mismatched JSON delimiters");
          if (!stack.length) {
            entries.push([entryStart, absolute + 1]);
            if (entries.length > MAX_INDEX_ENTRIES) throw new Error(`JSON array index exceeds ${MAX_INDEX_ENTRIES} entries: ${resolvedPath}`);
            allowArrayEnd = true;
            state = "after_entry";
          }
        }
      }
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (state !== "after_array") throw invalidArray(resolvedPath, position, "truncated JSON array");
  return entries;
}

function readIndexedItem(fd, entry, filePath) {
  const [start, end] = entry || [];
  const length = end - start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || length < 2) {
    throw new Error(`Invalid JSON array index entry for ${filePath}`);
  }
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, start);
  if (bytesRead !== length) throw new Error(`JSON array file changed while reading: ${filePath}`);
  return JSON.parse(buffer.toString("utf8"));
}

function rememberRequestIdentity(index, item, entryIndex) {
  index.scannedIdentities.add(entryIndex);
  if (item?.capture_id !== undefined && item.capture_id !== null) index.requestIndexes.set(String(item.capture_id), entryIndex);
  if (item?.request_index !== undefined && item.request_index !== null) index.requestIndexes.set(String(item.request_index), entryIndex);
}

function fingerprintFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`JSON array source is not a file: ${filePath}`);
  const fd = fs.openSync(filePath, "r");
  try {
    const sampleBytes = Math.min(4096, stat.size);
    const head = Buffer.alloc(sampleBytes);
    const tail = Buffer.alloc(sampleBytes);
    if (sampleBytes) {
      fs.readSync(fd, head, 0, sampleBytes, 0);
      fs.readSync(fd, tail, 0, sampleBytes, Math.max(0, stat.size - sampleBytes));
    }
    return {
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
      sample_sha256: crypto.createHash("sha256").update(head).update(tail).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readPersistedIndex(indexPath, fingerprint) {
  try {
    const stat = fs.statSync(indexPath);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    return validPersistedIndex(value, fingerprint) ? value : null;
  } catch {
    return null;
  }
}

function validPersistedIndex(value, fingerprint) {
  if (value?.format !== JSON_ARRAY_FILE_INDEX_FORMAT || !fingerprintsEqual(value.fingerprint, fingerprint)) return false;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_INDEX_ENTRIES || value.entry_count !== value.entries.length) return false;
  let previousEnd = 0;
  for (const entry of value.entries) {
    const [start, end] = entry || [];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || end <= start || end > fingerprint.size) return false;
    previousEnd = end;
  }
  return true;
}

function persistIndex(indexPath, value, { pathPrefix } = {}) {
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path.dirname(indexPath), 0o700);
    } catch {
      // Windows and some mounted filesystems do not expose POSIX permissions.
    }
    const tempPath = `${indexPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(tempPath, indexPath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (error?.code !== "EEXIST") throw error;
    }
    pruneOldIndexes(path.dirname(indexPath), path.basename(indexPath), pathPrefix);
  } catch {
    // Index persistence is an optimization. A read-only cache directory must not hide the Trace.
  }
}

function pruneOldIndexes(cacheDir, currentName, pathPrefix) {
  if (!pathPrefix) return;
  try {
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== currentName && entry.name.startsWith(`${pathPrefix}-`) && entry.name.endsWith(".json")) {
        fs.rmSync(path.join(cacheDir, entry.name), { force: true });
      }
    }
  } catch {
    // Stale cache cleanup is best-effort.
  }
}

function hydrateIndex(data, sourcePath, indexPath) {
  return {
    ...data,
    sourcePath,
    indexPath,
    requestIndexes: new Map(),
    scannedIdentities: new Set(),
  };
}

function resolveFile(filePath) {
  if (!filePath) throw new TypeError("filePath is required");
  return fs.realpathSync(path.resolve(filePath));
}

function pathHash(filePath) {
  return crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}

function fingerprintsEqual(left, right) {
  return Boolean(left && right && left.size === right.size && left.mtime_ms === right.mtime_ms && left.ctime_ms === right.ctime_ms && left.sample_sha256 === right.sample_sha256);
}

function invalidArray(filePath, offset, reason) {
  return new SyntaxError(`Invalid JSON object array at byte ${offset} (${reason}): ${filePath}`);
}

function range(start, end) {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function isWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}
