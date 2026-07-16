#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const CHILD_PROMPT = "Inspect the cursor pagination contract and return the invariant.";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-timeline-cursor-http-"));
const storePath = path.join(tempDir, "store.sqlite");
const upstream = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  const index = Number(body.metadata?.request_index) || 0;
  const content =
    index === 1
      ? [
          { type: "text", text: "launching child" },
          {
            type: "tool_use",
            id: "spawn-cursor-child",
            name: "Agent",
            input: { description: "Inspect cursor", prompt: CHILD_PROMPT, subagent_type: "Explore" },
          },
        ]
      : [{ type: "text", text: `response ${index}` }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `message-${index}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: index === 1 ? "tool_use" : "end_turn",
      usage: { input_tokens: 10 + index, output_tokens: 2 },
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
      conversation_id: "timeline-cursor-http-smoke",
      target_base_url: upstreamUrl,
    });

    for (let index = 1; index <= 3; index += 1) await captureRequest(watch.base_url, index);

    const first = await getJson(
      `${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}&compact=1&initial=1&limit=1`,
    );
    assert.equal(first.requests.length, 1);
    assert.equal(first.partial.loaded_request_count, 1);
    assert.equal(first.partial.total_request_count, 3);
    assert.equal(first.partial.has_more, true);
    assert.match(first.partial.next_cursor, /^[0-9a-f-]{20,}$/i, "HTTP cursor is opaque rather than a reader offset");
    assert.equal(first.partial.refresh_cursor, first.partial.next_cursor);
    assert.equal(first.turns.length, 1);
    assert.equal(first.agent_trace.spawn_count, 1);
    assert.equal(first.agent_trace.branch_count, 0);

    const second = await cursorPage(viewer.url, watch.id, first.partial.next_cursor, 1);
    assert.deepEqual(second.requests.map((item) => item.request_index), [2]);
    assert.equal(second.partial.loaded_request_count, 2);
    assert.equal(second.partial.has_more, true);
    assert.equal("turns" in second, false, "later pages carry turn entity deltas rather than the full loaded prefix");
    assert.ok(second.turn_updates.length >= 1);
    assert.equal("agent_trace" in second, false, "later pages carry Agent graph deltas rather than the full graph");
    assert.equal(second.agent_trace_delta.branch_count, 1, "a child request can match a parent spawn from an earlier page");
    assert.equal(second.agent_trace_delta.branch_updates.length, 1);

    const third = await cursorPage(viewer.url, watch.id, second.partial.next_cursor, 100);
    assert.deepEqual(third.requests.map((item) => item.request_index), [3]);
    assert.equal(third.partial.loaded_request_count, 3);
    assert.equal(third.partial.has_more, false);
    assert.equal(third.partial.next_cursor, null);
    assert.ok(third.partial.refresh_cursor, "live source keeps a resumable cursor after reaching its tail");
    assert.equal(third.agent_trace_delta.return_count, 1);
    assert.equal(third.agent_trace_delta.branch_updates[0].status, "returned");

    const noop = await cursorPage(viewer.url, watch.id, third.partial.refresh_cursor, 100);
    assert.deepEqual(noop.requests, []);
    assert.equal(noop.partial.loaded_request_count, 3);
    assert.equal(noop.partial.refresh_cursor, third.partial.refresh_cursor);

    await captureRequest(watch.base_url, 4);
    const refresh = await cursorPage(viewer.url, watch.id, noop.partial.refresh_cursor, 100);
    assert.deepEqual(refresh.requests.map((item) => item.request_index), [4]);
    assert.equal(refresh.partial.loaded_request_count, 4);
    assert.equal(refresh.partial.has_more, false);

    const mismatchResponse = await fetch(
      `${viewer.url}/api/view?source=other-source&compact=1&cursor=${encodeURIComponent(refresh.partial.refresh_cursor)}`,
    );
    assert.equal(mismatchResponse.status, 409);

    const full = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}&compact=1`);
    assert.equal(full.requests.length, 4, "the legacy complete compact endpoint remains compatible");
  } finally {
    await viewer.close();
  }
  console.log("timeline cursor HTTP smoke passed");
} finally {
  await closeServer(upstream);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function captureRequest(baseUrl, index) {
  const messages =
    index === 2
      ? [{ role: "user", content: CHILD_PROMPT }]
      : index === 3
        ? [
            { role: "user", content: "launch a child" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "spawn-cursor-child",
                  name: "Agent",
                  input: { description: "Inspect cursor", prompt: CHILD_PROMPT, subagent_type: "Explore" },
                },
              ],
            },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "spawn-cursor-child", content: "cursor checked" }] },
          ]
        : [{ role: "user", content: `user request ${index}` }];
  return postJson(`${baseUrl}/v1/messages`, {
    model: "mock-cursor-model",
    metadata: { request_index: index },
    system: [{ type: "text", text: "stable system" }],
    tools: [{ name: "Echo", description: "echo text", input_schema: { type: "object" } }],
    messages,
  });
}

function cursorPage(viewerUrl, sourceId, cursor, limit) {
  return getJson(
    `${viewerUrl}/api/view?source=${encodeURIComponent(sourceId)}&compact=1&cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
  );
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
    headers: jsonHeadersForUrl(url),
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
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
