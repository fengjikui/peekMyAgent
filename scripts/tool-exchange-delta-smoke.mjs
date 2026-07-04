import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-tool-delta-"));
const storePath = path.join(tmpDir, "store.sqlite");
const originalTarget = process.env.PEEK_CLAUDE_TARGET_BASE_URL;

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_mock", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

const upstreamUrl = await listen(upstream);
process.env.PEEK_CLAUDE_TARGET_BASE_URL = upstreamUrl;

try {
  const viewer = await startViewerServer({ cwd, storePath });
  try {
    const watch = await postJson(`${viewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: cwd,
      conversation_id: "tool-delta-smoke-session",
      target_base_url: upstreamUrl,
    });

    const oldUserMessage = { role: "user", content: "old turn from before the watcher was opened" };
    const oldToolUse = {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_old", name: "Bash", input: { command: "ls" } }],
    };
    const oldToolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "dist\nsrc" }],
    };
    const oldFinal = { role: "assistant", content: "I listed the old directory." };
    const userMessageText = "please inspect the current directory";
    const userMessage = { role: "user", content: [{ type: "text", text: userMessageText, cache_control: { type: "ephemeral" } }] };
    const replayedUserMessage = { role: "user", content: userMessageText };
    const toolUse = {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }],
    };
    const toolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "/tmp/peekmyagent", cache_control: { type: "ephemeral" } }],
    };
    const replayedToolResult = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "/tmp/peekmyagent" }],
    };

    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [oldUserMessage, oldToolUse, oldToolResult, oldFinal, userMessage],
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [oldUserMessage, oldToolUse, oldToolResult, oldFinal, replayedUserMessage, toolUse, toolResult],
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [
        oldUserMessage,
        oldToolUse,
        oldToolResult,
        oldFinal,
        replayedUserMessage,
        toolUse,
        replayedToolResult,
        { role: "assistant", content: "The cwd is /tmp/peekmyagent." },
        { role: "user", content: "thanks" },
      ],
    });

    const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}`);
    assert.equal(view.stats.request_count, 3);
    assert.equal(view.turns.length, 2);
    assert.deepEqual(view.turns[0].request_indexes, [1, 2]);
    assert.equal(view.turns[0].request_count, 2);
    assert.equal(view.turns[0].main_request_count, 2);
    assert.equal(view.turns[0].internal_request_count, 0);
    assert.equal(view.turns[0].tool_call_count, 1);
    assert.equal(view.turns[0].tool_result_count, 1);
    assert.deepEqual(view.turns[1].request_indexes, [3]);
    assert.equal(view.turns[1].tool_call_count, 0);
    assert.equal(view.turns[1].tool_result_count, 0);
    assert.equal(view.requests[0].context_delta.baseline, true);
    assert.equal(view.requests[0].context_delta.reused_messages, 0);
    assert.equal(view.requests[0].context_delta.new_messages, 5);
    assert.equal(view.requests[0].context_delta.fixed_context.system, "baseline");
    assert.equal(view.requests[0].summary.tool_calls.length, 1);
    assert.equal(view.requests[0].summary.current_tool_calls.length, 0);
    assert.equal(view.requests[1].context_delta.baseline, false);
    assert.equal(view.requests[1].context_delta.reused_messages, 5);
    assert.equal(view.requests[1].context_delta.new_messages, 2);
    assert.equal(view.requests[1].context_delta.new_roles.tool_use, 1);
    assert.equal(view.requests[1].context_delta.new_roles.tool_result, 1);
    assert.equal(view.requests[1].context_delta.new_tool_calls, 1);
    assert.equal(view.requests[1].context_delta.new_tool_results, 1);
    assert.equal(view.requests[1].context_delta.fixed_context.system, "reused");
    assert.equal(view.requests[1].summary.tool_calls.length, 2);
    assert.equal(view.requests[1].summary.current_tool_calls.length, 1);
    assert.equal(view.requests[1].summary.current_tool_calls[0].name, "Bash");
    assert.equal(view.requests[1].summary.current_tool_calls[0].id, "toolu_1");
    assert.equal(view.requests[1].summary.tool_results.length, 2);
    assert.equal(view.requests[1].summary.current_tool_results.length, 1);
    assert.equal(view.requests[1].summary.current_tool_results[0].id, "toolu_1");
    assert.equal(view.requests[1].summary.history_stack.length, 7);
    assert.equal(view.requests[1].summary.history_stack[2].role, "user");
    assert.equal(view.requests[1].summary.history_stack[2].kind, "tool_result");
    assert.equal(view.requests[1].summary.history_stack[2].label, "Tool result");
    assert.equal(view.requests[1].summary.history_stack[2].context_status, "reused");
    assert.equal(view.requests[1].summary.history_stack[5].kind, "tool_use");
    assert.equal(view.requests[1].summary.history_stack[5].context_status, "new");
    assert.equal(view.requests[1].summary.history_stack[5].tool_calls[0].name, "Bash");
    assert.equal(view.requests[1].summary.history_stack[6].kind, "tool_result");
    assert.equal(view.requests[1].summary.history_stack[6].context_status, "new");
    assert.equal(view.requests[1].summary.history_stack[6].tool_results[0].id, "toolu_1");
    assert.ok(view.requests[1].summary.composition.total_payload_chars > 0);
    assert.ok(view.requests[1].summary.composition.current_user_chars > 0);
    assert.ok(view.requests[1].summary.composition.tool_result_chars > 0);
    assert.ok(view.requests[1].summary.composition.tool_use_chars > 0);
    assert.ok(view.requests[1].summary.composition.response_text_chars > 0);
    assert.ok(view.requests[1].summary.composition.ratios.current_user_to_input > 0);
    assert.ok(view.requests[1].summary.composition.ratios.output_to_input > 0);
    assert.equal(view.requests[2].context_delta.reused_messages, 7);
    assert.equal(view.requests[2].context_delta.new_messages, 2);
    assert.equal(view.requests[2].context_delta.new_roles.assistant, 1);
    assert.equal(view.requests[2].context_delta.new_roles.user, 1);
    assert.equal(view.requests[2].summary.tool_calls.length, 2);
    assert.equal(view.requests[2].summary.current_tool_calls.length, 0);
    assert.equal(view.requests[2].summary.tool_results.length, 2);
    assert.equal(view.requests[2].summary.current_tool_results.length, 0);
  } finally {
    await viewer.close();
  }

  console.log("tool-exchange-delta smoke passed");
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
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
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
