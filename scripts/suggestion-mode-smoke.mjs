import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-suggestion-"));
const storePath = path.join(tmpDir, "store.sqlite");

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_mock", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

try {
  const upstreamUrl = await listen(upstream);
  const viewer = await startViewerServer({ cwd, storePath });
  try {
    const watch = await postJson(`${viewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: cwd,
      conversation_id: "suggestion-mode-smoke-session",
      target_base_url: upstreamUrl,
    });

    const realUser = { role: "user", content: "请帮我分析一下目标公司列表。" };
    const assistant = { role: "assistant", content: "我先帮你分层。" };
    const suggestionUser = {
      role: "user",
      content:
        "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\nFIRST: Look at the user's recent messages and original request.\nYour job is to predict what THEY would type - not what you think they should do.",
    };

    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [realUser],
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [realUser, assistant, suggestionUser],
    });
    const frameworkReminder = {
      role: "user",
      content:
        "<system-reminder>\nThe user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown.\n</system-reminder>",
    };
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [realUser, assistant, frameworkReminder],
    });

    const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}`);
    assert.equal(view.stats.request_count, 3);
    assert.equal(view.turns.length, 1);
    assert.deepEqual(view.turns[0].request_indexes, [1, 2, 3]);
    assert.equal(view.turns[0].request_count, 3);
    assert.equal(view.turns[0].main_request_count, 1);
    assert.equal(view.turns[0].internal_request_count, 2);
    assert.equal(view.turns[0].title, realUser.content);
    assert.equal(view.requests[0].source_hint.type, "main");
    assert.equal(view.requests[0].summary.current_user, realUser.content);
    assert.equal(view.requests[1].source_hint.type, "metadata");
    assert.equal(view.requests[1].source_hint.label, "Agent 输入建议请求");
    assert.equal(view.requests[1].summary.current_user, realUser.content);
    assert.ok(view.requests[1].summary.internal_request_preview.includes("SUGGESTION MODE"));
    assert.ok(!view.requests[1].summary.current_user.includes("SUGGESTION MODE"));
    assert.equal(view.requests[1].summary.history_stack[2].role, "user");
    assert.equal(view.requests[1].summary.history_stack[2].kind, "agent_internal");
    assert.equal(view.requests[1].summary.history_stack[2].label, "Agent 内部请求");
    assert.equal(view.requests[1].context_delta.baseline, true);
    assert.equal(view.requests[1].context_delta.comparison_key, "side:suggestion-mode-smoke-session:metadata");
    assert.equal(view.requests[1].context_delta.reused_messages, 0);
    assert.equal(view.requests[1].context_delta.new_messages, 3);
    assert.equal(view.requests[1].context_delta.new_roles.user, 1);
    assert.equal(view.requests[1].context_delta.new_roles.assistant, 1);
    assert.equal(view.requests[1].context_delta.new_roles.agent_internal, 1);
    assert.ok(view.requests[1].summary.composition.current_user_chars > 0);
    assert.ok(view.requests[1].summary.composition.agent_internal_chars > 0);
    assert.ok(view.requests[1].summary.composition.ratios.current_user_to_input > 0);
    assert.ok(view.requests[1].summary.composition.sections.agent_internal.ratio > 0);
    assert.equal(view.requests[2].source_hint.type, "metadata");
    assert.equal(view.requests[2].source_hint.label, "Claude Code 框架提醒");
    assert.equal(view.requests[2].summary.current_user, realUser.content);
    assert.equal(view.requests[2].summary.history_stack[2].role, "user");
    assert.equal(view.requests[2].summary.history_stack[2].kind, "framework_reminder");
    assert.equal(view.requests[2].summary.history_stack[2].label, "框架提醒");
    assert.ok(view.requests[2].summary.history_stack[2].full_text.includes("<system-reminder>"));
    assert.ok(!view.requests[2].summary.current_user.includes("system-reminder"));
    assert.equal(view.requests[2].context_delta.new_roles.framework_reminder, 1);
  } finally {
    await viewer.close();
  }

  console.log("suggestion-mode smoke passed");
} finally {
  await closeServer(upstream).catch(() => {});
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
