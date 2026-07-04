import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-response-"));
const storePath = path.join(tmpDir, "store.sqlite");
const originalTarget = process.env.PEEK_CLAUDE_TARGET_BASE_URL;

const upstream = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  if (body.delay_response) await delay(250);
  if (body.anthropic_stream) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ type: "message_start", message: { id: "msg_anthropic", type: "message", role: "assistant", content: [] } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal thought " } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "should be folded" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "anthropic " } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "stream reply" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 8, output_tokens: 3 } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    res.end();
    return;
  }
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "openai thought " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "folded" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "stream " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_openai", type: "function", function: { name: "Read", arguments: "" } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "reply" }, finish_reason: "stop" }], usage: { input_tokens: 5, output_tokens: 2 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_response_smoke",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "json reply from upstream" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 4 },
    }),
  );
});

const upstreamUrl = await listen(upstream);
process.env.PEEK_CLAUDE_TARGET_BASE_URL = upstreamUrl;

let sourceId = null;

try {
  const viewer = await startViewerServer({ cwd, storePath });
  try {
    const watch = await postJson(`${viewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: cwd,
      conversation_id: "response-capture-smoke-session",
      target_base_url: upstreamUrl,
    });
    sourceId = watch.id;

    const delayed = postModelRequest(watch.base_url, {
      model: "mock-claude",
      delay_response: true,
      messages: [{ role: "user", content: "capture a normal response" }],
    });
    const inFlightView = await waitFor(async () => {
      const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
      return view.stats.request_count === 1 && !view.requests[0].summary.response.captured ? view : null;
    });
    assert.equal(inFlightView.requests[0].summary.response.captured, false);
    const inFlightSources = await getJson(`${viewer.url}/api/sources`);
    const inFlightSource = inFlightSources.find((source) => source.id === sourceId);
    assert.equal(inFlightSource.response_count || 0, 0);
    await delayed;
    const afterResponseSources = await waitFor(async () => {
      const sources = await getJson(`${viewer.url}/api/sources`);
      const source = sources.find((item) => item.id === sourceId);
      return source?.response_count === 1 && source.last_response_seen ? source : null;
    });
    assert.equal(afterResponseSources.response_count, 1);

    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      stream: true,
      messages: [{ role: "user", content: "capture a stream response" }],
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      anthropic_stream: true,
      messages: [{ role: "user", content: "capture an anthropic stream response" }],
    });

    const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
    assert.equal(view.stats.request_count, 3);
    assert.equal(view.requests[0].summary.response.captured, true);
    assert.equal(view.requests[0].summary.response.preview, "json reply from upstream");
    assert.equal(view.requests[0].summary.response.finish_reason, "end_turn");
    assert.equal(view.requests[0].summary.response.usage.input_tokens, 11);
    assert.equal(view.requests[0].summary.response.stream, false);
    assert.equal(view.requests[0].summary.response.complete_response.stop_reason, "end_turn");
    assert.equal(view.requests[0].summary.response.complete_response.content[0].text, "json reply from upstream");
    assert.equal(view.requests[1].summary.response.captured, true);
    assert.equal(view.requests[1].summary.response.preview, "stream reply");
    assert.equal(view.requests[1].summary.response.thinking, "openai thought folded");
    assert.equal(view.requests[1].summary.response.thinking_preview, "openai thought folded");
    assert.equal(view.requests[1].summary.response.tool_calls[0].name, "Read");
    assert.equal(view.requests[1].summary.response.tool_calls[0].id, "call_openai");
    assert.equal(view.requests[1].summary.response.tool_calls[0].arguments.file_path, "README.md");
    assert.equal(view.requests[1].summary.response.finish_reason, "stop");
    assert.equal(view.requests[1].summary.response.usage.output_tokens, 2);
    assert.equal(view.requests[1].summary.response.stream, true);
    assert.ok(view.requests[1].summary.response.event_count >= 3);
    assert.equal(view.requests[1].summary.response.complete_response.stop_reason, "stop");
    assert.equal(view.requests[1].summary.response.complete_response.content.some((part) => part.type === "tool_use" && part.name === "Read"), true);
    assert.equal(view.requests[1].raw.response.body_text, undefined, "stream response body text is not sent to the viewer");
    assert.equal(view.requests[1].raw.response.body_text_omitted.reason, "stream");
    assert.equal(view.requests[1].raw.response.body_text_omitted.body_json_available, false);
    assert.equal(view.requests[2].summary.response.captured, true);
    assert.equal(view.requests[2].summary.response.preview, "anthropic stream reply");
    assert.equal(view.requests[2].summary.response.text.includes("anthropic anthropic"), false);
    assert.equal(view.requests[2].summary.response.text.includes("internal thought"), false);
    assert.equal(view.requests[2].summary.response.thinking, "internal thought should be folded");
    assert.equal(view.requests[2].summary.response.thinking_preview, "internal thought should be folded");
    assert.equal(view.requests[2].summary.response.complete_response.stop_reason, "end_turn");
    assert.equal(view.requests[2].summary.response.complete_response.content[0].type, "thinking");
    assert.equal(view.requests[2].summary.response.complete_response.content[1].text, "anthropic stream reply");
  } finally {
    await viewer.close();
  }

  const restarted = await startViewerServer({ cwd, storePath });
  try {
    const sources = await getJson(`${restarted.url}/api/sources`);
    const persisted = sources.find((source) => source.id === sourceId.replace(/^live-/, "stored-"));
    assert.ok(persisted, "persisted source should survive restart");
    const persistedView = await getJson(`${restarted.url}/api/view?source=${encodeURIComponent(persisted.id)}`);
    assert.equal(persistedView.requests[0].summary.response.preview, "json reply from upstream");
    assert.equal(persistedView.requests[1].summary.response.preview, "stream reply");
    assert.equal(persistedView.requests[2].summary.response.preview, "anthropic stream reply");
    assert.equal(persistedView.requests[2].summary.response.thinking, "internal thought should be folded");
    assert.equal(persistedView.requests[0].raw.response.body_ref.kind, "response_body");
    assert.equal(persistedView.requests[0].raw.response.body_text, undefined, "duplicated JSON response text is not sent to the viewer");
    assert.equal(persistedView.requests[0].raw.response.body_text_omitted.reason, "duplicated_body_json");
    assert.equal(persistedView.requests[0].raw.response.body_json.content[0].text, "json reply from upstream");
  } finally {
    await restarted.close();
  }

  console.log("response-capture smoke passed");
} finally {
  await closeServer(upstream);
  if (originalTarget == null) delete process.env.PEEK_CLAUDE_TARGET_BASE_URL;
  else process.env.PEEK_CLAUDE_TARGET_BASE_URL = originalTarget;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postModelRequest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeadersForUrl(url),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 40 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}
