#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    loadCaptureWindow(watchId, requestId, { previousCount }) {
      storeCalls.push(["window", watchId, requestId, previousCount]);
      return captures.slice(1, 3);
    },
  },
  files: {
    readJson: (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")),
    readOptionalJson(filePath) {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return null;
      }
    },
  },
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

  const persistedSource = { id: "stored-watch-1", store_watch_id: "watch-1", kind: "persisted_capture", available: true, request_count: 3 };
  assert.deepEqual(reader.read(persistedSource, { limit: 1 }).captures.map((capture) => capture.request_index), [1]);
  assert.deepEqual(reader.readAll(persistedSource).captures.map((capture) => capture.request_index), [1, 2, 3]);
  const persistedWindow = reader.readRequestWindow(persistedSource, "capture-3");
  assert.deepEqual(persistedWindow.captures.map((capture) => capture.request_index), [2, 3]);
  assert.equal(persistedWindow.startIndex, 1);
  assert.deepEqual(storeCalls, [
    ["initial", "watch-1", 1],
    ["all", "watch-1"],
    ["window", "watch-1", "capture-3", 1],
  ]);

  const fileSource = { id: "file-source", path: tmpDir, kind: "fixture", available: true };
  const fileInitial = reader.read(fileSource, { limit: 2 });
  assert.equal(fileInitial.captures.length, 2);
  assert.equal(fileInitial.debugSources.length, 2);
  assert.deepEqual(fileInitial.command, { argv: ["claude"] });
  const fileAll = reader.readAll(fileSource);
  assert.equal(fileAll.captures.length, 3);
  assert.deepEqual(fileAll.debugSources, [], "full export read skips debug companion data");
  assert.equal(fileAll.command, null, "full export read skips command companion data");
  const fileWindow = reader.readRequestWindow(fileSource, "3");
  assert.deepEqual(fileWindow.captures.map((capture) => capture.request_index), [2, 3]);
  assert.deepEqual(fileWindow.debugSources.map((item) => item.request_index), [2, 3]);

  assert.throws(() => reader.readRequestWindow(fileSource, "missing"), (error) => error.statusCode === 404);
  assert.throws(() => reader.read({ ...fileSource, available: false }), /Evidence not found/);

  console.log("source capture reader smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
