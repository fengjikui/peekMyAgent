#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "assets", "demo", "storyboard", "catalog.zh-CN.json");
const tmpRoot = path.join(root, "tmp");
const shaPattern = /^[0-9a-f]{40}$/;
const decisionLabels = Object.freeze({
  pending: "未审阅",
  approved: "故事线通过",
  changes: "需要修改",
  deferred: "暂缓决定",
});
const topLevelFields = [
  "schema_version",
  "kind",
  "candidate_sha",
  "candidate_worktree_dirty",
  "exported_at",
  "chapter_count",
  "reviewed_count",
  "decisions",
  "privacy_notice",
];
const decisionFields = [
  "chapter_id",
  "chapter_label",
  "decision",
  "decision_label",
  "note",
  "updated_at",
];
const privacyRules = [
  { label: "provider credential", pattern: /\b(?:sk-(?:ant-)?|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/i },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/i },
  { label: "Bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/i },
  { label: "credential assignment", pattern: /\b(?:api[_\s-]?key|access[_\s-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;]{6,}/i },
  { label: "JWT-like token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { label: "macOS or Linux home path", pattern: /\/(?:Users|home)\/[^/\s]+\/[^\s]*/ },
  { label: "macOS temporary privacy path", pattern: /\/(?:private\/)?var\/folders\/[^\s]*/ },
  { label: "Windows home path", pattern: /\b[A-Za-z]:\\Users\\[^\s]+/i },
];

export function validateStoryboardReviewHandoff(payload, {
  catalog = readJson(catalogPath),
  expectedTarget = null,
  allowDirty = false,
} = {}) {
  assertRecord(payload, "review handoff");
  assertExactFields(payload, topLevelFields, "review handoff");
  assertInteger(payload.schema_version, "schema_version");
  if (payload.schema_version !== 1) throw new Error("schema_version must be 1");
  if (payload.kind !== "peekmyagent_storyboard_owner_review") {
    throw new Error("kind must be peekmyagent_storyboard_owner_review");
  }
  assertSha(payload.candidate_sha, "candidate_sha");
  assertBoolean(payload.candidate_worktree_dirty, "candidate_worktree_dirty");
  assertIsoTimestamp(payload.exported_at, "exported_at");
  assertInteger(payload.chapter_count, "chapter_count");
  assertInteger(payload.reviewed_count, "reviewed_count");
  assertNonEmptyString(payload.privacy_notice, "privacy_notice");
  if (payload.privacy_notice.length > 500) throw new Error("privacy_notice exceeds 500 characters");
  scanSensitiveText(payload.privacy_notice, "privacy_notice");

  if (expectedTarget !== null) {
    assertSha(expectedTarget, "expected target");
    if (payload.candidate_sha !== expectedTarget) {
      throw new Error(`candidate SHA mismatch: expected ${expectedTarget}, got ${payload.candidate_sha}`);
    }
  }
  if (payload.candidate_worktree_dirty && !allowDirty) {
    throw new Error("candidate_worktree_dirty is true; regenerate the review page from a clean commit or pass --allow-dirty for an internal-only inspection");
  }

  assertRecord(catalog, "storyboard catalog");
  if (!Array.isArray(catalog.chapters) || catalog.chapters.length === 0) {
    throw new Error("storyboard catalog must contain chapters");
  }
  if (!Array.isArray(payload.decisions)) throw new Error("decisions must be an array");
  if (payload.chapter_count !== catalog.chapters.length) {
    throw new Error("chapter_count does not match the current storyboard catalog");
  }
  if (payload.decisions.length !== catalog.chapters.length) {
    throw new Error("decisions must contain exactly one item for every catalog chapter");
  }

  const counts = { pending: 0, approved: 0, changes: 0, deferred: 0 };
  let notes = 0;
  for (const [index, decision] of payload.decisions.entries()) {
    const label = `decisions[${index}]`;
    const chapter = catalog.chapters[index];
    assertRecord(decision, label);
    assertExactFields(decision, decisionFields, label);
    if (decision.chapter_id !== chapter.id) {
      throw new Error(`${label}.chapter_id does not match catalog order`);
    }
    if (decision.chapter_label !== chapter.label) {
      throw new Error(`${label}.chapter_label does not match the current catalog`);
    }
    if (!Object.hasOwn(decisionLabels, decision.decision)) {
      throw new Error(`${label}.decision is not supported`);
    }
    if (decision.decision_label !== decisionLabels[decision.decision]) {
      throw new Error(`${label}.decision_label does not match its decision`);
    }
    if (typeof decision.note !== "string") throw new Error(`${label}.note must be a string`);
    if (decision.note.length > 2000) throw new Error(`${label}.note exceeds 2000 characters`);
    if (/\p{Cc}/u.test(decision.note.replace(/[\n\r\t]/g, ""))) {
      throw new Error(`${label}.note contains unsupported control characters`);
    }
    if (decision.note.trim()) {
      notes += 1;
      scanSensitiveText(decision.note, `${label}.note`);
    }
    if (decision.updated_at !== null) assertIsoTimestamp(decision.updated_at, `${label}.updated_at`);
    if ((decision.decision !== "pending" || decision.note.trim()) && decision.updated_at === null) {
      throw new Error(`${label}.updated_at is required after a decision or note is recorded`);
    }
    counts[decision.decision] += 1;
  }

  const reviewedCount = payload.decisions.filter((item) => item.decision !== "pending").length;
  if (payload.reviewed_count !== reviewedCount) {
    throw new Error("reviewed_count does not match the chapter decisions");
  }

  return {
    payload,
    catalog,
    counts,
    noteCount: notes,
    complete: reviewedCount === catalog.chapters.length,
  };
}

export function renderStoryboardReviewSummary(validated, {
  showNotes = false,
  currentHead = null,
  candidateCommitAvailable = null,
} = {}) {
  assertRecord(validated, "validated review handoff");
  const { payload, counts, noteCount, complete } = validated;
  const lines = [
    "# PMA 中文故事板所有者审阅交接",
    "",
    "> 这是只读的本地审阅摘要。它不会上传备注、修改 catalog、推进发布状态或代替真实 Viewer 复核。",
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    `| 候选提交 | ${inlineCode(payload.candidate_sha)} |`,
    `| 候选工作区 | ${payload.candidate_worktree_dirty ? "生成时有未提交修改（仅限内部检查）" : "干净"} |`,
    `| 导出时间 | ${inlineCode(payload.exported_at)} |`,
    `| 已审章节 | ${payload.reviewed_count}/${payload.chapter_count} |`,
    `| 带备注章节 | ${noteCount} |`,
  ];
  if (currentHead !== null) {
    assertSha(currentHead, "currentHead");
    lines.push(`| 当前检出 | ${inlineCode(currentHead)}${currentHead === payload.candidate_sha ? "（与候选一致）" : "（与候选不同）"} |`);
  }
  if (candidateCommitAvailable !== null) {
    lines.push(`| 本地候选 commit | ${candidateCommitAvailable ? "可解析" : "不可解析"} |`);
  }

  lines.push(
    "",
    "## 结论统计",
    "",
    `- 故事线通过：${counts.approved}`,
    `- 需要修改：${counts.changes}`,
    `- 暂缓决定：${counts.deferred}`,
    `- 未审阅：${counts.pending}`,
    "",
    "## 逐章结论",
    "",
  );

  for (const [index, item] of payload.decisions.entries()) {
    lines.push(
      `### ${String(index + 1).padStart(2, "0")}. ${escapeText(item.chapter_label)}`,
      "",
      `- 章节 ID：${inlineCode(item.chapter_id)}`,
      `- 结论：${escapeText(item.decision_label)}`,
      `- 备注：${item.note.trim() ? `已记录（${item.note.length} 字符，默认隐藏）` : "无"}`,
    );
    if (showNotes && item.note.trim()) {
      lines.push(
        "",
        "<details>",
        "<summary>显示本地审阅备注</summary>",
        "",
        `<pre><code>${escapeText(item.note)}</code></pre>`,
        "",
        "</details>",
      );
    }
    lines.push("");
  }

  lines.push("## 下一步", "");
  if (!complete) {
    lines.push(`- 还有 ${counts.pending} 章未作出结论；先在同一候选 SHA 的审片页完成审阅。`);
  }
  if (counts.changes > 0) {
    lines.push(`- ${counts.changes} 章需要修改；只重做对应镜头、字幕或标注，再生成新的候选 SHA 重新审阅。`);
  }
  if (counts.deferred > 0) {
    lines.push(`- ${counts.deferred} 章暂缓；记录缺少的产品事实或所有者决定，不把它们写成已发布能力。`);
  }
  if (complete && counts.changes === 0 && counts.deferred === 0) {
    lines.push("- 十章均已给出“故事线通过”；维护者仍须人工核对事实边界，再手工更新 catalog 与后续配音状态。");
  }
  lines.push(
    "- 分享任何含备注的报告前再次检查真实提示词、源码、本地路径、账号信息和密钥；自动扫描不能替代人工脱敏。",
    "",
  );
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = {
    allowDirty: false,
    check: false,
    expectedTarget: null,
    help: false,
    input: null,
    output: null,
    showNotes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--expected-target") options.expectedTarget = requiredValue(argv, ++index, argument);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--input") options.input = requiredValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(argv, ++index, argument);
    else if (argument === "--show-notes") options.showNotes = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.help) return options;
  if (!options.input) throw new Error("--input is required");
  if (options.expectedTarget !== null) assertSha(options.expectedTarget, "--expected-target");
  if (options.check && options.output) throw new Error("--check cannot be combined with --output");
  if (options.check && options.showNotes) throw new Error("--check cannot be combined with --show-notes");
  if (options.output && path.extname(options.output).toLowerCase() !== ".md") {
    throw new Error("--output must end in .md");
  }
  if (options.showNotes && !options.output) {
    throw new Error("--show-notes requires --output inside the repository tmp/ directory");
  }
  if (options.showNotes) {
    const output = path.resolve(root, options.output);
    if (output !== tmpRoot && !output.startsWith(`${tmpRoot}${path.sep}`)) {
      throw new Error("--show-notes output must stay inside the repository tmp/ directory");
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/storyboard-review-handoff.mjs --input <review.json> [options]

Options:
  --expected-target <sha>  Require the review candidate to match an exact commit
  --allow-dirty            Accept a dirty-worktree candidate for internal inspection only
  --check                  Validate without rendering a Markdown summary
  --output <file.md>       Write the safe summary instead of printing it
  --show-notes             Include note text; requires --output under tmp/
  -h, --help               Show this help

The default summary never prints review note text. Possible credentials and private
home paths are rejected without echoing the matched value. This command is local and
read-only with respect to catalog, documentation status, GitHub, and published media.`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const payload = readJson(path.resolve(root, options.input));
  const validated = validateStoryboardReviewHandoff(payload, {
    expectedTarget: options.expectedTarget,
    allowDirty: options.allowDirty,
  });
  if (!gitCommitExists(payload.candidate_sha)) {
    throw new Error(`candidate commit ${payload.candidate_sha} is not available locally; fetch the reviewed branch before processing this handoff`);
  }
  if (options.check) {
    console.log([
      "storyboard owner review handoff check passed:",
      `${payload.reviewed_count}/${payload.chapter_count} reviewed,`,
      `${validated.counts.changes} changes,`,
      `${validated.noteCount} notes,`,
      `candidate ${payload.candidate_sha}`,
    ].join(" "));
    return;
  }

  const summary = renderStoryboardReviewSummary(validated, {
    showNotes: options.showNotes,
    currentHead: gitHead(),
    candidateCommitAvailable: true,
  });
  if (options.output) {
    const output = path.resolve(root, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${summary}\n`, "utf8");
    console.log(`storyboard owner review summary written: ${relative(output)}`);
    return;
  }
  process.stdout.write(`${summary}\n`);
}

function scanSensitiveText(value, label) {
  for (const rule of privacyRules) {
    if (rule.pattern.test(value)) {
      throw new Error(`${label} failed privacy scan (${rule.label}); edit or remove the text before processing`);
    }
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactFields(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((field, index) => field !== required[index])) {
    throw new Error(`${label} has an unexpected field set for schema version 1`);
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new Error(`${label} must use canonical UTC ISO format`);
  }
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("could not resolve the current Git HEAD");
  return result.stdout.trim();
}

function gitCommitExists(sha) {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  return result.status === 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function inlineCode(value) {
  return `<code>${escapeText(value)}</code>`;
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "")
    .replaceAll("\n", "&#10;");
}

function relative(file) {
  const value = path.relative(root, file).split(path.sep).join("/");
  return value.startsWith("../") ? path.basename(file) : value;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
