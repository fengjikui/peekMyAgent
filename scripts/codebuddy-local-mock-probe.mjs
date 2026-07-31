import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildCodeBuddyProxyEnv } from "../src/adapters/codebuddy-config.mjs";
import { readBody } from "../src/core/capture-proxy.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codebuddy-probe-"));
const configDir = path.join(tmpDir, "config");
const directConfigDir = path.join(tmpDir, "direct-config");
const workspace = path.join(tmpDir, "workspace");
const toolFixturePath = path.join(workspace, "tool-fixture.txt");
const requests = [];
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(directConfigDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(toolFixturePath, "PMA_CODEBUDDY_TOOL_FIXTURE\n", "utf8");

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

  if (
    request.method !== "POST" ||
    ![
      "/proxy/chat/completions",
      "/chat/completions",
      "/tool-loop/chat/completions",
      "/subagent/chat/completions",
      "/resume/chat/completions",
    ].includes(request.url)
  ) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected probe route" } }));
    return;
  }

  if (request.url === "/tool-loop/chat/completions") {
    const hasToolResult = body.messages?.some((message) => message?.role === "tool");
    if (hasToolResult) writeTextResponse(response, "PMA_CODEBUDDY_TOOL_LOOP_OK");
    else writeToolCallResponse(response, {
      id: "call-codebuddy-read",
      name: "Read",
      argumentsJson: JSON.stringify({ file_path: toolFixturePath }),
    });
    return;
  }
  if (request.url === "/subagent/chat/completions") {
    const purpose = String(request.headers["x-agent-purpose"] || "");
    const hasToolResult = body.messages?.some((message) => message?.role === "tool");
    if (/^(?:subagent|custom_agent)(?::|$)/i.test(purpose)) {
      writeTextResponse(response, "PMA_CODEBUDDY_SUBAGENT_CHILD_OK");
    } else if (hasToolResult) {
      writeTextResponse(response, "PMA_CODEBUDDY_SUBAGENT_PARENT_OK");
    } else {
      writeToolCallResponse(response, {
        id: "call-codebuddy-agent",
        name: "Agent",
        argumentsJson: JSON.stringify({
          description: "Inspect one fixture",
          prompt: "Return a concise fixture inspection result.",
          subagent_type: "Explore",
          max_turns: 1,
        }),
      });
    }
    return;
  }
  if (request.url === "/resume/chat/completions") {
    const resumeRequestCount = requests.filter((item) => item.path === "/resume/chat/completions").length;
    writeTextResponse(
      response,
      resumeRequestCount === 1 ? "PMA_CODEBUDDY_RESUME_FIRST_OK" : "PMA_CODEBUDDY_RESUME_SECOND_OK",
    );
    return;
  }
  const responseText = request.url === "/chat/completions" ? "PMA_CODEBUDDY_DIRECT_OK" : "PMA_CODEBUDDY_FILE_OK";
  writeTextResponse(response, responseText);
});

try {
  const upstreamUrl = await listen(upstream);
  const modelsPath = path.join(configDir, "models.json");
  const modelsSource =
    `${JSON.stringify({
      models: [{
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro PMA probe",
        vendor: "OpenAI-compatible",
        apiKey: "probe-key-not-real",
        url: `${upstreamUrl}/must-not-bypass/chat/completions`,
        maxInputTokens: 128000,
        maxOutputTokens: 4096,
        supportsToolCall: true,
        supportsImages: false,
        supportsReasoning: true,
      }],
      availableModels: ["mimo-v2.5-pro"],
    }, null, 2)}\n`;
  fs.writeFileSync(
    modelsPath,
    modelsSource,
    { mode: 0o600 },
  );

  const fileModelEnv = {
    ...process.env,
    CODEBUDDY_CONFIG_DIR: configDir,
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1",
    CODEBUDDY_PROMPT_SUGGESTION_DISABLED: "1",
    CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
    CODEBUDDY_MEMORY_RELEVANCE_DISABLED: "1",
    CODEBUDDY_MEMORY_EXTRACTION_DISABLED: "1",
    CODEBUDDY_CODE_DISABLE_TERMINAL_TITLE: "1",
    CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
  const openAiResult = await runCodeBuddy({
    cwd: workspace,
    expectedText: "PMA_CODEBUDDY_FILE_OK",
    env: buildCodeBuddyProxyEnv({
      env: fileModelEnv,
      proxyBaseUrl: `${upstreamUrl}/proxy`,
      model: "mimo-v2.5-pro",
      cwd: workspace,
    }),
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
      CODEBUDDY_MEMORY_RELEVANCE_DISABLED: "1",
      CODEBUDDY_MEMORY_EXTRACTION_DISABLED: "1",
      CODEBUDDY_CODE_DISABLE_TERMINAL_TITLE: "1",
      CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1",
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
    },
  });

  const toolLoopResult = await runCodeBuddy({
    cwd: workspace,
    expectedText: "PMA_CODEBUDDY_TOOL_LOOP_OK",
    tools: "Read",
    maxTurns: 3,
    prompt: "Read the fixture file, then report the final fixture status.",
    env: buildCodeBuddyProxyEnv({
      env: fileModelEnv,
      proxyBaseUrl: `${upstreamUrl}/tool-loop`,
      model: "mimo-v2.5-pro",
      cwd: workspace,
    }),
  });

  const subagentResult = await runCodeBuddy({
    cwd: workspace,
    expectedText: "PMA_CODEBUDDY_SUBAGENT_PARENT_OK",
    tools: "Agent",
    maxTurns: 4,
    prompt: "Delegate one fixture inspection to an Explore subagent, then report the final status.",
    env: buildCodeBuddyProxyEnv({
      env: fileModelEnv,
      proxyBaseUrl: `${upstreamUrl}/subagent`,
      model: "mimo-v2.5-pro",
      cwd: workspace,
    }),
  });

  const resumeSessionId = "codebuddy-pma-resume-probe";
  const resumeEnv = buildCodeBuddyProxyEnv({
    env: fileModelEnv,
    proxyBaseUrl: `${upstreamUrl}/resume`,
    model: "mimo-v2.5-pro",
    cwd: workspace,
  });
  const resumeFirstResult = await runCodeBuddy({
    cwd: workspace,
    env: resumeEnv,
    expectedText: "PMA_CODEBUDDY_RESUME_FIRST_OK",
    persistSession: true,
    sessionArgs: ["--session-id", resumeSessionId],
    prompt: "Create the first non-sensitive resume fixture turn.",
  });
  const resumeSecondResult = await runCodeBuddy({
    cwd: workspace,
    env: resumeEnv,
    expectedText: "PMA_CODEBUDDY_RESUME_SECOND_OK",
    persistSession: true,
    sessionArgs: ["--resume", resumeSessionId],
    prompt: "Continue with the second non-sensitive resume fixture turn.",
  });

  console.log(JSON.stringify({
    kind: "codebuddy_local_mock_probe",
    codebuddy_version: await codeBuddyVersion(),
    models_json_process_override: {
      exit_code: openAiResult.code,
      stdout_contains_expected_text: openAiResult.stdout.includes("PMA_CODEBUDDY_FILE_OK"),
      source_file_unchanged: fs.readFileSync(modelsPath, "utf8") === modelsSource,
      stderr_present: Boolean(openAiResult.stderr.trim()),
    },
    direct_base_url: {
      exit_code: directResult.code,
      stdout_contains_expected_text: directResult.stdout.includes("PMA_CODEBUDDY_DIRECT_OK"),
      stderr_present: Boolean(directResult.stderr.trim()),
    },
    tool_loop: {
      exit_code: toolLoopResult.code,
      stdout_contains_expected_text: toolLoopResult.stdout.includes("PMA_CODEBUDDY_TOOL_LOOP_OK"),
      stderr_present: Boolean(toolLoopResult.stderr.trim()),
    },
    subagent: {
      exit_code: subagentResult.code,
      stdout_contains_expected_text: subagentResult.stdout.includes("PMA_CODEBUDDY_SUBAGENT_PARENT_OK"),
      stderr_present: Boolean(subagentResult.stderr.trim()),
    },
    resume: {
      first_exit_code: resumeFirstResult.code,
      second_exit_code: resumeSecondResult.code,
      first_stdout_contains_expected_text: resumeFirstResult.stdout.includes("PMA_CODEBUDDY_RESUME_FIRST_OK"),
      second_stdout_contains_expected_text: resumeSecondResult.stdout.includes("PMA_CODEBUDDY_RESUME_SECOND_OK"),
      second_request_includes_history: requests
        .filter((request) => request.path === "/resume/chat/completions")
        .at(-1)?.body?.messages?.length > 2,
    },
    requests: requests.map((request) => ({
      method: request.method,
      path: request.path,
      headers: summarizeHeaders(request.headers),
      body: summarizeBody(request.body),
    })),
  }, null, 2));
  if (
    openAiResult.code !== 0 ||
    !openAiResult.stdout.includes("PMA_CODEBUDDY_FILE_OK") ||
    fs.readFileSync(modelsPath, "utf8") !== modelsSource ||
    directResult.code !== 0 ||
    !directResult.stdout.includes("PMA_CODEBUDDY_DIRECT_OK") ||
    toolLoopResult.code !== 0 ||
    !toolLoopResult.stdout.includes("PMA_CODEBUDDY_TOOL_LOOP_OK") ||
    subagentResult.code !== 0 ||
    !subagentResult.stdout.includes("PMA_CODEBUDDY_SUBAGENT_PARENT_OK") ||
    resumeFirstResult.code !== 0 ||
    !resumeFirstResult.stdout.includes("PMA_CODEBUDDY_RESUME_FIRST_OK") ||
    resumeSecondResult.code !== 0 ||
    !resumeSecondResult.stdout.includes("PMA_CODEBUDDY_RESUME_SECOND_OK") ||
    requests[0]?.path !== "/proxy/chat/completions" ||
    requests[1]?.path !== "/chat/completions" ||
    requests.some((request) => request.body?.model !== "mimo-v2.5-pro") ||
    requests.some((request) =>
      !/^(?:subagent|custom_agent)(?::|$)/i.test(String(request.headers?.["x-agent-purpose"] || "")) &&
      request.headers?.["x-codebuddy-request"] !== "1"
    ) ||
    requests.filter((request) => request.path === "/tool-loop/chat/completions").length !== 2 ||
    !requests.some((request) =>
      request.path === "/tool-loop/chat/completions" &&
      request.body?.messages?.some((message) => message?.role === "tool")
    ) ||
    !requests.some((request) =>
      request.path === "/subagent/chat/completions" &&
      /^subagent(?::|$)/i.test(String(request.headers?.["x-agent-purpose"] || "")) &&
      request.headers?.["x-codebuddy-request"] == null
    ) ||
    requests.filter((request) => request.path === "/resume/chat/completions").length !== 2 ||
    requests.filter((request) => request.path === "/resume/chat/completions").at(-1)?.body?.messages?.length <= 2
  ) {
    process.exitCode = 1;
  }
} finally {
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function beginStream(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function writeTextResponse(response, text) {
  beginStream(response);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-codebuddy-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
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
}

function writeToolCallResponse(response, { id, name, argumentsJson }) {
  beginStream(response);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-codebuddy-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: argumentsJson } }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-codebuddy-probe",
    object: "chat.completion.chunk",
    created: 1,
    model: "mimo-v2.5-pro",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function runCodeBuddy({
  cwd,
  env,
  expectedText = "PMA_CODEBUDDY_OK",
  tools = "",
  maxTurns = 1,
  prompt,
  persistSession = false,
  sessionArgs = [],
}) {
  return run("codebuddy", [
    "--print",
    "--output-format",
    "text",
    "--model",
    "mimo-v2.5-pro",
    "--tools",
    tools,
    "--permission-mode",
    "bypassPermissions",
    ...(persistSession ? [] : ["--no-session-persistence"]),
    ...sessionArgs,
    "--max-turns",
    String(maxTurns),
    prompt || `Reply with ${expectedText} and do not use tools.`,
  ], { cwd, env, timeoutMs: 60_000 });
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

function summarizeHeaders(headers) {
  const rawPurpose = String(headers?.["x-agent-purpose"] || "").toLowerCase();
  const agentPurpose = rawPurpose.startsWith("subagent:")
    ? "subagent"
    : rawPurpose.startsWith("custom_agent:")
      ? "custom_agent"
      : rawPurpose || null;
  return {
    codebuddy_request: headers?.["x-codebuddy-request"] || null,
    agent_purpose: agentPurpose,
    agent_intent: headers?.["x-agent-intent"] || null,
    ide_version: headers?.["x-ide-version"] || null,
    authorization_present: Boolean(headers?.authorization),
    api_key_present: Boolean(headers?.["x-api-key"]),
  };
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
