import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codebuddy-probe-"));
const configDir = path.join(tmpDir, "config");
const directConfigDir = path.join(tmpDir, "direct-config");
const workspace = path.join(tmpDir, "workspace");
const requests = [];
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(directConfigDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const upstream = http.createServer(async (request, response) => {
  const rawBody = await readBody(request);
  let body = null;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    body = { unparsed: true };
  }
  requests.push({
    method: request.method,
    path: request.url,
    headers: redactHeaders(request.headers),
    body,
  });

  if (request.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(request.url)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected probe route" } }));
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const responseText = request.url === "/chat/completions" ? "PMA_CODEBUDDY_DIRECT_OK" : "PMA_CODEBUDDY_OK";
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-codebuddy-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-codebuddy-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
});

try {
  const upstreamUrl = await listen(upstream);
  fs.writeFileSync(
    path.join(configDir, "models.json"),
    `${JSON.stringify({
      models: [{
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro PMA probe",
        vendor: "OpenAI-compatible",
        apiKey: "${PMA_CODEBUDDY_TEST_API_KEY}",
        url: `${upstreamUrl}/v1/chat/completions`,
        maxInputTokens: 128000,
        maxOutputTokens: 4096,
        supportsToolCall: true,
        supportsImages: false,
        supportsReasoning: true,
      }],
      availableModels: ["mimo-v2.5-pro"],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const openAiResult = await runCodeBuddy({
    cwd: workspace,
    env: {
      ...process.env,
      CODEBUDDY_CONFIG_DIR: configDir,
      PMA_CODEBUDDY_TEST_API_KEY: "probe-key-not-real",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1",
      CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
      CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
    },
  });

  const directResult = await runCodeBuddy({
    cwd: workspace,
    expectedText: "PMA_CODEBUDDY_DIRECT_OK",
    env: {
      ...process.env,
      CODEBUDDY_CONFIG_DIR: directConfigDir,
      CODEBUDDY_BASE_URL: upstreamUrl,
      CODEBUDDY_API_KEY: "probe-key-not-real",
      CODEBUDDY_MODEL: "mimo-v2.5-pro",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1",
      CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
      CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
    },
  });

  console.log(JSON.stringify({
    kind: "codebuddy_local_mock_probe",
    codebuddy_version: await codeBuddyVersion(),
    custom_openai: {
      exit_code: openAiResult.code,
      stdout_contains_expected_text: openAiResult.stdout.includes("PMA_CODEBUDDY_OK"),
      stderr_present: Boolean(openAiResult.stderr.trim()),
    },
    direct_base_url: {
      exit_code: directResult.code,
      stdout_contains_expected_text: directResult.stdout.includes("PMA_CODEBUDDY_DIRECT_OK"),
      stderr_present: Boolean(directResult.stderr.trim()),
    },
    requests: requests.map((request) => ({
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: summarizeBody(request.body),
    })),
  }, null, 2));
  if (
    openAiResult.code !== 0 ||
    !openAiResult.stdout.includes("PMA_CODEBUDDY_OK") ||
    directResult.code !== 0 ||
    !directResult.stdout.includes("PMA_CODEBUDDY_DIRECT_OK") ||
    requests.length !== 2 ||
    requests[0]?.path !== "/v1/chat/completions" ||
    requests[1]?.path !== "/chat/completions" ||
    requests.some((request) => request.body?.model !== "mimo-v2.5-pro") ||
    requests.some((request) => request.headers?.["x-codebuddy-request"] !== "1")
  ) {
    process.exitCode = 1;
  }
} finally {
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCodeBuddy({ cwd, env, expectedText = "PMA_CODEBUDDY_OK" }) {
  return run("codebuddy", [
    "--print",
    "--output-format",
    "text",
    "--model",
    "mimo-v2.5-pro",
    "--tools",
    "",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--max-turns",
    "1",
    `Reply with ${expectedText} and do not use tools.`,
  ], { cwd, env, timeoutMs: 30_000 });
}

async function codeBuddyVersion() {
  const result = await run("codebuddy", ["--version"], { cwd: workspace, env: process.env, timeoutMs: 10_000 });
  return result.stdout.trim() || null;
}

function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
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

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    /authorization|api-key|cookie|token|conversation|request-id|message-id|user-id/i.test(key) ? "[REDACTED]" : value,
  ]));
}

function summarizeBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return {
    model: body?.model || null,
    stream: body?.stream ?? null,
    message_count: messages.length,
    roles: messages.map((message) => message?.role || null),
    tools_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    max_tokens: body?.max_tokens ?? null,
    reasoning_effort: body?.reasoning_effort ?? null,
  };
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
