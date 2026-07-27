#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, "tmp", "readme-media-state");
const storePath = path.join(stateDir, "store.sqlite");
const port = readPort(process.argv.slice(2));
const workspace = "/workspace/peekmyagent-demo";
const toolResult = JSON.stringify({
  file: "README.md",
  status: "ok",
  notes: Array.from({ length: 120 }, (_, index) => `line ${index + 1}: public demo evidence only`),
});
const imageBytes = makeDemoPng(320, 180);
const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;

fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(stateDir, "demo-input.png"), imageBytes);

let responseIndex = 0;
const upstream = http.createServer(async (request, response) => {
  await readBody(request);
  const payload = demoResponse(responseIndex);
  responseIndex += 1;
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`);
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({
  cwd: root,
  port,
  storePath,
  capturePort: 0,
});

const watch = await postJson(`${viewer.url}/api/watch/start`, {
  agent: "Codex",
  mode: "single_session",
  workspace,
  conversation_id: "readme-protocol-demo",
  target_base_url: upstreamUrl,
  kind: "codex_proxy_exact",
  confidence: "exact",
  reuse: false,
});

const firstInput = [
  {
    type: "additional_tools",
    role: "developer",
    tools: [
      { type: "custom", name: "exec", description: "Run a bounded local command." },
      { type: "custom", name: "wait", description: "Wait for an existing command." },
      {
        type: "namespace",
        name: "collaboration",
        description: "Tools for spawning and managing sub-agents.",
        tools: [
          {
            type: "function",
            name: "followup_task",
            description: "Send a follow-up task to an existing agent.",
            parameters: {
              type: "object",
              properties: {
                target: { type: "string", description: "Target agent id." },
                message: { type: "string", description: "Follow-up task." },
              },
              required: ["target", "message"],
            },
          },
          {
            type: "namespace",
            name: "mailbox",
            tools: [
              {
                type: "function",
                name: "send_message",
                description: "Send a message to another agent.",
                defer_loading: true,
                parameters: { type: "object", properties: { message: { type: "string" } } },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "You are Codex. Inspect repository evidence before answering." }],
  },
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "请检查 README.md，并解释工具目录中的 namespace 是如何展开的。" }],
  },
];

await postResponses(watch.base_url, {
  model: "gpt-5.6",
  tools: [
    {
      type: "function",
      name: "shell",
      description: "Run a safe shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  ],
  input: firstInput,
});

await postResponses(watch.base_url, {
  model: "gpt-5.6",
  previous_response_id: "resp_readme_demo_1",
  tools: [
    {
      type: "function",
      name: "shell",
      description: "Run a safe shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  ],
  input: [
    ...firstInput,
    { type: "custom_tool_call", call_id: "call_readme_demo", name: "exec", input: "sed -n '1,40p' README.md" },
    { type: "custom_tool_call_output", call_id: "call_readme_demo", output: toolResult },
    {
      type: "tool_search_output",
      tools: [
        {
          type: "namespace",
          name: "web",
          tools: [{ type: "function", name: "open", description: "Open a page.", defer_loading: true }],
        },
      ],
    },
  ],
});

await postResponses(watch.base_url, {
  model: "gpt-5.6",
  input: [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Describe only the provided anonymous image." }],
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "请说明这张匿名演示图的主要颜色。" },
        { type: "input_image", image_url: imageDataUrl },
      ],
    },
  ],
});

console.log(`README media demo: ${viewer.url}`);
console.log(`Source: ${viewer.url}/?source=${encodeURIComponent(watch.id)}`);
console.log("Synthetic provider only; no external request was sent.");
console.log("Press Ctrl-C to stop.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await viewer.close();
    await closeServer(upstream);
    process.exit(0);
  });
}

function demoResponse(index) {
  if (index === 0) {
    return {
      id: "resp_readme_demo_1",
      model: "gpt-5.6",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the README before explaining the tool catalog." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "我会先检查 README，再根据真实协议结构解释 namespace。" }] },
        { type: "custom_tool_call", call_id: "call_readme_demo", name: "exec", input: "sed -n '1,40p' README.md" },
      ],
      usage: { input_tokens: 620, output_tokens: 96 },
    };
  }
  if (index === 1) {
    return {
      id: "resp_readme_demo_2",
      model: "gpt-5.6",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Use the returned README evidence and preserve namespace identity." }] },
        {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "检查完成：collaboration 是命名空间容器；实际可调用叶子是 collaboration.followup_task 与 collaboration.mailbox.send_message。",
          }],
        },
      ],
      usage: { input_tokens: 980, output_tokens: 128 },
    };
  }
  return {
    id: "resp_readme_demo_3",
    model: "gpt-5.6",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "这张匿名演示图由蓝色、紫色和浅色背景组成。" }],
      },
    ],
    usage: { input_tokens: 180, output_tokens: 32 },
  };
}

async function postResponses(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer readme-demo-only" },
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

function makeDemoPng(width, height) {
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const mix = x / Math.max(1, width - 1);
      raw[offset] = Math.round(50 + 70 * mix);
      raw[offset + 1] = Math.round(110 - 35 * mix);
      raw[offset + 2] = Math.round(220 + 20 * mix);
      raw[offset + 3] = 255;
    }
  }
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
