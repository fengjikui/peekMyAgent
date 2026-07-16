#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildSystemDiffModel, compactDiffRows, splitSystemDiffLines } from "../src/viewer/system-diff-model.js";
import { renderSystemDiffView } from "../src/viewer/system-diff-renderer.js";
import { translateUi } from "../src/viewer/ui-i18n.js";

const exact = buildSystemDiffModel("alpha\nbeta\ngamma", "alpha\nchanged\ngamma");
assert.equal(exact.mode, "line");
assert.equal(exact.addedLines, 1);
assert.equal(exact.removedLines, 1);
assert.deepEqual(
  exact.rows.filter((row) => row.type !== "context").map((row) => [row.type, row.oldLine, row.newLine, row.text]),
  [
    ["remove", 2, "", "beta"],
    ["add", "", 2, "changed"],
  ],
);
assert.equal(exact.before.fingerprint.length, 16);
assert.notEqual(exact.before.fingerprint, exact.after.fingerprint);

const equal = buildSystemDiffModel("same\r\ntext", "same\ntext");
assert.equal(equal.mode, "equal", "line ending normalization should not create a visible diff");
assert.deepEqual(splitSystemDiffLines("one\r\ntwo\rthree"), ["one", "two", "three"]);

const manyShortLines = buildSystemDiffModel("", "\n".repeat(2_000));
assert.equal(manyShortLines.mode, "summary", "a small matrix must not create thousands of rendered rows");
assert.equal(manyShortLines.limitReason, "lines");

const compacted = compactDiffRows(
  [
    { type: "context", text: "one" },
    { type: "context", text: "two" },
    { type: "remove", text: "three" },
    { type: "add", text: "four" },
    { type: "context", text: "five" },
    { type: "context", text: "six" },
  ],
  0,
);
assert.deepEqual(compacted.map((row) => row.type), ["skip", "remove", "add", "skip"]);

const largeBefore = Array.from({ length: 5_000 }, (_, index) => `system line ${index}`).join("\n");
const largeAfter = Array.from({ length: 5_000 }, (_, index) =>
  index >= 2_200 && index < 2_500 ? `changed system line ${index}` : `system line ${index}`,
).join("\n");
const startedAt = performance.now();
const bounded = buildSystemDiffModel(largeBefore, largeAfter, { maxExactLines: 20_000 });
const elapsedMs = performance.now() - startedAt;
assert.equal(bounded.mode, "summary");
assert.equal(bounded.limitReason, "matrix_cells");
assert.equal(bounded.sharedPrefixLines, 2_200);
assert.equal(bounded.sharedSuffixLines, 2_500);
assert.equal(bounded.changedBeforeLines, 300);
assert.equal(bounded.changedAfterLines, 300);
assert(bounded.blockLines >= 32);
assert(bounded.rows.length <= 2 * bounded.limits.maxSummaryBlocks + 2, "summary output must stay bounded");
assert(elapsedMs < 2_000, `bounded 5k-line diff should complete promptly, took ${elapsedMs.toFixed(1)}ms`);

const shiftedBlock = buildSystemDiffModel(
  ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "B3", "C0", "C1", "C2", "C3"].join("\n"),
  ["X0", "X1", "X2", "X3", "Y0", "Y1", "Y2", "Y3", "B0", "B1", "B2", "B3", "Z0", "Z1", "Z2", "Z3"].join("\n"),
  { maxMatrixCells: 4, minSummaryBlockLines: 4, maxSummaryBlocks: 16 },
);
const shiftedContext = shiftedBlock.rows.find((row) => row.type === "context" && row.preview === "B0");
assert.ok(shiftedContext, "shared block should remain visible near changed blocks");
assert.equal(shiftedContext.oldLine, "5-8");
assert.equal(shiftedContext.newLine, "9-12", "matched summary blocks retain distinct before and after ranges");

const exactHtml = renderSystemDiffView({
  model: buildSystemDiffModel("safe", "<script>alert(1)</script>"),
  previousIndex: 4,
  currentIndex: 5,
  translate: (key, vars) => translateUi("en-US", key, vars),
  escapeHtml,
});
assert.match(exactHtml, /data-system-diff-mode="line"/);
assert.match(exactHtml, /#4 → #5/);
assert.match(exactHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.doesNotMatch(exactHtml, /<script>/);

const boundedHtml = renderSystemDiffView({
  model: bounded,
  previousIndex: 8,
  currentIndex: 9,
  translate: (key, vars) => translateUi("zh-CN", key, vars),
  escapeHtml,
});
assert.match(boundedHtml, /data-system-diff-mode="summary"/);
assert.match(boundedHtml, /有界块摘要/);
assert.match(boundedHtml, /2,200/);
assert.match(boundedHtml, /diff-block-hash/);

const equalHtml = renderSystemDiffView({
  model: equal,
  previousIndex: 1,
  currentIndex: 2,
  translate: (key, vars) => translateUi("en-US", key, vars),
  escapeHtml,
});
assert.match(equalHtml, /data-system-diff-mode="equal"/);
assert.match(equalHtml, /extracted System text is identical/);

console.log(`system diff view contract smoke passed (${elapsedMs.toFixed(1)}ms bounded diff)`);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
