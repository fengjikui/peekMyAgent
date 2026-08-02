#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, "tmp", "claude-mechanisms-media-state");
const storePath = path.join(stateDir, "store.sqlite");
const port = readPort(process.argv.slice(2));
const verifyOnly = process.argv.includes("--verify");

const publicSystem = [{
  type: "text",
  text: "This is a deterministic public Claude Code teaching trace. Use only fictional /demo files; never access credentials, user files, or the network.",
}];
const readTool = tool("Read", "Read a bounded range from a public demo file.", {
  file_path: { type: "string", description: "Project-relative public demo path." },
  offset: { type: "integer", description: "First line, starting at 1." },
  limit: { type: "integer", description: "Maximum lines to return." },
}, ["file_path"]);
const globTool = tool("Glob", "Find public demo files by glob pattern.", {
  pattern: { type: "string" },
  path: { type: "string" },
}, ["pattern"]);
const bashTool = tool("Bash", "Run an explicitly approved command in the public demo directory.", {
  command: { type: "string" },
  description: { type: "string" },
}, ["command"]);
const skillTool = tool("Skill", "Load a discovered reusable workflow into the current conversation.", {
  skill: { type: "string" },
  args: { type: "string" },
}, ["skill"]);
const taskCreateTool = tool("TaskCreate", "Create a visible task item for a multi-step job.", {
  subject: { type: "string" },
  description: { type: "string" },
  activeForm: { type: "string" },
}, ["subject", "description"]);
const taskUpdateTool = tool("TaskUpdate", "Update the status of an existing task item.", {
  taskId: { type: "string" },
  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
}, ["taskId", "status"]);

const helloRead = toolUse("read_hello", "Read", { file_path: "README.md", offset: 1, limit: 1 });
const skillCall = toolUse("skill_project_summary", "Skill", { skill: "project-summary" });
const skillRead = toolUse("read_skill_readme", "Read", { file_path: "README.md", offset: 1, limit: 12 });
const createReadme = toolUse("task_create_readme", "TaskCreate", {
  subject: "核对 README",
  description: "只读检查项目名称与目标。",
  activeForm: "正在核对 README",
});
const createGuide = toolUse("task_create_guide", "TaskCreate", {
  subject: "核对快速开始",
  description: "只读检查快速开始的范围。",
  activeForm: "正在核对快速开始",
});
const readReadme = toolUse("read_plan_readme", "Read", { file_path: "README.md", offset: 1, limit: 12 });
const readGuide = toolUse("read_plan_guide", "Read", { file_path: "docs/guide.md", offset: 1, limit: 12 });
const completeReadme = toolUse("task_update_readme", "TaskUpdate", { taskId: "1", status: "completed" });
const completeGuide = toolUse("task_update_guide", "TaskUpdate", { taskId: "2", status: "completed" });
const compactPrompt = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "",
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests.",
  "Wrap your analysis in <analysis> tags then provide a <summary> block.",
].join("\n");

const queues = {
  "tool-loop": [
    response("msg_tool_read", [{ type: "text", text: "我先读取 README.md 第一行。" }, helloRead], "tool_use", 44),
    response("msg_tool_final", [{ type: "text", text: "项目名是 hello-agent。" }], "end_turn", 24),
  ],
  skill: [
    response("msg_skill_load", [{ type: "text", text: "我会先加载 project-summary skill。" }, skillCall], "tool_use", 42),
    response("msg_skill_ready", [{ type: "text", text: "Skill 调用已确认，等待 Harness 注入正文。" }], "end_turn", 30),
    response("msg_skill_read", [{ type: "text", text: "Skill 要求先读取 README.md。" }, skillRead], "tool_use", 46),
    response("msg_skill_final", [{ type: "text", text: "- 项目名：hello-agent\n- 目标：解释可检查的 Agent 工具闭环\n- 下一步：比较工具调用与回传证据" }], "end_turn", 58),
  ],
  planning: [
    response("msg_plan_welcome", [{ type: "text", text: "你好，我只会使用公开演示内容。" }], "end_turn", 22),
    response("msg_plan_name", [{ type: "text", text: "记住了：项目名是 hello-agent。" }], "end_turn", 24),
    response("msg_plan_known", [{ type: "text", text: "目前只知道项目名，还没有读取文件。" }], "end_turn", 26),
    response("msg_plan_tasks", [{ type: "text", text: "我先建立两个只读核对任务。" }, createReadme, createGuide], "tool_use", 64),
    response("msg_plan_readme", [{ type: "text", text: "任务已建立，先读取 README.md。" }, readReadme], "tool_use", 44),
    response("msg_plan_guide", [{ type: "text", text: "README 已核对，继续读取 docs/guide.md。" }, readGuide], "tool_use", 46),
    response("msg_plan_update", [{ type: "text", text: "两份证据已齐，更新任务状态。" }, completeReadme, completeGuide], "tool_use", 58),
    response("msg_plan_final", [{ type: "text", text: "一、保留 README 的一句话价值主张；二、用只读工具闭环完成快速开始；三、在进阶章节解释协议、Raw 与上下文变化。" }], "end_turn", 68),
  ],
  compact: [
    response("msg_compact_known", [{ type: "text", text: "记住了：公开项目名是 hello-agent。" }], "end_turn", 24),
    response("msg_compact_summary", [{ type: "text", text: "<summary>公开项目名是 hello-agent；尚未读取文件；后续只使用公开演示内容。</summary>" }], "end_turn", 50),
  ],
};

fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const offsets = Object.fromEntries(Object.keys(queues).map((key) => [key, 0]));
const upstream = http.createServer(async (request, reply) => {
  const body = await readJsonBody(request);
  const { demo } = parseMetadata(body?.metadata?.user_id);
  const queue = queues[demo];
  if (!queue) {
    reply.writeHead(400, { "content-type": "application/json" });
    reply.end(JSON.stringify({ error: { type: "invalid_request_error", message: `unknown synthetic demo: ${demo}` } }));
    return;
  }
  const payload = queue[offsets[demo]++] || queue.at(-1);
  reply.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  reply.end(JSON.stringify(payload));
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd: root, port, storePath, capturePort: 0 });
const sources = {};

sources.toolLoop = await createSource(viewer.url, upstreamUrl, "Claude 工具闭环", "/demo/claude-tool-loop", "claude-tool-loop");
const toolPrompt = "请读取 README.md 第一行，告诉我项目名；不要修改文件。";
await send(sources.toolLoop.baseUrl, request("tool-loop", "claude-tool-loop", [{ role: "user", content: toolPrompt }], [readTool, globTool, bashTool]), "claude-tool-loop");
await send(sources.toolLoop.baseUrl, request("tool-loop", "claude-tool-loop", [
  { role: "user", content: toolPrompt },
  { role: "assistant", content: [{ type: "text", text: "我先读取 README.md 第一行。" }, helloRead] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: helloRead.id, content: "# hello-agent" }] },
], [readTool, globTool, bashTool]), "claude-tool-loop");

sources.skill = await createSource(viewer.url, upstreamUrl, "Claude Skill 加载", "/demo/claude-skill", "claude-skill-load");
const skillPrompt = "请使用 project-summary skill，总结这个演示项目。";
const skillBody = [
  "Base directory for this skill: /demo/claude-skill/.claude/skills/project-summary",
  "",
  "# Project Summary",
  "Read README.md, then return exactly three bullets: project name, goal, and next step.",
].join("\n");
const skillSystem = [...publicSystem, {
  type: "text",
  text: "Available skill: project-summary — Read the public README and return project name, goal, and next step.",
}];
await send(sources.skill.baseUrl, request("skill", "claude-skill-load", [{ role: "user", content: skillPrompt }], [skillTool, readTool], skillSystem), "claude-skill-load");
const skillResultMessages = [
  { role: "user", content: skillPrompt },
  { role: "assistant", content: [{ type: "text", text: "我会先加载 project-summary skill。" }, skillCall] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: skillCall.id, content: "Skill loaded." }] },
];
await send(sources.skill.baseUrl, request("skill", "claude-skill-load", skillResultMessages, [skillTool, readTool], skillSystem), "claude-skill-load");
const skillMessages = [
  ...skillResultMessages,
  { role: "assistant", content: [{ type: "text", text: "Skill 调用已确认，等待 Harness 注入正文。" }] },
  { role: "user", content: skillBody },
];
await send(sources.skill.baseUrl, request("skill", "claude-skill-load", skillMessages, [skillTool, readTool], skillSystem), "claude-skill-load");
skillMessages.push(
  { role: "assistant", content: [{ type: "text", text: "Skill 要求先读取 README.md。" }, skillRead] },
  { role: "user", content: [{
    type: "tool_result",
    tool_use_id: skillRead.id,
    content: "# hello-agent\n\nGoal: teach a minimal, inspectable Agent tool loop.\nNext step: compare the tool call with its evidence.",
  }] },
);
await send(sources.skill.baseUrl, request("skill", "claude-skill-load", skillMessages, [skillTool, readTool], skillSystem), "claude-skill-load");

sources.planning = await createSource(viewer.url, upstreamUrl, "Claude 五 Request 规划", "/demo/claude-planning", "claude-five-request-plan");
const planningTools = [taskCreateTool, taskUpdateTool, readTool];
const history = [];
await simpleTurn(sources.planning.baseUrl, history, "你好。", "你好，我只会使用公开演示内容。", planningTools);
await simpleTurn(sources.planning.baseUrl, history, "请记住这个项目叫 hello-agent。", "记住了：项目名是 hello-agent。", planningTools);
await simpleTurn(sources.planning.baseUrl, history, "先别读文件，只说你现在知道什么。", "目前只知道项目名，还没有读取文件。", planningTools);
const planPrompt = "只读检查 README.md 和 docs/guide.md，先建立任务清单，核对两个文件，再给我三步改进计划；不要修改文件。";
const planMessages = [...history, { role: "user", content: planPrompt }];
await send(sources.planning.baseUrl, request("planning", "claude-five-request-plan", planMessages, planningTools), "claude-five-request-plan");
planMessages.push(
  { role: "assistant", content: [{ type: "text", text: "我先建立两个只读核对任务。" }, createReadme, createGuide] },
  { role: "user", content: [result(createReadme.id, { taskId: "1", status: "pending" }), result(createGuide.id, { taskId: "2", status: "pending" })] },
);
await send(sources.planning.baseUrl, request("planning", "claude-five-request-plan", planMessages, planningTools), "claude-five-request-plan");
planMessages.push(
  { role: "assistant", content: [{ type: "text", text: "任务已建立，先读取 README.md。" }, readReadme] },
  { role: "user", content: [result(readReadme.id, "# hello-agent\n\nGoal: explain an inspectable Agent tool loop.")] },
);
await send(sources.planning.baseUrl, request("planning", "claude-five-request-plan", planMessages, planningTools), "claude-five-request-plan");
planMessages.push(
  { role: "assistant", content: [{ type: "text", text: "README 已核对，继续读取 docs/guide.md。" }, readGuide] },
  { role: "user", content: [result(readGuide.id, "# 快速开始\n\nStart with one read-only task, then inspect requests, tools, results, and Raw.")] },
);
await send(sources.planning.baseUrl, request("planning", "claude-five-request-plan", planMessages, planningTools), "claude-five-request-plan");
planMessages.push(
  { role: "assistant", content: [{ type: "text", text: "两份证据已齐，更新任务状态。" }, completeReadme, completeGuide] },
  { role: "user", content: [result(completeReadme.id, { taskId: "1", status: "completed" }), result(completeGuide.id, { taskId: "2", status: "completed" })] },
);
await send(sources.planning.baseUrl, request("planning", "claude-five-request-plan", planMessages, planningTools), "claude-five-request-plan");

sources.compact = await createSource(viewer.url, upstreamUrl, "Claude compact 合约（待真实复核）", "/demo/claude-compact-contract", "claude-compact-contract");
await send(sources.compact.baseUrl, request("compact", "claude-compact-contract", [{ role: "user", content: "请记住：公开项目名是 hello-agent。" }], [readTool]), "claude-compact-contract");
await send(sources.compact.baseUrl, request("compact", "claude-compact-contract", [
  { role: "user", content: "请记住：公开项目名是 hello-agent。" },
  { role: "assistant", content: [{ type: "text", text: "记住了：公开项目名是 hello-agent。" }] },
  { role: "user", content: [{ type: "text", text: compactPrompt }] },
], [readTool], [...publicSystem, {
  type: "text",
  text: "Synthetic compact-classification contract only. Do not cite this Source as proof of current Claude Code post-compaction wire behavior.",
}]), "claude-compact-contract");

console.log(`Claude mechanisms media demo: ${viewer.url}`);
for (const [name, source] of Object.entries(sources)) console.log(`${name}: ${sourceUrl(viewer.url, source.id)}`);
console.log("Synthetic local provider and fictional /demo paths only.");

if (verifyOnly) {
  await verifySources(viewer.url, sources);
  console.log("Claude mechanisms media demo verification passed.");
  await viewer.close();
  await closeServer(upstream);
  process.exit(0);
}

console.log("Press Ctrl-C to stop.");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await viewer.close();
    await closeServer(upstream);
    process.exit(0);
  });
}

function request(demo, sessionId, messages, tools, system = publicSystem) {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system,
    tools,
    messages,
    stream: false,
    metadata: { user_id: JSON.stringify({ session_id: sessionId, demo, privacy: "synthetic" }) },
  };
}

function response(id, content, stopReason, outputTokens) {
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

function tool(name, description, properties, required) {
  return { name, description, input_schema: { type: "object", properties, required, additionalProperties: false } };
}

function toolUse(id, name, input) {
  return { type: "tool_use", id, name, input };
}

function result(toolUseId, content) {
  return { type: "tool_result", tool_use_id: toolUseId, content: typeof content === "string" ? content : JSON.stringify(content) };
}

async function simpleTurn(baseUrl, history, userText, assistantText, tools) {
  const user = { role: "user", content: userText };
  await send(baseUrl, request("planning", "claude-five-request-plan", [...history, user], tools), "claude-five-request-plan");
  history.push(user, { role: "assistant", content: [{ type: "text", text: assistantText }] });
}

async function createSource(viewerUrl, upstreamUrl, label, workspace, conversationId) {
  const watch = await postJson(`${viewerUrl}/api/watch/start`, {
    agent: "Claude Code",
    label,
    mode: "single_session",
    workspace,
    conversation_id: conversationId,
    target_base_url: upstreamUrl,
    kind: "claude_proxy_exact",
    confidence: "exact",
    reuse: false,
  });
  return { id: watch.id, baseUrl: watch.base_url };
}

async function send(baseUrl, payload, sessionId) {
  const sent = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "synthetic-demo-only",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId,
    },
    body: JSON.stringify(payload),
  });
  if (!sent.ok) throw new Error(`Anthropic demo request failed: ${sent.status} ${await sent.text()}`);
  await sent.text();
}

async function postJson(url, payload) {
  const sent = await fetch(url, { method: "POST", headers: jsonHeadersForUrl(url), body: JSON.stringify(payload) });
  const body = await sent.json();
  if (!sent.ok) throw new Error(`${url}: ${sent.status} ${JSON.stringify(body)}`);
  return body;
}

async function verifySources(viewerUrl, sources) {
  const toolLoop = await readView(viewerUrl, sources.toolLoop.id);
  assert.equal(toolLoop.requests.length, 2, "tool-loop request count");
  assert.equal(toolLoop.turns.length, 1, "tool-loop turn count");
  assert.ok(toolLoop.requests[1].summary.current_tool_results.some((item) => item.id === helloRead.id), "Read result returns in request 2");

  const skill = await readView(viewerUrl, sources.skill.id);
  assert.equal(skill.requests.length, 4, "skill request count");
  assert.ok(skill.requests.some((item) => item.summary.entry.kind === "harness_injection"), "Skill body is classified as Harness injection");

  const planning = await readView(viewerUrl, sources.planning.id);
  assert.equal(planning.requests.length, 8, "planning total request count");
  assert.equal(planning.turns.length, 4, "planning turn count");
  assert.deepEqual(planning.turns.map((turn) => turn.request_indexes.length), [1, 1, 1, 5], "final Turn contains five Requests");

  const compact = await readView(viewerUrl, sources.compact.id);
  assert.equal(compact.requests.length, 2, "compact contract request count");
  assert.equal(compact.requests[1].summary.entry.kind, "compact", "compact request classification");
}

async function readView(viewerUrl, sourceId) {
  const read = await fetch(`${viewerUrl}/api/view?source=${encodeURIComponent(sourceId)}`);
  if (!read.ok) throw new Error(`View verification failed: ${read.status} ${await read.text()}`);
  return read.json();
}

function sourceUrl(viewerUrl, sourceId) {
  return `${viewerUrl}/?source=${encodeURIComponent(sourceId)}`;
}

function parseMetadata(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function readPort(args) {
  const index = args.indexOf("--port");
  const value = index >= 0 ? Number(args[index + 1]) : 43114;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid --port: ${args[index + 1]}`);
  return value;
}

function readJsonBody(requestStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    requestStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    requestStream.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    requestStream.on("error", reject);
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
