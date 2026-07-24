#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-run-opencode-"));
const binDir = path.join(tmpDir, "bin");
const storePath = path.join(tmpDir, "state", "captures.sqlite");
const argsPath = path.join(tmpDir, "opencode-args.json");
const envPath = path.join(tmpDir, "opencode-env.json");
const sessionId = `opencode-smoke-${Date.now()}-${process.pid}`;
const learnedSessionId = `${sessionId}-learned`;
const failureSessionId = `${sessionId}-failure`;
const upstreamRequests = [];
fs.mkdirSync(binDir, { recursive: true });

const upstream = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  upstreamRequests.push({ method: req.method, path: req.url, headers: req.headers, body });
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":{"message":"unexpected route"}}');
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-opencode-wrapper",
      object: "chat.completion.chunk",
      model: "mock",
      choices: [{ index: 0, delta: { role: "assistant", content: "OPEN_CODE_OK" }, finish_reason: null }],
    })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-opencode-wrapper",
      object: "chat.completion.chunk",
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
    })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});

const upstreamUrl = await listen(upstream);
const effectiveConfig = {
  model: "mimo/mimo-v2.5-pro",
  provider: {
    mimo: {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: `${upstreamUrl}/v1`,
        apiKey: "effective-config-secret",
      },
      models: {
        "mimo-v2.5-pro": {},
      },
    },
  },
};
const existingInline = {
  plugin: ["existing-plugin"],
  provider: {
    mimo: {
      options: {
        apiKey: "process-local-secret",
        headers: { "x-provider-feature": "enabled" },
      },
    },
  },
};
const viewer = await startViewerServer({ cwd, storePath });

try {
  writeFakeNodeCommand(
    binDir,
    "opencode",
    `
import fs from "node:fs";

if (process.argv[2] === "debug" && process.argv[3] === "config" && process.argv[4] === "--pure") {
  process.stdout.write(process.env.PEEK_FAKE_OPENCODE_EFFECTIVE_CONFIG);
  process.exit(0);
}

await fs.promises.writeFile(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2), null, 2));
const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
await fs.promises.writeFile(${JSON.stringify(envPath)}, JSON.stringify({
  plugin: inline.plugin,
  provider: {
    mimo: {
      npm: inline.provider?.mimo?.npm || null,
      options: inline.provider?.mimo?.options || null,
    },
  },
}, null, 2));

if (process.env.PEEK_FAKE_OPENCODE_FAIL === "1") {
  console.error("fake opencode failure");
  process.exit(9);
}

const baseURL = inline.provider?.mimo?.options?.baseURL;
if (!baseURL) process.exit(4);
const post = async (body) => {
  const response = await fetch(baseURL + "/chat/completions", {
    method: "POST",
    headers: {
      ...(inline.provider?.mimo?.options?.headers || {}),
      "content-type": "application/json",
      authorization: "Bearer wrapper-secret",
      "x-session-id": ${JSON.stringify(learnedSessionId)},
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(5);
  }
  return response.text();
};

await post({
  model: "mimo-v2.5-pro",
  messages: [
    {
      role: "system",
      content: "You are a title generator. You output ONLY a thread title. Nothing else.\\n\\n<task>\\nGenerate a brief title that would help the user find this conversation later.\\n</task>",
    },
    { role: "user", content: "Generate a title for this conversation:\\n" },
    { role: "user", content: "\\"hello from OpenCode wrapper\\"" },
  ],
  tools: [],
  stream: true,
});
const mainResponse = await post({
  model: "mimo-v2.5-pro",
  messages: [
    {
      role: "system",
      content: "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
    },
    { role: "user", content: "hello from OpenCode wrapper" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { filePath: { type: "string" } } },
      },
    },
  ],
  stream: true,
});
if (!mainResponse.includes("OPEN_CODE_OK")) process.exit(6);
console.log("fake opencode ok");
`,
  );

  const baseEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(existingInline),
    PEEK_FAKE_OPENCODE_EFFECTIVE_CONFIG: JSON.stringify(effectiveConfig),
  };
  const result = await runCli(
    [
      `--viewer-url=${viewer.url}`,
      "opencode",
      "run",
      "--command",
      "pma-smoke",
      "--model",
      "mimo/mimo-v2.5-pro",
      "hello",
    ],
    baseEnv,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OpenCode exact proxy \(process-local; user config unchanged\)/);
  assert.match(result.stdout, /fake opencode ok/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /process-local-secret|effective-config-secret|wrapper-secret/);

  const childArgs = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  assert.deepEqual(childArgs, [
    "run",
    "--command",
    "pma-smoke",
    "--model",
    "mimo/mimo-v2.5-pro",
    "hello",
  ]);
  const childConfig = JSON.parse(fs.readFileSync(envPath, "utf8"));
  assert.deepEqual(childConfig.plugin, ["existing-plugin"]);
  assert.equal(childConfig.provider.mimo.options.apiKey, "process-local-secret");
  assert.deepEqual(childConfig.provider.mimo.options.headers, {
    "x-provider-feature": "enabled",
    "x-peek-opencode-command": "pma-smoke",
  });
  assert.match(childConfig.provider.mimo.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/watch\//);

  assert.equal(upstreamRequests.length, 2);
  assert.ok(upstreamRequests.every((request) => request.method === "POST"));
  assert.ok(upstreamRequests.every((request) => request.path === "/v1/chat/completions"));
  assert.ok(upstreamRequests.every((request) => request.headers["x-provider-feature"] === "enabled"));
  assert.ok(upstreamRequests.every((request) => request.headers["x-peek-opencode-command"] === undefined));
  assert.deepEqual(
    upstreamRequests.map((request) => request.body.tools.length),
    [0, 1],
  );

  const sources = await getJson(`${viewer.url}/api/sources`);
  const source = sources.find((item) => item.agent === "OpenCode" && item.conversation_id === learnedSessionId);
  assert.ok(source);
  assert.equal(source.kind, "opencode_proxy_exact");
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, 2);

  const data = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  assert.equal(data.source.workbench.capture_label, "OpenCode exact Chat Completions capture");
  assert.equal(data.requests[0].source_hint.type, "metadata");
  assert.equal(data.requests[0].source_hint.label, "生成会话标题");
  assert.equal(data.requests[1].source_hint.type, "main");
  assert.equal(data.requests[1].protocol, "openai_chat_completions");
  assert.equal(data.requests[1].counts.system, 1);
  assert.equal(data.requests[1].counts.tools, 1);
  assert.equal(data.requests[1].summary.current_user, "hello from OpenCode wrapper");
  assert.equal(data.requests[1].raw.headers["x-peek-opencode-command"], "pma-smoke");
  assert.deepEqual(
    data.requests[1].raw.body.messages.map((message) => message.role),
    ["system", "user"],
  );

  const failure = await runCli(
    [
      "run",
      "opencode",
      "--viewer-url",
      viewer.url,
      "--",
      "--session",
      failureSessionId,
    ],
    {
      ...baseEnv,
      PEEK_FAKE_OPENCODE_FAIL: "1",
    },
  );
  assert.equal(failure.code, 9, failure.stderr);
  assert.match(failure.stderr, /fake opencode failure/);
  const sourcesAfterFailure = await getJson(`${viewer.url}/api/sources`);
  const failedSource = sourcesAfterFailure.find(
    (item) => item.agent === "OpenCode" && item.conversation_id === failureSessionId,
  );
  assert.ok(failedSource);
  assert.equal(failedSource.live_status, "stopped");
  assert.equal(failedSource.request_count, 0);

  console.log("run opencode wrapper smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/peekmyagent.mjs", ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 15_000);
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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
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
