#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-opencode-probe-"));
const workDir = path.join(tmpDir, "work");
const requests = [];
fs.mkdirSync(workDir, { recursive: true });

const upstream = http.createServer(async (req, res) => {
  const bodyText = await readBody(req);
  const body = parseJson(bodyText);
  requests.push({
    method: req.method,
    path: req.url,
    headers: redactedHeaders(req.headers),
    body,
  });

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeSse(res, {
      id: "chatcmpl-pma-probe",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock",
      choices: [{ index: 0, delta: { role: "assistant", content: "PMA_MOCK_OK" }, finish_reason: null }],
    });
    writeSse(res, {
      id: "chatcmpl-pma-probe",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 101, completion_tokens: 3, total_tokens: 104 },
    });
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":{"message":"unexpected probe route"}}\n');
});

const upstreamUrl = await listen(upstream);
const providerConfig = {
  model: "pma-mock/mock",
  provider: {
    "pma-mock": {
      npm: "@ai-sdk/openai-compatible",
      name: "PMA local protocol probe",
      options: {
        baseURL: `${upstreamUrl}/v1`,
        apiKey: "probe-not-a-secret",
      },
      models: {
        mock: {
          name: "PMA mock model",
        },
      },
    },
  },
};

try {
  const result = await runOpenCode({
    cwd: workDir,
    env: isolatedOpenCodeEnv(tmpDir, providerConfig),
    args: [
      "run",
      "--pure",
      "--format",
      "json",
      "--model",
      "pma-mock/mock",
      "Reply with PMA_MOCK_OK only.",
    ],
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PMA_MOCK_OK/);
  const requestSummaries = requests.map(summarizeRequest);
  assert.ok(requests.length >= 1, "OpenCode did not send a model request.");
  assert.ok(requests.every((entry) => entry.method === "POST"));
  assert.ok(requests.every((entry) => entry.path === "/v1/chat/completions"));
  const primary = requests.find((entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length > 0) || requests.at(-1);
  assert.equal(primary.body?.model, "mock");
  assert.ok(Array.isArray(primary.body?.messages));
  assert.ok(Array.isArray(primary.body?.tools));
  assert.equal(primary.body?.stream, true);
  const emittedSessionIds = openCodeSessionIds(result.stdout);
  assert.equal(emittedSessionIds.size, 1, "OpenCode JSONL should report exactly one session ID.");
  assert.ok(
    requests.every((entry) => emittedSessionIds.has(entry.headers?.["x-session-id"])),
    "OpenCode x-session-id should match the session ID emitted by the CLI.",
  );

  const roles = primary.body.messages.map((message) => message?.role).filter(Boolean);
  const toolNames = primary.body.tools
    .map((tool) => tool?.function?.name || tool?.name)
    .filter(Boolean);
  process.stdout.write(`${JSON.stringify({
    opencode_exit_code: result.code,
    requests: requestSummaries,
    primary_request: {
      method: primary.method,
      path: primary.path,
      protocol: "openai-chat-completions",
      message_count: primary.body.messages.length,
      roles,
      tool_count: primary.body.tools.length,
      tool_names: toolNames,
      stream: primary.body.stream,
    },
    response_observed: "PMA_MOCK_OK",
    request_session_matches_cli: true,
    isolated_state_removed: true,
  }, null, 2)}\n`);
} finally {
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function isolatedOpenCodeEnv(root, config) {
  const home = path.join(root, "home");
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

function runOpenCode({ cwd, env, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OpenCode protocol probe timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
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
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function openCodeSessionIds(stdout) {
  const ids = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseJson(line);
    if (typeof event?.sessionID === "string") ids.add(event.sessionID);
  }
  return ids;
}

function redactedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      /authorization|api[-_]?key|cookie|token/i.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

function summarizeRequest(entry) {
  const messages = Array.isArray(entry.body?.messages) ? entry.body.messages : [];
  const tools = Array.isArray(entry.body?.tools) ? entry.body.tools : [];
  return {
    method: entry.method,
    path: entry.path,
    header_names: Object.keys(entry.headers || {}).sort(),
    user_agent: entry.headers?.["user-agent"] || null,
    x_header_names: Object.keys(entry.headers || {}).filter((name) => name.startsWith("x-")).sort(),
    x_session_id: entry.headers?.["x-session-id"] || null,
    x_session_affinity: entry.headers?.["x-session-affinity"] || null,
    model: entry.body?.model || null,
    message_count: messages.length,
    roles: messages.map((message) => message?.role).filter(Boolean),
    messages: messages.map((message, index) => ({
      index,
      role: message?.role || null,
      chars: messageText(message).length,
      preview: messageText(message).slice(0, 160),
    })),
    tool_count: tools.length,
    tool_names: tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean),
    max_tokens: entry.body?.max_tokens ?? null,
    stream: entry.body?.stream ?? null,
    last_text_preview: messageText(messages.at(-1)).slice(0, 120),
  };
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => part?.text || "").join("\n");
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}
