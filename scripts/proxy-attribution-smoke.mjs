import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { listen, readBody, resolveUpstreamUrl, startCaptureProxy } from "../src/core/capture-proxy.mjs";

const reportPath =
  process.env.PEEKMYAGENT_PROXY_ATTRIBUTION_SMOKE_REPORT_PATH ||
  path.join(process.cwd(), "tmp", "proxy-smoke", "proxy-attribution-smoke-report.md");

async function startUpstream() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(bodyText) });
    await delay(Math.floor(Math.random() * 20));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `chatcmpl_${seen.length}`, choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  const address = await listen(server);
  return { server, seen, baseUrl: `http://${address.address}:${address.port}` };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJson(url, payload, headers = {}) {
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
          authorization: "Bearer should-not-be-written",
          ...headers,
        },
      },
      async (res) => {
        const text = await readBody(res);
        resolve({ statusCode: res.statusCode, body: text });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function payload(label) {
  return {
    model: "peek/peek-test",
    messages: [
      { role: "system", content: `system for ${label}` },
      { role: "user", content: `hello from ${label}` },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  };
}

function groupByWatch(captures) {
  const groups = new Map();
  for (const capture of captures) {
    const values = groups.get(capture.watch_id) || [];
    values.push(capture);
    groups.set(capture.watch_id, values);
  }
  return groups;
}

function renderReport({ proxy, upstream, normalized, responses }) {
  const groups = groupByWatch(proxy.captures);
  const lines = [];
  lines.push("# Proxy 多会话归属 smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：本测试在同一个代理端口上并发发送多个 watch 的请求，只输出结构化检查结果，不输出 prompt 正文。");
  lines.push("");
  lines.push(`- proxy base URL：${proxy.baseUrl}`);
  lines.push(`- upstream base URL：${upstream.baseUrl}`);
  lines.push(`- proxy captures：${proxy.captures.length}`);
  lines.push(`- upstream receives：${upstream.seen.length}`);
  lines.push(`- responses：${responses.map((response) => response.statusCode).join(", ")}`);
  lines.push("");
  lines.push("| watch_id | captures | request_index | conversation_id | normalized_confidence | forwarded_paths |");
  lines.push("| --- | ---: | --- | --- | --- | --- |");
  for (const [watchId, captures] of groups) {
    const byWatch = normalized.filter((item) => item.watch_id === watchId);
    lines.push(
      `| ${watchId} | ${captures.length} | ${captures.map((capture) => capture.request_index).join(", ")} | ${captures.map((capture) => capture.conversation_id).join(", ")} | ${byWatch.map((item) => item.capture_confidence).join(", ")} | ${captures.map((capture) => capture.path).join(", ")} |`,
    );
  }
  lines.push("");
  lines.push("结论：同一代理端口可以用 path token 或 header watch id 区分并发请求；转发给 provider 前会剥离 path token 并移除 `x-peek-*` 本地归属 header。第一版产品仍建议 UI 为每个 watch 分配独立 base URL，内部继续保留 `watch_id` 作为最终分组键。");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const upstream = await startUpstream();
  const proxy = await startCaptureProxy({
    targetBaseUrl: upstream.baseUrl,
    defaultAttribution: {
      agentProfile: "OpenClaw",
      workspace: "/tmp/peek-default",
      conversationId: "default-conversation",
    },
  });

  const responses = await Promise.all([
    postJson(`${proxy.urlForWatch("openclaw-project-a")}/v1/chat/completions`, payload("openclaw-project-a"), {
      "x-peek-agent-profile": "OpenClaw main",
      "x-peek-workspace": "/workspace/a",
      "x-peek-conversation-id": "agent:main:a",
    }),
    postJson(`${proxy.urlForWatch("openclaw-project-b")}/v1/chat/completions`, payload("openclaw-project-b"), {
      "x-peek-agent-profile": "OpenClaw helper",
      "x-peek-workspace": "/workspace/b",
      "x-peek-conversation-id": "agent:helper:b",
    }),
    postJson(`${proxy.baseUrl}/v1/chat/completions`, payload("header-watch"), {
      "x-peek-watch-id": "header-watch",
      "x-peek-agent-profile": "OpenClaw header",
      "x-peek-workspace": "/workspace/header",
      "x-peek-conversation-id": "agent:header:1",
    }),
    postJson(`${proxy.urlForWatch("openclaw-project-a")}/v1/chat/completions`, payload("openclaw-project-a-second"), {
      "x-peek-agent-profile": "OpenClaw main",
      "x-peek-workspace": "/workspace/a",
      "x-peek-conversation-id": "agent:main:a",
    }),
    postJson(`${proxy.urlForWatch("claude-header")}/v1/messages`, payload("claude-header"), {
      "x-peek-agent-profile": "Claude Code",
      "x-peek-workspace": "/workspace/claude",
      "x-claude-code-session-id": "claude-native-session",
    }),
    postJson(`${proxy.urlForWatch("opencode-header")}/v1/chat/completions`, payload("opencode-header"), {
      "x-peek-agent-profile": "OpenCode",
      "x-peek-workspace": "/workspace/opencode",
      "x-session-id": "opencode-native-session",
    }),
  ]);

  assert.equal(proxy.captures.length, 6);
  assert.equal(upstream.seen.length, 6);
  assert.deepEqual(
    upstream.seen.map((request) => request.url).sort(),
    [
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/messages",
    ].sort(),
    "concurrent forwarding should preserve the expected path multiset without requiring arrival order",
  );
  assert.equal(resolveUpstreamUrl("https://api.example.com/anthropic", "/v1/messages", true).toString(), "https://api.example.com/anthropic/v1/messages");
  assert.equal(
    resolveUpstreamUrl("https://api.example.com/anthropic", "/v1/messages?beta=true", true).toString(),
    "https://api.example.com/anthropic/v1/messages?beta=true",
  );
  assert.ok(upstream.seen.every((request) => !Object.keys(request.headers).some((key) => key.startsWith("x-peek-"))));
  assert.ok(responses.every((response) => response.statusCode === 200));

  const groups = groupByWatch(proxy.captures);
  assert.equal(groups.get("openclaw-project-a").length, 2);
  assert.deepEqual(
    groups.get("openclaw-project-a").map((capture) => capture.request_index),
    [1, 2],
  );
  assert.equal(groups.get("openclaw-project-b").length, 1);
  assert.equal(groups.get("header-watch").length, 1);
  assert.equal(groups.get("claude-header").length, 1);
  assert.equal(groups.get("opencode-header").length, 1);
  assert.equal(groups.get("claude-header")[0].conversation_id, "claude-native-session");
  assert.equal(groups.get("opencode-header")[0].conversation_id, "opencode-native-session");
  assert.ok(proxy.captures.every((capture) => capture.capture_id && capture.received_at));
  assert.ok(proxy.captures.every((capture) => Object.values(capture.headers).some((value) => String(value).includes("[REDACTED"))));

  const openclawCaptures = proxy.captures.filter(
    (capture) =>
      capture.path === "/v1/chat/completions" &&
      /^openclaw\b/i.test(String(capture.agent_profile || "")),
  );
  const normalized = openclawCaptures.map((capture) => normalizeOpenClawProxyCapture(capture));
  assert.ok(normalized.every((item) => item.capture_confidence === "exact"));
  assert.equal(normalized.find((item) => item.watch_id === "openclaw-project-b").conversation_id, "agent:helper:b");

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderReport({ proxy, upstream, normalized, responses }));
  await proxy.close();
  upstream.server.close();
  console.log(`Wrote ${reportPath}`);
  console.log({
    captures: proxy.captures.length,
    watchIds: Array.from(groups.keys()),
    normalized: normalized.map((item) => ({ watch_id: item.watch_id, request_index: item.request_index })),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
