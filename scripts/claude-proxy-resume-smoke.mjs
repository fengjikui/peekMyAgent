import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeClaudeOtelRequestBody } from "../src/adapters/claude-otel.mjs";
import { startCaptureProxy } from "../src/core/capture-proxy.mjs";

const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const sessionId = crypto.randomUUID();
const watchId = "claude-proxy-resume";
const reportPath =
  process.env.PEEK_CLAUDE_PROXY_RESUME_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "claude-proxy-resume-smoke", "claude-proxy-resume-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "claude-proxy-resume", "latest");

if (!originalBaseUrl || !originalAuthToken) {
  console.error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are required for this smoke test.");
  process.exit(1);
}

const prompts = [
  [
    "这是 peekMyAgent 的 Claude Code proxy resume 捕获实验第一轮。",
    "请只读 package.json，找出和 Claude smoke 有关的 npm scripts。",
    "不要修改文件。用一句话回答。",
  ].join("\n"),
  [
    "这是第二轮，请使用同一个 Claude Code resume 会话继续。",
    "请只读 docs/user-guide.md，找出和 watch_id、conversation_id、子代理请求归属有关的说明。",
    "不要修改文件。用 3 条短 bullet 回答。",
  ].join("\n"),
  [
    "这是第三轮，请尝试使用 Task/subagent 工具启动 1 个只读子代理。",
    "子代理任务：只读 docs/claude-code-current-session-control.md，汇总 Claude Code 当前会话控制的关键限制。",
    "如果 Task/subagent 工具不可用，请明确说不可用，不要伪造。不要修改文件。",
    "最后用 2 句话说明这些证据对 peekMyAgent UI 有什么影响。",
  ].join("\n"),
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runClaude({ prompt, turnIndex, bodyDir, debugFile, proxyBaseUrl }) {
  return new Promise((resolve) => {
    const sessionArgs = turnIndex === 0 ? ["--session-id", sessionId] : ["--resume", sessionId];
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        ...sessionArgs,
        "--tools",
        "default",
        "--permission-mode",
        "bypassPermissions",
        "--max-budget-usd",
        "0.35",
        "--debug-file",
        debugFile,
        prompt,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: proxyBaseUrl,
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
      resolve({
        turn_index: turnIndex + 1,
        mode: turnIndex === 0 ? "session-id" : "resume",
        prompt,
        code,
        signal: signal || null,
        stdout,
        stderr,
      });
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
      else if (entry.isFile()) out.push(next);
    }
  }
  return out.sort();
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

function contentParts(messages, type) {
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
  const toolUses = contentParts(messages, "tool_use");
  const toolResults = contentParts(messages, "tool_result");
  const userMessages = messages.filter((message) => message.role === "user");
  const bodyText = JSON.stringify(body || {});
  return {
    model: body?.model || null,
    messages_count: messages.length,
    roles: messages.map((message) => message.role || "unknown"),
    system_count: system.length,
    tools_count: tools.length,
    tool_names: tools.map((tool) => tool?.name || tool?.function?.name || tool?.type || "unknown").slice(0, 30),
    tool_use_count: toolUses.length,
    tool_use_names: toolUses.map(({ part }) => part?.name || "unknown"),
    tool_result_count: toolResults.length,
    latest_user_length: userMessages.length ? contentText(userMessages.at(-1).content).length : 0,
    has_subagent_text: /subagent|Task|子代理|agent:builtin|Explore/i.test(bodyText),
    system_hash: hashJson(system),
    tools_hash: hashJson(tools),
    params_hash: hashJson(Object.fromEntries(Object.entries(body || {}).filter(([key]) => !["messages", "system", "tools"].includes(key)))),
    normalized_hash: hashJson(normalizeClaudeOtelRequestBody(body || {})),
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
    conversation_id: capture.conversation_id,
    path: capture.path,
    original_url: capture.original_url,
    status: capture.upstream_status || null,
    claude_session_id: requestHeader(capture, "x-claude-code-session-id"),
    raw_body_length: capture.raw_body_length,
    ...summarizeBody(capture.body),
  };
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

function countBy(items, keyFn) {
  return items.reduce((counts, item) => {
    const key = keyFn(item) || "";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function compareCaptureSummaries(captures) {
  const first = captures[0] || {};
  return {
    request_count: captures.length,
    unique_watch_ids: [...new Set(captures.map((item) => item.watch_id).filter(Boolean))],
    unique_conversation_ids: [...new Set(captures.map((item) => item.conversation_id).filter(Boolean))],
    unique_claude_session_ids: [...new Set(captures.map((item) => item.claude_session_id).filter(Boolean))],
    stable_model: captures.every((item) => item.model === first.model),
    stable_system_hash: captures.every((item) => item.system_hash === first.system_hash),
    stable_tools_hash: captures.every((item) => item.tools_hash === first.tools_hash),
    stable_params_hash: captures.every((item) => item.params_hash === first.params_hash),
    message_counts: captures.map((item) => item.messages_count),
    tool_use_counts: captures.map((item) => item.tool_use_count),
    tool_result_counts: captures.map((item) => item.tool_result_count),
    statuses: captures.map((item) => item.status),
  };
}

function writeEvidence({ proxy, proxyBaseUrl, turnResults, otelFiles, otelSummaries, captureSummaries, comparison, debugFile, debugApiSources }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(evidenceDir, "otel-raw-bodies"), { recursive: true });
  for (const file of otelFiles) fs.copyFileSync(file, path.join(evidenceDir, "otel-raw-bodies", path.basename(file)));
  if (fs.existsSync(debugFile)) fs.copyFileSync(debugFile, path.join(evidenceDir, "claude-debug.log"));
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        cwd: process.cwd(),
        session_id: sessionId,
        watch_id: watchId,
        original_base_url: originalBaseUrl,
        proxy_base_url: proxy.baseUrl,
        proxy_watch_base_url: proxyBaseUrl,
        prompts,
        note: "Claude Code first turn uses --session-id; later turns use --resume while ANTHROPIC_BASE_URL points at peekMyAgent proxy.",
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "turn-results.json"), `${JSON.stringify(turnResults, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(proxy.captures, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "capture-summaries.json"), `${JSON.stringify(captureSummaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "otel-summaries.json"), `${JSON.stringify(otelSummaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "debug-api-sources.json"), `${JSON.stringify(debugApiSources, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "stable-vs-changing.json"), `${JSON.stringify(comparison, null, 2)}\n`);
}

function writeReport({ turnResults, captureSummaries, otelSummaries, debugApiSources, comparison }) {
  const sourceCounts = countBy(debugApiSources, (item) => item.source);
  const agentSources = debugApiSources.filter((item) => item.source.startsWith("agent:"));
  const lines = [];
  lines.push("# Claude Code proxy resume smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：Claude Code 第一轮使用 `--session-id`，第 2/3 轮使用 `--resume`，同时把 `ANTHROPIC_BASE_URL` 指向 peekMyAgent proxy。报告只输出结构化摘要，不输出完整请求正文。");
  lines.push("");
  lines.push(`- session id：${sessionId}`);
  lines.push(`- watch id：${watchId}`);
  lines.push(`- upstream base URL：${originalBaseUrl}`);
  lines.push(`- turn exits：${turnResults.map((turn) => `${turn.turn_index}:${turn.code}`).join(", ")}`);
  lines.push(`- proxy captures：${captureSummaries.length}`);
  lines.push(`- otel requests：${otelSummaries.length}`);
  lines.push(`- unique watch_id：${comparison.unique_watch_ids.join(", ") || "none"}`);
  lines.push(`- unique conversation_id：${comparison.unique_conversation_ids.join(", ") || "none"}`);
  lines.push(`- unique x-claude-code-session-id：${comparison.unique_claude_session_ids.length}`);
  lines.push(`- debug API sources：${Object.entries(sourceCounts).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`);
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("## Proxy capture 摘要");
  lines.push("");
  lines.push("| index | status | watch_id | conv_id | claude_session | model | messages | system | tools | tool_use | tool_result | body_bytes | subagent_text |");
  lines.push("| ---: | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |");
  for (const item of captureSummaries) {
    lines.push(
      `| ${item.request_index} | ${item.status || ""} | ${item.watch_id || ""} | ${item.conversation_id || ""} | ${(item.claude_session_id || "").slice(0, 12)} | ${item.model || ""} | ${item.messages_count} | ${item.system_count} | ${item.tools_count} | ${item.tool_use_names.join(", ") || item.tool_use_count} | ${item.tool_result_count} | ${item.raw_body_length} | ${item.has_subagent_text} |`,
    );
  }
  lines.push("");
  lines.push("## OTel raw body 摘要");
  lines.push("");
  lines.push("| file_index | model | messages | system | tools | tool_use | tool_result | subagent_text | normalized_hash |");
  lines.push("| ---: | --- | ---: | ---: | ---: | --- | ---: | --- | --- |");
  for (const [index, item] of otelSummaries.entries()) {
    lines.push(
      `| ${index + 1} | ${item.model || ""} | ${item.messages_count} | ${item.system_count} | ${item.tools_count} | ${item.tool_use_names.join(", ") || item.tool_use_count} | ${item.tool_result_count} | ${item.has_subagent_text} | ${item.normalized_hash.slice(0, 12)} |`,
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
  lines.push("## 稳定性对比");
  lines.push("");
  lines.push("| 对比项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(comparison)) lines.push(`| ${key} | ${Array.isArray(value) ? value.join(" / ") : value} |`);
  lines.push("");
  lines.push("## 产品判读");
  lines.push("");
  if (comparison.unique_watch_ids.length === 1 && comparison.unique_watch_ids[0] === watchId) {
    lines.push("- `watch_id` 在 Claude Code proxy resume 场景下稳定，可作为 UI 捕获归属的硬分组键。");
  } else {
    lines.push("- `watch_id` 未完全稳定，UI 不能只依赖自动归属，需要暴露异常和未归属请求。");
  }
  if (comparison.unique_claude_session_ids.length === 1) {
    lines.push("- `x-claude-code-session-id` 跨 `--session-id` / `--resume` 稳定，可作为 Claude 原生 `conversation_id` 的强候选。");
  } else {
    lines.push("- `x-claude-code-session-id` 不唯一，UI 需要把 Claude 原生 session 与 peekMyAgent watch 分开显示。");
  }
  if (agentSources.length) {
    lines.push("- debug source 中出现 `agent:*`，可用于把独立子代理请求标记为子代理事件；父子精确折叠仍需要结合主请求里的 tool_use。");
  } else {
    lines.push("- debug source 中未出现 `agent:*`，本次无法证明 resume 场景触发了独立子代理请求。");
  }
  lines.push("- 中间时间线应默认展示用户轮次、请求数量、工具调用和子代理标记；完整 system/tools/history 继续放到右侧 Raw 证据区。");
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-proxy-resume-"));
  const bodyDir = path.join(tmpRoot, "raw-bodies");
  const debugFile = path.join(tmpRoot, "claude-debug.log");
  fs.mkdirSync(bodyDir, { recursive: true });

  const proxy = await startCaptureProxy({
    targetBaseUrl: originalBaseUrl,
    preserveTargetPathPrefix: true,
    defaultAttribution: {
      watchId,
      agentProfile: "Claude Code",
      workspace: process.cwd(),
      conversationId: sessionId,
    },
  });

  const proxyBaseUrl = proxy.urlForWatch(watchId);
  const turnResults = [];
  for (const [index, prompt] of prompts.entries()) {
    const result = await runClaude({ prompt, turnIndex: index, bodyDir, debugFile, proxyBaseUrl });
    turnResults.push(result);
    await sleep(1200);
  }
  await proxy.close();

  const otelFiles = listFiles(bodyDir).filter((file) => file.endsWith(".request.json"));
  const otelSummaries = otelFiles.map((file) => summarizeBody(readJson(file)));
  const captureSummaries = proxy.captures.map((capture) => summarizeCapture(capture));
  const debugApiSources = parseDebugApiSources(debugFile);
  const comparison = compareCaptureSummaries(captureSummaries);
  writeEvidence({ proxy, proxyBaseUrl, turnResults, otelFiles, otelSummaries, captureSummaries, comparison, debugFile, debugApiSources });
  writeReport({ turnResults, captureSummaries, otelSummaries, debugApiSources, comparison });
  if (process.env.PEEK_KEEP_RAW !== "1") fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Wrote ${reportPath}`);
  console.log({
    sessionId,
    watchId,
    turnExits: turnResults.map((turn) => turn.code),
    proxyCaptures: proxy.captures.length,
    otelRequests: otelFiles.length,
    uniqueClaudeSessionIds: comparison.unique_claude_session_ids.length,
    debugSources: countBy(debugApiSources, (item) => item.source),
    evidenceDir,
  });
  if (turnResults.some((turn) => turn.code !== 0) || proxy.captures.length === 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
