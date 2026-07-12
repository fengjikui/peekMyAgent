#!/usr/bin/env node
import assert from "node:assert/strict";
import { SourceRepository, validateSourceSummary } from "../src/server/source-repository.mjs";

const includeStatsCalls = [];
const repository = new SourceRepository({
  listBase({ includeStats }) {
    includeStatsCalls.push(includeStats);
    return [source("live", "Live", "proxy_capture", { request_count: includeStats ? 2 : undefined })];
  },
  listPersisted() {
    return [source("stored", "Stored", "persisted_capture", { request_count: 4 })];
  },
  listImported() {
    return [source("imported", "Imported", "imported_trace", { request_count: 1 })];
  },
  decorate(sources) {
    return sources.map((item) => ({ ...item, decorated: true }));
  },
  sanitizeId(value) {
    return String(value || "").trim().slice(0, 32);
  },
  notFoundError(id) {
    return Object.assign(new Error(`Source not found: ${id}`), { statusCode: 404 });
  },
});

const listed = repository.list();
assert.deepEqual(
  listed.map((item) => item.id),
  ["live", "stored", "imported"],
  "provider precedence remains live/base, persisted, imported",
);
assert.equal(listed.every((item) => item.decorated), true);
assert.equal(repository.resolve(" stored ").id, "stored");
assert.equal(repository.resolve("").id, "live", "empty selection falls back to the first decorated source");
assert.throws(() => repository.resolve("missing"), (error) => error.statusCode === 404);

const withoutStats = repository.list({ includeStats: false });
assert.equal(withoutStats[0].request_count, undefined);
assert.equal(includeStatsCalls[0], true);
assert.equal(includeStatsCalls.at(-1), false);

assert.equal(validateSourceSummary(source("ok", "OK", "proxy_capture")).ok, true);
assert.deepEqual(validateSourceSummary({ id: "broken" }).errors, ["label is required", "kind is required", "available must be boolean"]);
assert.throws(
  () =>
    new SourceRepository({
      listBase: () => [{ id: "broken", label: "Broken", available: true }],
      listPersisted: () => [],
      listImported: () => [],
      decorate: (sources) => sources,
      sanitizeId: String,
    }).list(),
  /kind is required/,
  "malformed providers fail at the repository boundary",
);

console.log("source repository contract smoke passed");

function source(id, label, kind, extra = {}) {
  return { id, label, kind, available: true, ...extra };
}
