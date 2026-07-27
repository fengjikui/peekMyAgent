import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { startViewerServer } from "../src/viewer/server.mjs";
import { rawResponseSectionValue } from "../src/viewer/raw-view-model.js";
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
  if (body.response_encoding === "gzip-corrupt") {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end("not a gzip stream");
    return;
  }
  const requestedEncoding = body.response_encoding || "identity";
  const responseEncoding = requestedEncoding === "gzip-large" ? "gzip" : requestedEncoding;
  const responseText =
    requestedEncoding === "gzip-large"
      ? "x".repeat(4 * 1024 * 1024 + 1)
      : responseEncoding === "identity"
        ? "json reply from upstream"
        : `${responseEncoding} reply from upstream`;
  const responseJson = {
    id: `msg_response_smoke_${requestedEncoding}`,
    type: "message",
    role: "assistant",
    model: "mock-claude",
    content: [{ type: "text", text: responseText }],
    stop_reason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 4 },
  };
  const responseBuffer = Buffer.from(JSON.stringify(responseJson));
  const encoded = encodeResponseBody(responseBuffer, responseEncoding);
  const headers = { "content-type": "application/json", "content-length": String(encoded.length) };
  if (responseEncoding !== "identity") headers["content-encoding"] = responseEncoding;
  res.writeHead(200, headers);
  res.end(encoded);
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
    const encodedResponses = [];
    for (const encoding of ["gzip", "deflate", "br", "zstd", "pma-unknown", "gzip-corrupt", "gzip-large"]) {
      encodedResponses.push([
        encoding,
        await postRawModelRequest(watch.base_url, {
          model: "mock-claude",
          response_encoding: encoding,
          messages: [{ role: "user", content: `capture a ${encoding} response` }],
        }),
      ]);
    }
    for (const [encoding, response] of encodedResponses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-encoding"], ["gzip-corrupt", "gzip-large"].includes(encoding) ? "gzip" : encoding);
    }
    const gzipDownstream = encodedResponses[0][1].body;
    assert.equal(gzipDownstream[0], 0x1f, "downstream keeps the upstream gzip bytes");
    assert.equal(gzipDownstream[1], 0x8b, "downstream keeps the upstream gzip bytes");
    assert.equal(JSON.parse(zlib.gunzipSync(gzipDownstream)).content[0].text, "gzip reply from upstream");
    assert.equal(JSON.parse(zlib.inflateSync(encodedResponses[1][1].body)).content[0].text, "deflate reply from upstream");
    assert.equal(JSON.parse(zlib.brotliDecompressSync(encodedResponses[2][1].body)).content[0].text, "br reply from upstream");
    assert.equal(JSON.parse(zlib.zstdDecompressSync(encodedResponses[3][1].body)).content[0].text, "zstd reply from upstream");
    assert.equal(JSON.parse(encodedResponses[4][1].body).content[0].text, "pma-unknown reply from upstream");
    assert.equal(encodedResponses[5][1].body.toString("utf8"), "not a gzip stream");
    assert.ok(zlib.gunzipSync(encodedResponses[6][1].body).length > 4 * 1024 * 1024);

    const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
    assert.equal(view.stats.request_count, 10);
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
    assert.equal(view.requests[1].summary.response.response_protocol, "openai_chat_completions");
    assert.equal(view.requests[1].summary.response.complete_response_source, "stream_reconstruction");
    assert.equal(view.requests[1].summary.response.complete_response.choices[0].finish_reason, "stop");
    assert.equal(
      view.requests[1].summary.response.complete_response.choices[0].message.tool_calls[0].function.name,
      "Read",
    );
    assert.equal(
      view.requests[1].summary.response.complete_response.choices[0].message.tool_calls[0].function.arguments,
      '{"file_path":"README.md"}',
    );
    assert.equal("content" in view.requests[1].summary.response.complete_response, false);
    assert.equal(view.requests[1].raw.response.body_text, undefined, "stream response body text is not sent to the viewer");
    assert.equal(view.requests[1].raw.response.body_text_omitted.reason, "stream");
    assert.equal(view.requests[1].raw.response.body_text_omitted.body_json_available, false);
    assert.equal(view.requests[2].summary.response.captured, true);
    assert.equal(view.requests[2].summary.response.preview, "anthropic stream reply");
    assert.equal(view.requests[2].summary.response.text.includes("anthropic anthropic"), false);
    assert.equal(view.requests[2].summary.response.text.includes("internal thought"), false);
    assert.equal(view.requests[2].summary.response.thinking, "internal thought should be folded");
    assert.equal(view.requests[2].summary.response.thinking_preview, "internal thought should be folded");
    assert.equal(view.requests[2].summary.response.response_protocol, "anthropic_messages");
    assert.equal(view.requests[2].summary.response.complete_response_source, "stream_reconstruction");
    assert.equal(view.requests[2].summary.response.complete_response.stop_reason, "end_turn");
    assert.equal(view.requests[2].summary.response.complete_response.content[0].type, "thinking");
    assert.equal(view.requests[2].summary.response.complete_response.content[1].text, "anthropic stream reply");
    const gzipRequest = view.requests[3];
    assert.equal(gzipRequest.summary.response.preview, "gzip reply from upstream");
    assert.equal(gzipRequest.summary.response.complete_response.content[0].text, "gzip reply from upstream");
    assert.equal(gzipRequest.summary.protocol_exchange.request.counts.input_items, 1, "gzip capture keeps the upstream request");
    assert.equal(gzipRequest.summary.protocol_exchange.response.counts.output_items, 1, "gzip capture restores the downstream protocol item");
    assert.equal(gzipRequest.summary.protocol_exchange.response.output_items[0].semantic, "assistant_message");
    assert.equal(gzipRequest.raw.response.response_content_encoding, "gzip");
    assert.equal(gzipRequest.raw.response.content_decoding.status, "decoded");
    assert.deepEqual(gzipRequest.raw.response.content_decoding.encodings, ["gzip"]);
    assert.equal(gzipRequest.raw.response.raw_body_length, encodedResponses[0][1].body.length);
    assert.equal(gzipRequest.raw.response.captured_body_length, encodedResponses[0][1].body.length);
    assert.equal(gzipRequest.raw.response.decoded_body_length, Buffer.byteLength(JSON.stringify(gzipRequest.summary.response.complete_response)));
    assert.equal(gzipRequest.raw.response.body_text_source, "utf8_from_content_decoded_bytes");
    assert.equal(gzipRequest.raw.provenance.response.fidelity, "exact");
    assert.equal(gzipRequest.raw.provenance.response.artifact, "http_response_decoded_body");
    assert.equal(rawResponseSectionValue(gzipRequest).response.content[0].text, "gzip reply from upstream", "Raw Inspector receives the decoded provider JSON");
    for (const [index, encoding] of ["deflate", "br", "zstd"].entries()) {
      const request = view.requests[index + 4];
      assert.equal(request.summary.response.preview, `${encoding} reply from upstream`);
      assert.equal(request.raw.response.response_content_encoding, encoding);
      assert.equal(request.raw.response.content_decoding.status, "decoded");
      assert.equal(request.raw.response.body_text_source, "utf8_from_content_decoded_bytes");
    }
    const unknownRequest = view.requests[7];
    assert.equal(unknownRequest.summary.response.preview, "");
    assert.equal(unknownRequest.summary.response.complete_response, null);
    assert.equal(unknownRequest.summary.protocol_exchange.response.counts.output_items, 0);
    assert.equal(unknownRequest.raw.response.body_json, null);
    assert.equal(unknownRequest.raw.response.body_text, null);
    assert.equal(unknownRequest.raw.response.content_decoding.status, "unsupported");
    assert.equal(unknownRequest.raw.response.content_decoding.failed_encoding, "pma-unknown");
    assert.equal(unknownRequest.raw.response.body_text_omitted.reason, "unsupported_content_encoding");
    assert.equal(unknownRequest.raw.provenance.response.fidelity, "partial");
    assert.equal(unknownRequest.raw.provenance.response.artifact, "http_response_metadata");
    const corruptRequest = view.requests[8];
    assert.equal(corruptRequest.raw.response.body_json, null);
    assert.equal(corruptRequest.raw.response.body_text, null);
    assert.equal(corruptRequest.raw.response.content_decoding.status, "failed");
    assert.equal(corruptRequest.raw.response.body_text_omitted.reason, "content_decoding_failed");
    const oversizedDecodedRequest = view.requests[9];
    assert.equal(oversizedDecodedRequest.raw.response.body_json, null);
    assert.equal(oversizedDecodedRequest.raw.response.body_text, null);
    assert.equal(oversizedDecodedRequest.raw.response.content_decoding.status, "decoded_too_large");
    assert.equal(oversizedDecodedRequest.raw.response.content_decoding.error_code, "ERR_BUFFER_TOO_LARGE");
    assert.equal(oversizedDecodedRequest.raw.response.body_text_omitted.reason, "decoded_body_too_large");
    assert.equal(oversizedDecodedRequest.raw.provenance.response.fidelity, "partial");
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
    assert.equal(persistedView.requests[3].summary.response.preview, "gzip reply from upstream");
    assert.equal(persistedView.requests[3].raw.response.body_ref.kind, "response_body");
    assert.equal(persistedView.requests[3].raw.response.response_content_encoding, "gzip");
    assert.equal(persistedView.requests[3].raw.response.content_decoding.status, "decoded");
    assert.equal(persistedView.requests[3].summary.protocol_exchange.response.counts.output_items, 1);
    assert.equal(rawResponseSectionValue(persistedView.requests[3]).response.content[0].text, "gzip reply from upstream");
    assert.equal(persistedView.requests[7].raw.response.body_ref, undefined, "unsupported encodings do not persist fake response text");
    assert.equal(persistedView.requests[7].raw.response.body_text_omitted.reason, "unsupported_content_encoding");
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

function postRawModelRequest(baseUrl, body) {
  const url = new URL("/v1/messages", baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          authorization: "Bearer smoke",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function encodeResponseBody(buffer, encoding) {
  if (encoding === "identity" || encoding === "pma-unknown") return buffer;
  if (encoding === "gzip") return zlib.gzipSync(buffer);
  if (encoding === "deflate") return zlib.deflateSync(buffer);
  if (encoding === "br") return zlib.brotliCompressSync(buffer);
  if (encoding === "zstd" && typeof zlib.zstdCompressSync === "function") return zlib.zstdCompressSync(buffer);
  throw new Error(`Unsupported response smoke encoding: ${encoding}`);
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
