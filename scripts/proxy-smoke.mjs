import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { listen, readBody, startCaptureProxy } from "../src/core/capture-proxy.mjs";

const mode = process.argv[2] || "openai";
const REPORT_PATH =
  process.env.PEEKMYAGENT_PROXY_SMOKE_REPORT_PATH ||
  path.join(process.cwd(), "tmp", "proxy-smoke", `proxy-smoke-${mode}-report.md`);

async function startUpstream() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, {
      "content-type": "application/json",
      connection: "keep-alive, x-hop-secret",
      "x-hop-secret": "should-not-reach-agent",
      "x-peek-debug": "internal-response-header",
      "set-cookie": "provider_session=secret",
      "x-api-key": "response-secret",
    });
    if (mode === "anthropic") {
      res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }));
    } else {
      res.end(JSON.stringify({ id: "chatcmpl_mock", choices: [{ message: { role: "assistant", content: "ok" } }] }));
    }
  });
  const address = await listen(server);
  return { server, seen, baseUrl: `http://${address.address}:${address.port}` };
}

async function startProxy(targetBaseUrl) {
  return startCaptureProxy({
    targetBaseUrl,
    defaultAttribution: {
      watchId: `${mode}-smoke`,
      agentProfile: mode === "anthropic" ? "Claude-compatible smoke" : "OpenAI-compatible smoke",
      workspace: process.cwd(),
      conversationId: "proxy-smoke",
    },
  });
}

async function postJson(url, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      async (res) => {
        const text = await readBody(res);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: text });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function samplePayload() {
  if (mode === "anthropic") {
    return {
      model: "claude-smoke-test",
      max_tokens: 128,
      system: "You are a smoke test system prompt.",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file content" }] },
      ],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    };
  }
  return {
    model: "gpt-smoke-test",
    messages: [
      { role: "system", content: "You are a smoke test system prompt." },
      { role: "user", content: "hello" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  };
}

function evaluate(capture, upstream, response) {
  const body = capture.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const anthropicSystem = typeof body.system === "string" || Array.isArray(body.system);
  const roles = new Set(messages.map((message) => message.role).filter(Boolean));
  const hasTool =
    Array.isArray(body.tools) ||
    messages.some((message) => message.tool_calls || JSON.stringify(message).includes("tool_use") || JSON.stringify(message).includes("tool_result"));
  const upstreamHeaders = upstream.seen[0]?.headers || {};
  const downstreamHeaders = response.headers || {};
  const capturedResponseHeaders = capture.response?.headers || {};
  return {
    hasRequestBody: Boolean(capture.body),
    hasModel: typeof body.model === "string",
    hasMessages: messages.length > 0,
    hasSystem: roles.has("system") || anthropicSystem,
    hasUser: roles.has("user"),
    hasAssistant: roles.has("assistant"),
    hasTool,
    headersRedacted: Object.values(capture.headers).some((value) => String(value).includes("[REDACTED")),
    requestHopHeadersFiltered: !("x-extra-hop" in upstreamHeaders) && !("x-peek-internal" in upstreamHeaders),
    responseHopHeadersFiltered: !("x-hop-secret" in downstreamHeaders) && !("x-peek-debug" in downstreamHeaders),
    responseHeadersRedacted:
      capturedResponseHeaders["set-cookie"] === "[REDACTED:header]" &&
      capturedResponseHeaders["x-api-key"] === "[REDACTED:header]" &&
      Array.isArray(capture.response?.header_redactions) &&
      capture.response.header_redactions.length >= 2,
    hasWatchId: capture.watch_id === `${mode}-smoke`,
    hasCaptureId: typeof capture.capture_id === "string" && capture.capture_id.length > 0,
    hasConversationId: capture.conversation_id === "proxy-smoke",
  };
}

function renderReport(proxy, upstream, response, evaluation) {
  const lines = [];
  lines.push(`# ${mode} 代理捕获 smoke test`);
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- proxy base URL：${proxy.baseUrl}`);
  lines.push(`- upstream base URL：${upstream.baseUrl}`);
  lines.push(`- upstream response status：${response.statusCode}`);
  lines.push(`- proxy captures：${proxy.captures.length}`);
  lines.push(`- upstream receives：${upstream.seen.length}`);
  lines.push("");
  lines.push("| 检查项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(evaluation)) {
    lines.push(`| ${key} | ${value ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push("结论：代理路径可以捕获完整本地请求 body，适合标记为 `exact`，前提是真实 Agent 的 provider/base URL 能指向该代理。");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!["openai", "anthropic"].includes(mode)) {
    throw new Error("Usage: node scripts/proxy-smoke.mjs openai|anthropic");
  }
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.baseUrl);
  const url = mode === "anthropic" ? `${proxy.baseUrl}/v1/messages` : `${proxy.baseUrl}/v1/chat/completions`;
  const response = await postJson(url, samplePayload(), {
    authorization: "Bearer should-not-be-written",
    "x-api-key": "secret-key",
    connection: "keep-alive, x-extra-hop",
    "x-extra-hop": "remove-me",
    "x-peek-internal": "remove-me",
  });
  const evaluation = evaluate(proxy.captures[0], upstream, response);
  const report = renderReport(proxy, upstream, response, evaluation);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  proxy.server.close();
  upstream.server.close();
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(evaluation);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
