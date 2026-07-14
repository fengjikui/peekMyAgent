export const DEFAULT_SYSTEM_DIFF_LIMITS = Object.freeze({
  maxMatrixCells: 250_000,
  maxExactCharacters: 256 * 1024,
  maxExactLineCharacters: 20_000,
  maxExactLines: 1_000,
  minSummaryBlockLines: 32,
  maxSummaryBlocks: 256,
  lineContext: 4,
  blockContext: 1,
  previewCharacters: 180,
});

export function buildSystemDiffModel(before, after, options = {}) {
  const limits = normalizeLimits(options);
  const beforeText = normalizeDiffText(before);
  const afterText = normalizeDiffText(after);
  const beforeLines = splitSystemDiffLines(beforeText);
  const afterLines = splitSystemDiffLines(afterText);
  const base = {
    before: summarizeText(beforeText, beforeLines),
    after: summarizeText(afterText, afterLines),
    limits,
  };

  if (beforeText === afterText) {
    return {
      ...base,
      mode: "equal",
      addedLines: 0,
      removedLines: 0,
      rows: [],
    };
  }

  const exactReason = exactDiffLimitReason(beforeText, afterText, beforeLines, afterLines, limits);
  if (!exactReason) {
    const rows = createLineDiff(beforeLines, afterLines);
    return {
      ...base,
      mode: "line",
      addedLines: rows.filter((row) => row.type === "add").length,
      removedLines: rows.filter((row) => row.type === "remove").length,
      rows: compactDiffRows(rows, limits.lineContext),
    };
  }

  return {
    ...base,
    ...buildBlockSummary(beforeLines, afterLines, limits),
    mode: "summary",
    limitReason: exactReason,
  };
}

export function splitSystemDiffLines(text) {
  const normalized = normalizeDiffText(text);
  return normalized ? normalized.split("\n") : [];
}

export function compactDiffRows(rows, contextSize) {
  const changedIndexes = rows.flatMap((row, index) => (row.type === "context" ? [] : [index]));
  if (!changedIndexes.length) return rows;
  const keep = new Set();
  const context = Math.max(0, Number(contextSize) || 0);
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    for (let cursor = start; cursor <= end; cursor += 1) keep.add(cursor);
  }
  const output = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped) {
        output.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      output.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped) output.push({ type: "skip", count: skipped });
  return output;
}

function normalizeLimits(options) {
  const defaults = DEFAULT_SYSTEM_DIFF_LIMITS;
  return {
    maxMatrixCells: positiveInteger(options.maxMatrixCells, defaults.maxMatrixCells),
    maxExactCharacters: positiveInteger(options.maxExactCharacters, defaults.maxExactCharacters),
    maxExactLineCharacters: positiveInteger(options.maxExactLineCharacters, defaults.maxExactLineCharacters),
    maxExactLines: positiveInteger(options.maxExactLines, defaults.maxExactLines),
    minSummaryBlockLines: positiveInteger(options.minSummaryBlockLines, defaults.minSummaryBlockLines),
    maxSummaryBlocks: positiveInteger(options.maxSummaryBlocks, defaults.maxSummaryBlocks),
    lineContext: nonNegativeInteger(options.lineContext, defaults.lineContext),
    blockContext: nonNegativeInteger(options.blockContext, defaults.blockContext),
    previewCharacters: positiveInteger(options.previewCharacters, defaults.previewCharacters),
  };
}

function exactDiffLimitReason(beforeText, afterText, beforeLines, afterLines, limits) {
  if (beforeText.length + afterText.length > limits.maxExactCharacters) return "characters";
  if (maxLineLength(beforeLines, afterLines) > limits.maxExactLineCharacters) return "line_characters";
  if (beforeLines.length + afterLines.length > limits.maxExactLines) return "lines";
  const matrixCells = (beforeLines.length + 1) * (afterLines.length + 1);
  if (matrixCells > limits.maxMatrixCells) return "matrix_cells";
  return "";
}

function createLineDiff(beforeLines, afterLines) {
  const table = buildLcsTable(beforeLines, afterLines, (left, right) => left === right);
  return walkLcsDiff(beforeLines, afterLines, table, (left, right) => left === right, (line, type, oldIndex, newIndex) => ({
    type,
    oldLine: type === "add" ? "" : oldIndex + 1,
    newLine: type === "remove" ? "" : newIndex + 1,
    text: line,
  }));
}

function buildBlockSummary(beforeLines, afterLines, limits) {
  const sharedPrefixLines = countSharedPrefix(beforeLines, afterLines);
  const sharedSuffixLines = countSharedSuffix(beforeLines, afterLines, sharedPrefixLines);
  const beforeEnd = beforeLines.length - sharedSuffixLines;
  const afterEnd = afterLines.length - sharedSuffixLines;
  const changedBeforeLines = Math.max(0, beforeEnd - sharedPrefixLines);
  const changedAfterLines = Math.max(0, afterEnd - sharedPrefixLines);
  const largestChangedRange = Math.max(1, changedBeforeLines, changedAfterLines);
  const blockLines = Math.max(limits.minSummaryBlockLines, Math.ceil(largestChangedRange / limits.maxSummaryBlocks));
  const beforeBlocks = buildBlocks(beforeLines, sharedPrefixLines, beforeEnd, blockLines, limits.previewCharacters);
  const afterBlocks = buildBlocks(afterLines, sharedPrefixLines, afterEnd, blockLines, limits.previewCharacters);
  const sameBlock = (left, right) => left.signature === right.signature;
  const table = buildLcsTable(beforeBlocks, afterBlocks, sameBlock);
  const rows = walkLcsDiff(beforeBlocks, afterBlocks, table, sameBlock, (block, type, _oldIndex, _newIndex, beforeBlock, afterBlock) => ({
    type,
    oldLine: beforeBlock ? formatLineRange(beforeBlock.startLine, beforeBlock.endLine) : "",
    newLine: afterBlock ? formatLineRange(afterBlock.startLine, afterBlock.endLine) : "",
    hash: block.hash,
    lineCount: block.lineCount,
    preview: block.preview,
  }));

  return {
    blockLines,
    sharedPrefixLines,
    sharedSuffixLines,
    changedBeforeLines,
    changedAfterLines,
    removedBlocks: rows.filter((row) => row.type === "remove").length,
    addedBlocks: rows.filter((row) => row.type === "add").length,
    rows: compactDiffRows(rows, limits.blockContext),
  };
}

function buildBlocks(lines, start, end, blockLines, previewCharacters) {
  const blocks = [];
  for (let index = start; index < end; index += blockLines) {
    const stop = Math.min(end, index + blockLines);
    const slice = lines.slice(index, stop);
    const hash = fingerprintLines(slice);
    const characterCount = slice.reduce((total, line) => total + line.length + 1, 0);
    blocks.push({
      startLine: index + 1,
      endLine: stop,
      lineCount: stop - index,
      hash,
      signature: `${hash}:${stop - index}:${characterCount}`,
      preview: previewBlock(slice, previewCharacters),
    });
  }
  return blocks;
}

function buildLcsTable(beforeItems, afterItems, equals) {
  const table = Array.from({ length: beforeItems.length + 1 }, () => new Uint32Array(afterItems.length + 1));
  for (let row = beforeItems.length - 1; row >= 0; row -= 1) {
    for (let col = afterItems.length - 1; col >= 0; col -= 1) {
      table[row][col] = equals(beforeItems[row], afterItems[col])
        ? table[row + 1][col + 1] + 1
        : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }
  return table;
}

function walkLcsDiff(beforeItems, afterItems, table, equals, mapRow) {
  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeItems.length && newIndex < afterItems.length) {
    if (equals(beforeItems[oldIndex], afterItems[newIndex])) {
      rows.push(mapRow(beforeItems[oldIndex], "context", oldIndex, newIndex, beforeItems[oldIndex], afterItems[newIndex]));
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push(mapRow(beforeItems[oldIndex], "remove", oldIndex, newIndex, beforeItems[oldIndex], null));
      oldIndex += 1;
    } else {
      rows.push(mapRow(afterItems[newIndex], "add", oldIndex, newIndex, null, afterItems[newIndex]));
      newIndex += 1;
    }
  }
  while (oldIndex < beforeItems.length) {
    rows.push(mapRow(beforeItems[oldIndex], "remove", oldIndex, newIndex, beforeItems[oldIndex], null));
    oldIndex += 1;
  }
  while (newIndex < afterItems.length) {
    rows.push(mapRow(afterItems[newIndex], "add", oldIndex, newIndex, null, afterItems[newIndex]));
    newIndex += 1;
  }
  return rows;
}

function summarizeText(text, lines) {
  return {
    characters: text.length,
    lines: lines.length,
    fingerprint: fingerprintText(text),
  };
}

function countSharedPrefix(beforeLines, afterLines) {
  const limit = Math.min(beforeLines.length, afterLines.length);
  let count = 0;
  while (count < limit && beforeLines[count] === afterLines[count]) count += 1;
  return count;
}

function countSharedSuffix(beforeLines, afterLines, prefixLines) {
  const limit = Math.min(beforeLines.length, afterLines.length) - prefixLines;
  let count = 0;
  while (
    count < limit &&
    beforeLines[beforeLines.length - count - 1] === afterLines[afterLines.length - count - 1]
  ) {
    count += 1;
  }
  return count;
}

function fingerprintText(text) {
  return dualFnvFingerprint((emit) => emit(text));
}

function fingerprintLines(lines) {
  return dualFnvFingerprint((emit) => {
    lines.forEach((line, index) => {
      if (index) emit("\n");
      emit(line);
    });
  });
}

function dualFnvFingerprint(write) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  write((value) => {
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first ^= code & 0xff;
      first = Math.imul(first, 0x01000193);
      first ^= code >>> 8;
      first = Math.imul(first, 0x01000193);
      second ^= code & 0xff;
      second = Math.imul(second, 0x85ebca6b);
      second ^= code >>> 8;
      second = Math.imul(second, 0x85ebca6b);
    }
  });
  return `${unsignedHex(first)}${unsignedHex(second)}`;
}

function unsignedHex(value) {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function previewBlock(lines, maxCharacters) {
  const text = lines.find((line) => String(line || "").trim()) || lines[0] || "";
  const normalized = String(text).trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, Math.max(1, maxCharacters - 3))}...`;
}

function formatLineRange(start, end) {
  return start === end ? String(start) : `${start}-${end}`;
}

function normalizeDiffText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function maxLineLength(beforeLines, afterLines) {
  let max = 0;
  for (const line of beforeLines) max = Math.max(max, line.length);
  for (const line of afterLines) max = Math.max(max, line.length);
  return max;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
