#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(root, "tmp", "custom-harness-protocol-demo");
const stateDir = path.join(runRoot, "state");
const disposableRoot = "/tmp/pma-custom-harness-demo";
const publicWorkspace = path.join(disposableRoot, "public-project");
const harnessPath = path.join(runRoot, "demo-harness.mjs");
const requestLog = path.join(runRoot, "upstream-requests.jsonl");
const transcriptPath = path.join(runRoot, "terminal-transcript.txt");
const descriptorPath = path.join(runRoot, "session.json");

fs.rmSync(runRoot, { recursive: true, force: true });
fs.rmSync(disposableRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(publicWorkspace, "docs"), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(publicWorkspace, "README.md"), [
  "# Pocket Guide",
  "",
  "这是一个只包含公开虚构内容的自研 Harness 教学目录。",
  "",
  "新用户从 README.md 开始，再进入 docs/。",
].join("\n"));
fs.writeFileSync(path.join(publicWorkspace, "docs", "viewer.md"), [
  "# Viewer",
  "",
  "在 PMA 中先看时间线，再打开协议视图和 Raw。",
].join("\n"));

fs.writeFileSync(harnessPath, harnessSource(), { mode: 0o755 });

const requestCounters = { openai: 0, anthropic: 0 };
const upstream = http.createServer(async (request, response) => {
  const rawBody = await readBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const protocol = request.url === "/v1/responses"
    ? "openai"
    : request.url === "/v1/messages"
      ? "anthropic"
      : null;
  if (!protocol) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected demo path" }));
    return;
  }

  requestCounters[protocol] += 1;
  const index = requestCounters[protocol];
  fs.appendFileSync(requestLog, `${JSON.stringify({
    protocol,
    index,
    method: request.method,
    path: request.url,
    body,
  })}\n`);

  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  if (protocol === "openai") {
    response.end(JSON.stringify(openAiResponse(index)));
  } else {
    response.end(JSON.stringify(anthropicResponse(index)));
  }
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({
  cwd: root,
  port: 0,
  capturePort: 0,
  storePath: path.join(stateDir, "store.sqlite"),
});

try {
  const publicCommands = [
    "export OPENAI_BASE_URL='http://127.0.0.1:<fake-upstream>/v1'",
    "pma observe --name protocol-lab-openai --base-url-env OPENAI_BASE_URL -- node demo-harness.mjs openai",
    "export ANTHROPIC_BASE_URL='http://127.0.0.1:<fake-upstream>'",
    "pma observe --name protocol-lab-anthropic --base-url-env ANTHROPIC_BASE_URL -- node demo-harness.mjs anthropic",
  ];
  const transcript = [
    "$ " + publicCommands[0],
    "$ " + publicCommands[1],
    "[PMA] child-only OPENAI_BASE_URL override; child arguments omitted",
    "OpenAI demo: 2 requests · list_directory → tool result → final answer",
    "",
    "$ " + publicCommands[2],
    "$ " + publicCommands[3],
    "[PMA] child-only ANTHROPIC_BASE_URL override; child arguments omitted",
    "Anthropic demo: 2 requests · list_directory → tool result → final answer",
  ].join("\n");
  fs.writeFileSync(transcriptPath, `${transcript}\n`);

  const openaiRun = await runObserve({
    name: "protocol-lab-openai",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrl: `${upstreamUrl}/v1`,
    protocol: "openai",
    conversationId: "protocol-lab-openai-session",
  });
  assert.equal(openaiRun.code, 0, openaiRun.stderr);
  assert.match(openaiRun.stdout, /OpenAI demo completed/);
  assert.match(openaiRun.stderr, /child-only OPENAI_BASE_URL override/);
  assert.doesNotMatch(openaiRun.stderr, /local-public-demo-token/);

  const anthropicRun = await runObserve({
    name: "protocol-lab-anthropic",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    baseUrl: upstreamUrl,
    protocol: "anthropic",
    conversationId: "protocol-lab-anthropic-session",
  });
  assert.equal(anthropicRun.code, 0, anthropicRun.stderr);
  assert.match(anthropicRun.stdout, /Anthropic demo completed/);
  assert.match(anthropicRun.stderr, /child-only ANTHROPIC_BASE_URL override/);
  assert.doesNotMatch(anthropicRun.stderr, /local-public-demo-token/);

  const openaiSource = await sourceForConversation(viewer.url, "protocol-lab-openai-session");
  const anthropicSource = await sourceForConversation(viewer.url, "protocol-lab-anthropic-session");
  await verifySource(viewer.url, openaiSource, "openai_responses");
  await verifySource(viewer.url, anthropicSource, "anthropic_messages");

  const descriptor = {
    scenario_id: "custom-harness-protocol-demo",
    viewer_url: viewer.url,
    upstream_url: upstreamUrl,
    store_path: path.join(stateDir, "store.sqlite"),
    workspace: publicWorkspace,
    harness: harnessPath,
    request_log: requestLog,
    transcript: transcriptPath,
    sources: {
      openai: {
        id: openaiSource.id,
        conversation_id: openaiSource.conversation_id,
        requests: openaiSource.request_count,
        protocol: "OpenAI Responses",
      },
      anthropic: {
        id: anthropicSource.id,
        conversation_id: anthropicSource.conversation_id,
        requests: anthropicSource.request_count,
        protocol: "Anthropic Messages",
      },
    },
    public_commands: publicCommands,
    facts: [
      "Both Sources were captured through the real pma observe wrapper.",
      "Each Source contains two model requests and one list_directory tool exchange.",
      "Only the child process receives the temporary base URL override.",
      "The protocol is inferred from the wire path and body, not from --name.",
      "The generic bridge does not claim Harness-specific Skill, permission, resume, compression, or subagent semantics.",
    ],
    privacy: "Fictional files, deterministic loopback upstream, placeholder token, no provider credentials, no external requests.",
  };
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  console.log("\nCustom Harness protocol demo is ready.");
  console.log(`Descriptor: ${descriptorPath}`);
  console.log(`Viewer: ${viewer.url}`);
  console.log(`OpenAI Source: ${openaiSource.id}`);
  console.log(`Anthropic Source: ${anthropicSource.id}`);
  console.log("Keep this process running while reviewing or capturing the Viewer. Press Ctrl-C to stop local servers.");
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

async function runObserve({ name, baseUrlEnv, baseUrl, protocol, conversationId }) {
  return runProcess(
    process.execPath,
    [
      path.join(root, "bin", "peekmyagent.mjs"),
      "observe",
      "--name",
      name,
      "--base-url-env",
      baseUrlEnv,
      "--conversation-id",
      conversationId,
      "--viewer-url",
      viewer.url,
      "--",
      process.execPath,
      harnessPath,
      protocol,
    ],
    {
      ...process.env,
      PEEKMYAGENT_STATE_DIR: stateDir,
      PMA_DEMO_WORKSPACE: publicWorkspace,
      PMA_DEMO_TOKEN: "local-public-demo-token",
      [baseUrlEnv]: baseUrl,
    },
  );
}

function harnessSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const protocol = process.argv[2];
const workspace = process.env.PMA_DEMO_WORKSPACE;
if (!workspace || !["openai", "anthropic"].includes(protocol)) process.exit(2);
const baseUrl = process.env[protocol === "openai" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"];
const token = process.env.PMA_DEMO_TOKEN;
const entries = fs.readdirSync(workspace, { withFileTypes: true })
  .map((entry) => entry.isDirectory() ? entry.name + "/" : entry.name)
  .sort();

if (protocol === "openai") {
  const common = {
    model: "pma-demo-model",
    instructions: "你是只读目录助手。只能使用 list_directory 查看第一层目录，然后根据工具结果回答。",
    tools: [{
      type: "function",
      name: "list_directory",
      description: "列出公开演示目录的第一层内容",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对目录" } },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    }],
    temperature: 0,
    max_output_tokens: 180,
  };
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "请列出当前演示目录第一层的内容，并说明新用户应该先看哪个文件。" }] };
  const first = await post(baseUrl.replace(/\\/$/, "") + "/responses", {
    ...common,
    input: [user],
  }, { authorization: "Bearer " + token });
  const call = first.output.find((item) => item.type === "function_call");
  if (!call || call.name !== "list_directory") throw new Error("missing list_directory call");
  const second = await post(baseUrl.replace(/\\/$/, "") + "/responses", {
    ...common,
    input: [user, call, { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ path: ".", entries }) }],
  }, { authorization: "Bearer " + token });
  console.log("OpenAI demo completed: " + second.output[0].content[0].text);
} else {
  const common = {
    model: "pma-demo-claude",
    system: "你是只读目录助手。只能使用 list_directory 查看第一层目录，然后根据工具结果回答。",
    tools: [{
      name: "list_directory",
      description: "列出公开演示目录的第一层内容",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "相对目录" } },
        required: ["path"],
      },
    }],
    temperature: 0,
    max_tokens: 180,
  };
  const user = { role: "user", content: "请列出当前演示目录第一层的内容，并说明新用户应该先看哪个文件。" };
  const first = await post(baseUrl.replace(/\\/$/, "") + "/v1/messages", {
    ...common,
    messages: [user],
  }, { "x-api-key": token, "anthropic-version": "2023-06-01" });
  const call = first.content.find((item) => item.type === "tool_use");
  if (!call || call.name !== "list_directory") throw new Error("missing list_directory call");
  const second = await post(baseUrl.replace(/\\/$/, "") + "/v1/messages", {
    ...common,
    messages: [
      user,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ path: ".", entries }) }] },
    ],
  }, { "x-api-key": token, "anthropic-version": "2023-06-01" });
  console.log("Anthropic demo completed: " + second.content[0].text);
}

async function post(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
`;
}

function openAiResponse(index) {
  if (index === 1) {
    return {
      id: "resp_protocol_lab_openai_1",
      object: "response",
      status: "completed",
      model: "pma-demo-model",
      output: [{
        id: "fc_protocol_lab_list",
        type: "function_call",
        status: "completed",
        call_id: "call_protocol_lab_list",
        name: "list_directory",
        arguments: "{\"path\":\".\"}",
      }],
      usage: { input_tokens: 92, output_tokens: 12, total_tokens: 104 },
    };
  }
  return {
    id: "resp_protocol_lab_openai_2",
    object: "response",
    status: "completed",
    model: "pma-demo-model",
    output: [{
      id: "msg_protocol_lab_openai_2",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: "目录包含 README.md 和 docs/。新用户应该先看 README.md。",
        annotations: [],
      }],
    }],
    usage: { input_tokens: 134, output_tokens: 24, total_tokens: 158 },
  };
}

function anthropicResponse(index) {
  if (index === 1) {
    return {
      id: "msg_protocol_lab_anthropic_1",
      type: "message",
      role: "assistant",
      model: "pma-demo-claude",
      content: [{
        type: "tool_use",
        id: "toolu_protocol_lab_list",
        name: "list_directory",
        input: { path: "." },
      }],
      stop_reason: "tool_use",
      usage: { input_tokens: 88, output_tokens: 14 },
    };
  }
  return {
    id: "msg_protocol_lab_anthropic_2",
    type: "message",
    role: "assistant",
    model: "pma-demo-claude",
    content: [{
      type: "text",
      text: "目录包含 README.md 和 docs/。新用户应该先看 README.md。",
    }],
    stop_reason: "end_turn",
    usage: { input_tokens: 128, output_tokens: 22 },
  };
}

async function verifySource(viewerUrl, source, expectedProtocol) {
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, 2);
  assert.equal(source.response_count, 2);
  const view = await getJson(`${viewerUrl}/api/view?source=${encodeURIComponent(source.id)}`);
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[0].summary.protocol_exchange.protocol, expectedProtocol);
  assert.equal(view.requests[1].summary.protocol_exchange.protocol, expectedProtocol);
  const sensitiveHeader = expectedProtocol === "openai_responses" ? "authorization" : "x-api-key";
  assert.equal(view.requests[0].raw.headers[sensitiveHeader], "[REDACTED:header]");
  assert.equal(view.requests[0].raw.provenance.request.fidelity, "exact");
  assert.equal(view.requests[1].raw.provenance.response.fidelity, "exact");
}

async function sourceForConversation(viewerUrl, conversationId) {
  const sources = await getJson(`${viewerUrl}/api/sources`);
  const source = sources.find((item) => item.conversation_id === conversationId);
  assert.ok(source, `missing Source for ${conversationId}`);
  return source;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: publicWorkspace, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("custom Harness demo command timed out"));
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
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

async function close() {
  await viewer.close().catch(() => {});
  await new Promise((resolve) => upstream.close(() => resolve()));
}
