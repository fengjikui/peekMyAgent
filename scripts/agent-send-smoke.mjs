import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-agent-send-"));
const workspace = path.join(tmpDir, "workspace");
const fakeBin = path.join(tmpDir, "bin");
const storePath = path.join(tmpDir, "store.sqlite");
const fakeClaudeLog = path.join(tmpDir, "fake-claude.json");
let previousPath = process.env.PATH || "";
let previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
let viewer = null;

try {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  writeFakeNodeCommand(
    fakeBin,
    "claude",
    `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(fakeClaudeLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null
}, null, 2));
console.log("fake claude response");
	`,
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";

  viewer = await startViewerServer({ cwd: workspace, port: 0, capturePort: 0, storePath });
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace,
    conversation_id: "11111111-1111-4111-8111-111111111111",
    target_base_url: "http://127.0.0.1:9",
    reuse: false,
  });

  const send = await postJson(`${viewer.url}/api/agent/send`, {
    source_id: watch.id,
    message: "hello from dashboard",
  });

  assert.equal(send.ok, true);
  assert.equal(send.exit_code, 0);
  assert.equal(send.stdout.trim(), "fake claude response");
  assertDetachedResumeDelivery(send);
  const call = JSON.parse(fs.readFileSync(fakeClaudeLog, "utf8"));
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(workspace));
  assert.equal(call.anthropicBaseUrl, watch.base_url);
  assertClaudeSendArgs(call.argv, "11111111-1111-4111-8111-111111111111", "hello from dashboard");

  fs.rmSync(workspace, { recursive: true, force: true });
  const missingWorkspaceWatch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace,
    conversation_id: "22222222-2222-4222-8222-222222222222",
    target_base_url: "http://127.0.0.1:9",
    reuse: false,
  });
  const fallbackSend = await postJson(`${viewer.url}/api/agent/send`, {
    source_id: missingWorkspaceWatch.id,
    message: "after workspace was removed",
  });
  assert.equal(fallbackSend.ok, true);
  assert.equal(fallbackSend.exit_code, 0);
  assertDetachedResumeDelivery(fallbackSend);
  const fallbackCall = JSON.parse(fs.readFileSync(fakeClaudeLog, "utf8"));
  assert.equal(fs.existsSync(fallbackCall.cwd), true);
  assert.notEqual(fallbackCall.cwd, workspace);
  assert.equal(fs.realpathSync(fallbackSend.command.cwd), fs.realpathSync(fallbackCall.cwd));
  assertClaudeSendArgs(fallbackCall.argv, "22222222-2222-4222-8222-222222222222", "after workspace was removed");

  fs.mkdirSync(workspace, { recursive: true });
  const persistedWatch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace,
    conversation_id: "33333333-3333-4333-8333-333333333333",
    target_base_url: "http://127.0.0.1:9",
    reuse: false,
  });
  await fetch(`${persistedWatch.base_url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-test",
      messages: [{ role: "user", content: "persist me" }],
    }),
  }).catch(() => null);
  await viewer.close();
  viewer = await startViewerServer({ cwd: workspace, port: 0, capturePort: 0, storePath });

  const restoredSend = await postJson(`${viewer.url}/api/agent/send`, {
    source_id: `stored-${persistedWatch.watch_id}`,
    message: "after dashboard restart",
  });
  assert.equal(restoredSend.ok, true);
  assert.equal(restoredSend.source_id, `live-${persistedWatch.watch_id}`);
  assertDetachedResumeDelivery(restoredSend);
  const restoredCall = JSON.parse(fs.readFileSync(fakeClaudeLog, "utf8"));
  assert.equal(fs.realpathSync(restoredCall.cwd), fs.realpathSync(workspace));
  assert.ok(restoredCall.anthropicBaseUrl?.startsWith(`${viewer.captureUrl}/watch/`));
  assert.ok(restoredCall.anthropicBaseUrl?.includes(encodeURIComponent(persistedWatch.watch_id)));
  assertClaudeSendArgs(restoredCall.argv, "33333333-3333-4333-8333-333333333333", "after dashboard restart");

  console.log("agent send smoke passed");
} finally {
  process.env.PATH = previousPath;
  if (previousAnthropicBaseUrl == null) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
  if (viewer) await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function assertClaudeSendArgs(argv, sessionId, message) {
  assert.deepEqual(argv.slice(0, 5), ["-p", "--output-format", "text", "--resume", sessionId]);
  assert.equal(argv[5], "--settings");
  assert.match(argv[6], /peekmyagent-claude-settings-.+[\\/]settings\.json$/);
  assert.equal(argv[7], message);
  assert.equal(argv.length, 8);
}

function assertDetachedResumeDelivery(result) {
  assert.equal(result.delivery?.mode, "detached_resume");
  assert.equal(result.delivery?.terminal_echo, false);
  assert.equal(result.delivery?.inherits_active_terminal_context, false);
}
