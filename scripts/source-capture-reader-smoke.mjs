#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonArrayFileIndex } from "../src/server/json-array-file-index.mjs";
import { SourceCaptureReader } from "../src/server/source-capture-reader.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-capture-reader-"));
const captures = [1, 2, 3].map((requestIndex) => ({
  capture_id: `capture-${requestIndex}`,
  request_index: requestIndex,
  watch_id: "watch-1",
  body: { messages: [{ role: "user", content: `request ${requestIndex}` }] },
}));
const debugSources = captures.map((capture) => ({ request_index: capture.request_index, debug: true }));
fs.writeFileSync(path.join(tmpDir, "proxy-captures.json"), JSON.stringify(captures));
fs.writeFileSync(path.join(tmpDir, "debug-api-sources.json"), JSON.stringify(debugSources));
fs.writeFileSync(path.join(tmpDir, "command.json"), JSON.stringify({ argv: ["claude"] }));

const liveWatch = { id: "live-watch-1", watch_id: "watch-1" };
const storeCalls = [];
const fileReadCalls = [];
const reader = new SourceCaptureReader({
  watches: new Map([[liveWatch.id, liveWatch]]),
  store: {
    loadInitialCaptures(watchId, { limit }) {
      storeCalls.push(["initial", watchId, limit]);
      return captures.slice(0, limit);
    },
    loadCaptures(watchId) {
      storeCalls.push(["all", watchId]);
      return captures;
    },
    loadCapturePage(watchId, { offset, limit }) {
      storeCalls.push(["page", watchId, offset, limit]);
      return captures.slice(offset, offset + limit);
    },
    loadCaptureWindow(watchId, requestId, { previousCount }) {
      storeCalls.push(["window", watchId, requestId, previousCount]);
      return captures.slice(1, 3);
    },
  },
  files: {
    readJson(filePath) {
      fileReadCalls.push(filePath);
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    },
    readOptionalJson(filePath) {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return null;
      }
    },
  },
  fileIndex: new JsonArrayFileIndex({ cacheDir: path.join(tmpDir, "index-cache"), chunkBytes: 11 }),
  runtime: {
    capturesForWatch: () => captures,
    commandForWatch: () => ({ argv: ["claude", "-c"] }),
  },
  errors: {
    requestNotFound: (id) => Object.assign(new Error(`missing ${id}`), { statusCode: 404 }),
  },
});

try {
  const liveSource = { id: liveWatch.id, live_watch_id: "watch-1", kind: "proxy_capture", available: true };
  const liveInitial = reader.read(liveSource, { limit: 2 });
  assert.deepEqual(liveInitial.captures.map((capture) => capture.request_index), [1, 2]);
  assert.equal(liveInitial.totalCount, 3);
  assert.deepEqual(liveInitial.command, { argv: ["claude", "-c"] });
  const liveWindow = reader.readRequestWindow(liveSource, "capture-3");
  assert.deepEqual(liveWindow.captures.map((capture) => capture.request_index), [2, 3]);
  assert.equal(liveWindow.startIndex, 1);
  const livePage = reader.readPage(liveSource, { cursor: "1", limit: 1 });
  assert.deepEqual(livePage.captures.map((capture) => capture.request_index), [2]);
  assert.deepEqual(livePage.page, {
    cursor: "1",
    next_cursor: "2",
    offset: 1,
    limit: 1,
    loaded_count: 1,
    total_count: 3,
    has_more: true,
  });
  assert.equal(livePage.command, null, "companion command is emitted only on the first page");

  const persistedSource = { id: "stored-watch-1", store_watch_id: "watch-1", kind: "persisted_capture", available: true, request_count: 3 };
  assert.deepEqual(reader.read(persistedSource, { limit: 1 }).captures.map((capture) => capture.request_index), [1]);
  assert.deepEqual(reader.readAll(persistedSource).captures.map((capture) => capture.request_index), [1, 2, 3]);
  const persistedWindow = reader.readRequestWindow(persistedSource, "capture-3");
  assert.deepEqual(persistedWindow.captures.map((capture) => capture.request_index), [2, 3]);
  assert.equal(persistedWindow.startIndex, 1);
  const persistedPage = reader.readPage(persistedSource, { cursor: "1", limit: 2 });
  assert.deepEqual(persistedPage.captures.map((capture) => capture.request_index), [2, 3]);
  assert.equal(persistedPage.page.next_cursor, null);
  assert.equal(persistedPage.page.has_more, false);
  assert.deepEqual(storeCalls, [
    ["initial", "watch-1", 1],
    ["all", "watch-1"],
    ["window", "watch-1", "capture-3", 1],
    ["page", "watch-1", 1, 2],
  ]);

  const fileSource = { id: "file-source", path: tmpDir, kind: "fixture", available: true };
  const fileInitial = reader.read(fileSource, { limit: 2 });
  assert.equal(fileInitial.captures.length, 2);
  assert.equal(fileInitial.debugSources.length, 2);
  assert.deepEqual(fileInitial.command, { argv: ["claude"] });
  assert.equal(fileReadCalls.some((filePath) => filePath.endsWith("proxy-captures.json")), false, "bounded initial reads use the file index");
  const fileAll = reader.readAll(fileSource);
  assert.equal(fileAll.captures.length, 3);
  assert.deepEqual(fileAll.debugSources, [], "full export read skips debug companion data");
  assert.equal(fileAll.command, null, "full export read skips command companion data");
  assert.equal(fileReadCalls.filter((filePath) => filePath.endsWith("proxy-captures.json")).length, 1, "explicit full export still reads the complete capture file");
  fileReadCalls.length = 0;
  const firstFilePage = reader.readPage(fileSource, { limit: 2 });
  assert.deepEqual(firstFilePage.captures.map((capture) => capture.request_index), [1, 2]);
  assert.deepEqual(firstFilePage.debugSources.map((item) => item.request_index), [1, 2]);
  assert.deepEqual(firstFilePage.command, { argv: ["claude"] });
  assert.equal(firstFilePage.page.next_cursor, "2");
  const lastFilePage = reader.readPage(fileSource, { cursor: firstFilePage.page.next_cursor, limit: 2 });
  assert.deepEqual(lastFilePage.captures.map((capture) => capture.request_index), [3]);
  assert.deepEqual(lastFilePage.debugSources.map((item) => item.request_index), [3]);
  assert.equal(lastFilePage.page.next_cursor, null);
  assert.equal(lastFilePage.command, null);
  const fileWindow = reader.readRequestWindow(fileSource, "3");
  assert.deepEqual(fileWindow.captures.map((capture) => capture.request_index), [2, 3]);
  assert.deepEqual(fileWindow.debugSources.map((item) => item.request_index), [2, 3]);
  assert.equal(fileReadCalls.some((filePath) => filePath.endsWith("proxy-captures.json")), false, "file pages and request windows do not full-parse the capture file");

  assert.throws(() => reader.readRequestWindow(fileSource, "missing"), (error) => error.statusCode === 404);
  assert.throws(() => reader.readPage(fileSource, { cursor: "not-a-cursor" }), /cursor must be a non-negative integer/);
  assert.throws(() => reader.readPage(fileSource, { limit: -1 }), /limit must be a positive integer/);
  assert.throws(() => reader.read({ ...fileSource, available: false }), /Evidence not found/);

  console.log("source capture reader smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
