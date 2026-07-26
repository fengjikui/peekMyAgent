#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-opencode-compact-"));
const workDir = path.join(tmpDir, "work");
const modelRequests = [];
let openCode = null;

fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(path.join(workDir, "compact-fixture.txt"), "PMA_COMPACTION_FIXTURE\n");

const upstream = http.createServer(async (req, res) => {
  const body = parseJson(await readBody(req));
  modelRequests.push({
    method: req.method,
    path: req.url,
    body,
  });

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":{"message":"unexpected mock route"}}\n');
    return;
  }

  const systemText = lastMessageText(body, "system");
  const userText = lastMessageText(body, "user");
  const isCompaction =
    /anchored context summarization assistant for coding sessions/i.test(systemText) &&
    /^Create a new anchored summary from the conversation history\./i.test(userText.trimStart());
  const content = isCompaction ? "PMA_COMPACT_SUMMARY" : "PMA_MODEL_RESPONSE";
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, {
    id: `chatcmpl-${modelRequests.length}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  writeSse(res, {
    id: `chatcmpl-${modelRequests.length}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 101, completion_tokens: 3, total_tokens: 104 },
  });
  res.end("data: [DONE]\n\n");
});

try {
  const upstreamUrl = await listen(upstream);
  const port = await reservePort();
  const config = {
    model: "pma-mock/mock",
    provider: {
      "pma-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "PMA local compaction probe",
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
  const env = isolatedOpenCodeEnv(tmpDir, config);
  openCode = spawn(
    "opencode",
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
    {
      cwd: workDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const serverOutput = collectProcessOutput(openCode);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/doc`, serverOutput);

  const directoryQuery = `directory=${encodeURIComponent(workDir)}`;
  const session = await requestJson(`${baseUrl}/session?${directoryQuery}`, {
    method: "POST",
    body: {
      title: "peekMyAgent OpenCode compaction probe",
      model: { id: "mock", providerID: "pma-mock" },
    },
  });
  assert.match(String(session?.id || ""), /^ses/);

  await requestJson(`${baseUrl}/session/${encodeURIComponent(session.id)}/message?${directoryQuery}`, {
    method: "POST",
    body: {
      model: { providerID: "pma-mock", modelID: "mock" },
      parts: [
        {
          type: "text",
          text: "Remember the marker PMA_BEFORE_BOUNDARY and reply briefly.",
        },
      ],
    },
  });
  const requestCountBeforeCompaction = modelRequests.length;

  const summarized = await requestJson(
    `${baseUrl}/session/${encodeURIComponent(session.id)}/summarize?${directoryQuery}`,
    {
      method: "POST",
      body: {
        providerID: "pma-mock",
        modelID: "mock",
        auto: false,
      },
    },
  );
  assert.equal(summarized, true);
  assert.ok(
    modelRequests.length > requestCountBeforeCompaction,
    "The summarize API did not issue a model request",
  );
  const compactionRequests = modelRequests.filter(({ body }) => {
    const systemText = lastMessageText(body, "system");
    const userText = lastMessageText(body, "user");
    return (
      /anchored context summarization assistant for coding sessions/i.test(systemText) &&
      /^Create a new anchored summary from the conversation history\./i.test(userText.trimStart())
    );
  });
  assert.equal(compactionRequests.length, 1, "Expected exactly one anchored-summary model request");

  const messagesAfterCompaction = await requestJson(
    `${baseUrl}/session/${encodeURIComponent(session.id)}/message?${directoryQuery}`,
  );
  const summaryMessage = messagesAfterCompaction.find((message) => message?.info?.summary === true);
  const compactionBoundary = messagesAfterCompaction.find((message) =>
    message?.parts?.some((part) => part?.type === "compaction"),
  );
  assert.ok(summaryMessage, "OpenCode did not persist an assistant summary message");
  assert.ok(compactionBoundary, "OpenCode did not persist a compaction boundary part");

  await requestJson(`${baseUrl}/session/${encodeURIComponent(session.id)}/message?${directoryQuery}`, {
    method: "POST",
    body: {
      model: { providerID: "pma-mock", modelID: "mock" },
      parts: [
        {
          type: "text",
          text: "After compaction, reply with PMA_AFTER_COMPACTION.",
        },
      ],
    },
  });

  const postCompactionRequest = modelRequests.at(-1);
  assert.ok(
    requestText(postCompactionRequest?.body).includes("PMA_COMPACT_SUMMARY"),
    "The next model request did not carry the persisted compacted summary",
  );

  await requestJson(`${baseUrl}/session/${encodeURIComponent(session.id)}?${directoryQuery}`, {
    method: "DELETE",
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "opencode_compaction_local_probe",
        model_request_count: modelRequests.length,
        request_shapes: modelRequests.map((entry, index) => ({
          index: index + 1,
          roles: (entry.body?.messages || []).map((message) => message?.role || "unknown"),
          last_user_preview: lastMessageText(entry.body, "user").slice(0, 180),
          system_preview: lastMessageText(entry.body, "system").slice(0, 180),
        })),
        summarize_request_observed: true,
        assistant_summary_persisted: true,
        compaction_boundary_persisted: true,
        next_request_reused_summary: true,
        isolated_state_removed: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (openCode && openCode.exitCode === null) {
    openCode.kill("SIGTERM");
    await waitForExit(openCode, 2_000);
    if (openCode.exitCode === null) openCode.kill("SIGKILL");
  }
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function isolatedOpenCodeEnv(root, config) {
  return {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    NO_COLOR: "1",
  };
}

async function requestJson(url, { method = "GET", body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function waitForServer(url, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server startup is still in progress.
    }
    if (output.closed) {
      throw new Error(`OpenCode server exited during startup:\n${output.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the OpenCode server:\n${output.text()}`);
}

function collectProcessOutput(child) {
  let stdout = "";
  let stderr = "";
  const state = { closed: false };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("close", () => {
    state.closed = true;
  });
  return {
    get closed() {
      return state.closed;
    },
    text() {
      return `${stdout}\n${stderr}`.trim();
    },
  };
}

function reservePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
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
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
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

function requestText(body) {
  return (body?.messages || [])
    .flatMap((message) => {
      if (typeof message?.content === "string") return [message.content];
      if (!Array.isArray(message?.content)) return [];
      return message.content.map((part) => part?.text || "").filter(Boolean);
    })
    .join("\n");
}

function lastMessageText(body, role) {
  const message = [...(body?.messages || [])].reverse().find((item) => item?.role === role);
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => part?.text || "").join("\n");
}

function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}
