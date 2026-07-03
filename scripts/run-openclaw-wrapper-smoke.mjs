import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-run-openclaw-"));
const binDir = path.join(tmpDir, "bin");
const fakeConfigRoot = path.join(tmpDir, "config");
const patchPath = path.join(tmpDir, "patched-base-url.txt");
const argsPath = path.join(tmpDir, "child-args.json");
const failConversationId = "agent:main:wrapper-fail";
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(fakeConfigRoot, { recursive: true });

const defaultConfig = path.join(fakeConfigRoot, "openclaw.json");
fs.writeFileSync(defaultConfig, JSON.stringify({ ok: true }));

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "chatcmpl_openclaw_wrapper", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd, demo: "openclaw-subagent" });

try {
  writeFakeNodeCommand(
    binDir,
    "openclaw",
    `
import fs from 'node:fs';
import path from 'node:path';

let args = process.argv.slice(2);
let profile = null;
const profileIndex = args.indexOf('--profile');
if (profileIndex !== -1) {
  profile = args[profileIndex + 1];
  args.splice(profileIndex, 2);
}

const configRoot = process.env.PEEK_FAKE_OPENCLAW_CONFIG_ROOT;
const patchPath = process.env.PEEK_FAKE_OPENCLAW_PATCH_PATH;
const argsPath = process.env.PEEK_FAKE_OPENCLAW_ARGS_PATH;
const upstreamUrl = process.env.PEEK_FAKE_OPENCLAW_UPSTREAM_URL;

if (args[0] === 'config' && args[1] === 'file') {
  const file = profile ? path.join(configRoot, profile, 'openclaw.json') : path.join(configRoot, 'openclaw.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) && !profile) fs.writeFileSync(file, '{}');
  if (profile) console.log('Config warnings:\\n- plugins.entries.feishu: plugin not installed: feishu');
  console.log(file);
  process.exit(0);
}

if (args[0] === 'config' && args[1] === 'get') {
  if (args[2] === 'agents.defaults.model.primary') {
    console.log('peek/peek-test');
    process.exit(0);
  }
  if (args[2] === 'models.providers.peek.baseUrl') {
    console.log(upstreamUrl);
    process.exit(0);
  }
}

if (args[0] === 'config' && args[1] === 'patch' && args.includes('--stdin')) {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const patch = JSON.parse(stdin || '{}');
  const baseUrl = patch?.models?.providers?.peek?.baseUrl;
  if (!baseUrl) process.exit(3);
  fs.writeFileSync(patchPath, baseUrl);
  process.exit(0);
}

fs.writeFileSync(argsPath, JSON.stringify({ profile, args }, null, 2));
const baseUrl = fs.readFileSync(patchPath, 'utf8').trim();
if (process.env.PEEK_FAKE_OPENCLAW_FAIL === '1') {
  console.error('fake openclaw fail');
  process.exit(9);
}
const response = await fetch(baseUrl + '/v1/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-peek-conversation-id': process.env.PEEK_FAKE_OPENCLAW_CONVERSATION_ID || 'agent:main:wrapper-smoke',
  },
  body: JSON.stringify({
    model: 'peek/peek-test',
    messages: [{ role: 'user', content: 'hello from fake openclaw' }],
    tools: [],
  }),
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(2);
}
console.log('fake openclaw ok');
	`,
  );

  const result = await runCli(["--viewer-url", viewer.url, "openclaw", "tui"], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    PEEK_FAKE_OPENCLAW_CONFIG_ROOT: fakeConfigRoot,
    PEEK_FAKE_OPENCLAW_PATCH_PATH: patchPath,
    PEEK_FAKE_OPENCLAW_ARGS_PATH: argsPath,
    PEEK_FAKE_OPENCLAW_UPSTREAM_URL: upstreamUrl,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake openclaw ok/);

  const child = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  assert.equal(child.profile, "peekmyagent");
  assert.deepEqual(child.args, ["tui", "--local"]);

  const sources = await getJson(`${viewer.url}/api/sources`);
  const live = sources.find((source) => source.agent === "OpenClaw" && source.conversation_id === "agent:main:wrapper-smoke");
  assert.ok(live);
  assert.equal(live.live_status, "stopped");
  assert.equal(live.request_count, 1);

  const failResult = await runCli(["run", "openclaw", "--viewer-url", viewer.url, "--session-key", failConversationId, "--", "tui"], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    PEEK_FAKE_OPENCLAW_CONFIG_ROOT: fakeConfigRoot,
    PEEK_FAKE_OPENCLAW_PATCH_PATH: patchPath,
    PEEK_FAKE_OPENCLAW_ARGS_PATH: argsPath,
    PEEK_FAKE_OPENCLAW_UPSTREAM_URL: upstreamUrl,
    PEEK_FAKE_OPENCLAW_CONVERSATION_ID: failConversationId,
    PEEK_FAKE_OPENCLAW_FAIL: "1",
  });
  assert.equal(failResult.code, 9, failResult.stderr);
  assert.match(failResult.stderr, /peekMyAgent watch:/);
  assert.match(failResult.stderr, /fake openclaw fail/);
  assert.equal(fs.readFileSync(patchPath, "utf8").trim(), upstreamUrl);

  const sourcesAfterFailure = await getJson(`${viewer.url}/api/sources`);
  const failedLive = sourcesAfterFailure.find((source) => source.agent === "OpenClaw" && source.conversation_id === failConversationId);
  assert.ok(failedLive);
  assert.equal(failedLive.live_status, "stopped");
  assert.equal(failedLive.request_count, 0);

  console.log("run openclaw wrapper smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
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
