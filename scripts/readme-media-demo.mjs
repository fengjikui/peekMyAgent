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
const colorsResult = JSON.stringify({ primary: "blue", accent: "violet", background: "paper" }, null, 2);
const ideaResult = [
  "# 演示想法",
  "",
  "先展示简单对话，再展示工具链，最后用两级导航快速定位。",
].join("\n");

const navigationTurns = [
  {
    user: "你好，请记住这个公开演示项目叫 hello-agent。",
    steps: [],
    final: { reasoning: "记录用户提供的公开项目名称。", text: "记住了：这个公开演示项目叫 hello-agent。" },
  },
  {
    user: "先不读取文件，只复述你现在知道的信息。",
    steps: [],
    final: { reasoning: "只复述对话中已经明确的信息。", text: "目前只知道项目名是 hello-agent，其他内容还没有检查。" },
  },
  {
    user: "现在请确认 README.md 中写的项目目标。",
    steps: [
      {
        call: toolCall("call_nav_t3_list", "list_directory", { path: "." }),
        result: listResult,
        reasoning: "先确认 README.md 是否存在。",
        text: "我先确认目录中有哪些文件。",
      },
      {
        call: toolCall("call_nav_t3_readme", "read_file", { path: "README.md", start_line: 1, end_line: 12 }),
        result: readResult,
        reasoning: "README.md 存在，继续读取项目目标。",
        text: "README.md 已找到，我继续读取目标部分。",
      },
    ],
    final: {
      reasoning: "根据 README 原文回答项目目标。",
      text: "README 说明：这个项目用于演示 Agent 查看目录、读取文档并依据工具结果回答。",
    },
  },
  {
    user: "再看看 data/colors.json 使用了哪些演示颜色。",
    steps: [
      {
        call: toolCall("call_nav_t4_colors", "read_file", { path: "data/colors.json", start_line: 1, end_line: 20 }),
        result: colorsResult,
        reasoning: "读取公开的颜色配置。",
        text: "我读取一下颜色配置。",
      },
    ],
    final: { reasoning: "概括工具返回的三个颜色字段。", text: "演示颜色是蓝色主色、紫色强调色和纸白背景。" },
  },
  {
    user: "最后做一次完整检查：核对目录、README、颜色和 notes/idea.md，再给出总结。",
    steps: [
      {
        call: toolCall("call_nav_t5_list", "list_directory", { path: "." }),
        result: listResult,
        reasoning: "先重新确认完整目录。",
        text: "我先从目录清单开始核对。",
      },
      {
        call: toolCall("call_nav_t5_readme", "read_file", { path: "README.md", start_line: 1, end_line: 12 }),
        result: readResult,
        reasoning: "目录已确认，继续核对 README。",
        text: "接着核对 README 的项目目标。",
      },
      {
        call: toolCall("call_nav_t5_colors", "read_file", { path: "data/colors.json", start_line: 1, end_line: 20 }),
        result: colorsResult,
        reasoning: "README 已确认，继续核对颜色配置。",
        text: "现在核对颜色配置。",
      },
      {
        call: toolCall("call_nav_t5_idea", "read_file", { path: "notes/idea.md", start_line: 1, end_line: 20 }),
        result: ideaResult,
        reasoning: "最后读取演示想法，再统一总结。",
        text: "最后读取 notes/idea.md。",
      },
    ],
    final: {
      reasoning: "四项公开证据已经齐全，给出简洁总结。",
      text: "检查完成：目录、项目目标、配色和演示思路相互一致，适合用于 PMA 的公开教学轨迹。",
    },
  },
  {
    user: "用三点概括我们刚才完成了什么。",
    steps: [],
    final: {
      reasoning: "从完整对话历史提取三个阶段。",
      text: "一、确认项目目标；二、核对配色与演示说明；三、形成了可沿工具证据复查的总结。",
    },
  },
];
const navigationResponses = navigationTurns.flatMap((turn, turnIndex) => [
  ...turn.steps.map((step, stepIndex) => modelFixture(
    `resp_navigation_${turnIndex + 1}_${stepIndex + 1}`,
    step.reasoning,
    step.text,
    step.call,
    360 + turnIndex * 180 + stepIndex * 120,
  )),
  modelFixture(
    `resp_navigation_${turnIndex + 1}_final`,
    turn.final.reasoning,
    turn.final.text,
    null,
    420 + turnIndex * 240 + turn.steps.length * 120,
  ),
]);

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

const navigationWatch = await postJson(`${viewer.url}/api/watch/start`, {
  agent: "Codex",
  mode: "single_session",
  workspace: "/demo/navigation-lab",
  conversation_id: "navigation-long-trace",
  target_base_url: upstreamUrl,
  kind: "codex_proxy_exact",
  confidence: "exact",
  reuse: false,
});
const navigationHistory = [message("developer", "这是公开的长轨迹演示；只使用已提供的虚构文件内容。")];
for (const turn of navigationTurns) {
  const userMessage = message("user", turn.user);
  const currentTurn = [...navigationHistory, userMessage];
  for (const step of turn.steps) {
    await postResponses(navigationWatch.base_url, requestPayload(currentTurn, "navigation"));
    currentTurn.push(step.call, { type: "function_call_output", call_id: step.call.call_id, output: step.result });
  }
  await postResponses(navigationWatch.base_url, requestPayload(currentTurn, "navigation"));
  navigationHistory.push(
    userMessage,
    ...currentTurn.slice(navigationHistory.length + 1),
    message("assistant", turn.final.text),
  );
}

console.log(`README media demo: ${viewer.url}`);
console.log(`Quick-start source: ${viewer.url}/?source=${encodeURIComponent(watch.id)}`);
console.log(`Navigation source: ${viewer.url}/?source=${encodeURIComponent(navigationWatch.id)}`);
console.log("Deterministic synthetic provider; no external request or user file was used.");
console.log("Press Ctrl-C to stop.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await viewer.close();
    await closeServer(upstream);
    process.exit(0);
  });
}

function requestPayload(input, demo = "quickstart") {
  return {
    model: "gpt-5.6",
    instructions,
    input,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "medium", summary: "auto" },
    stream: true,
    metadata: { demo, privacy: "synthetic" },
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
  if (index === 2) return {
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
  return navigationResponses[index - 3] ?? navigationResponses.at(-1);
}

function toolCall(callId, name, args) {
  return { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) };
}

function message(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

function modelFixture(id, reasoning, text, call = null, inputTokens = 400) {
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
      output_tokens: call ? 72 : 54,
      input_tokens_details: { cached_tokens: Math.max(0, inputTokens - 260) },
    },
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
