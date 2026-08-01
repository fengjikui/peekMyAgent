#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "claude-planning-real-cli");
const stateDir = path.join(runRoot, "state");
const disposableRoot = "/tmp/pma-claude-planning-demo";
const workspace = path.join(disposableRoot, "public-project");
const configDir = path.join(disposableRoot, "claude-config");
const hookLog = path.join(disposableRoot, "hooks.jsonl");
const requestLog = path.join(runRoot, "upstream-requests.jsonl");
const descriptorPath = path.join(runRoot, "session.json");

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(disposableRoot, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const trustedWorkspace = fs.realpathSync(workspace);
const installedClaudeVersion = claudeVersion();

fs.writeFileSync(path.join(workspace, "README.md"), [
  "# Blue Lantern",
  "",
  "目标：演示如何用 PMA 检查一个多步 Agent 任务。",
  "",
  "首页建议：先说明一个用户 Turn 可以包含多次模型 Request。",
].join("\n"));
fs.writeFileSync(path.join(workspace, "docs", "guide.md"), [
  "# 公开快速指南",
  "",
  "1. 先看 Turn Rail，定位用户任务阶段。",
  "2. 再看 Request Rail，逐次检查工具调用与结果。",
  "3. 最后打开 History，核对最终模型实际收到的上下文。",
].join("\n"));
fs.writeFileSync(path.join(workspace, "CLAUDE.md"), [
  "# Public planning demo",
  "",
  "This is the fictional Blue Lantern teaching project.",
  "Use only files in this disposable workspace and never access the network.",
  "The requested task is read-only. Do not edit, write, or delete files.",
  "For the final multi-step request, maintain visible task state and base every recommendation on README.md or docs/guide.md.",
].join("\n"));

fs.writeFileSync(path.join(workspace, ".pma-hook-log.mjs"), [
  "import fs from 'node:fs';",
  "const chunks = [];",
  "for await (const chunk of process.stdin) chunks.push(chunk);",
  "const raw = Buffer.concat(chunks).toString('utf8').trim();",
  "if (raw) fs.appendFileSync('../hooks.jsonl', `${JSON.stringify(JSON.parse(raw))}\\n`);",
].join("\n"));
const hookCommand = "node .pma-hook-log.mjs";
const toolMatcher = "TaskCreate|TaskUpdate|TaskGet|Read";
fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
  theme: "light",
  skipDangerousModePermissionPrompt: true,
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }],
    PreToolUse: [{ matcher: toolMatcher, hooks: [{ type: "command", command: hookCommand }] }],
    PostToolUse: [{ matcher: toolMatcher, hooks: [{ type: "command", command: hookCommand }] }],
  },
}, null, 2));
fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({
  hasCompletedOnboarding: true,
  lastOnboardingVersion: installedClaudeVersion.split(" ")[0],
  projects: {
    [trustedWorkspace]: {
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    },
  },
}, null, 2));

const taskInputs = {
  createReadme: {
    subject: "核对 README 项目目标",
    description: "只读读取 README.md，确认公开项目名称、目标和首页建议。",
    activeForm: "正在核对 README 项目目标",
  },
  createGuide: {
    subject: "核对快速指南",
    description: "只读读取 docs/guide.md，确认新用户查看 PMA 的顺序。",
    activeForm: "正在核对快速指南",
  },
};
const responses = [
  [textBlock("记住了：公开演示项目是 Blue Lantern。")],
  [textBlock("明白，这次只做只读检查，不会修改文件。")],
  [textBlock("明白，最终建议必须能对应到实际读取的文件内容。")],
  [
    textBlock("我先把两个核对目标外化成可见任务。"),
    toolBlock("task_create_readme", "TaskCreate", taskInputs.createReadme),
    toolBlock("task_create_guide", "TaskCreate", taskInputs.createGuide),
  ],
  [
    textBlock("任务已经建立，先把两项标记为进行中。"),
    toolBlock("task_start_readme", "TaskUpdate", { taskId: "1", status: "in_progress" }),
    toolBlock("task_start_guide", "TaskUpdate", { taskId: "2", status: "in_progress" }),
  ],
  [
    textBlock("先读取 README.md，核对项目目标。"),
    toolBlock("read_planning_readme", "Read", { file_path: path.join(trustedWorkspace, "README.md") }),
  ],
  [
    textBlock("README 已返回，继续读取公开快速指南。"),
    toolBlock("read_planning_guide", "Read", { file_path: path.join(trustedWorkspace, "docs", "guide.md") }),
  ],
  [
    textBlock("两份文件已经核对，完成前先读取任务的最新状态。"),
    toolBlock("task_get_readme", "TaskGet", { taskId: "1" }),
    toolBlock("task_get_guide", "TaskGet", { taskId: "2" }),
  ],
  [
    textBlock("任务状态与实际进度一致，现在把两项标记为完成。"),
    toolBlock("task_complete_readme", "TaskUpdate", { taskId: "1", status: "completed" }),
    toolBlock("task_complete_guide", "TaskUpdate", { taskId: "2", status: "completed" }),
  ],
  [textBlock([
    "三条建议：",
    "1. README 首屏先说明：一个用户 Turn 可以包含多次模型 Request。",
    "2. 快速指南先用 Turn Rail 定位任务，再用 Request Rail 检查每次工具往返。",
    "3. 最后打开 History，核对最终模型是否真的收到了两份文件证据。",
    "",
    "两项只读任务均已完成，没有修改任何文件。",
  ].join("\n"))],
];

let responseIndex = 0;
const upstream = http.createServer(async (request, reply) => {
  const rawBody = await readBody(request);
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {}

  if (/\/count_tokens(?:\?|$)/.test(request.url || "")) {
    const chars = JSON.stringify(body || {}).length;
    reply.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    reply.end(JSON.stringify({ input_tokens: Math.max(64, Math.ceil(chars / 4)) }));
    return;
  }

  responseIndex += 1;
  fs.appendFileSync(requestLog, `${JSON.stringify({
    index: responseIndex,
    method: request.method,
    path: request.url,
    body,
  })}\n`);
  const content = responses[responseIndex - 1] || [textBlock("演示队列已经结束。")];
  writeAnthropicSse(reply, content, responseIndex);
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({
  cwd: root,
  port: 0,
  capturePort: 0,
  storePath: path.join(stateDir, "store.sqlite"),
});

const descriptor = {
  claude_version: installedClaudeVersion,
  viewer_url: viewer.url,
  upstream_url: upstreamUrl,
  workspace: trustedWorkspace,
  config_dir: configDir,
  hook_log: hookLog,
  request_log: requestLog,
  store_path: path.join(stateDir, "store.sqlite"),
  expected_turns: 4,
  expected_requests: 10,
  expected_requests_per_turn: [1, 1, 1, 7],
  prompts: [
    "演示项目叫 Blue Lantern，请记住。",
    "这次只做只读检查，不修改文件。",
    "最终建议必须能对应到实际文件内容。",
    "只读核对 README.md 和 docs/guide.md：先建立任务清单，逐个读取两个文件，更新任务状态，最后给我三条让新用户更容易理解 PMA 的建议。不要修改任何文件。",
  ],
  launch: {
    cwd: trustedWorkspace,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      PEEK_CLAUDE_TARGET_BASE_URL: upstreamUrl,
      ANTHROPIC_AUTH_TOKEN: "local-deterministic-test",
    },
    command: [
      "node",
      path.join(root, "bin", "peekmyagent.mjs"),
      "run",
      "claude",
      "--viewer-url",
      viewer.url,
      "--watch",
      "new",
      "--",
      "--dangerously-skip-permissions",
      "--model",
      "claude-probe-local",
      "--name",
      "pma-planning-demo",
    ],
  },
  privacy: "Fictional files, local mock upstream, isolated Claude config, no provider credentials.",
};
fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

console.log(`Claude planning real-CLI probe: ${descriptorPath}`);
console.log(JSON.stringify(descriptor, null, 2));
console.log("Keep this process running while a separate PTY launches Claude Code through PMA.");

const close = async () => {
  await viewer.close().catch(() => {});
  await closeServer(upstream).catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await close();
    process.exit(0);
  });
}
await new Promise(() => {});

function textBlock(text) {
  return { type: "text", text };
}

function toolBlock(id, name, input) {
  return { type: "tool_use", id, name, input };
}

function claudeVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function writeAnthropicSse(reply, content, index) {
  const id = `msg_planning_probe_${String(index).padStart(3, "0")}`;
  const events = [[
    "message_start",
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-probe-local",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 128, output_tokens: 0 },
      },
    },
  ]];

  for (const [blockIndex, block] of content.entries()) {
    if (block.type === "text") {
      events.push(
        ["content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: block.text } }],
        ["content_block_stop", { type: "content_block_stop", index: blockIndex }],
      );
      continue;
    }
    events.push(
      ["content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }],
      ["content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      }],
      ["content_block_stop", { type: "content_block_stop", index: blockIndex }],
    );
  }

  const hasToolUse = content.some((block) => block.type === "tool_use");
  const outputText = content.map((block) => block.type === "text" ? block.text : JSON.stringify(block.input)).join("\n");
  events.push(
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: Math.max(1, Math.ceil(outputText.length / 4)) },
    }],
    ["message_stop", { type: "message_stop" }],
  );

  reply.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const [event, data] of events) reply.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  reply.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
