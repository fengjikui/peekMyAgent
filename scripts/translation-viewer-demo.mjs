#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBody } from "../src/core/capture-proxy.mjs";
import { translationMaterialsForRequest } from "../src/translation/request-materials.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "translation-viewer-demo");
const stateDir = path.join(runRoot, "state");
const storePath = path.join(stateDir, "store.sqlite");
const descriptorPath = path.join(runRoot, "session.json");
const upstreamLogPath = path.join(runRoot, "model-requests.jsonl");
const translationLogPath = path.join(runRoot, "translation-requests.jsonl");
const workspace = "/tmp/pma-translation-codex-demo/public-project";
const conversationId = "translation-codex-demo-session";
const sourceName = "Codex · translation demo";
const correctCallId = "call_list_public_directory";

const systemBlocks = [
  "You are Codex, a coding agent working in a repository. Inspect evidence before answering.",
  "Repository instructions:\n- Read AGENTS.md and README.md before changing code.\n- Work only inside the public demo directory.\n- Preserve exact filenames, command names, and tool identifiers.",
  "Answer contract:\n1. Name the two files a new contributor should read first.\n2. Explain the purpose of each file.\n3. Cite the directory result you used.",
];
const translations = new Map([
  [systemBlocks[0], "你是 Codex，一名在仓库中工作的编程 Agent。回答前先检查证据。"],
  [systemBlocks[1], "仓库指令：\n- 修改代码前先阅读 AGENTS.md 和 README.md。\n- 只在公开演示目录内工作。\n- 保留准确的文件名、命令名和工具标识符。"],
  [systemBlocks[2], "回答约定：\n1. 指出新贡献者应该先阅读的两个文件。\n2. 解释每个文件的用途。\n3. 引用你使用的目录结果。"],
  ["List one level of entries in a public directory.", "列出公开目录第一层的条目。"],
  ["Relative path inside the public demo directory.", "公开演示目录内的相对路径。"],
  ["Maximum directory depth. Use 1 for this task.", "最大目录深度。本任务使用 1。"],
  ["Read a line range from one public text file.", "读取一个公开文本文件的指定行范围。"],
  ["Relative path of the public text file.", "公开文本文件的相对路径。"],
  ["First line to return, starting from 1.", "返回的起始行，从 1 开始。"],
  ["Last line to return, inclusive.", "返回的结束行，包含该行。"],
]);

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# Agent Rules\n\nRead-only public teaching rules.\n");
fs.writeFileSync(path.join(workspace, "README.md"), "# Public Codex Demo\n\nStart here to understand the project.\n");

process.env.PEEKMYAGENT_STATE_DIR = stateDir;
process.env.PEEKMYAGENT_TRANSLATION_PROTOCOL = "openai";
process.env.PEEKMYAGENT_TRANSLATION_API_KEY = "local-public-placeholder";
process.env.PEEKMYAGENT_TRANSLATION_MODEL = "deterministic-translation-model";

const userMessage = {
  type: "message",
  role: "user",
  content: [{
    type: "input_text",
    text: "如果第一次用 Codex 参与这个项目，修改代码前应该先读哪两个文件？",
  }],
};
const systemMessages = systemBlocks.map((text) => ({
  type: "message",
  role: "system",
  content: [{ type: "input_text", text }],
}));
const toolCall = {
  type: "function_call",
  id: "fc_translation_list",
  call_id: correctCallId,
  name: "list_directory",
  arguments: "{\"path\":\".\",\"max_depth\":1}",
  status: "completed",
};
const tools = [
  {
    type: "function",
    name: "list_directory",
    description: "List one level of entries in a public directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside the public demo directory." },
        max_depth: { type: "integer", description: "Maximum directory depth. Use 1 for this task." },
      },
      required: ["path", "max_depth"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a line range from one public text file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the public text file." },
        start_line: { type: "integer", description: "First line to return, starting from 1." },
        end_line: { type: "integer", description: "Last line to return, inclusive." },
      },
      required: ["path", "start_line", "end_line"],
      additionalProperties: false,
    },
    strict: true,
  },
];
const commonRequest = {
  model: "pma-translation-demo-model",
  tools,
  temperature: 0,
  max_output_tokens: 180,
  metadata: { agent: sourceName, demo: "translation-viewer", privacy: "synthetic" },
};
const toolOutput = JSON.stringify({ path: ".", max_depth: 1, entries: ["AGENTS.md", "README.md"] });

let modelRequestIndex = 0;
const modelUpstream = http.createServer(async (request, response) => {
  const rawBody = await readBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  modelRequestIndex += 1;
  fs.appendFileSync(upstreamLogPath, `${JSON.stringify({ index: modelRequestIndex, path: request.url, body })}\n`);
  if (request.url !== "/v1/responses") {
    sendJson(response, 404, { error: { code: "unexpected_demo_path", message: "Expected /v1/responses." } });
    return;
  }
  if (modelRequestIndex === 1) {
    sendJson(response, 200, {
      id: "resp_translation_demo_1",
      object: "response",
      status: "completed",
      model: commonRequest.model,
      output: [toolCall],
      usage: { input_tokens: 220, output_tokens: 18, total_tokens: 238 },
    });
    return;
  }
  sendJson(response, 200, {
    id: "resp_translation_demo_2",
    object: "response",
    status: "completed",
    model: commonRequest.model,
    output: [{
      id: "msg_translation_demo_2",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: "先读 AGENTS.md 了解协作规则，再读 README.md 了解项目入口；目录结果同时包含这两个文件。",
        annotations: [],
      }],
    }],
    usage: { input_tokens: 286, output_tokens: 26, total_tokens: 312 },
  });
});

const translationUpstream = http.createServer(async (request, response) => {
  const rawBody = await readBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const prompt = body.messages?.at(-1)?.content || "";
  const blocks = translationSourceBlocks(prompt);
  fs.appendFileSync(translationLogPath, `${JSON.stringify({ path: request.url, model: body.model, material_count: blocks.length })}\n`);
  const content = blocks.map((block) => {
    const translatedText = translations.get(block.sourceText);
    if (!translatedText) throw new Error(`missing deterministic translation for: ${block.sourceText}`);
    return `@@PEEK_TRANSLATION ${block.hash}\n${translatedText}\n@@PEEK_END_TRANSLATION`;
  }).join("\n\n");
  sendJson(response, 200, { choices: [{ message: { role: "assistant", content } }] });
});

const modelUpstreamUrl = await listen(modelUpstream);
const translationUpstreamUrl = await listen(translationUpstream);
process.env.PEEKMYAGENT_TRANSLATION_BASE_URL = translationUpstreamUrl;

const viewer = await startViewerServer({ cwd: root, port: 0, capturePort: 0, storePath });

try {
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: sourceName,
    mode: "single_session",
    workspace,
    conversation_id: conversationId,
    target_base_url: modelUpstreamUrl,
    kind: "capture_proxy_exact",
    confidence: "exact",
    reuse: false,
  });

  const first = await postResponses(watch.base_url, {
    ...commonRequest,
    input: [...systemMessages, userMessage],
  });
  assert.equal(first.status, 200);

  const second = await postResponses(watch.base_url, {
    ...commonRequest,
    input: [
      ...systemMessages,
      userMessage,
      toolCall,
      { type: "function_call_output", call_id: correctCallId, output: toolOutput },
    ],
  });
  assert.equal(second.status, 200);

  await postJson(`${viewer.url}/api/watch/stop`, { id: watch.id, clear: false });
  const source = await sourceForConversation(viewer.url, conversationId);
  const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  const firstRequestId = view.requests[0]?.id;
  assert.ok(firstRequestId, "missing first Request id");

  const systemGeneration = await postJson(`${viewer.url}/api/translations/generate`, {
    source_id: source.id,
    request_id: firstRequestId,
    section: "system",
    agent: sourceName,
    target_language: "zh-CN",
  });
  const toolsGeneration = await postJson(`${viewer.url}/api/translations/generate`, {
    source_id: source.id,
    request_id: firstRequestId,
    section: "tools",
    agent: sourceName,
    target_language: "zh-CN",
  });
  const cache = await getJson(`${viewer.url}/api/translations?agent=${encodeURIComponent(sourceName)}&target_language=zh-CN`);
  verifySource(source, view, { systemGeneration, toolsGeneration, cache });

  const descriptor = {
    scenario_id: "translation-codex-demo",
    viewer_url: viewer.url,
    model_upstream_url: modelUpstreamUrl,
    translation_upstream_url: translationUpstreamUrl,
    store_path: storePath,
    source: {
      id: source.id,
      conversation_id: source.conversation_id,
      label: sourceName,
      requests: source.request_count,
      protocol: "OpenAI Responses",
    },
    translation: {
      target_language: "zh-CN",
      system_blocks: 3,
      tool_blocks: 7,
      cache_entries: cache.entry_count,
      provider: "deterministic loopback OpenAI-compatible mock",
    },
    facts: [
      "The Capture contains two Requests: a Codex-shaped repository question, list_directory tool call, then tool result and final answer.",
      "System translation is split into three source blocks and keeps an expandable original under each translated card.",
      "Tools translation changes descriptions only; list_directory, read_file, path, max_depth, start_line, and end_line remain exact identifiers.",
      "Translation cache is auxiliary state and does not modify the exact Capture request body.",
    ],
    boundaries: [
      "The Source uses a public Codex-shaped teaching request over OpenAI Responses; it does not claim to be emitted by the real Codex CLI.",
      "Both model and translation responses are deterministic loopback fixtures; the Source does not prove remote model or translation quality.",
      "The demo verifies current Viewer rendering and cache behavior only for the included public English blocks.",
      "Translated prose is for reading assistance; protocol facts remain anchored in source text and Raw.",
    ],
    privacy: "Fixed disposable workspace, public synthetic prompts, placeholder token, loopback only, no external request or real credential.",
  };
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  console.log("\nTranslation Viewer demo is ready.");
  console.log(`Descriptor: ${descriptorPath}`);
  console.log(`Viewer: ${viewer.url}/?source=${encodeURIComponent(source.id)}`);
  console.log("2 Requests: tool call → tool result / final answer; 3 System + 7 Tools translation blocks cached.");
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

function verifySource(source, view, { systemGeneration, toolsGeneration, cache }) {
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, 2);
  assert.equal(source.response_count, 2);
  assert.equal(view.requests.length, 2);
  for (const request of view.requests) {
    assert.equal(request.summary.protocol_exchange.protocol, "openai_responses");
    assert.equal(request.raw.headers.authorization, "[REDACTED:header]");
    assert.equal(request.raw.provenance.request.fidelity, "exact");
    assert.equal(request.raw.provenance.response.fidelity, "exact");
  }
  const firstRequest = view.requests[0];
  const systemMaterials = translationMaterialsForRequest(firstRequest, { section: "system" });
  const toolMaterials = translationMaterialsForRequest(firstRequest, { section: "tools" });
  assert.equal(systemMaterials.length, 3);
  assert.equal(toolMaterials.length, 7);
  assert.equal(systemGeneration.extract.item_count, 3);
  assert.equal(systemGeneration.translate.translated, 3);
  assert.equal(toolsGeneration.extract.item_count, 7);
  assert.equal(toolsGeneration.translate.translated, 7);
  assert.equal(cache.available, true);
  assert.equal(cache.entry_count, 10);
  assert.equal(firstRequest.raw.body.tools[0].name, "list_directory");
  assert.equal(firstRequest.raw.body.tools[1].name, "read_file");
  assert.equal(view.requests[1].summary.response.text, "先读 AGENTS.md 了解协作规则，再读 README.md 了解项目入口；目录结果同时包含这两个文件。");
}

function translationSourceBlocks(prompt) {
  const output = [];
  const pattern = /@@PEEK_SOURCE\s+([a-f0-9]{64})\r?\nkind:\s*([^\r\n]+)\r?\nmetadata:\s*([^\r\n]+)\r?\n([\s\S]*?)\r?\n@@PEEK_END_SOURCE/g;
  let match;
  while ((match = pattern.exec(String(prompt || "")))) {
    output.push({ hash: match[1], kind: match[2].trim(), sourceText: match[4].trim() });
  }
  return output;
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
  return { status: response.status, body: await response.json() };
}

async function postJson(url, body) {
  const intentHeaders = new URL(url).pathname === "/api/translations/generate"
    ? { "x-peekmyagent-intent": "translation-generate" }
    : {};
  const response = await fetch(url, {
    method: "POST",
    headers: { ...jsonHeadersForUrl(url), ...intentHeaders },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const payload = await response.json();
  if (payload?.ok === false) throw new Error(payload.error || `Request failed: ${url}`);
  return payload;
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
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close() {
  await viewer.close().catch(() => {});
  await Promise.all([closeServer(modelUpstream), closeServer(translationUpstream)]);
}

function closeServer(server) {
  server.closeIdleConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}
