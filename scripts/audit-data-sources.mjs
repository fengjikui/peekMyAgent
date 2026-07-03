import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { joinPlatformPath, userHome } from "../src/core/platform.mjs";

const AUDIT_HOME = process.env.PEEK_AUDIT_HOME || userHome();
const DEFAULT_MAX_FILES = Number(process.env.PEEK_AUDIT_MAX_FILES || 80);
const DEFAULT_MAX_LINES = Number(process.env.PEEK_AUDIT_MAX_LINES || 2000);
const REPORT_PATH =
  process.env.PEEK_AUDIT_REPORT ||
  path.join(process.cwd(), "tmp", "audit", "data-source-audit-report.md");

const REQUIRED_SIGNALS = [
  {
    id: "session_id",
    label: "会话 ID",
    match: (ctx) => ctx.keyNames.has("session_id") || ctx.keyNames.has("sessionId") || ctx.keyNames.has("uuid"),
  },
  {
    id: "timestamp",
    label: "时间戳",
    match: (ctx) => ctx.keyNames.has("timestamp") || ctx.keyNames.has("created_at") || ctx.keyNames.has("createdAt"),
  },
  {
    id: "role",
    label: "消息角色",
    match: (ctx) => ctx.roleValues.size > 0 || ctx.keyNames.has("role") || ctx.keyNames.has("type"),
  },
  {
    id: "user_text",
    label: "用户原始文本",
    match: (ctx) => ctx.roleValues.has("user") || ctx.keyNames.has("user") || ctx.keyNames.has("prompt"),
  },
  {
    id: "assistant_text",
    label: "Assistant 输出",
    match: (ctx) => ctx.roleValues.has("assistant") || ctx.keyNames.has("assistant"),
  },
  {
    id: "tool_use",
    label: "工具调用",
    match: (ctx) =>
      ctx.keyNames.has("toolUseResult") ||
      ctx.keyNames.has("tool_use") ||
      ctx.keyNames.has("tool_result") ||
      ctx.keyNames.has("tool_name") ||
      ctx.typeValues.has("tool_use") ||
      ctx.typeValues.has("tool_result"),
  },
  {
    id: "model_name",
    label: "模型名",
    match: (ctx) => ctx.keyNames.has("model") || ctx.keyNames.has("model_name") || ctx.keyNames.has("modelName"),
  },
  {
    id: "request_body",
    label: "请求结构字段（非完整性证明）",
    match: (ctx) =>
      ctx.keyNames.has("request_body") ||
      ctx.keyNames.has("requestBody") ||
      ctx.keyNames.has("body") ||
      ctx.keyNames.has("body_ref") ||
      ctx.keyNames.has("messages") ||
      ctx.keyNames.has("input"),
  },
  {
    id: "system_prompt",
    label: "System prompt",
    match: (ctx) => ctx.roleValues.has("system") || ctx.keyNames.has("system") || ctx.keyNames.has("systemPrompt"),
  },
  {
    id: "developer_prompt",
    label: "Developer prompt",
    match: (ctx) => ctx.roleValues.has("developer") || ctx.keyNames.has("developer"),
  },
];

function discoverFiles({ home = AUDIT_HOME, platform = process.platform } = {}) {
  if (!home) throw new Error("Could not resolve audit home. Set PEEK_AUDIT_HOME.");
  const sources = [
    {
      sourceId: "claude-project-jsonl",
      agent: "Claude Code",
      method: "session_file",
      confidence: "derived",
      root: joinPlatformPath(platform, home, ".claude", "projects"),
      patterns: [".jsonl"],
    },
    {
      sourceId: "claude-telemetry-json",
      agent: "Claude Code",
      method: "telemetry",
      confidence: "partial",
      root: joinPlatformPath(platform, home, ".claude", "telemetry"),
      patterns: [".json"],
    },
    {
      sourceId: "openclaw-session-jsonl",
      agent: "OpenClaw",
      method: "session_file",
      confidence: "derived",
      root: joinPlatformPath(platform, home, ".openclaw", "agents"),
      patterns: [".jsonl"],
    },
    {
      sourceId: "openclaw-gateway-logs",
      agent: "OpenClaw",
      method: "gateway_log",
      confidence: "partial",
      root: joinPlatformPath(platform, home, ".openclaw", "logs"),
      patterns: [".jsonl", ".log"],
    },
  ];

  return sources.map((source) => {
    const files = walk(source.root)
      .filter((file) => source.patterns.some((suffix) => file.endsWith(suffix)))
      .sort((a, b) => statMtime(b) - statMtime(a))
      .slice(0, DEFAULT_MAX_FILES);
    return { ...source, files };
  });
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      if (entry.isFile()) found.push(next);
    }
  }
  return found;
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

async function analyzeSource(source) {
  const context = emptyContext(source);
  for (const file of source.files) {
    await analyzeFile(file, context);
  }
  const signals = REQUIRED_SIGNALS.map((signal) => ({
    id: signal.id,
    label: signal.label,
    present: signal.match(context),
  }));
  return {
    ...source,
    filesScanned: context.filesScanned,
    linesScanned: context.linesScanned,
    jsonRecords: context.jsonRecords,
    parseErrors: context.parseErrors,
    keyNames: [...context.keyNames].sort().slice(0, 120),
    roleValues: [...context.roleValues].sort(),
    typeValues: [...context.typeValues].sort().slice(0, 80),
    eventNames: [...context.eventNames].sort().slice(0, 80),
    signals,
    recommendedConfidence: recommendConfidence(source, signals),
  };
}

function emptyContext(source) {
  return {
    source,
    filesScanned: 0,
    linesScanned: 0,
    jsonRecords: 0,
    parseErrors: 0,
    keyNames: new Set(),
    roleValues: new Set(),
    typeValues: new Set(),
    eventNames: new Set(),
  };
}

async function analyzeFile(file, ctx) {
  ctx.filesScanned += 1;
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;
    ctx.linesScanned += 1;
    if (lines > DEFAULT_MAX_LINES) break;
    const parsed = parseMaybeJson(line);
    if (!parsed.ok) {
      ctx.parseErrors += 1;
      continue;
    }
    ctx.jsonRecords += 1;
    collectShape(parsed.value, ctx, 0);
  }
}

function parseMaybeJson(line) {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

function collectShape(value, ctx, depth) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectShape(item, ctx, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    ctx.keyNames.add(key);
    if (key === "role" && typeof child === "string") ctx.roleValues.add(child);
    if (key === "type" && typeof child === "string") ctx.typeValues.add(child);
    if ((key === "event" || key === "event_name" || key === "name") && typeof child === "string") {
      ctx.eventNames.add(child);
    }
    collectShape(child, ctx, depth + 1);
  }
}

function recommendConfidence(source, signals) {
  const present = new Set(signals.filter((s) => s.present).map((s) => s.id));
  if (source.method.includes("proxy")) return "exact";
  if (present.has("request_body") && present.has("system_prompt") && present.has("tool_use")) return "near-final";
  if (present.has("user_text") && present.has("assistant_text")) return "derived";
  return "partial";
}

function renderReport(results) {
  const now = new Date().toISOString();
  const lines = [];
  lines.push("# 数据源字段覆盖审计报告");
  lines.push("");
  lines.push(`生成时间：${now}`);
  lines.push("");
  lines.push("说明：本报告只统计字段名、role/type 值和覆盖情况，不输出真实对话正文或密钥。");
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.agent} / ${result.sourceId}`);
    lines.push("");
    lines.push(`- 扫描文件数：${result.filesScanned}`);
    lines.push(`- 扫描行数：${result.linesScanned}`);
    lines.push(`- JSON 记录数：${result.jsonRecords}`);
    lines.push(`- 解析失败行数：${result.parseErrors}`);
    lines.push(`- 数据源方法：${result.method}`);
    lines.push(`- 建议可信度：${result.recommendedConfidence}`);
    lines.push("");
    lines.push("| 目标字段 | 是否出现 |");
    lines.push("| --- | --- |");
    for (const signal of result.signals) {
      lines.push(`| ${signal.label} | ${signal.present ? "yes" : "no"} |`);
    }
    lines.push("");
    lines.push(`- role 值：${result.roleValues.length ? result.roleValues.join(", ") : "无"}`);
    lines.push(`- type 值：${result.typeValues.length ? result.typeValues.join(", ") : "无"}`);
    lines.push(`- event/name 值：${result.eventNames.length ? result.eventNames.join(", ") : "无"}`);
    lines.push("");
    lines.push("<details><summary>字段名样本</summary>");
    lines.push("");
    lines.push("```text");
    lines.push(result.keyNames.join("\n") || "无");
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  lines.push("## 判定规则");
  lines.push("");
  lines.push("- `exact`：来自本地代理捕获或明确原始 API body。");
  lines.push("- `near-final`：包含 request body、system prompt、tool use，但无法证明就是外发请求。");
  lines.push("- `derived`：可重建用户/助手/工具时间线，但不是最终模型请求。");
  lines.push("- `partial`：只有诊断、状态、耗时、片段字段。");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const sources = discoverFiles();
  const results = [];
  for (const source of sources) {
    results.push(await analyzeSource(source));
  }
  const report = renderReport(results);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`Wrote ${REPORT_PATH}`);
  for (const result of results) {
    const present = result.signals.filter((signal) => signal.present).length;
    console.log(
      `${result.agent}/${result.sourceId}: ${present}/${result.signals.length} signals, confidence=${result.recommendedConfidence}, files=${result.filesScanned}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
