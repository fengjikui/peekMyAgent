#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "claude-skill-real-cli");
const stateDir = path.join(runRoot, "state");
const disposableRoot = "/tmp/pma-claude-skill-demo";
const workspace = path.join(disposableRoot, "public-project");
const configDir = path.join(disposableRoot, "claude-config");
const hookLog = path.join(disposableRoot, "hooks.jsonl");
const requestLog = path.join(runRoot, "upstream-requests.jsonl");
const descriptorPath = path.join(runRoot, "session.json");

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(disposableRoot, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(workspace, ".claude", "skills", "project-summary"), { recursive: true });
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const trustedWorkspace = fs.realpathSync(workspace);
const installedClaudeVersion = claudeVersion();

const readmePath = path.join(trustedWorkspace, "README.md");
const skillPath = path.join(trustedWorkspace, ".claude", "skills", "project-summary", "SKILL.md");
fs.writeFileSync(readmePath, [
  "# Blue Lantern",
  "",
  "项目名：Blue Lantern。",
  "目标：用一个极简公开项目演示 Agent Skill 的加载与工具闭环。",
  "下一步：在 PMA 中比较 Skill 加载前后的模型请求。",
].join("\n"));
fs.writeFileSync(skillPath, [
  "---",
  "name: project-summary",
  "description: Read the public README and return exactly three Chinese bullets for project name, goal, and next step. Use when the user asks for the Blue Lantern project summary.",
  "---",
  "",
  "# Project summary",
  "",
  "1. Read README.md with the Read tool.",
  "2. Return exactly three Chinese bullets labeled 项目名、目标、下一步。",
  "3. Use only facts present in README.md. Do not edit files and do not access the network.",
].join("\n"));
fs.writeFileSync(path.join(trustedWorkspace, "CLAUDE.md"), [
  "# Public Skill demo",
  "",
  "This is the fictional Blue Lantern teaching project.",
  "Use only files in this disposable workspace and never access the network.",
  "The requested task is read-only. Do not edit, write, or delete files.",
].join("\n"));

fs.writeFileSync(path.join(trustedWorkspace, ".pma-hook-log.mjs"), [
  "import fs from 'node:fs';",
  "const chunks = [];",
  "for await (const chunk of process.stdin) chunks.push(chunk);",
  "const raw = Buffer.concat(chunks).toString('utf8').trim();",
  "if (raw) fs.appendFileSync('../hooks.jsonl', `${JSON.stringify(JSON.parse(raw))}\\n`);",
].join("\n"));
const hookCommand = "node .pma-hook-log.mjs";
fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
  theme: "light",
  skipDangerousModePermissionPrompt: true,
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }],
    PreToolUse: [{ matcher: "Skill|Read", hooks: [{ type: "command", command: hookCommand }] }],
    PostToolUse: [{ matcher: "Skill|Read", hooks: [{ type: "command", command: hookCommand }] }],
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

const responses = [
  [
    textBlock("我会先加载 project-summary Skill。"),
    toolBlock("skill_project_summary", "Skill", { skill: "project-summary" }),
  ],
  [
    textBlock("Skill 已进入当前会话；现在按它的步骤读取 README.md。"),
    toolBlock("read_skill_demo_readme", "Read", { file_path: readmePath }),
  ],
  [textBlock([
    "- 项目名：Blue Lantern。",
    "- 目标：用一个极简公开项目演示 Agent Skill 的加载与工具闭环。",
    "- 下一步：在 PMA 中比较 Skill 加载前后的模型请求。",
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
  expected_turns: 1,
  expected_model_requests: 3,
  prompt: "请使用 project-summary Skill，总结这个公开演示项目。",
  files_before: {
    README_md_sha256: sha256(readmePath),
    SKILL_md_sha256: sha256(skillPath),
  },
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
      "pma-skill-demo",
    ],
  },
  privacy: "Fictional files, local mock upstream, isolated Claude config, no provider credentials.",
};
fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

console.log(`Claude Skill real-CLI probe: ${descriptorPath}`);
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

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function claudeVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function writeAnthropicSse(reply, content, index) {
  const id = `msg_skill_probe_${String(index).padStart(3, "0")}`;
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
