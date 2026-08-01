#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "claude-subagents-real-cli");
const stateDir = path.join(runRoot, "state");
const disposableRoot = "/tmp/pma-claude-subagents-demo";
const workspace = path.join(disposableRoot, "public-project");
const configDir = path.join(disposableRoot, "claude-config");
const hookLog = path.join(disposableRoot, "hooks.jsonl");
const requestLog = path.join(runRoot, "upstream-requests.jsonl");
const descriptorPath = path.join(runRoot, "session.json");

const DOC_MARKER = "PMA_DOC_BRANCH_TASK";
const CATALOG_MARKER = "PMA_CATALOG_BRANCH_TASK";
const AGENT_DOC_ID = "agent_quickstart";
const AGENT_CATALOG_ID = "agent_catalog";
const READ_ID = "read_subagent_guide";
const BASH_ID = "bash_subagent_docs";

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(disposableRoot, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const trustedWorkspace = fs.realpathSync(workspace);
const installedClaudeVersion = claudeVersion();

const readmePath = path.join(trustedWorkspace, "README.md");
const guidePath = path.join(trustedWorkspace, "docs", "guide.md");
const viewerPath = path.join(trustedWorkspace, "docs", "viewer.md");
fs.writeFileSync(readmePath, [
  "# Blue Lantern",
  "",
  "这是一个完全虚构、只包含公开演示文字的 PMA 教学项目。",
  "README 负责三十秒产品概览；docs/guide.md 负责第一次真实观察。",
].join("\n"));
fs.writeFileSync(guidePath, [
  "# 五分钟快速开始",
  "",
  "1. 使用 PMA 启动 Claude Code，并在一次性公开项目中提出只读问题。",
  "2. 打开 Viewer，先用 Turn 定位用户阶段，再用 Request 查看内部模型往返。",
  "3. 点击工具调用和来源链接，核对参数、结果与最终回答。",
].join("\n"));
fs.writeFileSync(viewerPath, [
  "# Viewer 阅读顺序",
  "",
  "先看时间线，再打开请求详情；需要协议证据时使用协议视图或 Raw。",
].join("\n"));
fs.writeFileSync(path.join(trustedWorkspace, "CLAUDE.md"), [
  "# Public subagent demo",
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
    PreToolUse: [{ matcher: "Agent|Read|Bash", hooks: [{ type: "command", command: hookCommand }] }],
    PostToolUse: [{ matcher: "Agent|Read|Bash", hooks: [{ type: "command", command: hookCommand }] }],
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

const docPrompt = [
  DOC_MARKER,
  "只读核对 docs/guide.md。必须先用 Read 工具读取该文件，再返回两条简短中文结论：第一步做什么、在 Viewer 中先看什么。",
  "不要修改文件，不要访问网络，不要启动其他子 Agent。",
].join("\n");
const catalogPrompt = [
  CATALOG_MARKER,
  "只读核对公开 docs 目录。必须先用 Bash 工具运行给定的只读 find 命令列出 docs/*.md，再返回两条简短中文结论：有哪些公开文档、第一次应先打开哪一份。",
  "不要修改文件，不要访问网络，不要启动其他子 Agent。",
].join("\n");

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

  const kind = classifyRequest(request.headers, body);
  const agentId = headerValue(request.headers, "x-claude-code-agent-id");
  fs.appendFileSync(requestLog, `${JSON.stringify({
    received_at: new Date().toISOString(),
    kind,
    method: request.method,
    path: request.url,
    agent_id_present: Boolean(agentId),
    agent_id_hash: agentId ? createHash("sha256").update(agentId).digest("hex").slice(0, 12) : null,
    body,
  })}\n`);

  if (kind === "doc-final") await delay(600);
  const content = responseFor(kind);
  writeAnthropicSse(reply, content, kind);
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
  expected_turns: 3,
  expected_model_requests: 8,
  expected_child_branches: 2,
  request_order_note: "The catalog child completes first. Claude Code wakes the parent once per asynchronous task notification, then emits the final response only after the delayed document child returns.",
  prompt: "请启动两个只读 Explore 子 Agent：一个核对 docs/guide.md 的快速开始步骤，另一个核对公开 docs 目录入口。等待两者返回后，用三条中文要点总结：两个分支分别做了什么，以及新用户应该先看哪里。不要修改任何文件。",
  files_before: {
    README_md_sha256: sha256(readmePath),
    guide_md_sha256: sha256(guidePath),
    viewer_md_sha256: sha256(viewerPath),
  },
  launch: {
    cwd: trustedWorkspace,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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
      "pma-subagents-demo",
    ],
  },
  privacy: "Fictional files, local deterministic upstream, isolated Claude config, no provider credentials or external requests.",
};
fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

console.log(`Claude subagents real-CLI probe: ${descriptorPath}`);
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

function classifyRequest(headers, body) {
  const text = JSON.stringify(body || {});
  const toolResultIds = collectToolResultIds(body);
  const agentId = headerValue(headers, "x-claude-code-agent-id");
  if (agentId) {
    if (toolResultIds.has(READ_ID)) return "doc-final";
    if (toolResultIds.has(BASH_ID)) return "catalog-final";
    if (text.includes(DOC_MARKER)) return "doc-start";
    if (text.includes(CATALOG_MARKER)) return "catalog-start";
    return "unknown-child";
  }
  const notifications = completedAgentNotifications(text);
  if (notifications.has(AGENT_DOC_ID) && notifications.has(AGENT_CATALOG_ID)) return "parent-final";
  if (notifications.size) return "parent-wait-one";
  if (toolResultIds.has(AGENT_DOC_ID) || toolResultIds.has(AGENT_CATALOG_ID)) return "parent-wait-launch";
  return "parent-spawn";
}

function completedAgentNotifications(text) {
  const ids = new Set();
  for (const id of [AGENT_DOC_ID, AGENT_CATALOG_ID]) {
    if (text.includes("<task-notification>") && text.includes(`<tool-use-id>${id}</tool-use-id>`)) ids.add(id);
  }
  return ids;
}

function collectToolResultIds(body) {
  const ids = new Set();
  for (const message of body?.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_result" && block.tool_use_id) ids.add(block.tool_use_id);
    }
  }
  return ids;
}

function responseFor(kind) {
  if (kind === "parent-spawn") {
    return [
      textBlock("我会把两个只读核对任务分别交给 Explore 子 Agent。"),
      toolBlock(AGENT_DOC_ID, "Agent", {
        description: "核对快速开始",
        prompt: docPrompt,
        subagent_type: "Explore",
      }),
      toolBlock(AGENT_CATALOG_ID, "Agent", {
        description: "核对公开目录",
        prompt: catalogPrompt,
        subagent_type: "Explore",
      }),
    ];
  }
  if (kind === "doc-start") {
    return [
      textBlock("我先只读打开公开快速开始文档。"),
      toolBlock(READ_ID, "Read", { file_path: guidePath }),
    ];
  }
  if (kind === "doc-final") {
    return [textBlock([
      "- 第一步：使用 PMA 启动 Claude Code，并提出只读问题。",
      "- Viewer 顺序：先用 Turn 定位用户阶段，再用 Request 查看内部模型往返。",
    ].join("\n"))];
  }
  if (kind === "catalog-start") {
    return [
      textBlock("我先只读列出公开 docs 目录中的 Markdown 文件。"),
      toolBlock(BASH_ID, "Bash", {
        command: "find docs -maxdepth 1 -name '*.md' -type f -print | sort",
        description: "列出公开 docs Markdown 文件",
      }),
    ];
  }
  if (kind === "catalog-final") {
    return [textBlock([
      "- 公开文档：docs/guide.md、docs/viewer.md。",
      "- 第一次先打开 docs/guide.md，再按需查看 Viewer 细节。",
    ].join("\n"))];
  }
  if (kind === "parent-wait-launch") {
    return [textBlock("两个只读子 Agent 已在后台启动；我会等待完成通知，不提前猜测结果。")];
  }
  if (kind === "parent-wait-one") {
    return [textBlock("第一个子 Agent 已经返回；另一个仍在运行，等第二个完成后再统一汇总。")];
  }
  if (kind === "parent-final") {
    return [textBlock([
      "- 快速开始分支读取了 docs/guide.md，确认先启动 PMA，再用 Turn 和 Request 两级导航观察内部往返。",
      "- 目录分支列出了 docs/guide.md 与 docs/viewer.md，建议第一次先读 guide.md。",
      "- 两个结果都已回到父对话；新用户应先完成一次只读观察，再按需进入协议视图或 Raw。",
    ].join("\n"))];
  }
  return [textBlock(`Unexpected deterministic branch: ${kind}`)];
}

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

function writeAnthropicSse(reply, content, kind) {
  const id = `msg_subagent_probe_${kind.replace(/[^a-z0-9]+/gi, "_")}_${Date.now()}`;
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

function headerValue(headers, name) {
  const value = headers?.[name] || headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
