import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { listen, readBody, startCaptureProxy } from "../src/core/capture-proxy.mjs";
import { redactHeaders } from "../src/core/redaction.mjs";
import { removeOpenClawProfileDir } from "./lib/openclaw-profile-cleanup.mjs";

const profile = `peekmulti-${Date.now()}`;
const watchId = "openclaw-multiturn";
const sessionKey = "agent:main:peek-multiturn";
const model = "peek/peek-test";
const reportPath =
  process.env.PEEK_OPENCLAW_MULTITURN_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "openclaw-multiturn-smoke", "openclaw-multiturn-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "openclaw-multiturn", "latest");
const initialPrompt =
  "我们做一个 peekMyAgent 多轮捕获测试。请先读取 package.json，确认这个项目有哪些 smoke 脚本，然后用一句话告诉我你看到了什么。";

async function startOpenAICompatibleMock() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {}
    const requestIndex = seen.length;
    seen.push({
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers).headers,
      body,
    });
    const response = mockChatCompletion(body, requestIndex);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  const address = await listen(server);
  return { server, seen, baseUrl: `http://${address.address}:${address.port}` };
}

function mockChatCompletion(body, requestIndex) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1] || {};
  const userMessages = messages.filter((message) => message.role === "user");
  const latestUserText = extractText(userMessages[userMessages.length - 1]?.content);

  if (last.role === "tool") {
    return chatResponse(requestIndex, {
      role: "assistant",
      content: `我已经读取了工具结果。当前请求里一共有 ${messages.length} 条 messages；这说明 OpenClaw 已把工具结果带回模型请求。`,
    });
  }

  if (/第三轮|最后一轮|固定内容和变化内容/.test(latestUserText)) {
    return toolCallResponse(requestIndex, "exec", {
      command:
        "mkdir -p tmp/openclaw-multiturn-tool && printf 'created by OpenClaw multiturn smoke\\n' > tmp/openclaw-multiturn-tool/created-by-openclaw.txt && cat tmp/openclaw-multiturn-tool/created-by-openclaw.txt",
      workdir: process.cwd(),
      timeout: 10,
    });
  }

  if (/package\.json|smoke 脚本/.test(latestUserText)) {
    return toolCallResponse(requestIndex, "read", { path: "package.json" });
  }

  if (/user-guide|用户指南/.test(latestUserText)) {
    return toolCallResponse(requestIndex, "read", { path: "docs/user-guide.md", offset: 1, limit: 80 });
  }

  return chatResponse(requestIndex, {
    role: "assistant",
    content: `最终总结：我收到了多轮上下文。当前请求 messages=${messages.length}，tools=${Array.isArray(body?.tools) ? body.tools.length : 0}。`,
  });
}

function toolCallResponse(requestIndex, name, args) {
  return chatResponse(
    requestIndex,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_multiturn_${requestIndex + 1}`,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        },
      ],
    },
    "tool_calls",
  );
}

function chatResponse(requestIndex, message, finishReason = "stop") {
  return {
    id: `chatcmpl_multiturn_${requestIndex + 1}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").join("\n");
  if (content && typeof content === "object") return content.text || JSON.stringify(content);
  return "";
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function configPatch(baseUrl) {
  return JSON.stringify({
    gateway: { mode: "local", port: 18790, auth: { mode: "none" } },
    agents: {
      defaults: {
        model: { primary: model },
      },
    },
    models: {
      mode: "merge",
      providers: {
        peek: {
          baseUrl,
          apiKey: "dummy",
          api: "openai-completions",
          models: [
            {
              id: "peek-test",
              name: "Peek Test",
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  });
}

async function runTurn(turn, index) {
  const result = await run("openclaw", [
    "--profile",
    profile,
    "agent",
    "--local",
    "--agent",
    "main",
    "--session-key",
    sessionKey,
    "--message",
    turn.prompt,
    "--model",
    model,
    "--json",
  ]);
  return {
    turn_index: index + 1,
    label: turn.label,
    prompt: turn.prompt,
    exit_code: result.code,
    signal: result.signal || null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildNextPrompt(previousTurn, newCaptures, index) {
  const text = extractOpenClawText(previousTurn.stdout).slice(0, 500);
  const latestSummary = newCaptures.map(captureSummary).at(-1);
  if (index === 1) {
    return [
      "这是第二轮，请基于你刚才的实际回复继续。",
      `你上一轮回复摘要：${text || "(没有解析到文本)"}`,
      `我这边看到上一轮最后一次请求 messages=${latestSummary?.message_count ?? "unknown"}，tools=${latestSummary?.tools_count ?? "unknown"}。`,
      "请继续读取 docs/user-guide.md 的前 80 行，然后告诉我这次请求和上一轮可能有哪些值得比较的地方。",
    ].join("\n");
  }
  return [
    "这是第三轮，也是最后一轮。请基于前两轮的上下文总结：",
    "1. 你是否还记得第一轮读取 package.json 的目的？",
    "2. 你是否还记得第二轮读取用户指南的目的？",
    "3. 请执行一个很小的命令，创建 tmp/openclaw-multiturn-tool/created-by-openclaw.txt，然后用两句话说明多轮捕获工具应该如何展示固定内容和变化内容。",
  ].join("\n");
}

function extractOpenClawText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.text || parsed.message || parsed.content || JSON.stringify(parsed).slice(0, 500);
  } catch {
    return trimmed.split("\n").slice(-5).join("\n");
  }
}

function annotateCaptures(captures, beforeCount, turnIndex) {
  for (const capture of captures.slice(beforeCount)) {
    capture.turn_index = turnIndex;
  }
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function contentLength(message) {
  if (typeof message?.content === "string") return message.content.length;
  return JSON.stringify(message?.content ?? null).length;
}

function captureSummary(capture) {
  const body = capture.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessages = messages.filter((message) => message.role === "system");
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolMessages = messages.filter((message) => message.role === "tool");
  return {
    turn_index: capture.turn_index,
    request_index: capture.request_index,
    capture_id: capture.capture_id,
    watch_id: capture.watch_id,
    conversation_id: capture.conversation_id,
    path: capture.path,
    model: body.model || null,
    message_count: messages.length,
    roles: messages.map((message) => message.role || "unknown"),
    system_count: systemMessages.length,
    user_count: userMessages.length,
    assistant_count: assistantMessages.length,
    tool_count: toolMessages.length,
    latest_user_length: userMessages.length ? contentLength(userMessages[userMessages.length - 1]) : 0,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    assistant_tool_call_count: assistantMessages.reduce((sum, message) => sum + (Array.isArray(message.tool_calls) ? message.tool_calls.length : 0), 0),
    assistant_tool_call_names: assistantMessages.flatMap((message) =>
      Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call.function?.name || call.name || "unknown") : [],
    ),
    system_hash: hashJson(systemMessages),
    tools_hash: hashJson(body.tools || []),
    params_hash: hashJson(Object.fromEntries(Object.entries(body).filter(([key]) => !["messages", "tools"].includes(key)))),
  };
}

function compareSummaries(summaries) {
  const first = summaries[0] || {};
  return {
    request_count: summaries.length,
    stable_model: summaries.every((summary) => summary.model === first.model),
    stable_path: summaries.every((summary) => summary.path === first.path),
    stable_system_hash: summaries.every((summary) => summary.system_hash === first.system_hash),
    stable_tools_hash: summaries.every((summary) => summary.tools_hash === first.tools_hash),
    stable_params_hash: summaries.every((summary) => summary.params_hash === first.params_hash),
    message_counts: summaries.map((summary) => summary.message_count),
    tools_counts: summaries.map((summary) => summary.tools_count),
    system_counts: summaries.map((summary) => summary.system_count),
    latest_user_lengths: summaries.map((summary) => summary.latest_user_length),
    tool_message_counts: summaries.map((summary) => summary.tool_count),
    assistant_tool_call_counts: summaries.map((summary) => summary.assistant_tool_call_count),
    assistant_tool_call_names: summaries.map((summary) => summary.assistant_tool_call_names.join(",") || "none"),
    role_sequences: summaries.map((summary) => summary.roles.join(" -> ")),
  };
}

function renderReport({ upstream, proxy, patchResult, turnResults, summaries, comparison }) {
  const lines = [];
  lines.push("# OpenClaw 多轮会话捕获 smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用隔离 OpenClaw profile 与同一个 session key 连续发送 3 轮消息；第 2、3 轮 prompt 会根据上一轮 OpenClaw 实际 stdout 和捕获摘要生成。mock provider 会返回真实 tool_calls，让 OpenClaw 执行工具并把 tool result 带回模型请求。报告只展示结构摘要、长度和 hash，不直接输出完整 prompt/system/tools。");
  lines.push("");
  lines.push(`- profile：${profile}`);
  lines.push(`- session key：${sessionKey}`);
  lines.push(`- watch id：${watchId}`);
  lines.push(`- proxy baseUrl：${proxy.baseUrl}`);
  lines.push(`- provider mock baseUrl：${upstream.baseUrl}`);
  lines.push(`- config patch exit：${patchResult.code}`);
  lines.push(`- agent turn exits：${turnResults.map((turn) => turn.exit_code).join(", ")}`);
  lines.push(`- proxy captures：${proxy.captures.length}`);
  lines.push(`- upstream receives：${upstream.seen.length}`);
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("| turn | request_index | messages | roles | system | exposed_tools | tool_msgs | tool_calls | tool_call_names | latest_user_len | system_hash | tools_hash |");
  lines.push("| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.turn_index} | ${summary.request_index} | ${summary.message_count} | ${summary.roles.join(" -> ")} | ${summary.system_count} | ${summary.tools_count} | ${summary.tool_count} | ${summary.assistant_tool_call_count} | ${summary.assistant_tool_call_names.join(",") || "none"} | ${summary.latest_user_length} | ${summary.system_hash.slice(0, 12)} | ${summary.tools_hash.slice(0, 12)} |`,
    );
  }
  lines.push("");
  lines.push("| 对比项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(comparison)) {
    lines.push(`| ${key} | ${Array.isArray(value) ? value.join(" / ") : value} |`);
  }
  lines.push("");
  lines.push("初步结论：看 `stable_system_hash` 和 `stable_tools_hash` 可以判断 system/tool 是否跨轮稳定；看 `message_counts`、`role_sequences`、`tool_message_counts` 可以判断 OpenClaw 是否把历史对话和工具结果继续带入后续请求。完整内容见 evidence dir。");
  lines.push("");
  return lines.join("\n");
}

function writeEvidence({ upstream, proxy, patchResult, turnResults, normalized, summaries, comparison }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const command = {
    generated_at: new Date().toISOString(),
    cwd: process.cwd(),
    profile,
    session_key: sessionKey,
    agent: "main",
    model,
    watch_id: watchId,
    configured_provider_base_url: `${proxy.urlForWatch(watchId)}/v1`,
    initial_prompt: initialPrompt,
    prompts: turnResults.map(({ label, prompt }) => ({ label, prompt })),
    note: "这是 OpenClaw 自适应多轮 smoke test 证据包。provider 是本地 mock；同一个 session-key 连续发送 3 轮；第 2、3 轮 prompt 基于上一轮真实 stdout 和捕获摘要生成。",
  };
  fs.writeFileSync(path.join(evidenceDir, "command.json"), `${JSON.stringify(command, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "turn-results.json"), `${JSON.stringify(turnResults, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(proxy.captures, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "upstream-seen.json"), `${JSON.stringify(upstream.seen, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "normalized.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "request-summaries.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "stable-vs-changing.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "config-stderr.txt"), patchResult.stderr);
}

async function main() {
  const upstream = await startOpenAICompatibleMock();
  const proxy = await startCaptureProxy({
    targetBaseUrl: upstream.baseUrl,
    defaultAttribution: {
      watchId,
      agentProfile: "OpenClaw main",
      workspace: process.cwd(),
      conversationId: sessionKey,
    },
  });

  const patchResult = await run("openclaw", ["--profile", profile, "config", "patch", "--stdin"], {
    stdin: configPatch(`${proxy.urlForWatch(watchId)}/v1`),
  });

  const turnResults = [];
  let currentTurn = { label: "turn-1", prompt: initialPrompt };
  for (let index = 0; index < 3; index += 1) {
    const beforeCount = proxy.captures.length;
    currentTurn.label = `turn-${index + 1}`;
    const result = await runTurn(currentTurn, index);
    turnResults.push(result);
    annotateCaptures(proxy.captures, beforeCount, index + 1);
    const newCaptures = proxy.captures.slice(beforeCount);
    if (index < 2) {
      currentTurn = { label: `turn-${index + 2}`, prompt: buildNextPrompt(result, newCaptures, index + 1) };
    }
  }

  const normalized = proxy.captures.map((capture) => normalizeOpenClawProxyCapture(capture));
  const summaries = proxy.captures.map(captureSummary);
  const comparison = compareSummaries(summaries);
  writeEvidence({ upstream, proxy, patchResult, turnResults, normalized, summaries, comparison });
  fs.writeFileSync(reportPath, renderReport({ upstream, proxy, patchResult, turnResults, summaries, comparison }));

  proxy.server.close();
  upstream.server.close();
  removeOpenClawProfileDir(profile);

  console.log(`Wrote ${reportPath}`);
  console.log({
    captures: proxy.captures.length,
    upstreamReceives: upstream.seen.length,
    turnExits: turnResults.map((turn) => turn.exit_code),
    comparison,
    evidenceDir,
  });
  if (patchResult.code !== 0 || turnResults.some((turn) => turn.exit_code !== 0) || proxy.captures.length < 3) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
