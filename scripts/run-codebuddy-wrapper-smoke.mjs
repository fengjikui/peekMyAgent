import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";
import { buildMetadataView } from "../src/viewer/metadata-view-model.js";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-run-codebuddy-"));
const binDir = path.join(tmpDir, "bin");
const childStatePath = path.join(tmpDir, "child-state.json");
const storePath = path.join(tmpDir, "store.sqlite");
const previousStateDir = process.env.PEEKMYAGENT_STATE_DIR;
process.env.PEEKMYAGENT_STATE_DIR = path.join(tmpDir, "state");
fs.mkdirSync(binDir, { recursive: true });
const upstreamRequests = [];

const upstream = http.createServer(async (request, response) => {
  const body = JSON.parse((await readBody(request)) || "{}");
  upstreamRequests.push({
    path: request.url,
    authorization: request.headers.authorization || null,
    apiKey: request.headers["x-api-key"] || null,
    body,
  });
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected route" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-codebuddy-${upstreamRequests.length}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{ index: 0, delta: { role: "assistant", content: `CodeBuddy response ${upstreamRequests.length}` }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: `chatcmpl-codebuddy-${upstreamRequests.length}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd, storePath });

try {
  writeFakeNodeCommand(
    binDir,
    "codebuddy",
    `
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.130.0');
  process.exit(0);
}
const baseUrl = process.env.CODEBUDDY_BASE_URL || '';
const sessionIndex = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'codebuddy-session-smoke';
fs.writeFileSync(process.env.PEEK_FAKE_CODEBUDDY_STATE_PATH, JSON.stringify({
  args,
  baseUrl,
  credentialPreserved: process.env.CODEBUDDY_API_KEY === 'codebuddy-smoke-secret',
  models: {
    main: process.env.CODEBUDDY_MODEL,
    lite: process.env.CODEBUDDY_SMALL_FAST_MODEL,
    reasoning: process.env.CODEBUDDY_BIG_SLOW_MODEL,
    subagent: process.env.CODEBUDDY_CODE_SUBAGENT_MODEL,
  },
}, null, 2));

if (process.env.PEEK_FAKE_CODEBUDDY_FAIL === '1') {
  console.error('fake codebuddy failure');
  process.exit(19);
}

const response = await fetch(baseUrl.replace(/\\\/$/, '') + '/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + process.env.CODEBUDDY_API_KEY,
    'x-api-key': process.env.CODEBUDDY_API_KEY,
    'x-codebuddy-request': '1',
    'x-agent-intent': 'craft',
    'x-agent-purpose': 'conversation',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-ide-version': '2.130.0',
    'x-conversation-id': sessionId,
    'x-conversation-request-id': 'request-id-not-secret',
    'x-conversation-message-id': 'message-id-not-secret',
    'x-user-id': 'codebuddy-user-private',
  },
  body: JSON.stringify({
    model: process.env.CODEBUDDY_MODEL,
    messages: [
      { role: 'system', content: 'You are CodeBuddy Code. Use tools carefully.' },
      {
        role: 'user',
        agent: 'cli',
        content: '<system-reminder>CodeBuddy project instructions were injected.</system-reminder>\\n\\n<user_query>Inspect the CodeBuddy protocol.</user_query>',
      },
    ],
    tools: [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'high',
  }),
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(2);
}
console.log('fake codebuddy ok');
`,
  );

  const privateArgument = "private-codebuddy-argument";
  const commonEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    CODEBUDDY_API_KEY: "codebuddy-smoke-secret",
    PEEK_FAKE_CODEBUDDY_STATE_PATH: childStatePath,
  };
  const first = await runCli([
    "run",
    "codebuddy",
    "--watch",
    "new",
    "--target-base-url",
    `${upstreamUrl}/v1`,
    "--model",
    "mimo-v2.5-pro",
    "--viewer-url",
    viewer.url,
    "--",
    "--print",
    "--session-id",
    "codebuddy-session-smoke",
    `--private=${privateArgument}`,
  ], commonEnv);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /fake codebuddy ok/);
  assert.match(first.stderr, /arguments omitted/);
  assert.doesNotMatch(first.stderr, new RegExp(privateArgument));
  assert.doesNotMatch(first.stderr, /codebuddy-smoke-secret/);

  const child = JSON.parse(fs.readFileSync(childStatePath, "utf8"));
  assert.equal(child.credentialPreserved, true);
  assert.match(child.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/watch\//);
  assert.deepEqual(child.models, {
    main: "mimo-v2.5-pro",
    lite: "mimo-v2.5-pro",
    reasoning: "mimo-v2.5-pro",
    subagent: "mimo-v2.5-pro",
  });
  assert.deepEqual(upstreamRequests.map((request) => request.path), ["/v1/chat/completions"]);
  assert.equal(upstreamRequests[0].authorization, "Bearer codebuddy-smoke-secret");
  assert.equal(upstreamRequests[0].apiKey, "codebuddy-smoke-secret");

  const source = await sourceForConversation(viewer.url, "codebuddy-session-smoke");
  assert.equal(source.agent, "CodeBuddy Code");
  assert.equal(source.kind, "codebuddy_proxy_exact");
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, 1);
  assert.equal(source.response_count, 1);
  const firstView = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  const firstRequest = firstView.requests[0];
  assert.equal(firstRequest.summary.protocol_exchange.protocol, "openai_chat_completions");
  assert.equal(firstRequest.summary.protocol_exchange.response.counts.output_items, 1);
  assert.equal(firstRequest.summary.response.preview, "CodeBuddy response 1");
  assert.equal(firstRequest.summary.current_user, "Inspect the CodeBuddy protocol.");
  const metadata = buildMetadataView(firstRequest);
  assert.equal(
    metadata.generationParameters.groups
      .flatMap((group) => group.facts)
      .find((fact) => fact.native_key === "reasoning_effort")?.value,
    "high",
  );
  assert.equal(firstRequest.source_hint.type, "main");
  assert.equal(firstRequest.raw.headers.authorization, "[REDACTED:header]");
  assert.equal(firstRequest.raw.headers["x-api-key"], "[REDACTED:header]");
  assert.equal(firstRequest.raw.headers["x-conversation-id"], "[REDACTED:header]");
  assert.equal(firstRequest.raw.headers["x-user-id"], "[REDACTED:header]");
  assert.deepEqual(firstRequest.raw.header_semantics.codebuddy, {
    agent_purpose: "conversation",
    agent_intent: "craft",
    ide_type: "cli",
    ide_name: "cli",
    ide_version: "2.130.0",
    conversation_request_id_present: true,
  });

  const continued = await runCli([
    "run",
    "codebuddy",
    "--watch",
    "reuse",
    "--target-base-url",
    `${upstreamUrl}/v1`,
    "--model",
    "mimo-v2.5-pro",
    "--viewer-url",
    viewer.url,
    "--",
    "--continue",
    "--print",
  ], commonEnv);
  assert.equal(continued.code, 0, continued.stderr);
  const continuedChild = JSON.parse(fs.readFileSync(childStatePath, "utf8"));
  assert.equal(continuedChild.args.includes("--continue"), false);
  assert.deepEqual(continuedChild.args.slice(0, 2), ["--resume", "codebuddy-session-smoke"]);
  const continuedSource = await sourceForConversation(viewer.url, "codebuddy-session-smoke");
  assert.equal(continuedSource.store_watch_id, source.store_watch_id, "continue reuses the original watch");
  assert.equal(continuedSource.request_count, 2);
  assert.equal(continuedSource.response_count, 2);

  const failed = await runCli([
    "run",
    "codebuddy",
    "--watch",
    "new",
    "--target-base-url",
    `${upstreamUrl}/v1`,
    "--model",
    "mimo-v2.5-pro",
    "--viewer-url",
    viewer.url,
    "--",
    "--session-id",
    "codebuddy-failure-smoke",
  ], { ...commonEnv, PEEK_FAKE_CODEBUDDY_FAIL: "1" });
  assert.equal(failed.code, 19);
  const failedSource = await sourceForConversation(viewer.url, "codebuddy-failure-smoke");
  assert.equal(failedSource.live_status, "stopped");
  assert.equal(failedSource.request_count, 0);

  const withoutKey = { ...commonEnv };
  delete withoutKey.CODEBUDDY_API_KEY;
  const missingKey = await runCli([
    "run",
    "codebuddy",
    "--target-base-url",
    `${upstreamUrl}/v1`,
    "--model",
    "mimo-v2.5-pro",
    "--viewer-url",
    viewer.url,
    "--",
    "--print",
  ], withoutKey);
  assert.equal(missingKey.code, 1);
  assert.match(missingKey.stderr, /Missing CODEBUDDY_API_KEY/);

  console.log("run codebuddy wrapper smoke passed (exact Chat capture, OpenCode model mapping, variants, privacy, resume reuse, cleanup)");
} finally {
  await viewer.close();
  await closeServer(upstream);
  if (previousStateDir === undefined) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = previousStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/peekmyagent.mjs", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args[0] || "unknown"}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function sourceForConversation(viewerUrl, conversationId) {
  const sources = await getJson(`${viewerUrl}/api/sources`);
  const source = sources.find((item) => item.agent === "CodeBuddy Code" && item.conversation_id === conversationId);
  assert.ok(source, `missing source for ${conversationId}`);
  return source;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
