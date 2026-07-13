import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-compact-view-performance-"));
const evidenceDir = path.join(tmpDir, "evidence");
const storePath = path.join(tmpDir, "store.sqlite");
const requestCount = 420;
const hiddenTail = "UNIQUE_COMPACT_VIEW_PERF_TAIL_f58c6cf4";
const longText = `${"large trace payload ".repeat(300)}${hiddenTail}`;
const maxCompactBytes = 5 * 1024 * 1024;
const maxElapsedMs = 5000;

try {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "proxy-captures.json"),
    `${JSON.stringify(Array.from({ length: requestCount }, (_, index) => makeCapture(index)), null, 2)}\n`,
  );

  const viewer = await startViewerServer({ cwd: process.cwd(), storePath, evidencePath: evidenceDir });
  try {
    const started = performance.now();
    const response = await fetch(`${viewer.url}/api/view?source=custom&compact=1`);
    const text = await response.text();
    const elapsedMs = performance.now() - started;
    const byteLength = Buffer.byteLength(text);
    console.log(`compact-view-performance metrics: ${requestCount} requests, ${byteLength} bytes, ${Math.round(elapsedMs)}ms`);
    assert.equal(response.ok, true, text);
    assert.equal(text.includes(hiddenTail), false, "compact view must not include long request/response tails");
    assert.ok(byteLength < maxCompactBytes, `compact view payload should stay below ${maxCompactBytes} bytes`);
    assert.ok(elapsedMs < maxElapsedMs, `compact view should return within ${maxElapsedMs}ms; got ${Math.round(elapsedMs)}ms`);

    const view = JSON.parse(text);
    assert.equal(view.requests.length, requestCount);
    assert.equal(view.requests[0].detail_omitted, true);
    assert.equal(view.requests[0].raw.detail_omitted, true);
    assert.equal(view.requests[0].raw.headers, undefined);
    assert.equal(view.requests[0].raw.response.headers, undefined);
    assert.equal(view.requests[0].summary.response.preview, undefined);
    assert.equal(view.requests[0].summary.response.complete_response, undefined);
    assert.equal(view.requests[0].summary.response.complete_response_omitted, true);
    assert.equal(view.requests[0].summary.history_stack.length, 0);
    assert.ok(view.requests[0].summary.history_stack_omitted.count > 0);
    assert.ok(
      JSON.stringify(view.requests[0].context_delta.previews || []).length < 1200,
      "compact context delta previews should stay small",
    );

    const initialStarted = performance.now();
    const initialResponse = await fetch(`${viewer.url}/api/view?source=custom&compact=1&initial=1&limit=24`);
    const initialText = await initialResponse.text();
    const initialElapsedMs = performance.now() - initialStarted;
    const initialByteLength = Buffer.byteLength(initialText);
    const initialView = JSON.parse(initialText);
    assert.equal(initialResponse.ok, true, initialText);
    assert.equal(initialView.requests.length, 24, "initial view only returns the first requested window");
    assert.equal(initialView.partial.has_more, true);
    assert.equal(initialView.partial.loaded_request_count, 24);
    assert.equal(initialView.partial.total_request_count, requestCount);
    assert.equal(initialView.stats.request_count, requestCount, "initial view keeps total request count for the topbar");
    assert.ok(initialByteLength < byteLength / 4, "initial view payload should be materially smaller than full compact view");
    assert.ok(initialElapsedMs < maxElapsedMs, `initial view should return within ${maxElapsedMs}ms; got ${Math.round(initialElapsedMs)}ms`);

    let cursor = initialView.partial.next_cursor;
    let loadedRequests = initialView.requests.length;
    let pagedBytes = initialByteLength;
    let pageCount = 1;
    let largestTailPage = 0;
    while (cursor) {
      const pageResponse = await fetch(
        `${viewer.url}/api/view?source=custom&compact=1&cursor=${encodeURIComponent(cursor)}&limit=100`,
      );
      const pageText = await pageResponse.text();
      assert.equal(pageResponse.ok, true, pageText);
      const page = JSON.parse(pageText);
      const pageBytes = Buffer.byteLength(pageText);
      assert.equal("turns" in page, false, "tail pages must not repeat the complete loaded Turn prefix");
      assert.equal("agent_trace" in page, false, "tail pages must not repeat the complete Agent graph");
      loadedRequests += page.requests.length;
      pagedBytes += pageBytes;
      largestTailPage = Math.max(largestTailPage, pageBytes);
      pageCount += 1;
      cursor = page.partial.has_more ? page.partial.next_cursor : null;
    }
    assert.equal(loadedRequests, requestCount, "cursor pages cover every request exactly once");
    assert.ok(pagedBytes < byteLength * 1.8, "cursor transfer should remain linear rather than repeat the loaded prefix");
    assert.ok(largestTailPage < byteLength / 2, "a tail page should remain bounded independently of total Trace size");

    console.log(
      `compact-view-performance smoke passed (${requestCount} requests, full ${byteLength} bytes/${Math.round(elapsedMs)}ms, cursor ${pagedBytes} bytes/${pageCount} pages, initial ${initialByteLength} bytes/${Math.round(initialElapsedMs)}ms)`,
    );
  } finally {
    await viewer.close();
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function makeCapture(index) {
  const requestIndex = index + 1;
  const toolResultId = `toolu_perf_${requestIndex}`;
  return {
    capture_id: `compact-view-perf-${requestIndex}`,
    request_index: requestIndex,
    watch_id: "compact-view-performance",
    received_at: new Date(Date.UTC(2026, 6, 4, 0, 0, index)).toISOString(),
    method: "POST",
    path: "/v1/messages",
    headers: {},
    raw_body_length: Buffer.byteLength(longText) * 4,
    body: {
      model: "mock-large-trace",
      system: [
        { type: "text", text: `system ${requestIndex} ${longText}` },
        { type: "text", text: `policy ${requestIndex} ${longText}` },
      ],
      tools: [
        {
          name: "LargeTool",
          description: `tool description ${requestIndex} ${longText}`,
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: `query parameter ${requestIndex} ${longText}` },
            },
          },
        },
      ],
      messages: [
        { role: "user", content: `older user ${requestIndex} ${longText}` },
        { role: "assistant", content: `older assistant ${requestIndex} ${longText}` },
        { role: "user", content: `current user ${requestIndex}` },
      ],
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body_json: {
        id: `msg_perf_${requestIndex}`,
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: `assistant response ${requestIndex} ${longText}` },
          { type: "tool_use", id: toolResultId, name: "LargeTool", input: { query: longText } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100 + requestIndex, output_tokens: 20 },
      },
      body_text: JSON.stringify({
        id: `msg_perf_${requestIndex}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `assistant response ${requestIndex} ${longText}` }],
        stop_reason: "tool_use",
      }),
      raw_body_length: Buffer.byteLength(longText) * 2,
      captured_body_length: Buffer.byteLength(longText) * 2,
      received_at: new Date(Date.UTC(2026, 6, 4, 0, 0, index, 500)).toISOString(),
    },
  };
}
