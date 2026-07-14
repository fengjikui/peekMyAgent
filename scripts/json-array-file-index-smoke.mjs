#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSON_ARRAY_FILE_INDEX_FORMAT, JsonArrayFileIndex, buildObjectArrayIndex } from "../src/server/json-array-file-index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-json-index-"));
const cacheDir = path.join(root, "private-cache");
const sourcePath = path.join(root, "proxy-captures.json");
const captures = [
  capture(1, "plain"),
  capture(2, "braces inside a string: } ], { and an escaped quote: \\\"") ,
  capture(3, "unicode 中文 and nested content", { nested: [{ value: "[not structural]" }] }),
  capture(4, "last"),
];

try {
  fs.writeFileSync(sourcePath, `${JSON.stringify(captures, null, 2)}\n`, { mode: 0o400 });
  const originalHash = sha256(fs.readFileSync(sourcePath));
  const index = new JsonArrayFileIndex({ cacheDir, chunkBytes: 17 });

  const middle = index.readPage(sourcePath, { offset: 1, limit: 2 });
  assert.deepEqual(middle.items.map((item) => item.capture_id), ["capture-2", "capture-3"]);
  assert.equal(middle.totalCount, 4);
  assert.equal(middle.startIndex, 1);
  assert.equal(sha256(fs.readFileSync(sourcePath)), originalHash, "indexing never modifies the source Trace");

  const window = index.readWindow(sourcePath, "capture-3", { previousCount: 1 });
  assert.deepEqual(window.items.map((item) => item.request_index), [2, 3]);
  assert.equal(window.startIndex, 1);
  assert.deepEqual(index.readWindow(sourcePath, "4", { previousCount: 0 }).items.map((item) => item.capture_id), ["capture-4"]);
  assert.equal(index.readWindow(sourcePath, "missing"), null);

  const inspected = index.inspect(sourcePath);
  assert.equal(inspected.format, JSON_ARRAY_FILE_INDEX_FORMAT);
  assert.equal(inspected.entryCount, 4);
  assert.ok(inspected.indexPath.startsWith(path.resolve(cacheDir)));
  const persistedText = fs.readFileSync(inspected.indexPath, "utf8");
  assert.equal(persistedText.includes(sourcePath), false, "private sidecar does not disclose the source path");
  assert.equal(persistedText.includes("unicode 中文"), false, "private sidecar does not copy Trace content");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(inspected.indexPath).mode & 0o777, 0o600);
  }

  const persistedMtime = fs.statSync(inspected.indexPath).mtimeMs;
  const restarted = new JsonArrayFileIndex({ cacheDir, chunkBytes: 1 });
  assert.deepEqual(restarted.readPage(sourcePath, { offset: 3, limit: 1 }).items.map((item) => item.capture_id), ["capture-4"]);
  assert.equal(fs.statSync(inspected.indexPath).mtimeMs, persistedMtime, "a new process reuses the valid sidecar");

  fs.chmodSync(sourcePath, 0o600);
  fs.writeFileSync(sourcePath, `${JSON.stringify([...captures, capture(5, "new version")], null, 2)}\n`);
  const changed = restarted.readPage(sourcePath, { offset: 4, limit: 1 });
  assert.equal(changed.totalCount, 5);
  assert.equal(changed.items[0].capture_id, "capture-5", "source fingerprint changes invalidate the sidecar");
  assert.equal(fs.readdirSync(cacheDir).filter((name) => name.endsWith(".json")).length, 1, "stale versions are pruned");

  const compactPath = path.join(root, "compact.json");
  fs.writeFileSync(compactPath, JSON.stringify(captures));
  assert.deepEqual(new JsonArrayFileIndex({ cacheDir }).readPage(compactPath, { offset: 0, limit: 10 }).items, captures);

  const emptyPath = path.join(root, "empty.json");
  fs.writeFileSync(emptyPath, " [ \n ] \n");
  assert.deepEqual(buildObjectArrayIndex(emptyPath), []);

  assertInvalid("not-array.json", "{\"capture_id\":\"x\"}", /expected '\['/);
  assertInvalid("trailing-comma.json", "[{\"capture_id\":\"x\"},]", /capture entries must be JSON objects/);
  assertInvalid("truncated.json", "[{\"capture_id\":\"x\"}", /truncated JSON array/);
  assertInvalid("mismatched.json", "[{\"nested\":[1,2}}]", /mismatched JSON delimiters/);

  const invalidValuePath = path.join(root, "invalid-value.json");
  fs.writeFileSync(invalidValuePath, "[{\"capture_id\": nope}]");
  assert.throws(() => new JsonArrayFileIndex({ cacheDir }).readPage(invalidValuePath), SyntaxError, "items are JSON-validated when hydrated");

  const blockedCache = path.join(root, "cache-is-a-file");
  fs.writeFileSync(blockedCache, "not a directory");
  const memoryOnly = new JsonArrayFileIndex({ cacheDir: blockedCache });
  assert.equal(memoryOnly.readPage(compactPath, { offset: 0, limit: 1 }).items[0].capture_id, "capture-1", "cache write failures do not hide the Trace");

  console.log("json array file index smoke passed");
} finally {
  fs.chmodSync(sourcePath, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
}

function capture(requestIndex, text, extra = {}) {
  return {
    capture_id: `capture-${requestIndex}`,
    request_index: requestIndex,
    body: {
      messages: [{ role: "user", content: text }],
      ...extra,
    },
  };
}

function assertInvalid(name, contents, pattern) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, contents);
  assert.throws(() => buildObjectArrayIndex(filePath, { chunkBytes: 3 }), pattern);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
