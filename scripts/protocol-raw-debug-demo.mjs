#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "protocol-raw-debug-demo");
const stateDir = path.join(runRoot, "state");
const storePath = path.join(stateDir, "store.sqlite");
const descriptorPath = path.join(runRoot, "session.json");
const requestLogPath = path.join(runRoot, "upstream-requests.jsonl");
const workspace = "/tmp/pma-protocol-debug-demo/public-project";
const conversationId = "protocol-raw-debug-session";
const sourceName = "protocol-debug-lab";
const correctCallId = "call_list_directory";
const wrongCallId = "call_list_direct0ry";

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(workspace, "README.md"), "# Protocol Debug Lab\n\n公开、虚构、只读。\n");
fs.writeFileSync(path.join(workspace, "guide.md"), "# Guide\n\n先核对 call id，再查看 Raw。\n");

const userMessage = {
  type: "message",
  role: "user",
  content: [{
    type: "input_text",
    text: "请列出公开演示目录第一层，并告诉我新用户先看哪个文件。",
  }],
};
const toolCall = {
  type: "function_call",
  id: "fc_protocol_debug_list",
  call_id: correctCallId,
  name: "list_directory",
  arguments: "{\"path\":\".\"}",
  status: "completed",
};
const commonRequest = {
  model: "pma-debug-model",
  instructions: "只读取公开演示目录；必须使用 list_directory，再依据工具结果回答。",
  tools: [{
    type: "function",
    name: "list_directory",
    description: "列出公开演示目录第一层",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对目录" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  }],
  temperature: 0,
  max_output_tokens: 160,
  metadata: { demo: "protocol-raw-debug", privacy: "synthetic" },
};
const toolOutput = JSON.stringify({ path: ".", entries: ["README.md", "guide.md"] });

let requestIndex = 0;
const upstream = http.createServer(async (request, response) => {
  const rawBody = await readBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  requestIndex += 1;
  fs.appendFileSync(requestLogPath, `${JSON.stringify({
    index: requestIndex,
    method: request.method,
    path: request.url,
    body,
  })}\n`);

  if (request.url !== "/v1/responses") {
    sendJson(response, 404, { error: { code: "unexpected_demo_path", message: "Expected /v1/responses." } });
    return;
  }
  if (requestIndex === 1) {
    sendJson(response, 200, {
      id: "resp_protocol_debug_1",
      object: "response",
      status: "completed",
      model: "pma-debug-model",
      output: [toolCall],
      usage: { input_tokens: 84, output_tokens: 12, total_tokens: 96 },
    });
    return;
  }
  if (requestIndex === 2) {
    sendJson(response, 400, {
      error: {
        message: `No tool output found for call_id '${correctCallId}'. Received '${wrongCallId}'.`,
        type: "invalid_request_error",
        code: "invalid_tool_output",
        param: "input[3].call_id",
      },
      request_id: "req_protocol_debug_2",
    });
    return;
  }
  sendJson(response, 200, {
    id: "resp_protocol_debug_3",
    object: "response",
    status: "completed",
    model: "pma-debug-model",
    output: [{
      id: "msg_protocol_debug_3",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: "目录包含 README.md 和 guide.md；新用户先看 README.md。",
        annotations: [],
      }],
    }],
    usage: { input_tokens: 128, output_tokens: 22, total_tokens: 150 },
  });
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({
  cwd: root,
  port: 0,
  capturePort: 0,
  storePath,
});

try {
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: sourceName,
    mode: "single_session",
    workspace,
    conversation_id: conversationId,
    target_base_url: upstreamUrl,
    kind: "capture_proxy_exact",
    confidence: "exact",
    reuse: false,
  });

  const first = await postResponses(watch.base_url, {
    ...commonRequest,
    input: [userMessage],
  });
  assert.equal(first.status, 200);

  const second = await postResponses(watch.base_url, {
    ...commonRequest,
    input: [
      userMessage,
      toolCall,
      {
        type: "compatibility_note",
        id: "compat_protocol_debug_2",
        trace_marker: "compat-v2-preview",
        note: "未知字段仍应保留在 Raw，不能静默丢弃。",
      },
      { type: "function_call_output", call_id: wrongCallId, output: toolOutput },
    ],
  });
  assert.equal(second.status, 400);
  assert.equal(second.body?.error?.code, "invalid_tool_output");

  const third = await postResponses(watch.base_url, {
    ...commonRequest,
    input: [
      userMessage,
      toolCall,
      { type: "function_call_output", call_id: correctCallId, output: toolOutput },
    ],
  });
  assert.equal(third.status, 200);

  await postJson(`${viewer.url}/api/watch/stop`, { id: watch.id, clear: false });
  const source = await sourceForConversation(viewer.url, conversationId);
  const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  verifySource(source, view);

  const descriptor = {
    scenario_id: "protocol-raw-debug-demo",
    viewer_url: viewer.url,
    upstream_url: upstreamUrl,
    store_path: storePath,
    request_log: requestLogPath,
    source: {
      id: source.id,
      conversation_id: source.conversation_id,
      label: sourceName,
      requests: source.request_count,
      protocol: "OpenAI Responses",
    },
    facts: [
      "Request 1 returns list_directory with call_id call_list_directory.",
      "Request 2 sends call_list_direct0ry, contains one unknown compatibility_note item, and receives HTTP 400 invalid_tool_output.",
      "Request 3 restores call_list_directory and receives the final answer.",
      "The Capture Proxy preserves exact request and response bodies and redacts the placeholder authorization header.",
    ],
    boundaries: [
      "The deterministic upstream intentionally rejects the mismatched call id; this is a teaching fixture, not a provider incident.",
      "The protocol view exposes unknown schema items but does not claim they caused the HTTP error.",
      "Raw search is scoped to the currently selected Request and section.",
    ],
    privacy: "Fictional files, fixed disposable workspace, loopback only, placeholder token, no external request or real credential.",
  };
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  console.log("\nProtocol + Raw debug demo is ready.");
  console.log(`Descriptor: ${descriptorPath}`);
  console.log(`Viewer: ${viewer.url}/?source=${encodeURIComponent(source.id)}`);
  console.log("3 Requests: tool call → wrong call id / HTTP 400 → corrected call id / final answer.");
  console.log("Press Ctrl-C to stop local servers.");
} catch (error) {
  await close();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await close();
    process.exit(0);
  });
}
await new Promise(() => {});

function verifySource(source, view) {
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, 3);
  assert.equal(source.response_count, 3);
  assert.equal(view.requests.length, 3);
  for (const request of view.requests) {
    assert.equal(request.summary.protocol_exchange.protocol, "openai_responses");
    assert.equal(request.raw.headers.authorization, "[REDACTED:header]");
    assert.equal(request.raw.provenance.request.fidelity, "exact");
    assert.equal(request.raw.provenance.response.fidelity, "exact");
  }
  const middle = view.requests[1];
  assert.equal(middle.summary.protocol_exchange.request.counts.unknown_items, 1);
  assert.equal(middle.summary.protocol_exchange.request.input_items[2].schema_known, false);
  assert.equal(middle.raw.body.input[3].call_id, wrongCallId);
  assert.equal(middle.raw.response.body_json.error.code, "invalid_tool_output");
  assert.match(middle.raw.response.body_json.error.message, new RegExp(`${correctCallId}.*${wrongCallId}`));
  assert.equal(view.requests[2].raw.body.input[2].call_id, correctCallId);
  assert.equal(view.requests[2].summary.response.text, "目录包含 README.md 和 guide.md；新用户先看 README.md。");
}

async function postResponses(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-public-demo-token",
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json();
  return { status: response.status, body: responseBody };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeadersForUrl(url),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function sourceForConversation(viewerUrl, expectedConversationId) {
  const sources = await getJson(`${viewerUrl}/api/sources`);
  const source = sources.find((item) => item.conversation_id === expectedConversationId);
  assert.ok(source, `missing Source for ${expectedConversationId}`);
  return source;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close() {
  await viewer.close().catch(() => {});
  await new Promise((resolve) => upstream.close(() => resolve()));
}
