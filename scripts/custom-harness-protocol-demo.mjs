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
  "# Tiny Agent Project",
  "",
  "这是一个只包含公开虚构内容的自研 Harness 教学目录。",
  "",
  "项目入口是 src/main.mjs。",
  "新用户从 README.md 开始，再进入 docs/getting-started.md。",
].join("\n"));
fs.mkdirSync(path.join(publicWorkspace, "src"), { recursive: true });
fs.writeFileSync(path.join(publicWorkspace, "docs", "getting-started.md"), [
  "# Getting started",
  "",
  "运行 node src/main.mjs 启动公开教学程序。",
].join("\n"));
fs.writeFileSync(path.join(publicWorkspace, "src", "main.mjs"), "console.log('tiny agent demo');\n");

fs.writeFileSync(harnessPath, harnessSource(), { mode: 0o755 });

const requestCounters = { baseline: 0, improved: 0, anthropic: 0 };
const upstream = http.createServer(async (request, response) => {
  const rawBody = await readBody(request);
  const body = rawBody ? JSON.parse(rawBody) : {};
  const protocol = request.url === "/v1/responses"
    ? body.model === "pma-demo-model-baseline"
      ? "baseline"
      : body.model === "pma-demo-model-improved"
        ? "improved"
        : null
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
  if (protocol === "baseline" || protocol === "improved") {
    response.end(JSON.stringify(openAiResponse(protocol, index)));
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
    "pma observe --name harness-before --base-url-env OPENAI_BASE_URL -- node demo-harness.mjs openai-baseline",
    "pma observe --name harness-after --base-url-env OPENAI_BASE_URL -- node demo-harness.mjs openai-improved",
    "export ANTHROPIC_BASE_URL='http://127.0.0.1:<fake-upstream>'",
    "pma observe --name protocol-lab-anthropic --base-url-env ANTHROPIC_BASE_URL -- node demo-harness.mjs anthropic",
  ];
  const transcript = [
    "$ " + publicCommands[0],
    "$ " + publicCommands[1],
    "[PMA] child-only OPENAI_BASE_URL override; child arguments omitted",
    "Baseline: 3 requests · empty read_file args → error → retry → final answer",
    "",
    "$ " + publicCommands[2],
    "[PMA] child-only OPENAI_BASE_URL override; child arguments omitted",
    "Improved: 2 requests · valid read_file args → result → final answer",
    "",
    "$ " + publicCommands[3],
    "$ " + publicCommands[4],
    "[PMA] child-only ANTHROPIC_BASE_URL override; child arguments omitted",
    "Anthropic demo: 2 requests · list_directory → tool result → final answer",
  ].join("\n");
  fs.writeFileSync(transcriptPath, `${transcript}\n`);

  const baselineRun = await runObserve({
    name: "harness-before",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrl: `${upstreamUrl}/v1`,
    protocol: "openai-baseline",
    conversationId: "harness-before-session",
  });
  assert.equal(baselineRun.code, 0, baselineRun.stderr);
  assert.match(baselineRun.stdout, /Baseline demo completed/);
  assert.match(baselineRun.stderr, /child-only OPENAI_BASE_URL override/);
  assert.doesNotMatch(baselineRun.stderr, /local-public-demo-token/);

  const improvedRun = await runObserve({
    name: "harness-after",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrl: `${upstreamUrl}/v1`,
    protocol: "openai-improved",
    conversationId: "harness-after-session",
  });
  assert.equal(improvedRun.code, 0, improvedRun.stderr);
  assert.match(improvedRun.stdout, /Improved demo completed/);
  assert.match(improvedRun.stderr, /child-only OPENAI_BASE_URL override/);
  assert.doesNotMatch(improvedRun.stderr, /local-public-demo-token/);

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

  const baselineSource = await sourceForConversation(viewer.url, "harness-before-session");
  const improvedSource = await sourceForConversation(viewer.url, "harness-after-session");
  const anthropicSource = await sourceForConversation(viewer.url, "protocol-lab-anthropic-session");
  await verifySource(viewer.url, baselineSource, "openai_responses", 3);
  await verifySource(viewer.url, improvedSource, "openai_responses", 2);
  await verifySource(viewer.url, anthropicSource, "anthropic_messages", 2);

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
      baseline: {
        id: baselineSource.id,
        conversation_id: baselineSource.conversation_id,
        requests: baselineSource.request_count,
        protocol: "OpenAI Responses",
        observed_problem: "read_file accepts an empty argument object, causing one error result and one retry",
      },
      improved: {
        id: improvedSource.id,
        conversation_id: improvedSource.conversation_id,
        requests: improvedSource.request_count,
        protocol: "OpenAI Responses",
        observed_change: "path is required, described precisely, and the same task succeeds in one tool call",
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
      "All three Sources were captured through the real pma observe wrapper.",
      "The baseline Source needs three Requests because the tool schema permits an empty read_file argument object.",
      "The improved Source makes path required and completes the same task in two Requests.",
      "The before/after comparison is a human review workflow; PMA does not claim an automated experiment score.",
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
  console.log(`Baseline Source: ${baselineSource.id}`);
  console.log(`Improved Source: ${improvedSource.id}`);
  console.log(`Anthropic Source: ${anthropicSource.id}`);
  console.log("Before: 3 Requests. After: 2 Requests. Keep this process running while reviewing or capturing the Viewer.");
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
if (!workspace || !["openai-baseline", "openai-improved", "anthropic"].includes(protocol)) process.exit(2);
const baseUrl = process.env[protocol.startsWith("openai-") ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"];
const token = process.env.PMA_DEMO_TOKEN;
const entries = fs.readdirSync(workspace, { withFileTypes: true })
  .map((entry) => entry.isDirectory() ? entry.name + "/" : entry.name)
  .sort();

if (protocol.startsWith("openai-")) {
  const improved = protocol === "openai-improved";
  const common = {
    model: improved ? "pma-demo-model-improved" : "pma-demo-model-baseline",
    instructions: "你是只读项目向导。必须读取 README 的真实内容，再回答项目入口并引用证据。",
    tools: [{
      type: "function",
      name: "read_file",
      description: improved
        ? "读取项目根目录内一个 UTF-8 文本文件。path 必须是相对路径；要核对项目入口时请读取 README.md。"
        : "读取项目文档",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: improved ? "相对于项目根目录的文件路径，例如 README.md。" : "文件",
          },
        },
        ...(improved ? { required: ["path"], additionalProperties: false } : {}),
      },
      strict: improved,
    }],
    temperature: 0,
    max_output_tokens: 180,
    metadata: { demo: improved ? "harness-after" : "harness-before", privacy: "synthetic" },
  };
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "请从 README 中找出项目入口文件，并引用原文依据。" }] };
  const first = await post(baseUrl.replace(/\\/$/, "") + "/responses", {
    ...common,
    input: [user],
  }, { authorization: "Bearer " + token });
  const firstCall = first.output.find((item) => item.type === "function_call");
  if (!firstCall || firstCall.name !== "read_file") throw new Error("missing first read_file call");
  const firstResult = executeRead(firstCall);
  const second = await post(baseUrl.replace(/\\/$/, "") + "/responses", {
    ...common,
    input: [user, firstCall, { type: "function_call_output", call_id: firstCall.call_id, output: JSON.stringify(firstResult) }],
  }, { authorization: "Bearer " + token });
  if (improved) {
    console.log("Improved demo completed: " + second.output[0].content[0].text);
  } else {
    const retryCall = second.output.find((item) => item.type === "function_call");
    if (!retryCall || retryCall.name !== "read_file") throw new Error("missing retry read_file call");
    const retryResult = executeRead(retryCall);
    const third = await post(baseUrl.replace(/\\/$/, "") + "/responses", {
      ...common,
      input: [
        user,
        firstCall,
        { type: "function_call_output", call_id: firstCall.call_id, output: JSON.stringify(firstResult) },
        retryCall,
        { type: "function_call_output", call_id: retryCall.call_id, output: JSON.stringify(retryResult) },
      ],
    }, { authorization: "Bearer " + token });
    console.log("Baseline demo completed: " + third.output[0].content[0].text);
  }
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

function executeRead(call) {
  let args = {};
  try { args = JSON.parse(call.arguments || "{}"); } catch {}
  if (!args.path) return { ok: false, error: "path is required", received: args };
  const resolved = path.resolve(workspace, args.path);
  if (!resolved.startsWith(path.resolve(workspace) + path.sep)) return { ok: false, error: "path escapes workspace" };
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return { ok: false, error: "file not found", path: args.path };
  return { ok: true, path: args.path, content: fs.readFileSync(resolved, "utf8") };
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

function openAiResponse(profile, index) {
  const model = `pma-demo-model-${profile}`;
  if (index === 1) {
    return {
      id: `resp_harness_${profile}_1`,
      object: "response",
      status: "completed",
      model,
      output: [{
        id: `fc_harness_${profile}_read_1`,
        type: "function_call",
        status: "completed",
        call_id: `call_harness_${profile}_read_1`,
        name: "read_file",
        arguments: profile === "baseline" ? "{}" : "{\"path\":\"README.md\"}",
      }],
      usage: { input_tokens: 126, output_tokens: 12, total_tokens: 138 },
    };
  }
  if (profile === "baseline" && index === 2) {
    return {
      id: "resp_harness_baseline_2",
      object: "response",
      status: "completed",
      model,
      output: [{
        id: "fc_harness_baseline_read_2",
        type: "function_call",
        status: "completed",
        call_id: "call_harness_baseline_read_2",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      }],
      usage: { input_tokens: 178, output_tokens: 15, total_tokens: 193 },
    };
  }
  return {
    id: `resp_harness_${profile}_${index}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: `msg_harness_${profile}_${index}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: "项目入口是 src/main.mjs。依据是 README.md 中的原文：‘项目入口是 src/main.mjs。’",
        annotations: [],
      }],
    }],
    usage: { input_tokens: profile === "baseline" ? 284 : 206, output_tokens: 34, total_tokens: profile === "baseline" ? 318 : 240 },
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

async function verifySource(viewerUrl, source, expectedProtocol, expectedRequests) {
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, expectedRequests);
  assert.equal(source.response_count, expectedRequests);
  const view = await getJson(`${viewerUrl}/api/view?source=${encodeURIComponent(source.id)}`);
  assert.equal(view.requests.length, expectedRequests);
  for (const request of view.requests) assert.equal(request.summary.protocol_exchange.protocol, expectedProtocol);
  const sensitiveHeader = expectedProtocol === "openai_responses" ? "authorization" : "x-api-key";
  assert.equal(view.requests[0].raw.headers[sensitiveHeader], "[REDACTED:header]");
  assert.equal(view.requests[0].raw.provenance.request.fidelity, "exact");
  assert.equal(view.requests.at(-1).raw.provenance.response.fidelity, "exact");
  if (source.conversation_id === "harness-before-session") {
    assert.deepEqual(view.requests[0].summary.response.tool_calls[0].arguments, {});
    assert.match(view.requests[1].summary.tool_results[0].content, /path is required/);
  }
  if (source.conversation_id === "harness-after-session") {
    assert.deepEqual(view.requests[0].summary.response.tool_calls[0].arguments, { path: "README.md" });
    assert.equal(view.requests[0].raw.body.tools[0].parameters.required[0], "path");
  }
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
