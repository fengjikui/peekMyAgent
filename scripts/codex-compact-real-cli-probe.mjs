#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { codexHttpProviderOverrides, CODEX_CAPTURE_PROVIDER_ID } from "../src/adapters/codex-exact-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "codex-compact-real-cli-probe");
const stateDir = path.join(runRoot, "pma-state");
const storePath = path.join(stateDir, "store.sqlite");
const descriptorPath = path.join(runRoot, "session.json");
const requestLogPath = path.join(runRoot, "upstream-requests.jsonl");
const notificationLogPath = path.join(runRoot, "app-server-notifications.jsonl");
const appServerStderrPath = path.join(runRoot, "app-server.stderr.txt");
const demoRoot = "/tmp/pma-codex-compact-demo";
const codexHome = path.join(demoRoot, "codex-home");
const workspace = path.join(demoRoot, "public-project");
const sourceName = "codex-context-compaction-guide";
const model = "gpt-5.2-codex";

const prompts = [
  "公开演示项目的代号是 Blue Lantern，入口文件是 README.md。请只复述这两个事实。",
  "再补充一个公开事实：guide.md 解释观察步骤。请列出目前三个事实。",
  "压缩前检查点：后续回答必须同时保留 Blue Lantern、README.md 和 guide.md。请确认。",
  "压缩已经完成。请用一句话复述项目代号、入口文件和观察指南。",
];
const replies = [
  "项目代号是 Blue Lantern，入口文件是 README.md。",
  "三个事实是：代号 Blue Lantern；入口文件 README.md；guide.md 解释观察步骤。",
  "已确认：后续回答会同时保留 Blue Lantern、README.md 和 guide.md。",
  "项目事实：代号是 Blue Lantern，入口文件是 README.md，guide.md 解释观察步骤。用户要求压缩后仍保留这三项事实；下一步是在压缩后复述它们。",
  "Blue Lantern 项目以 README.md 为入口，并由 guide.md 说明观察步骤。",
];

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(demoRoot, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "# Blue Lantern\n\nPublic deterministic Codex compaction demo.\n");
fs.writeFileSync(path.join(workspace, "guide.md"), "# Observation guide\n\nCompare requests before and after compaction.\n");
fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# Public demo rules\n\n- Do not modify files.\n- Use only the facts in the user messages.\n");
fs.writeFileSync(path.join(codexHome, "config.toml"), [
  "[analytics]",
  "enabled = false",
  "",
  "[features]",
  "plugins = false",
  "",
  "[skills]",
  "include_instructions = false",
  "",
].join("\n"));

process.env.PEEKMYAGENT_STATE_DIR = stateDir;

let modelRequestIndex = 0;
const observedUpstreamRequests = [];
const upstream = http.createServer(async (request, response) => {
  const bodyBuffer = await readBuffer(request);
  const decoded = decodeRequestBody(bodyBuffer, request.headers["content-encoding"]);
  const body = decoded.length ? JSON.parse(decoded.toString("utf8")) : {};
  const record = {
    index: observedUpstreamRequests.length + 1,
    method: request.method,
    path: request.url,
    content_encoding: request.headers["content-encoding"] || "identity",
    body,
  };
  observedUpstreamRequests.push(record);
  fs.appendFileSync(requestLogPath, `${JSON.stringify(record)}\n`);

  if (request.method === "GET" && request.url === "/backend-api/codex/models") {
    sendJson(response, 200, { data: [] });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: { message: "Only deterministic POST requests are supported." } });
    return;
  }
  if (request.url !== "/backend-api/codex/responses") {
    sendJson(response, 404, { error: { message: `Unexpected deterministic path: ${request.url}` } });
    return;
  }

  modelRequestIndex += 1;
  const reply = replies[modelRequestIndex - 1];
  if (!reply) {
    sendJson(response, 409, { error: { message: `Unexpected model request ${modelRequestIndex}.` } });
    return;
  }
  sendSseResponse(response, {
    id: `resp_codex_compact_demo_${modelRequestIndex}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: `msg_codex_compact_demo_${modelRequestIndex}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply, annotations: [] }],
    }],
    usage: {
      input_tokens: 300 + modelRequestIndex * 80,
      output_tokens: 24,
      total_tokens: 324 + modelRequestIndex * 80,
    },
  });
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd: root, port: 0, capturePort: 0, storePath });
let appServer;
let rpc;

try {
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Codex",
    mode: "single_session",
    workspace,
    conversation_id: "codex-context-compaction-demo",
    started_by: "codex-compact-real-cli-probe",
    reuse: false,
    target_base_url: upstreamUrl,
    kind: "codex_proxy_exact",
    confidence: "exact",
    label: "Codex · context compaction",
    note: "Real Codex App Server with deterministic loopback model responses.",
  });

  appServer = spawn("codex", [
    ...codexHttpProviderOverrides(watch.base_url),
    "-c", `model=${JSON.stringify(model)}`,
    "-c", "model_context_window=128000",
    "-c", "model_auto_compact_token_limit=120000",
    "-c", "memories.use_memories=false",
    "-c", "memories.generate_memories=false",
    "app-server",
    "--stdio",
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "local-public-placeholder",
      RUST_LOG: "warn",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  rpc = createStdioRpcClient(appServer, notificationLogPath, appServerStderrPath);
  await rpc.request("initialize", {
    clientInfo: { name: "peekmyagent-compaction-demo", title: "peekMyAgent compaction demo", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized", {});

  const started = await rpc.request("thread/start", {
    cwd: workspace,
    model,
    modelProvider: CODEX_CAPTURE_PROVIDER_ID,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
    baseInstructions: "You are Codex in a public deterministic context-compaction demonstration. Do not call tools. Answer only from user-provided facts.",
  });
  const threadId = started.thread?.id;
  assert.ok(threadId, "Codex App Server did not return a thread id");

  for (const prompt of prompts.slice(0, 3)) {
    await runTurn(rpc, threadId, prompt);
  }

  const beforeCompactNotifications = rpc.notifications.length;
  await rpc.request("thread/compact/start", { threadId });
  const compactItem = await rpc.waitFor(
    (message) =>
      message.method === "item/completed" &&
      message.params?.threadId === threadId &&
      message.params?.item?.type === "contextCompaction",
    15_000,
    beforeCompactNotifications,
  );
  assert.equal(compactItem.params.item.type, "contextCompaction");
  const compactTurn = await rpc.waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === compactItem.params.turnId,
    30_000,
    beforeCompactNotifications,
  );
  assert.equal(compactTurn.params.turn.status, "completed", JSON.stringify(compactTurn.params.turn.error || null));

  await runTurn(rpc, threadId, prompts[3]);
  await postJson(`${viewer.url}/api/watch/stop`, { id: watch.id, clear: false });

  const source = await sourceForConversation(viewer.url, "codex-context-compaction-demo");
  const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  verifyCapture(view, observedUpstreamRequests);

  const descriptor = {
    scenario_id: "codex-context-compaction-real-cli",
    codex_version: await codexVersion(),
    viewer_url: `${viewer.url}/?source=${encodeURIComponent(source.id)}`,
    source_id: source.id,
    protocol: "OpenAI Responses (local summary compaction)",
    source_kind: source.kind,
    turns: 4,
    captured_requests: view.requests.length,
    ordinary_turn_requests: 4,
    compaction_model_requests: observedUpstreamRequests.filter(isCompactionRequest).length,
    app_server_context_compaction_items: rpc.notifications.filter((message) =>
      message.method === "item/completed" && message.params?.item?.type === "contextCompaction").length,
    facts: [
      "Three ordinary turns establish public facts before manual compaction.",
      "Real Codex App Server thread/compact/start produces one Responses request marked request_kind=compaction.",
      "Because PMA routes Codex through a named custom provider, this installed Codex uses local summary compaction rather than the OpenAI-only /responses/compact path.",
      "The compaction request contains the accumulated conversation plus Codex's checkpoint prompt, and the deterministic model returns a readable handoff summary.",
      "The next ordinary request carries retained user messages, the generated summary, and the new user message.",
      "The post-compaction reply still uses the three public facts.",
    ],
    boundaries: [
      "Harness request construction and lifecycle come from the installed Codex App Server.",
      "Ordinary model replies and the compaction-summary reply are deterministic loopback fixtures, not remote model output.",
      "The summary response is deterministic and carries only the three public demo facts.",
      "This probe covers manual compaction only; automatic threshold behavior remains separate.",
      "Codex can use the dedicated /responses/compact endpoint for built-in OpenAI or Azure providers; this Source does not claim to demonstrate that separate path.",
    ],
    privacy: "Isolated CODEX_HOME, fixed /tmp workspace, public prompts, placeholder credential, loopback only.",
  };
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  console.log("\nCodex compaction demo is ready.");
  console.log(`Descriptor: ${descriptorPath}`);
  console.log(`Viewer: ${descriptor.viewer_url}`);
    console.log(`${descriptor.turns} ordinary Turns · ${descriptor.captured_requests} captured Requests · 1 manual compaction.`);
  console.log("Press Ctrl-C to stop local services.");
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

function verifyCapture(view, upstreamRequests) {
  assert.equal(view.source.kind, "codex_proxy_exact");
  assert.equal(view.requests.length, 5, "expected three turns, one compaction request, and one post-compaction turn");
  assert.equal(upstreamRequests.length, 5);
  const compact = view.requests.find((request) => request.summary?.entry?.operation === "context_compaction");
  assert.ok(compact, "missing exact request_kind=compaction Capture");
  assert.equal(compact.raw.path, "/v1/responses");
  assert.equal(compact.summary.entry.operation, "context_compaction");
  assert.equal(compact.source_hint.request_kind, "compaction");
  assert.equal(compact.raw.provenance.request.fidelity, "exact");
  assert.equal(compact.raw.provenance.response.fidelity, "exact");
  assert.equal(compact.summary.history_stack.some((item) =>
    item.kind === "compact" && item.text.includes("You are performing a CONTEXT CHECKPOINT COMPACTION.")), true);
  assert.equal(compact.summary.response.text, replies[3]);
  const postCompact = view.requests.at(-1);
  assert.equal(postCompact.summary.current_user, prompts[3]);
  assert.equal(postCompact.summary.response.text, replies[4]);
  assert.equal(postCompact.raw.body.input.some((item) => messageText(item).includes(replies[3])), true);
  assert.equal(postCompact.raw.body.input.some((item) => messageText(item).startsWith("Another language model started to solve this problem")), true);
  assert.equal(JSON.stringify(view).includes("local-public-placeholder"), false);
  assert.equal(JSON.stringify(view).includes("/Users/"), false);
  for (const request of view.requests) {
    assert.equal(request.raw.provenance.request.fidelity, "exact");
    assert.equal(request.raw.provenance.response.fidelity, "exact");
  }
}

function isCompactionRequest(record) {
  const raw = record?.body?.client_metadata?.["x-codex-turn-metadata"];
  if (typeof raw !== "string") return false;
  try {
    return JSON.parse(raw).request_kind === "compaction";
  } catch {
    return false;
  }
}

function messageText(item) {
  return Array.isArray(item?.content)
    ? item.content.map((part) => part?.text || "").join("\n")
    : "";
}

async function runTurn(client, threadId, prompt) {
  const notificationStart = client.notifications.length;
  const started = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    model,
    effort: "low",
    summary: "none",
  });
  const turnId = started.turn?.id;
  assert.ok(turnId, "turn/start did not return a turn id");
  const completed = await client.waitFor((message) =>
    message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId,
  15_000, notificationStart);
  assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn.error || null));
}

function createStdioRpcClient(child, logPath, stderrPath) {
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  let nextId = 1;
  let stderr = "";
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => {
    fs.appendFileSync(stderrPath, chunk);
    stderr = `${stderr}${chunk}`.slice(-12_000);
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    notifications.push(message);
    fs.appendFileSync(logPath, `${JSON.stringify(message)}\n`);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(message)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    notifications,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex App Server request timed out: ${method}. ${stderr.trim()}`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    waitFor(predicate, timeoutMs = 15_000, fromIndex = 0) {
      const existing = notifications.slice(fromIndex).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for Codex App Server notification. ${stderr.trim()}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function sourceForConversation(viewerUrl, conversationId) {
  const sources = await getJson(`${viewerUrl}/api/sources`);
  const source = sources.find((item) => item.conversation_id === conversationId);
  assert.ok(source, `missing Source for ${conversationId}`);
  return source;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeadersForUrl(url),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(payload)}`);
  return payload;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(payload)}`);
  return payload;
}

function sendSseResponse(response, body) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  for (const [outputIndex, item] of (body.output || []).entries()) {
    response.write(`event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })}\n\n`);
  }
  response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function decodeRequestBody(buffer, contentEncoding) {
  const encoding = String(contentEncoding || "identity").toLowerCase();
  if (encoding === "zstd") return zstdDecompressSync(buffer);
  if (encoding === "identity") return buffer;
  throw new Error(`Unsupported deterministic request encoding: ${encoding}`);
}

function readBuffer(request) {
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
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function codexVersion() {
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", () => resolve(stdout.trim() || "unknown"));
    child.on("error", () => resolve("unknown"));
  });
}

async function close() {
  rpc = null;
  if (appServer && appServer.exitCode == null && appServer.signalCode == null) {
    appServer.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => appServer.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (appServer.exitCode == null && appServer.signalCode == null) appServer.kill("SIGKILL");
  }
  await viewer.close().catch(() => {});
  upstream.closeIdleConnections?.();
  await new Promise((resolve) => upstream.close(() => resolve()));
}
