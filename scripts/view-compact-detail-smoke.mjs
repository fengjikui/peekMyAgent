import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-view-compact-detail-"));
const storePath = path.join(tmpDir, "store.sqlite");
const hiddenTail = "UNIQUE_COMPACT_DETAIL_TAIL_0d6f5e9e";
const largeText = `${"large context ".repeat(800)}${hiddenTail}`;
const responseHiddenTail = "UNIQUE_RESPONSE_TOOL_ARGUMENT_TAIL_7b8e4d1c";
const responseToolArgument = `${"response tool argument ".repeat(800)}${responseHiddenTail}`;

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_compact_detail",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "toolu_compact_detail", name: "HugeTool", input: { query: responseToolArgument } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 1 },
    }),
  );
});

const upstreamUrl = await listen(upstream);

try {
  const viewer = await startViewerServer({ cwd: process.cwd(), storePath });
  try {
    const watch = await postJson(`${viewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: process.cwd(),
      conversation_id: "view-compact-detail-smoke",
      target_base_url: upstreamUrl,
    });

    await postJson(`${watch.base_url}/v1/messages`, {
      model: "mock-large-trace",
      system: [{ type: "text", text: `system ${largeText}` }],
      tools: [
        {
          name: "HugeTool",
          description: `tool ${largeText}`,
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: `parameter ${largeText}` },
            },
          },
        },
      ],
      messages: [
        { role: "user", content: `older user ${largeText}` },
        { role: "assistant", content: `older assistant ${largeText}` },
        { role: "user", content: `current user ${largeText}` },
      ],
    });

    const sourceId = watch.id;
    const fullResponse = await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
    const fullText = await fullResponse.text();
    assert.equal(fullResponse.ok, true, fullText);
    assert.equal(fullText.includes(hiddenTail), true, "full view remains backward compatible and includes complete raw data");

    const compactResponse = await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(sourceId)}&compact=1`);
    const compactText = await compactResponse.text();
    assert.equal(compactResponse.ok, true, compactText);
    assert.equal(compactText.includes(hiddenTail), false, "compact timeline payload should omit large raw fields");
    assert.equal(compactText.includes(responseHiddenTail), false, "compact timeline payload should omit large response tool arguments");
    assert.ok(compactText.length < fullText.length / 2, "compact timeline payload should be substantially smaller than full view");

    const compact = JSON.parse(compactText);
    const compactRequest = compact.requests[0];
    assert.equal(compactRequest.detail_omitted, true);
    assert.equal(compactRequest.raw.detail_omitted, true);
    assert.equal(compactRequest.raw.body.messages, undefined);
    assert.equal(compactRequest.raw.body_omitted.messages, 3);
    assert.equal(compactRequest.raw.body_omitted.tools, 1);
    assert.equal(compactRequest.summary.history_stack.length, 0);
    assert.ok(compactRequest.summary.history_stack_omitted.count > 0);
    assert.equal(compactRequest.summary.response.complete_response, undefined);
    assert.equal(compactRequest.summary.response.complete_response_omitted, true);
    assert.equal(compactRequest.summary.response.tool_calls[0].arguments.omitted.reason, "compact_view");

    const detail = await getJson(`${viewer.url}/api/request?source=${encodeURIComponent(sourceId)}&request=${encodeURIComponent(compactRequest.id)}`);
    assert.equal(JSON.stringify(detail.request).includes(hiddenTail), true, "detail endpoint restores complete raw request data");
    assert.equal(JSON.stringify(detail.request).includes(responseHiddenTail), true, "detail endpoint restores complete response tool arguments");
    assert.equal(detail.request.raw.body.messages.length, 3);
    assert.equal(detail.request.raw.body.tools.length, 1);
    assert.equal(detail.request.summary.history_stack.length, compactRequest.summary.history_stack_omitted.count);
    assert.equal(detail.request.summary.response.complete_response.content.some((part) => part.type === "tool_use"), true);
  } finally {
    await viewer.close();
  }

  console.log("view-compact-detail smoke passed");
} finally {
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text);
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
