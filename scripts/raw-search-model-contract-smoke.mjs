#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  clampRawSearchIndex,
  collectRawSearchEntries,
  escapeRawSearchRegExp,
  filterRawSearchEntries,
  nextRawSearchIndex,
  normalizeRawSearchQuery,
  rawSearchSnippetSegments,
} from "../src/viewer/raw-search-model.js";

assert.equal(normalizeRawSearchQuery("  Agent  "), "Agent");

const entries = collectRawSearchEntries(
  {
    name: "Agent",
    input: { description: "Inspect the repository", pattern: "a+b" },
    tags: ["tool", "search"],
  },
  "Tools[0]",
);
assert(entries.some((entry) => entry.path === "Tools[0].name" && entry.value === "Agent"));
assert(entries.some((entry) => entry.path === "Tools[0].input.description"));
assert(entries.some((entry) => entry.path === "Tools[0].tags[1]" && entry.scope === "Tools"));
assert(filterRawSearchEntries(entries, "repository").some((entry) => entry.path.endsWith("description")));
assert(filterRawSearchEntries(entries, "description").some((entry) => entry.path.endsWith("description")));
assert.equal(filterRawSearchEntries(entries, "  ").length, 0);

const segments = rawSearchSnippetSegments("before A+B middle a+b after", "a+b");
assert.deepEqual(
  segments.filter((segment) => segment.match).map((segment) => segment.text),
  ["A+B", "a+b"],
);
assert.equal(escapeRawSearchRegExp("a+b[0]"), "a\\+b\\[0\\]");

assert.equal(clampRawSearchIndex(8, 3), 2);
assert.equal(clampRawSearchIndex(-2, 3), 0);
assert.equal(nextRawSearchIndex(2, 1, 3), 0);
assert.equal(nextRawSearchIndex(0, -1, 3), 2);
assert.equal(nextRawSearchIndex(4, 1, 0), 0);

console.log("raw search model contract smoke passed");
