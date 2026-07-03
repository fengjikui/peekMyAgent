import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { readBody, startCaptureProxy } from "../src/core/capture-proxy.mjs";
import { redactHeaders } from "../src/core/redaction.mjs";
import { removeOpenClawProfileDir } from "./lib/openclaw-profile-cleanup.mjs";

const profile = `peeksmoke-${Date.now()}`;
const reportPath =
  process.env.PEEK_OPENCLAW_PROXY_INTEGRATION_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "openclaw-proxy-integration-smoke", "openclaw-proxy-integration-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const prompt = "say only ok";
const sessionKey = "agent:main:peek-smoke";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

async function startOpenAICompatibleMock() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {}
    seen.push({
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers).headers,
      body,
    });
    if (req.url.includes("/responses")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_mock", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl_mock", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  const address = await listen(server);
  return { server, seen, baseUrl: `http://${address.address}:${address.port}` };
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
    gateway: { mode: "local", port: 18789, auth: { mode: "none" } },
    agents: {
      defaults: {
        model: { primary: "peek/peek-test" },
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

function evaluate(captures, upstream) {
  const first = captures.find((capture) => capture.body);
  const body = first?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];
  return {
    proxyHit: captures.length > 0,
    upstreamHit: upstream.seen.length > 0,
    hasRequestBody: Boolean(first?.body),
    path: first?.path || "none",
    originalUrl: first?.original_url || "none",
    hasWatchId: first?.watch_id === "openclaw-smoke",
    hasCaptureId: typeof first?.capture_id === "string",
    hasConversationId: first?.conversation_id === "agent:main:peek-smoke",
    hasModel: typeof body.model === "string",
    hasMessagesOrInput: messages.length > 0 || input.length > 0,
    hasUserRole: messages.some((message) => message.role === "user") || JSON.stringify(input).includes("user"),
    hasTools: Array.isArray(body.tools),
    captureConfidence: captures.length > 0 && first?.body ? "exact" : "failed",
  };
}

function renderReport({ upstream, proxy, patchResult, agentResult, evaluation }) {
  const lines = [];
  lines.push("# OpenClaw proxy integration smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用隔离 OpenClaw profile，不修改用户主配置。报告不输出真实 prompt 正文。");
  lines.push("");
  lines.push(`- profile：${profile}`);
  lines.push(`- proxy baseUrl：${proxy.baseUrl}`);
  lines.push(`- provider mock baseUrl：${upstream.baseUrl}`);
  lines.push(`- config patch exit：${patchResult.code}`);
  lines.push(`- agent exit：${agentResult.code}`);
  lines.push(`- proxy captures：${proxy.captures.length}`);
  lines.push(`- upstream receives：${upstream.seen.length}`);
  lines.push("");
  lines.push("| 检查项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(evaluation)) lines.push(`| ${key} | ${value} |`);
  lines.push("");
  if (!proxy.captures.length) {
    lines.push("未命中代理。可能原因：OpenClaw isolated profile 配置 schema 不匹配、agent --local 未使用该 provider、需要 gateway 模式，或 provider 配置字段变化。");
    lines.push("");
  }
  lines.push("建议：只有当 OpenClaw provider baseUrl 实际命中 peekMyAgent proxy 时，才能标记 `capture_confidence=exact`。");
  lines.push("");
  lines.push("<details><summary>命令输出摘要</summary>");
  lines.push("");
  lines.push("```text");
  lines.push(`config stderr:\n${patchResult.stderr.split("\n").slice(0, 20).join("\n")}`);
  lines.push(`agent stderr:\n${agentResult.stderr.split("\n").slice(0, 30).join("\n")}`);
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const upstream = await startOpenAICompatibleMock();
  const proxy = await startCaptureProxy({
    targetBaseUrl: upstream.baseUrl,
    defaultAttribution: {
      watchId: "openclaw-smoke",
      agentProfile: "OpenClaw main",
      workspace: process.cwd(),
      conversationId: "agent:main:peek-smoke",
    },
  });
  const patchResult = await run("openclaw", ["--profile", profile, "config", "patch", "--stdin"], {
    stdin: configPatch(`${proxy.urlForWatch("openclaw-smoke")}/v1`),
  });
  const agentResult = await run("openclaw", [
    "--profile",
    profile,
    "agent",
    "--local",
    "--agent",
    "main",
    "--session-key",
    sessionKey,
    "--message",
    prompt,
    "--model",
    "peek/peek-test",
    "--json",
  ], {
    timeoutMs: 120_000,
  });
  const evaluation = evaluate(proxy.captures, upstream);
  writeEvidence({ upstream, proxy, patchResult, agentResult, evaluation });
  fs.writeFileSync(reportPath, renderReport({ upstream, proxy, patchResult, agentResult, evaluation }));
  proxy.server.close();
  upstream.server.close();
  removeOpenClawProfileDir(profile);
  console.log(`Wrote ${reportPath}`);
  console.log(evaluation);
  if (!evaluation.proxyHit) process.exitCode = 1;
}

function writeEvidence({ upstream, proxy, patchResult, agentResult, evaluation }) {
  if (process.env.PEEK_WRITE_EVIDENCE !== "1") return;
  const evidenceDir = process.env.PEEK_EVIDENCE_DIR || path.join(process.cwd(), "tmp", "smoke-evidence", "openclaw-proxy", "latest");
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const normalized = proxy.captures.map((capture) => normalizeOpenClawProxyCapture(capture));
  const command = {
    generated_at: new Date().toISOString(),
    cwd: process.cwd(),
    profile,
    session_key: sessionKey,
    agent: "main",
    model: "peek/peek-test",
    prompt,
    proxy_base_url: proxy.baseUrl,
    provider_mock_base_url: upstream.baseUrl,
    configured_provider_base_url: `${proxy.urlForWatch("openclaw-smoke")}/v1`,
    openclaw_args: [
      "--profile",
      profile,
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-key",
      sessionKey,
      "--message",
      prompt,
      "--model",
      "peek/peek-test",
      "--json",
    ],
    note: "这是隔离 OpenClaw profile 的 smoke test 证据包，provider 是本地 mock，不是真实远程模型。",
  };

  fs.writeFileSync(path.join(evidenceDir, "command.json"), `${JSON.stringify(command, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(proxy.captures, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "upstream-seen.json"), `${JSON.stringify(upstream.seen, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "normalized.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "openclaw-stdout.txt"), agentResult.stdout);
  fs.writeFileSync(path.join(evidenceDir, "openclaw-stderr.txt"), agentResult.stderr);
  fs.writeFileSync(path.join(evidenceDir, "config-stderr.txt"), patchResult.stderr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
