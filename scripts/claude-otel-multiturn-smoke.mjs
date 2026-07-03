import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeClaudeOtelRequestFile } from "../src/adapters/claude-otel.mjs";

const sessionId = crypto.randomUUID();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-multiturn-"));
const bodyDir = path.join(tmpRoot, "raw-bodies");
const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "claude-otel-multiturn", "latest");
const reportPath =
  process.env.PEEK_CLAUDE_OTEL_MULTITURN_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "claude-otel-multiturn-smoke", "claude-otel-multiturn-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });

fs.mkdirSync(bodyDir, { recursive: true });

const initialPrompt =
  "我们做一个 peekMyAgent Claude Code 多轮捕获测试。请读取 package.json，确认这个项目有哪些 smoke 脚本，然后用一句话回答。";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runClaude(prompt, index) {
  return new Promise((resolve) => {
    const args =
      index === 0
        ? [
            "-p",
            "--output-format",
            "json",
            "--session-id",
            sessionId,
            "--tools",
            "Read,Bash",
            "--permission-mode",
            "bypassPermissions",
            "--max-budget-usd",
            "0.10",
            prompt,
          ]
        : [
            "-p",
            "--output-format",
            "json",
            "--resume",
            sessionId,
            "--tools",
            "Read,Bash",
            "--permission-mode",
            "bypassPermissions",
            "--max-budget-usd",
            "0.10",
            prompt,
          ];
    const child = spawn("claude", args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "console",
        OTEL_LOG_RAW_API_BODIES: `file:${bodyDir}`,
        OTEL_LOGS_EXPORT_INTERVAL: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ turn_index: index + 1, prompt, args, code, signal: signal || null, stdout, stderr });
    });
  });
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      if (entry.isFile()) out.push(next);
    }
  }
  return out.sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function extractClaudeText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.result || parsed.text || parsed.message || JSON.stringify(parsed).slice(0, 600);
  } catch {
    return trimmed.split("\n").slice(-8).join("\n");
  }
}

function buildNextPrompt(previousTurn, newRequestBodies, index) {
  const text = extractClaudeText(previousTurn.stdout).slice(0, 500);
  const latest = summarizeClaudeBody(newRequestBodies.at(-1)?.body || {});
  if (index === 1) {
    return [
      "这是第二轮，请基于你刚才的实际回复继续。",
      `你上一轮回复摘要：${text || "(没有解析到文本)"}`,
      `我这边看到上一轮最后一次请求 messages=${latest.message_count}，system=${latest.system_count}，tools=${latest.tools_count}。`,
      "请读取 docs/user-guide.md 的前 60 行，并用一句话说明 Claude Code 与 OpenClaw 的捕获差异。",
    ].join("\n");
  }
  return [
    "这是第三轮，也是最后一轮。请基于前两轮上下文，执行一个很小的 Bash 命令，创建 tmp/claude-otel-multiturn-tool/created-by-claude.txt。",
    "然后用两句话总结：Claude Code 多轮捕获里哪些内容适合折叠，哪些内容应该突出展示。",
  ].join("\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || `[${part?.type || "object"}]`).join("\n");
  if (content && typeof content === "object") return content.text || JSON.stringify(content);
  return "";
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function summarizeClaudeBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = Array.isArray(body.system) ? body.system : body.system ? [body.system] : [];
  const toolUseCount = messages.reduce(
    (sum, message) => sum + (Array.isArray(message.content) ? message.content.filter((part) => part?.type === "tool_use").length : 0),
    0,
  );
  const toolResultCount = messages.reduce(
    (sum, message) => sum + (Array.isArray(message.content) ? message.content.filter((part) => part?.type === "tool_result").length : 0),
    0,
  );
  const userMessages = messages.filter((message) => message.role === "user");
  return {
    model: body.model || null,
    message_count: messages.length,
    roles: messages.map((message) => message.role || "unknown"),
    system_count: system.length,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    tool_use_count: toolUseCount,
    tool_result_count: toolResultCount,
    latest_user_length: userMessages.length ? contentText(userMessages[userMessages.length - 1].content).length : 0,
    system_hash: hashJson(system),
    tools_hash: hashJson(body.tools || []),
    params_hash: hashJson(Object.fromEntries(Object.entries(body).filter(([key]) => !["messages", "system", "tools"].includes(key)))),
  };
}

function compare(summaries) {
  const first = summaries[0] || {};
  return {
    request_count: summaries.length,
    stable_model: summaries.every((summary) => summary.model === first.model),
    stable_system_hash: summaries.every((summary) => summary.system_hash === first.system_hash),
    stable_tools_hash: summaries.every((summary) => summary.tools_hash === first.tools_hash),
    stable_params_hash: summaries.every((summary) => summary.params_hash === first.params_hash),
    message_counts: summaries.map((summary) => summary.message_count),
    system_counts: summaries.map((summary) => summary.system_count),
    tools_counts: summaries.map((summary) => summary.tools_count),
    tool_use_counts: summaries.map((summary) => summary.tool_use_count),
    tool_result_counts: summaries.map((summary) => summary.tool_result_count),
    latest_user_lengths: summaries.map((summary) => summary.latest_user_length),
    role_sequences: summaries.map((summary) => summary.roles.join(" -> ")),
  };
}

function writeReport({ turnResults, requestRecords, summaries, comparison }) {
  const lines = [];
  lines.push("# Claude Code OTel 多轮捕获 smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用同一个 Claude Code `--session-id` 连续发送 3 轮消息；第 2、3 轮 prompt 基于上一轮真实 stdout 和 OTel raw body 摘要生成。报告不输出完整 system/messages/tools。");
  lines.push("");
  lines.push(`- session id：${sessionId}`);
  lines.push(`- raw body files：${requestRecords.length}`);
  lines.push(`- turn exits：${turnResults.map((turn) => turn.code).join(", ")}`);
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("| turn | request_file | messages | roles | system | tools | tool_use | tool_result | latest_user_len | system_hash | tools_hash |");
  lines.push("| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const record of requestRecords) {
    const summary = record.summary;
    lines.push(
      `| ${record.turn_index} | ${path.basename(record.file)} | ${summary.message_count} | ${summary.roles.join(" -> ")} | ${summary.system_count} | ${summary.tools_count} | ${summary.tool_use_count} | ${summary.tool_result_count} | ${summary.latest_user_length} | ${summary.system_hash.slice(0, 12)} | ${summary.tools_hash.slice(0, 12)} |`,
    );
  }
  lines.push("");
  lines.push("| 对比项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(comparison)) lines.push(`| ${key} | ${Array.isArray(value) ? value.join(" / ") : value} |`);
  lines.push("");
  lines.push("完整 raw request、turn stdout/stderr、normalized JSON 已写入 evidence dir。");
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

function copyEvidence({ turnResults, requestRecords, normalized, summaries, comparison }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(evidenceDir, "raw-bodies"), { recursive: true });
  for (const record of requestRecords) {
    fs.copyFileSync(record.file, path.join(evidenceDir, "raw-bodies", path.basename(record.file)));
  }
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        cwd: process.cwd(),
        session_id: sessionId,
        prompts: turnResults.map(({ turn_index, prompt }) => ({ turn_index, prompt })),
        tmp_raw_body_dir: bodyDir,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "turn-results.json"), `${JSON.stringify(turnResults, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "request-summaries.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "stable-vs-changing.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "normalized.json"), `${JSON.stringify(normalized, null, 2)}\n`);
}

async function main() {
  const turnResults = [];
  const requestRecords = [];
  let prompt = initialPrompt;
  for (let index = 0; index < 3; index += 1) {
    const before = new Set(listFiles(bodyDir));
    const result = await runClaude(prompt, index);
    await sleep(1200);
    turnResults.push(result);
    const after = listFiles(bodyDir).filter((file) => file.endsWith(".request.json") && !before.has(file));
    const records = after.map((file) => ({ turn_index: index + 1, file, body: readJson(file) }));
    requestRecords.push(...records);
    if (index < 2) prompt = buildNextPrompt(result, records, index + 1);
  }
  const summaries = requestRecords.map((record) => ({ turn_index: record.turn_index, file: record.file, ...summarizeClaudeBody(record.body) }));
  for (const [index, summary] of summaries.entries()) requestRecords[index].summary = summary;
  const comparison = compare(summaries);
  const normalized = requestRecords.map((record) => normalizeClaudeOtelRequestFile(record.file));
  copyEvidence({ turnResults, requestRecords, normalized, summaries, comparison });
  writeReport({ turnResults, requestRecords, summaries, comparison });
  if (process.env.PEEK_KEEP_RAW !== "1") fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Wrote ${reportPath}`);
  console.log({ sessionId, requests: requestRecords.length, turnExits: turnResults.map((turn) => turn.code), comparison, evidenceDir });
  if (turnResults.some((turn) => turn.code !== 0) || requestRecords.length === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
