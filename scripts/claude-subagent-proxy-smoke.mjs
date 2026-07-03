import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCaptureProxy } from "../src/core/capture-proxy.mjs";

const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const reportPath =
  process.env.PEEK_CLAUDE_SUBAGENT_PROXY_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "claude-subagent-proxy-smoke", "claude-subagent-proxy-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "claude-subagent-proxy", "latest");
const prompt = [
  "这是 peekMyAgent 的 Claude Code subagent 捕获实验。",
  "请必须尝试使用 Task/subagent 工具并行启动 2 个子代理；如果 Task/subagent 工具不可用，请明确说不可用，不要伪造。",
  "子代理 A：只读 package.json，汇总 scripts 里和 smoke 有关的命令。",
  "子代理 B：只读 docs/user-guide.md，汇总其中和 Subagent、Raw 展示、隐私提醒有关的说明。",
  "不要修改文件。等待两个子代理都返回后，用 3 条短 bullet 总结你观察到的结果。",
].join("\n");

if (!originalBaseUrl || !originalAuthToken) {
  console.error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are required for this smoke test.");
  process.exit(1);
}

function runClaude({ env, bodyDir, debugFile }) {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "default",
        "--permission-mode",
        "bypassPermissions",
        "--max-budget-usd",
        "0.40",
        "--debug-file",
        debugFile,
        prompt,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...env,
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_LOGS_EXPORTER: "console",
          OTEL_LOG_RAW_API_BODIES: `file:${bodyDir}`,
          OTEL_LOGS_EXPORT_INTERVAL: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal || null, stdout, stderr });
    });
  });
}

function listRequestFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.endsWith(".request.json")).sort().map((name) => path.join(root, name));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || `[${part?.type || "object"}]`).join("\n");
  if (content && typeof content === "object") return content.text || JSON.stringify(content);
  return "";
}

function findContentParts(messages, type) {
  const parts = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === type) parts.push({ role: message.role || null, part });
    }
  }
  return parts;
}

function summarizeBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = Array.isArray(body?.system) ? body.system : body?.system ? [body.system] : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolUses = findContentParts(messages, "tool_use");
  const toolResults = findContentParts(messages, "tool_result");
  const text = JSON.stringify(body || {});
  return {
    model: body?.model || null,
    messages_count: messages.length,
    roles: messages.map((message) => message.role || "unknown"),
    system_count: system.length,
    tools_count: tools.length,
    tool_names: tools.map((tool) => tool?.name || tool?.function?.name || tool?.type || "unknown").slice(0, 20),
    tool_use_count: toolUses.length,
    tool_use_names: toolUses.map(({ part }) => part?.name || "unknown"),
    tool_result_count: toolResults.length,
    has_task_text: /subagent|Task|任务|子代理|agent/i.test(text),
    first_user_preview: contentText(messages.find((message) => message.role === "user")?.content).slice(0, 160),
    body_hash: hashJson(body),
  };
}

function requestHeader(capture, key) {
  const value = capture?.headers?.[key] || capture?.headers?.[key.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : value || "";
}

function summarizeCapture(capture) {
  return {
    capture_id: capture.capture_id,
    watch_id: capture.watch_id,
    request_index: capture.request_index,
    path: capture.path,
    status: capture.upstream_status || null,
    claude_session_id: requestHeader(capture, "x-claude-code-session-id"),
    raw_body_length: capture.raw_body_length,
    ...summarizeBody(capture.body),
  };
}

function parseClaudeJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseDebugApiSources(debugFile) {
  if (!fs.existsSync(debugFile)) return [];
  const rows = [];
  for (const line of fs.readFileSync(debugFile, "utf8").split("\n")) {
    const match = line.match(/^(\S+).*?\[API REQUEST\]\s+(\S+)\s+source=(\S+)/);
    if (match) rows.push({ timestamp: match[1], path: match[2], source: match[3] });
  }
  return rows;
}

function writeEvidence({ result, proxy, otelFiles, otelSummaries, captureSummaries, debugFile }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(evidenceDir, "proxy-otel"), { recursive: true });
  for (const file of otelFiles) fs.copyFileSync(file, path.join(evidenceDir, "proxy-otel", path.basename(file)));
  fs.copyFileSync(debugFile, path.join(evidenceDir, "claude-debug.log"));
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        cwd: process.cwd(),
        prompt,
        original_base_url: originalBaseUrl,
        proxy_base_url: proxy.baseUrl,
        note: "Claude Code 在 ANTHROPIC_BASE_URL 指向 peekMyAgent proxy 时尝试触发 Task/subagent；proxy-captures 是真实 HTTP body。",
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "stdout-parsed.json"), `${JSON.stringify(parseClaudeJson(result.stdout), null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(proxy.captures, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "capture-summaries.json"), `${JSON.stringify(captureSummaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "otel-summaries.json"), `${JSON.stringify(otelSummaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "debug-api-sources.json"), `${JSON.stringify(parseDebugApiSources(debugFile), null, 2)}\n`);
}

function writeReport({ result, captureSummaries, otelSummaries, debugApiSources }) {
  const uniqueSessionIds = [...new Set(captureSummaries.map((item) => item.claude_session_id).filter(Boolean))];
  const sourceCounts = debugApiSources.reduce((counts, item) => {
    counts[item.source] = (counts[item.source] || 0) + 1;
    return counts;
  }, {});
  const lines = [];
  lines.push("# Claude Code subagent proxy smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：让 Claude Code 在 peekMyAgent proxy 路径下尝试使用 Task/subagent，同时保存 proxy capture 与 OTel raw body。报告不输出完整正文。");
  lines.push("");
  lines.push(`- upstream base URL：${originalBaseUrl}`);
  lines.push(`- exit：${result.code}`);
  lines.push(`- proxy captures：${captureSummaries.length}`);
  lines.push(`- otel requests：${otelSummaries.length}`);
  lines.push(`- unique x-claude-code-session-id：${uniqueSessionIds.length}`);
  lines.push(`- debug API sources：${Object.entries(sourceCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("## Proxy capture 摘要");
  lines.push("");
  lines.push("| index | status | model | messages | system | tools | tool_use | tool_names | claude_session_id | body_bytes | task_text |");
  lines.push("| ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- |");
  for (const item of captureSummaries) {
    lines.push(
      `| ${item.request_index} | ${item.status || ""} | ${item.model || ""} | ${item.messages_count} | ${item.system_count} | ${item.tools_count} | ${item.tool_use_count} | ${item.tool_use_names.join(", ")} | ${item.claude_session_id.slice(0, 12)} | ${item.raw_body_length} | ${item.has_task_text} |`,
    );
  }
  lines.push("");
  lines.push("## OTel raw body 摘要");
  lines.push("");
  lines.push("| file_index | model | messages | system | tools | tool_use | tool_result | task_text | hash |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const [index, item] of otelSummaries.entries()) {
    lines.push(
      `| ${index + 1} | ${item.model || ""} | ${item.messages_count} | ${item.system_count} | ${item.tools_count} | ${item.tool_use_count} | ${item.tool_result_count} | ${item.has_task_text} | ${item.body_hash.slice(0, 12)} |`,
    );
  }
  lines.push("");
  lines.push("## Debug API source 摘要");
  lines.push("");
  lines.push("| request | timestamp | source | path |");
  lines.push("| ---: | --- | --- | --- |");
  for (const [index, item] of debugApiSources.entries()) {
    lines.push(`| ${index + 1} | ${item.timestamp} | ${item.source} | ${item.path} |`);
  }
  lines.push("");
  lines.push("## 初步判读");
  lines.push("");
  if (captureSummaries.some((item) => item.tool_use_names.some((name) => /task/i.test(name)))) {
    lines.push("- 捕获中出现 Task/tool_use，说明主 Agent 至少把 subagent 调度作为模型请求的一部分发送。");
  } else {
    lines.push("- 捕获摘要中未直接看到名为 Task 的 tool_use；需要查看 evidence 里的 raw body 和 debug log 判断 Claude Code 是否用其他机制调度。");
  }
  if (debugApiSources.some((item) => item.source.startsWith("agent:"))) {
    lines.push("- debug log 中出现 `agent:*` API source，说明 subagent/Agent 工具触发了独立模型请求；这些请求应在 UI 中标记为子代理请求。");
  }
  if (uniqueSessionIds.length > 1) {
    lines.push("- 捕获到多个 `x-claude-code-session-id`，可能表示 subagent 使用独立 session 或派生 session。");
  } else {
    lines.push("- 本次 proxy capture 的 `x-claude-code-session-id` 看起来相同，初步更像共享同一 Claude Code session；是否存在内部 subagent 仍需结合 tool_use/tool_result 判断。");
  }
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-subagent-"));
  const bodyDir = path.join(tmpRoot, "raw-bodies");
  const debugFile = path.join(tmpRoot, "claude-debug.log");
  fs.mkdirSync(bodyDir, { recursive: true });

  const proxy = await startCaptureProxy({
    targetBaseUrl: originalBaseUrl,
    preserveTargetPathPrefix: true,
    defaultAttribution: {
      watchId: "claude-subagent-smoke",
      agentProfile: "Claude Code",
      workspace: process.cwd(),
      conversationId: "claude-subagent-smoke",
    },
  });
  const result = await runClaude({ bodyDir, debugFile, env: { ANTHROPIC_BASE_URL: proxy.baseUrl } });
  await proxy.close();

  const otelFiles = listRequestFiles(bodyDir);
  const otelSummaries = otelFiles.map((file) => summarizeBody(readJson(file)));
  const captureSummaries = proxy.captures.map((capture) => summarizeCapture(capture));
  const debugApiSources = parseDebugApiSources(debugFile);
  writeEvidence({ result, proxy, otelFiles, otelSummaries, captureSummaries, debugFile });
  writeReport({ result, captureSummaries, otelSummaries, debugApiSources });
  if (process.env.PEEK_KEEP_RAW !== "1") fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Wrote ${reportPath}`);
  console.log({ exit: result.code, proxyCaptures: proxy.captures.length, otelRequests: otelFiles.length, evidenceDir });
  if (result.code !== 0 || proxy.captures.length === 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
