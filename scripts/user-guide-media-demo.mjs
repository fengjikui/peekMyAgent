#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, "tmp", "user-guide-media-state");
const storePath = path.join(stateDir, "store.sqlite");
const port = readPort(process.argv.slice(2));
const verifyOnly = process.argv.includes("--verify");

const codexTools = [
  functionTool("read_file", "Read a bounded range from a public demo file.", {
    path: { type: "string", description: "Project-relative file path." },
    start_line: { type: "integer", description: "First line, starting at 1." },
    end_line: { type: "integer", description: "Last line, inclusive." },
  }),
  functionTool("start_background_scan", "Start a non-sensitive background scan and return when it completes.", {
    path: { type: "string", description: "Project-relative directory." },
    pattern: { type: "string", description: "Public demo search pattern." },
  }),
  functionTool("check_scan", "Check whether a background scan has completed.", {
    job_id: { type: "string", description: "Job id returned by the scan service." },
  }),
];

const contextInstructions = [
  "You are Codex in a synthetic public project.",
  "Use only project-relative demo files.",
  "Base answers on captured tool results.",
].join(" ");
const contextInstructionsChanged = `${contextInstructions} In the final answer, use exactly three concise bullets.`;
const contextUser1 = message("user", "请记住公开演示项目代号是 BLUE-7，并告诉我你记住了什么。");
const contextAssistant1 = message("assistant", "我记住了：公开演示项目代号是 BLUE-7。");
const contextUser2 = message("user", "现在读取 notes/plan.md 的前 12 行，告诉我下一步是什么。");
const contextReadCall = toolCall("call_context_plan", "read_file", {
  path: "notes/plan.md",
  start_line: 1,
  end_line: 12,
});
const contextReadResult = [
  "# 公开演示计划",
  "",
  "1. 先确认项目代号。",
  "2. 再核对工具返回的计划。",
  "3. 最后比较相邻请求中的上下文变化。",
].join("\n");
const contextAssistant2 = message("assistant", "计划要求下一步比较相邻请求中的上下文变化。");
const contextUser3 = message("user", "把项目代号和计划合并成三点总结，并说明哪些信息来自历史、哪些来自工具结果。");

const asyncInstructions = [
  "You are Codex demonstrating delayed tool-result correlation.",
  "The background scan is synthetic and only reads public demo paths.",
  "Do not invent a result before the tool output arrives.",
].join(" ");
const asyncUser = message("user", "后台检查 docs 中是否包含“快速开始”，等待期间先读取 README 的标题，最后一起汇报。");
const scanCall = toolCall("call_background_scan", "start_background_scan", {
  path: "docs",
  pattern: "快速开始",
});
const titleCall = toolCall("call_async_readme", "read_file", {
  path: "README.md",
  start_line: 1,
  end_line: 4,
});
const scanCheckCall = toolCall("call_scan_status", "check_scan", { job_id: "scan-demo-7" });
const titleResult = "# hello-agent\n\n一个用于公开演示 Agent 观察能力的最小项目。";
const scanResult = JSON.stringify({ job_id: "scan-demo-7", status: "completed", matches: ["docs/quick-start.md:1"] });
const scanStatusResult = JSON.stringify({ job_id: "scan-demo-7", status: "completed" });

const childDocsPrompt = "只读取 docs/guide.md 的前 10 行，说明快速开始章节解决什么问题。";
const childTreePrompt = "只根据提供的虚构目录，说明用户应该先看哪两个文件。";
const claudeSystem = [{ type: "text", text: "这是公开的 Claude Code 子 Agent 演示；不得访问用户文件或网络。" }];
const claudeTools = [
  {
    name: "Agent",
    description: "Start a focused read-only subagent.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
  {
    name: "Read",
    description: "Read a public demo file.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["file_path"],
    },
  },
];
const spawnDocs = anthropicToolUse("agent_docs", "Agent", {
  description: "核对快速开始",
  prompt: childDocsPrompt,
  subagent_type: "Explore",
});
const spawnTree = anthropicToolUse("agent_tree", "Agent", {
  description: "核对目录入口",
  prompt: childTreePrompt,
  subagent_type: "Explore",
});
const childRead = anthropicToolUse("read_guide", "Read", {
  file_path: "docs/guide.md",
  offset: 1,
  limit: 10,
});
const childReadResult = "# 快速开始\n\n用一个最小任务看清用户请求、工具调用、结果回传和最终回答。";

const openAiResponses = {
  context: [
    responsesFixture("resp_context_1", "确认并保留用户给出的公开项目代号。", "我记住了：公开演示项目代号是 BLUE-7。"),
    responsesFixture("resp_context_2", "读取计划文件后再回答，避免凭记忆猜测。", "我先读取公开计划。", contextReadCall),
    responsesFixture("resp_context_3", "工具结果说明下一步是比较相邻请求的上下文变化。", contextAssistant2.content[0].text),
    responsesFixture("resp_context_4", "区分历史中的代号和工具结果中的计划，再按新指令输出三点。", [
      "- 历史信息：项目代号是 BLUE-7。",
      "- 工具证据：计划要求比较相邻请求的上下文变化。",
      "- 综合结论：历史与新工具结果共同构成最终回答。",
    ].join("\n"), null, 1180),
  ],
  async: [
    responsesFixture("resp_async_1", "先启动后台扫描；结果返回前不能猜测。", "我先启动后台扫描。", scanCall),
    responsesFixture("resp_async_2", "扫描尚未回传，等待期间读取 README 标题。", "扫描仍在运行，我先读取 README 标题。", titleCall),
    responsesFixture("resp_async_3", "README 标题已经返回；现在检查后台任务状态。", "README 标题已确认，我检查后台扫描状态。", scanCheckCall),
    responsesFixture("resp_async_4", "迟到的扫描结果与 README 标题都已到达，可以一起汇报。", "README 标题是 hello-agent；后台扫描在 docs/quick-start.md 找到“快速开始”。", null, 1040),
  ],
};

const anthropicResponses = [
  anthropicFixture("msg_parent_spawn", [
    { type: "text", text: "我会并行请两个只读子 Agent 分别核对文档与目录。" },
    spawnDocs,
    spawnTree,
  ], "tool_use", 64),
  anthropicFixture("msg_child_docs_read", [
    { type: "text", text: "我先读取快速开始文档。" },
    childRead,
  ], "tool_use", 42),
  anthropicFixture("msg_child_docs_done", [
    { type: "text", text: "快速开始用最小任务解释请求、工具调用、结果回传与最终回答。" },
  ], "end_turn", 38),
  anthropicFixture("msg_child_tree_done", [
    { type: "text", text: "用户应先看 README.md 获取首页概览，再看 docs/guide.md 完成快速开始。" },
  ], "end_turn", 36),
  anthropicFixture("msg_parent_done", [
    { type: "text", text: "两个子 Agent 已回流：README 负责首页概览，docs/guide.md 用最小工具闭环带用户完成快速开始。" },
  ], "end_turn", 58),
];

fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const responseOffsets = { context: 0, async: 0, anthropic: 0 };
const upstream = http.createServer(async (request, response) => {
  const body = await readJsonBody(request);
  if (request.url?.includes("/messages")) {
    const payload = anthropicResponses[responseOffsets.anthropic++] || anthropicResponses.at(-1);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
    return;
  }
  const demo = body?.metadata?.demo === "async-tool-result" ? "async" : "context";
  const payload = openAiResponses[demo][responseOffsets[demo]++] || openAiResponses[demo].at(-1);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`);
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd: root, port, storePath, capturePort: 0 });

const contextWatch = await startWatch(viewer.url, {
  agent: "Codex",
  workspace: "/demo/context-lab",
  conversation_id: "context-evolution",
  target_base_url: upstreamUrl,
  kind: "codex_proxy_exact",
});
await postResponses(contextWatch.base_url, responsesRequest(contextInstructions, [contextUser1], "context-evolution", "medium"));
await postResponses(contextWatch.base_url, responsesRequest(contextInstructions, [contextUser1, contextAssistant1, contextUser2], "context-evolution", "medium"));
await postResponses(contextWatch.base_url, responsesRequest(contextInstructions, [
  contextUser1,
  contextAssistant1,
  contextUser2,
  contextReadCall,
  { type: "function_call_output", call_id: contextReadCall.call_id, output: contextReadResult },
], "context-evolution", "medium"));
await postResponses(contextWatch.base_url, responsesRequest(contextInstructionsChanged, [
  contextUser1,
  contextAssistant1,
  contextUser2,
  contextReadCall,
  { type: "function_call_output", call_id: contextReadCall.call_id, output: contextReadResult },
  contextAssistant2,
  contextUser3,
], "context-evolution", "high"));

const asyncWatch = await startWatch(viewer.url, {
  agent: "Codex",
  workspace: "/demo/async-tool-lab",
  conversation_id: "delayed-tool-result",
  target_base_url: upstreamUrl,
  kind: "codex_proxy_exact",
});
await postResponses(asyncWatch.base_url, responsesRequest(asyncInstructions, [asyncUser], "async-tool-result", "medium"));
await postResponses(asyncWatch.base_url, responsesRequest(asyncInstructions, [
  asyncUser,
  message("assistant", "我先启动后台扫描。"),
  scanCall,
], "async-tool-result", "medium"));
await postResponses(asyncWatch.base_url, responsesRequest(asyncInstructions, [
  asyncUser,
  message("assistant", "我先启动后台扫描。"),
  scanCall,
  message("assistant", "扫描仍在运行，我先读取 README 标题。"),
  titleCall,
  { type: "function_call_output", call_id: titleCall.call_id, output: titleResult },
], "async-tool-result", "medium"));
await postResponses(asyncWatch.base_url, responsesRequest(asyncInstructions, [
  asyncUser,
  message("assistant", "我先启动后台扫描。"),
  scanCall,
  message("assistant", "扫描仍在运行，我先读取 README 标题。"),
  titleCall,
  { type: "function_call_output", call_id: titleCall.call_id, output: titleResult },
  message("assistant", "README 标题已确认，我检查后台扫描状态。"),
  scanCheckCall,
  { type: "function_call_output", call_id: scanCheckCall.call_id, output: scanStatusResult },
  { type: "function_call_output", call_id: scanCall.call_id, output: scanResult },
], "async-tool-result", "medium"));

const subagentWatch = await startWatch(viewer.url, {
  agent: "Claude Code",
  workspace: "/demo/subagent-lab",
  conversation_id: "two-readonly-subagents",
  target_base_url: upstreamUrl,
  kind: "claude_proxy_exact",
});
const parentPrompt = "请并行启动两个只读子 Agent：一个核对快速开始文档，一个核对目录入口，最后统一汇总。";
const sessionHeaders = { "x-claude-code-session-id": "session-public-demo" };
await postAnthropic(subagentWatch.base_url, anthropicRequest([{ role: "user", content: parentPrompt }]), sessionHeaders);
await postAnthropic(subagentWatch.base_url, anthropicRequest([{ role: "user", content: childDocsPrompt }]), {
  ...sessionHeaders,
  "x-claude-code-agent-id": "agent-doc-reader",
});
await postAnthropic(subagentWatch.base_url, anthropicRequest([
  { role: "user", content: childDocsPrompt },
  { role: "assistant", content: [childRead] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: childRead.id, content: childReadResult }] },
]), { ...sessionHeaders, "x-claude-code-agent-id": "agent-doc-reader" });
await postAnthropic(subagentWatch.base_url, anthropicRequest([{ role: "user", content: childTreePrompt }]), {
  ...sessionHeaders,
  "x-claude-code-agent-id": "agent-tree-reader",
});
await postAnthropic(subagentWatch.base_url, anthropicRequest([
  { role: "user", content: parentPrompt },
  { role: "assistant", content: [spawnDocs, spawnTree] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: spawnDocs.id, content: "快速开始用最小工具闭环解释 Agent 机制。" },
      { type: "tool_result", tool_use_id: spawnTree.id, content: "先看 README.md，再看 docs/guide.md。" },
    ],
  },
]), sessionHeaders);

console.log(`User-guide media demo: ${viewer.url}`);
console.log(`Context source: ${sourceUrl(viewer.url, contextWatch.id)}`);
console.log(`Delayed-result source: ${sourceUrl(viewer.url, asyncWatch.id)}`);
console.log(`Subagent source: ${sourceUrl(viewer.url, subagentWatch.id)}`);
console.log(`Synthetic local provider and fictional /demo paths only.${verifyOnly ? "" : " Press Ctrl-C to stop."}`);

if (verifyOnly) {
  await verifyGeneratedSources(viewer.url, {
    context: contextWatch.id,
    asyncResult: asyncWatch.id,
    subagent: subagentWatch.id,
  });
  console.log("User-guide media demo verification passed.");
  await viewer.close();
  await closeServer(upstream);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await viewer.close();
    await closeServer(upstream);
    process.exit(0);
  });
}

function responsesRequest(instructions, input, demo, effort) {
  return {
    model: "gpt-5.6",
    instructions,
    input,
    tools: codexTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort, summary: "auto" },
    stream: true,
    metadata: { demo, privacy: "synthetic" },
  };
}

function anthropicRequest(messages) {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: claudeSystem,
    tools: claudeTools,
    messages,
    stream: false,
    metadata: { user_id: JSON.stringify({ session_id: "session-public-demo" }) },
  };
}

function responsesFixture(id, reasoning, text, call = null, inputTokens = 520) {
  const output = [
    { type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] },
    message("assistant", text),
  ];
  if (call) output.push(call);
  return {
    id,
    model: "gpt-5.6",
    status: "completed",
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: call ? 74 : 56,
      input_tokens_details: { cached_tokens: Math.max(0, inputTokens - 300) },
    },
  };
}

function anthropicFixture(id, content, stopReason, outputTokens) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 420, output_tokens: outputTokens },
  };
}

function functionTool(name, description, properties) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

function toolCall(callId, name, args) {
  return { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) };
}

function anthropicToolUse(id, name, input) {
  return { type: "tool_use", id, name, input };
}

function message(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

async function startWatch(viewerUrl, options) {
  return postJson(`${viewerUrl}/api/watch/start`, {
    mode: "single_session",
    confidence: "exact",
    reuse: false,
    ...options,
  });
}

async function postResponses(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-demo-only" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Responses demo request failed: ${response.status} ${await response.text()}`);
  await response.text();
}

async function postAnthropic(baseUrl, payload, extraHeaders) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "synthetic-demo-only",
      "anthropic-version": "2023-06-01",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Anthropic demo request failed: ${response.status} ${await response.text()}`);
  await response.text();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeadersForUrl(url),
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function sourceUrl(viewerUrl, id) {
  return `${viewerUrl}/?source=${encodeURIComponent(id)}`;
}

async function verifyGeneratedSources(viewerUrl, ids) {
  const context = await readView(viewerUrl, ids.context);
  assert.equal(context.requests.length, 4, "context scenario request count");
  assert.equal(context.turns.length, 3, "context scenario turn count");
  const contextFourth = context.requests.find((request) => request.request_index === 4);
  assert.equal(contextFourth?.context_delta?.previous_request_index, 3, "context request 4 compares with request 3");
  assert.equal(contextFourth?.changes?.system_changed, true, "context request 4 changes System");
  assert.equal(contextFourth?.changes?.params_changed, true, "context request 4 changes params");

  const asyncResult = await readView(viewerUrl, ids.asyncResult);
  assert.equal(asyncResult.requests.length, 4, "delayed-result request count");
  assert.equal(asyncResult.turns.length, 1, "delayed-result turn count");
  const asyncFourth = asyncResult.requests.find((request) => request.request_index === 4);
  assert.ok(
    asyncFourth?.summary?.current_tool_results?.some((result) => result.id === scanCall.call_id),
    "request 4 contains the delayed result from request 1",
  );

  const subagent = await readView(viewerUrl, ids.subagent);
  assert.equal(subagent.requests.length, 5, "subagent scenario request count");
  assert.equal(subagent.stats?.subagent_instance_count, 2, "subagent instance count");
  const branches = subagent.agent_trace?.branches || [];
  assert.equal(branches.length, 2, "subagent branch count");
  assert.deepEqual(branches.map((branch) => branch.request_indexes), [[2, 3], [4]], "subagent request grouping");
  assert.ok(branches.every((branch) => branch.spawn?.parent_request_index === 1), "both branches spawn from request 1");
  assert.ok(branches.every((branch) => branch.return?.parent_request_index === 5), "both branches return to request 5");
}

async function readView(viewerUrl, sourceId) {
  const response = await fetch(`${viewerUrl}/api/view?source=${encodeURIComponent(sourceId)}`);
  if (!response.ok) throw new Error(`View verification failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function readPort(args) {
  const index = args.indexOf("--port");
  const value = index >= 0 ? Number(args[index + 1]) : 43113;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid --port: ${args[index + 1]}`);
  return value;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
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

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
