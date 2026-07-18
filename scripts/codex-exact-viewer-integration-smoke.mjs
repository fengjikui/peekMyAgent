#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { rawResponseSectionValue } from "../src/viewer/raw-view-model.js";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-codex-exact-viewer-"));
const storePath = path.join(tmpDir, "store.sqlite");
const forwarded = [];

const upstream = http.createServer(async (req, res) => {
  forwarded.push({ path: req.url, body: await readBuffer(req), headers: req.headers });
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  if (forwarded.length > 1) {
    res.end(
      'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"id":"resp_exact_viewer_final","model":"gpt-codex-fixture","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Use the returned file content."}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"README.md describes peekMyAgent."}]}],"usage":{"input_tokens":57,"output_tokens":9}}}\n\n',
    );
    return;
  }
  res.end(
    'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_exact_viewer","model":"gpt-codex-fixture","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Inspect the project file first."}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will inspect README.md."}]},{"type":"function_call","call_id":"call_exact_viewer","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}],"usage":{"input_tokens":41,"output_tokens":13}}}\n\n',
  );
});

const upstreamUrl = await listen(upstream);
let viewer;
try {
  viewer = await startViewerServer({ cwd: tmpDir, storePath });
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Codex",
    mode: "single_session",
    workspace: tmpDir,
    conversation_id: "codex-exact-viewer-fixture",
    target_base_url: upstreamUrl,
    kind: "codex_proxy_exact",
    confidence: "exact",
    reuse: false,
  });

  const requestBody = {
    model: "gpt-codex-fixture",
    instructions: "You are Codex. Inspect the repository before answering.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect README.md." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read one workspace file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Workspace-relative path." } },
          required: ["path"],
        },
      },
    ],
  };
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify(requestBody)));
  const response = await postCodexRequest(watch.base_url, compressed);
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);

  const continuedRequestBody = {
    ...requestBody,
    input: [
      ...requestBody.input,
      {
        type: "function_call",
        call_id: "call_exact_viewer",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_exact_viewer",
        output: "# peekMyAgent",
      },
    ],
  };
  const continuedCompressed = zstdCompressSync(Buffer.from(JSON.stringify(continuedRequestBody)));
  const continuedResponse = await postCodexRequest(watch.base_url, continuedCompressed);
  const continuedResponseText = await continuedResponse.text();
  assert.equal(continuedResponse.status, 200, continuedResponseText);

  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].path, "/backend-api/codex/responses");
  assert.deepEqual(forwarded[0].body, compressed, "Viewer-managed proxy must preserve Codex zstd bytes");
  assert.deepEqual(forwarded[1].body, continuedCompressed, "continued Codex requests preserve their zstd bytes");

  const sourceId = watch.id;
  const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
  assert.equal(view.source.agent, "Codex");
  assert.equal(view.source.kind, "codex_proxy_exact");
  assert.equal(view.requests.length, 2);
  assert.equal(view.stats.tool_call_count, 1);
  assert.equal(view.stats.tool_result_count, 1);
  assert.equal(view.requests[0].summary.current_user, "Inspect README.md.");
  assert.equal(view.requests[0].summary.response.preview, "I will inspect README.md.");
  assert.equal(view.requests[0].summary.response.thinking, "Inspect the project file first.");
  assert.equal(view.requests[0].summary.response.response_status, "completed");
  assert.equal(view.requests[0].summary.response.tool_calls[0].name, "read_file");
  assert.equal(view.requests[1].summary.current_tool_results[0].id, "call_exact_viewer");
  assert.equal(view.requests[1].summary.response.preview, "README.md describes peekMyAgent.");

  const detail = await getJson(
    `${viewer.url}/api/request?source=${encodeURIComponent(sourceId)}&request=${encodeURIComponent(view.requests[0].id)}`,
  );
  assert.equal(detail.request.raw.provenance.transport, "capture_proxy");
  assert.equal(detail.request.raw.capture_adapter, "codex_responses_v1");
  assert.equal(detail.request.raw.body.instructions, requestBody.instructions);
  assert.equal(detail.request.raw.body.tools[0].name, "read_file");
  const responseSection = rawResponseSectionValue(detail.request);
  assert.equal(responseSection.parsed_from_response.text, "I will inspect README.md.");
  assert.equal(responseSection.parsed_from_response.tool_use[0].name, "read_file");

  const store = openPersistenceStore(storePath);
  try {
    const systemStats = store.blobStats().find((item) => item.kind === "system_block");
    const toolStats = store.blobStats().find((item) => item.kind === "tool_schema");
    assert.equal(systemStats.count, 1, "stable Codex instructions are stored once");
    assert.equal(systemStats.refs, 2, "both Codex requests reuse the same instructions block");
    assert.equal(toolStats.count, 1, "stable Codex tool schemas are stored once");
    assert.equal(toolStats.refs, 2, "both Codex requests reuse the same tool schema block");
    assert.deepEqual(store.reconstructBody(view.requests[1].id), continuedRequestBody);
  } finally {
    store.close();
  }

  console.log("Codex exact Viewer integration smoke passed");
} finally {
  await viewer?.close();
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeadersForUrl(url),
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}

function postCodexRequest(baseUrl, body) {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer exact-viewer-secret",
      "content-encoding": "zstd",
      "content-type": "application/json",
    },
    body,
  });
}

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
