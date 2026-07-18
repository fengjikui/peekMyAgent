#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { zstdCompressSync } from "node:zlib";
import { createCodexExactProxyAdapter, CODEX_CAPTURE_ADAPTER } from "../src/adapters/codex-exact-proxy.mjs";
import { listen, startCaptureProxy } from "../src/core/capture-proxy.mjs";
import { summarizeModelResponse } from "../src/trace/model-response-normalizer.mjs";

const forwarded = [];
const upstream = http.createServer(async (req, res) => {
  const body = await readBuffer(req);
  forwarded.push({ method: req.method, path: req.url, headers: req.headers, body });
  res.writeHead(200, { "content-type": req.url.includes("/responses") ? "text/event-stream" : "application/json" });
  if (req.url.includes("/responses")) {
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_smoke","model":"gpt-smoke","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"inspect first"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will read the file."}]},{"type":"function_call","call_id":"call-smoke","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}],"usage":{"input_tokens":21,"output_tokens":8}}}\n\n');
  } else {
    res.end('{"data":[]}');
  }
});

await listen(upstream, "127.0.0.1", 0);
const address = upstream.address();
const targetBaseUrl = `http://${address.address}:${address.port}`;
const captures = [];
const proxy = await startCaptureProxy({
  targetBaseUrl,
  captures,
  captureAdapter: createCodexExactProxyAdapter(),
  defaultAttribution: { watchId: "codex-exact-smoke", agentProfile: "Codex" },
});

try {
  const requestBody = {
    model: "gpt-smoke",
    instructions: "Inspect the current project.",
    input: [{ role: "user", content: [{ type: "input_text", text: "List one file." }] }],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" } }],
  };
  const rawJson = Buffer.from(JSON.stringify(requestBody));
  const compressed = zstdCompressSync(rawJson);
  const response = await fetch(`${proxy.baseUrl}/v1/responses?stream=true`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret-smoke-token",
      "chatgpt-account-id": "acct-smoke-private",
      "content-encoding": "zstd",
      "content-type": "application/json",
      "thread-id": "thread-smoke-private",
      "x-peek-watch-id": "codex-exact-smoke",
      "x-client-request-id": "request-smoke-private",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "session-smoke-private",
        thread_id: "thread-smoke-private",
        turn_id: "turn-smoke-private",
      }),
      "x-codex-window-id": "window-smoke-private",
    },
    body: compressed,
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].path, "/backend-api/codex/responses?stream=true");
  assert.equal(forwarded[0].headers.authorization, "Bearer secret-smoke-token");
  assert.equal(forwarded[0].headers["chatgpt-account-id"], "acct-smoke-private");
  assert.equal(forwarded[0].headers["thread-id"], "thread-smoke-private");
  assert.equal(forwarded[0].headers["x-client-request-id"], "request-smoke-private");
  assert.equal(forwarded[0].headers["x-codex-turn-metadata"], JSON.stringify({
    session_id: "session-smoke-private",
    thread_id: "thread-smoke-private",
    turn_id: "turn-smoke-private",
  }));
  assert.equal(forwarded[0].headers["x-codex-window-id"], "window-smoke-private");
  assert.equal(forwarded[0].headers["x-peek-watch-id"], undefined);
  assert.deepEqual(forwarded[0].body, compressed, "the authenticated request is forwarded with byte-identical zstd content");

  assert.equal(captures.length, 1);
  assert.equal(captures[0].capture_adapter, CODEX_CAPTURE_ADAPTER);
  assert.equal(captures[0].request_content_encoding, "zstd");
  assert.equal(captures[0].raw_body_length, compressed.length);
  assert.equal(captures[0].decoded_body_length, rawJson.length);
  assert.deepEqual(captures[0].body, requestBody);
  assert.equal(captures[0].upstream_path, "/backend-api/codex/responses?stream=true");
  assert.notEqual(captures[0].headers.authorization, "Bearer secret-smoke-token");
  for (const header of [
    "authorization",
    "chatgpt-account-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-turn-metadata",
    "x-codex-window-id",
  ]) {
    assert.equal(captures[0].headers[header], "[REDACTED:header]", `${header} is redacted before persistence`);
    assert.ok(
      captures[0].header_redactions.some((entry) => entry.field_path === `headers.${header}`),
      `${header} redaction is recorded`,
    );
  }
  const responseSummary = summarizeModelResponse(captures[0].response);
  assert.equal(responseSummary.text, "I will read the file.");
  assert.equal(responseSummary.thinking, "inspect first");
  assert.equal(responseSummary.response_status, "completed");
  assert.deepEqual(responseSummary.tool_calls, [{ id: "call-smoke", name: "read_file", arguments: { path: "README.md" } }]);

  const models = await fetch(`${proxy.baseUrl}/v1/models`, {
    headers: { authorization: "Bearer secret-smoke-token" },
  });
  assert.equal(models.status, 200);
  await models.text();
  assert.equal(forwarded[1].path, "/backend-api/codex/models");
  assert.equal(captures.length, 1, "model catalog traffic is forwarded but not stored as a Trace request");

  const blocked = await fetch(`${proxy.baseUrl}/v1/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(blocked.status, 404);
  assert.equal(forwarded.length, 2, "unverified Codex routes never reach the upstream");

  const unsupportedEncoding = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-encoding": "gzip", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unsupportedEncoding.status, 415);
  assert.equal(forwarded.length, 2);

  console.log("Codex exact proxy smoke passed");
} finally {
  await proxy.close();
  await closeServer(upstream);
}

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
