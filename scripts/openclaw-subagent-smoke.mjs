import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { listen, readBody, startCaptureProxy } from "../src/core/capture-proxy.mjs";
import { redactHeaders } from "../src/core/redaction.mjs";
import { removeOpenClawProfileDir } from "./lib/openclaw-profile-cleanup.mjs";

const profile = `peeksub-${Date.now()}`;
const watchId = "openclaw-subagent";
const sessionKey = "agent:main:peek-subagent";
const model = "peek/peek-test";
const gatewayPort = 28791;
const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "openclaw-subagent", "latest");
const reportPath =
  process.env.PEEK_OPENCLAW_SUBAGENT_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "openclaw-subagent-smoke", "openclaw-subagent-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const prompt =
  "这是 peekMyAgent OpenClaw 子代理捕获测试。请启动两个子代理，一个读取 package.json，一个读取 docs/user-guide.md 的开头，然后汇总它们的结果。";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 180_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal || null, stdout, stderr });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function startBackground(command, args) {
  const env = { ...process.env };
  for (const key of [
    "LAUNCH_JOB_LABEL",
    "LAUNCH_JOB_NAME",
    "XPC_SERVICE_NAME",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
    "INVOCATION_ID",
    "SYSTEMD_EXEC_PID",
    "JOURNAL_STREAM",
    "OPENCLAW_WINDOWS_TASK_NAME",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
  ]) {
    delete env[key];
  }
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = {
    command,
    args,
    stdout: "",
    stderr: "",
    exit_code: null,
    signal: null,
  };
  child.stdout.on("data", (chunk) => (result.stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (result.stderr += chunk.toString()));
  child.on("close", (code, signal) => {
    result.exit_code = code;
    result.signal = signal || null;
  });
  return { child, result };
}

async function stopBackground(background) {
  if (!background) return null;
  if (background.child.exitCode !== null || background.child.signalCode) return background.result;
  background.child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (background.child.exitCode === null) background.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    background.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return background.result;
}

async function waitForGateway() {
  const attempts = [];
  for (let i = 0; i < 20; i += 1) {
    const result = await run("openclaw", ["--profile", profile, "health"], { timeoutMs: 10_000 });
    attempts.push({ attempt: i + 1, code: result.code, stdout: result.stdout.slice(0, 500), stderr: result.stderr.slice(0, 500) });
    if (result.code === 0) return { ready: true, attempts };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ready: false, attempts };
}

async function startOpenAICompatibleMock() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {}
    const requestIndex = seen.length;
    const summary = summarizeBody(body, requestIndex);
    seen.push({
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers).headers,
      body,
      summary,
    });
    const response = mockChatCompletion(body, summary, requestIndex);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  const address = await listen(server);
  return { server, seen, baseUrl: `http://${address.address}:${address.port}` };
}

function mockChatCompletion(body, summary, requestIndex) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1] || {};
  const toolResultText = last.role === "tool" ? extractText(last.content) : "";
  const latestUserText = summary.latest_user_text;
  const availableTools = new Set((body?.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean));

  if (isSubagentRequest(summary)) {
    const target = /user-guide/.test(latestUserText) ? "docs/user-guide.md" : "package.json";
    return chatResponse(requestIndex, {
      role: "assistant",
      content: `子代理完成：我看到了 ${target}，这是 OpenClaw 子代理自己的模型请求。`,
    });
  }

  if (last.role === "tool") {
    if (/sessions_spawn|spawn|subagent|子代理|agent:/.test(toolResultText)) {
      if (availableTools.has("sessions_yield")) {
        return toolCallResponse(requestIndex, "sessions_yield", {
          message: "我已经启动子代理，等待它们完成后再汇总。",
        });
      }
      return chatResponse(requestIndex, {
        role: "assistant",
        content: "已收到子代理启动结果，但当前工具列表里没有 sessions_yield。",
      });
    }
    return chatResponse(requestIndex, {
      role: "assistant",
      content: `已收到工具结果。当前请求 messages=${messages.length}，我将结束本轮。`,
    });
  }

  if (availableTools.has("sessions_spawn") && /子代理|subagent/.test(latestUserText)) {
    return chatResponse(
      requestIndex,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_spawn_pkg",
            type: "function",
            function: {
              name: "sessions_spawn",
              arguments: JSON.stringify({
                task: "读取 package.json，只用一句话说明 scripts 里是否有 smoke 测试。",
                taskName: "pkg_reader",
                label: "package reader",
                runtime: "subagent",
                mode: "run",
                context: "isolated",
                cleanup: "keep",
              }),
            },
          },
          {
            id: "call_spawn_ux",
            type: "function",
            function: {
              name: "sessions_spawn",
              arguments: JSON.stringify({
                task: "读取 docs/user-guide.md 的开头，只用一句话说明 dashboard 展示原则。",
                taskName: "ux_reader",
                label: "ux reader",
                runtime: "subagent",
                mode: "run",
                context: "isolated",
                cleanup: "keep",
              }),
            },
          },
        ],
      },
      "tool_calls",
    );
  }

  return chatResponse(requestIndex, {
    role: "assistant",
    content: `没有触发子代理。当前工具列表包含 ${availableTools.size} 个工具。`,
  });
}

function chatResponse(requestIndex, message, finishReason = "stop") {
  return {
    id: `chatcmpl_openclaw_subagent_${requestIndex + 1}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
}

function toolCallResponse(requestIndex, name, args) {
  return chatResponse(
    requestIndex,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${name}_${requestIndex + 1}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || JSON.stringify(part)).join("\n");
  if (content && typeof content === "object") return content.text || JSON.stringify(content);
  return "";
}

function summarizeBody(body, requestIndex) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolMessages = messages.filter((message) => message.role === "tool");
  const latestUserText = extractText(userMessages.at(-1)?.content);
  return {
    request_index: requestIndex + 1,
    model: body?.model || null,
    message_count: messages.length,
    roles: messages.map((message) => message.role || "unknown"),
    latest_user_text: latestUserText.slice(0, 800),
    tools_count: tools.length,
    tool_names: tools.map((tool) => tool.function?.name || tool.name || tool.type).filter(Boolean),
    assistant_tool_call_names: assistantMessages.flatMap((message) =>
      Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call.function?.name || call.name || "unknown") : [],
    ),
    tool_message_count: toolMessages.length,
    looks_like_subagent: isSubagentRequest({ latest_user_text: latestUserText }),
  };
}

function isSubagentRequest(summary) {
  return (
    /\[Subagent Task\]/i.test(summary.latest_user_text) ||
    /读取 package\.json，只用一句话/.test(summary.latest_user_text) ||
    /读取 docs\/product-ux-decisions\.md 的开头，只用一句话/.test(summary.latest_user_text)
  );
}

function configPatch(baseUrl) {
  return JSON.stringify({
    gateway: { mode: "local", port: gatewayPort, auth: { mode: "none" } },
    agents: { defaults: { model: { primary: model } } },
    models: {
      mode: "merge",
      providers: {
        peek: {
          baseUrl,
          apiKey: "dummy",
          api: "openai-completions",
          models: [{ id: "peek-test", name: "Peek Test", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    },
  });
}

function writeEvidence({ upstream, proxy, patchResult, gatewayStart, gatewayReady, agentResult }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        cwd: process.cwd(),
        profile,
        session_key: sessionKey,
        model,
        watch_id: watchId,
        prompt,
        configured_provider_base_url: `${proxy.urlForWatch(watchId)}/v1`,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "agent-result.json"), `${JSON.stringify(agentResult, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "gateway-start.json"), `${JSON.stringify(gatewayStart, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "gateway-ready.json"), `${JSON.stringify(gatewayReady, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(proxy.captures, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "upstream-seen.json"), `${JSON.stringify(upstream.seen, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "capture-summaries.json"), `${JSON.stringify(proxy.captures.map((capture) => summarizeBody(capture.body, capture.request_index - 1)), null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "config-stderr.txt"), patchResult.stderr);
}

function writeReport({ upstream, proxy, patchResult, gatewayStart, gatewayReady, agentResult }) {
  const summaries = proxy.captures.map((capture) => summarizeBody(capture.body, capture.request_index - 1));
  const toolNames = summaries[0]?.tool_names || [];
  const lines = [];
  lines.push("# OpenClaw 子代理捕获 smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用隔离 OpenClaw profile，把 provider 指向 peekMyAgent 本地 capture proxy，再由 mock provider 主动返回 `sessions_spawn` 工具调用。目标是确认 OpenClaw 的子代理是否会产生可捕获的独立模型请求。");
  lines.push("");
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push(`- profile：${profile}`);
  lines.push(`- session key：${sessionKey}`);
  lines.push(`- watch id：${watchId}`);
  lines.push(`- config patch exit：${patchResult.code}`);
  lines.push(`- gateway ready：${gatewayReady.ready}`);
  lines.push(`- gateway exit after stop：${gatewayStart.exit_code ?? "running/unset"}${gatewayStart.signal ? ` (${gatewayStart.signal})` : ""}`);
  lines.push(`- OpenClaw agent exit：${agentResult.code}`);
  lines.push(`- proxy captures：${proxy.captures.length}`);
  lines.push(`- upstream receives：${upstream.seen.length}`);
  lines.push(`- exposed subagent tools：${toolNames.filter((name) => /subagent|sessions_(spawn|send|yield|list|history)/i.test(name)).join(", ") || "none"}`);
  lines.push("");
  lines.push("| request | messages | roles | tools | assistant_tool_calls | tool_msgs | looks_like_subagent | latest_user_excerpt |");
  lines.push("| ---: | ---: | --- | ---: | --- | ---: | --- | --- |");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.request_index} | ${summary.message_count} | ${summary.roles.join(" -> ")} | ${summary.tools_count} | ${summary.assistant_tool_call_names.join(",") || "none"} | ${summary.tool_message_count} | ${summary.looks_like_subagent} | ${summary.latest_user_text.replaceAll("\n", " ").slice(0, 90)} |`,
    );
  }
  lines.push("");
  lines.push("结论：如果表格中出现 `sessions_spawn` 后又出现 `looks_like_subagent=true` 的请求，说明 OpenClaw 与 Claude Code 类似，子代理工作也会以独立模型请求进入同一条 provider/capture 链路。完整请求体见 evidence dir。");
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const upstream = await startOpenAICompatibleMock();
  const proxy = await startCaptureProxy({
    targetBaseUrl: upstream.baseUrl,
    defaultAttribution: {
      watchId,
      agentProfile: "OpenClaw main/subagents",
      workspace: process.cwd(),
      conversationId: sessionKey,
    },
  });

  let gateway = null;
  let gatewayReady = { ready: false, attempts: [] };
  let agentResult = { code: null, signal: null, stdout: "", stderr: "not run" };
  try {
    const patchResult = await run("openclaw", ["--profile", profile, "config", "patch", "--stdin"], {
      stdin: configPatch(`${proxy.urlForWatch(watchId)}/v1`),
    });

    gateway = startBackground("openclaw", ["--profile", profile, "gateway", "--port", String(gatewayPort), "--force", "--auth", "none"]);
    gatewayReady = await waitForGateway();

    agentResult = await run("openclaw", [
      "--profile",
      profile,
      "agent",
      "--agent",
      "main",
      "--session-key",
      sessionKey,
      "--message",
      prompt,
      "--model",
      model,
      "--json",
    ]);

    const gatewayStart = await stopBackground(gateway);
    writeEvidence({ upstream, proxy, patchResult, gatewayStart, gatewayReady, agentResult });
    writeReport({ upstream, proxy, patchResult, gatewayStart, gatewayReady, agentResult });

    const summaries = proxy.captures.map((capture) => summarizeBody(capture.body, capture.request_index - 1));
    console.log(`Wrote ${reportPath}`);
    console.log({ captures: proxy.captures.length, upstreamReceives: upstream.seen.length, gatewayReady: gatewayReady.ready, agentExit: agentResult.code, evidenceDir, summaries });
    if (patchResult.code !== 0 || !gatewayReady.ready || agentResult.code !== 0 || proxy.captures.length < 3) process.exitCode = 1;
  } finally {
    await stopBackground(gateway);
    await proxy.close();
    upstream.server.close();
    removeOpenClawProfileDir(profile);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
