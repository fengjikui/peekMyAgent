#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startViewerServer } from "../src/viewer/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "claude-compact-real-cli");
const stateDir = path.join(runRoot, "state");
const disposableRoot = "/tmp/pma-claude-compact-demo";
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
  "# blue-lantern",
  "",
  "A fictional project used only to explain Agent context compaction.",
].join("\n"));
fs.writeFileSync(path.join(workspace, "docs", "guide.md"), [
  "# Public guide",
  "",
  "Verified: the project name is blue-lantern.",
  "Pending: compare the request immediately before and after compaction.",
].join("\n"));
fs.writeFileSync(path.join(workspace, "CLAUDE.md"), [
  "# Public demo rule",
  "",
  "The fictional project codename is Blue Lantern.",
  "Use only files in this disposable demo workspace.",
  "When asked for the checkpoint, include the marker ROOT_RULE_RELOADED.",
].join("\n"));

fs.writeFileSync(path.join(workspace, ".pma-hook-log.mjs"), [
  "import fs from 'node:fs';",
  "const chunks = [];",
  "for await (const chunk of process.stdin) chunks.push(chunk);",
  "const raw = Buffer.concat(chunks).toString('utf8').trim();",
  "if (raw) fs.appendFileSync('../hooks.jsonl', `${JSON.stringify(JSON.parse(raw))}\\n`);",
].join("\n"));
const hookCommand = "node .pma-hook-log.mjs";
fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
  theme: "light",
  hooks: {
    PreCompact: [{ hooks: [{ type: "command", command: hookCommand }] }],
    SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }],
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

let responseIndex = 0;
const upstream = http.createServer(async (request, reply) => {
  const rawBody = await readBody(request);
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {}
  fs.appendFileSync(requestLog, `${JSON.stringify({
    index: responseIndex + 1,
    method: request.method,
    path: request.url,
    body,
  })}\n`);

  if (/\/count_tokens(?:\?|$)/.test(request.url || "")) {
    const chars = JSON.stringify(body || {}).length;
    reply.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    reply.end(JSON.stringify({ input_tokens: Math.max(64, Math.ceil(chars / 4)) }));
    return;
  }

  responseIndex += 1;
  const text = responseText(body, responseIndex);
  writeAnthropicSse(reply, text, responseIndex);
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
  workspace,
  config_dir: configDir,
  hook_log: hookLog,
  request_log: requestLog,
  store_path: path.join(stateDir, "store.sqlite"),
  privacy: "Fictional files, local mock upstream, isolated Claude config, no provider credentials.",
};
fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

console.log(`Claude compact real-CLI probe: ${descriptorPath}`);
console.log(JSON.stringify(descriptor, null, 2));
console.log("Keep this process running while the separate PTY launches Claude Code through PMA.");

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

function responseText(body, index) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const current = latestUserText(messages);
  const joined = messages.map((message) => contentText(message?.content)).join("\n");

  if (/create a detailed summary|provide a detailed summary|conversation so far|<summary>/i.test(current)) {
    return [
      "<summary>",
      "The fictional project is Blue Lantern (blue-lantern).",
      "Verified files: README.md and docs/guide.md.",
      "The user asked to preserve the project goal, verified files, and pending checkpoint.",
      "Pending: compare the request immediately before and after manual compaction.",
      "All content is public test data; do not use network access or files outside the disposable workspace.",
      "</summary>",
    ].join("\n");
  }
  if (/checkpoint|压缩后|compact/i.test(current) && /Blue Lantern|blue-lantern|summary/i.test(joined)) {
    return "项目是 Blue Lantern；已核对 README.md 与 docs/guide.md；待完成压缩前后请求比较。ROOT_RULE_RELOADED";
  }
  if (/title|sentence-case|3-7 words/i.test(joined)) return JSON.stringify({ title: "Blue Lantern context demo" });
  if (/README\.md/i.test(current)) return "已记录：README.md 说明这是虚构的上下文压缩演示项目。";
  if (/docs\/guide\.md|guide/i.test(current)) return "已记录：docs/guide.md 的待办是比较压缩前后的请求。";
  if (/记住|remember|项目/i.test(current)) return "记住了：公开演示项目是 Blue Lantern。";
  return `第 ${index} 次确定性回复：继续使用 Blue Lantern 的公开演示上下文。`;
}

function latestUserText(messages) {
  const content = [...messages].reverse().find((message) => message?.role === "user")?.content;
  if (!Array.isArray(content)) return contentText(content);
  const parts = content
    .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
    .filter(Boolean);
  return parts.at(-1) || "";
}

function claudeVersion() {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text || part?.content || "").join("\n");
}

function writeAnthropicSse(reply, text, index) {
  const id = `msg_compact_probe_${String(index).padStart(3, "0")}`;
  const events = [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-probe-local", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 128, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) } }],
    ["message_stop", { type: "message_stop" }],
  ];
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
