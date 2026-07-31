#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, "tmp", "readme-media-state");
const storePath = path.join(stateDir, "store.sqlite");
const port = readPort(process.argv.slice(2));
const workspace = "/demo/hello-agent";
const instructions = [
  "You are Codex working in a small, anonymous demo project.",
  "Use the available tools to inspect evidence before answering.",
  "Do not modify files unless the user explicitly asks you to.",
].join(" ");
const tools = [
  {
    type: "function",
    name: "list_directory",
    description: "List files and folders under a path in the current project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Project-relative directory path." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a bounded line range from a UTF-8 text file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative file path." },
        start_line: { type: "integer", description: "First line to read, starting at 1." },
        end_line: { type: "integer", description: "Last line to read, inclusive." },
      },
      required: ["path", "start_line", "end_line"],
      additionalProperties: false,
    },
  },
];
const initialInput = [
  {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "项目约束：这是公开演示目录；只读取相对路径，不访问用户文件。" }],
  },
  {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "请先查看当前文件夹有哪些内容，再读取 README.md 中的「项目目标」部分，最后用一句话说明这个项目是做什么的。",
    }],
  },
];
const listCall = {
  type: "function_call",
  call_id: "call_list_directory",
  name: "list_directory",
  arguments: JSON.stringify({ path: "." }),
};
const listResult = [
  "README.md",
  "data/",
  "data/colors.json",
  "notes/",
  "notes/idea.md",
].join("\n");
const readCall = {
  type: "function_call",
  call_id: "call_read_readme",
  name: "read_file",
  arguments: JSON.stringify({ path: "README.md", start_line: 1, end_line: 12 }),
};
const readResult = [
  "# hello-agent",
  "",
  "## 项目目标",
  "",
  "用一个最小项目演示 Agent 如何查看目录、读取文档，并根据工具结果回答。",
].join("\n");

fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

let responseIndex = 0;
const upstream = http.createServer(async (request, response) => {
  await readBody(request);
  const payload = demoResponse(responseIndex);
  responseIndex += 1;
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`);
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd: root, port, storePath, capturePort: 0 });
const watch = await postJson(`${viewer.url}/api/watch/start`, {
  agent: "Codex",
  mode: "single_session",
  workspace,
  conversation_id: "quickstart-tool-loop",
  target_base_url: upstreamUrl,
  kind: "codex_proxy_exact",
  confidence: "exact",
  reuse: false,
});

await postResponses(watch.base_url, requestPayload(initialInput));
await postResponses(watch.base_url, requestPayload([
  ...initialInput,
  listCall,
  { type: "function_call_output", call_id: listCall.call_id, output: listResult },
]));
await postResponses(watch.base_url, requestPayload([
  ...initialInput,
  listCall,
  { type: "function_call_output", call_id: listCall.call_id, output: listResult },
  readCall,
  { type: "function_call_output", call_id: readCall.call_id, output: readResult },
]));

console.log(`README media demo: ${viewer.url}`);
console.log(`Source: ${viewer.url}/?source=${encodeURIComponent(watch.id)}`);
console.log("Deterministic synthetic provider; no external request or user file was used.");
console.log("Press Ctrl-C to stop.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await viewer.close();
    await closeServer(upstream);
    process.exit(0);
  });
}

function requestPayload(input) {
  return {
    model: "gpt-5.6",
    instructions,
    input,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "medium", summary: "auto" },
    stream: true,
    metadata: { demo: "quickstart", privacy: "synthetic" },
  };
}

function demoResponse(index) {
  if (index === 0) {
    return {
      id: "resp_quickstart_1",
      model: "gpt-5.6",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "先列出目录，再根据结果读取 README 的目标部分。" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "我先查看目录结构。" }] },
        listCall,
      ],
      usage: { input_tokens: 412, output_tokens: 58, input_tokens_details: { cached_tokens: 0 } },
    };
  }
  if (index === 1) {
    return {
      id: "resp_quickstart_2",
      model: "gpt-5.6",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "目录中存在 README.md；读取项目目标对应的小段内容。" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "已经找到 README.md，接着读取「项目目标」。" }] },
        readCall,
      ],
      usage: { input_tokens: 538, output_tokens: 72, input_tokens_details: { cached_tokens: 320 } },
    };
  }
  return {
    id: "resp_quickstart_3",
    model: "gpt-5.6",
    status: "completed",
    output: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "根据目录清单和 README 原文给出一句话结论。" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "这个最小项目用于演示 Agent 如何查看目录、读取文档，并依据真实工具结果回答问题。",
        }],
      },
    ],
    usage: { input_tokens: 704, output_tokens: 68, input_tokens_details: { cached_tokens: 448 } },
  };
}

async function postResponses(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer quickstart-demo-only" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Responses demo request failed: ${response.status} ${await response.text()}`);
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

function readPort(args) {
  const index = args.indexOf("--port");
  const value = index >= 0 ? Number(args[index + 1]) : 43112;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid --port: ${args[index + 1]}`);
  return value;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
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
