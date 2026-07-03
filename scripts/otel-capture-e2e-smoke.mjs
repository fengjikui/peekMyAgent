import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

// End-to-end smoke for the subscription/OTel capture path:
//   peekmyagent claude ... without an upstream base URL  ->  auto OTel fallback
//   fake claude dumps raw bodies via
//   OTEL_LOG_RAW_API_BODIES  ->  wrapper ingests into the daemon  ->
//   /api/view surfaces the captures with real token usage.
// No proxy, no network: this is exactly how an OAuth subscription would capture.

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-otel-e2e-"));
const binDir = path.join(tmpDir, "bin");
const fakeHome = path.join(tmpDir, "home");
fs.mkdirSync(binDir);
fs.mkdirSync(fakeHome, { recursive: true });
const storePath = path.join(tmpDir, "store.sqlite");
const sessionId = `otel-e2e-${Date.now()}-${process.pid}`;

process.env.PEEKMYAGENT_STATE_DIR = tmpDir;
const viewer = await startViewerServer({ cwd, storePath });

try {
  // Fake `claude`: must see the telemetry env the wrapper injected, then dump
  // request/response bodies shaped like OTEL_LOG_RAW_API_BODIES output.
  writeFakeNodeCommand(
    binDir,
    "claude",
    `
import fs from 'node:fs';
import path from 'node:path';
const spec = process.env.OTEL_LOG_RAW_API_BODIES || '';
if (process.env.CLAUDE_CODE_ENABLE_TELEMETRY !== '1' || !spec.startsWith('file:')) {
  console.error('otel telemetry env missing');
  process.exit(5);
}
if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_BASE_URL.includes('127.0.0.1')) {
  console.error('otel mode must not point claude at a local proxy');
  process.exit(6);
}
const dir = spec.slice('file:'.length);
fs.mkdirSync(dir, { recursive: true });
const meta = { user_id: JSON.stringify({ session_id: ${JSON.stringify(sessionId)} }) };
function w(name, t, payload) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(payload));
  fs.utimesSync(f, t, t);
}
w('c1.request.json', 1000, { model: 'claude-opus-4-8', system: [{ type: 'text', text: 'S' }], messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash' }], metadata: meta });
w('req_1.response.json', 1001, { id: 'req_1', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 506, output_tokens: 9, cache_read_input_tokens: 14376, cache_creation_input_tokens: 0 } });
w('c2.request.json', 2000, { model: 'claude-haiku-4-5', system: [{ type: 'text', text: 'S' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }], tools: [{ name: 'Bash' }], metadata: meta });
console.log('fake claude otel dumped');
`,
  );

  const env = cleanEnv({
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    PEEKMYAGENT_STATE_DIR: tmpDir,
  });

  const result = await runCli([`--viewer-url=${viewer.url}`, "claude", "-p", "hi"], env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake claude otel dumped/, "fake claude ran");
  assert.match(result.stderr, /auto fallback/, "wrapper auto-selected OTel mode");
  assert.match(result.stderr, /OTel raw body/, "wrapper announced OTel mode");
  assert.match(result.stderr, /captured 2 OTel request\(s\), 1 response\(s\)/, "wrapper reported ingest counts");

  // /api/sources surfaces it as a persisted Claude Code source.
  const sources = await getJson(`${viewer.url}/api/sources`);
  const src = sources.find((s) => s.agent === "Claude Code" && s.conversation_id === sessionId);
  assert.ok(src, "OTel capture appears in /api/sources");
  assert.equal(src.request_count, 2, "two requests captured");
  assert.equal(src.response_count, 1, "one response captured");

  // /api/view reconstructs them with the right shape + real token usage.
  const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(src.id)}`);
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[0].model, "claude-opus-4-8");
  assert.equal(view.requests[0].request_index, 1);
  assert.equal(view.requests[0].conversation_id, sessionId);
  assert.equal(view.requests[0].upstream_status, 200, "request #1 has a paired response");
  assert.equal(view.requests[1].model, "claude-haiku-4-5");
  assert.equal(view.requests[1].request_index, 2);

  // Response must actually RENDER in the view (regression: OTel response needs
  // body_json or the non-stream display path drops it silently).
  const resp0 = view.requests[0].summary?.response;
  assert.ok(resp0?.captured, "response #1 rendered in the view");
  assert.equal(resp0.finish_reason, "end_turn", "stop_reason surfaced");
  assert.equal(resp0.usage?.cache_read_input_tokens, 14376, "real cache token usage surfaced in view");

  console.log("otel-capture e2e smoke passed");
} finally {
  await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/peekmyagent.mjs", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function cleanEnv(env) {
  const output = { ...env };
  delete output.ANTHROPIC_BASE_URL;
  delete output.PEEK_CLAUDE_TARGET_BASE_URL;
  delete output.ANTHROPIC_AUTH_TOKEN;
  return output;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
