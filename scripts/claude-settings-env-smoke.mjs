import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { claudeCodeSettingsPaths } from "../src/core/claude-code-settings.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-settings-"));
const fakeHome = path.join(tmpDir, "home");
const workspace = path.join(fakeHome, "workspace");
const binDir = path.join(tmpDir, "bin");
const fakeClaudeLog = path.join(tmpDir, "fake-claude.json");
let viewer = null;
let upstream = null;
let upstreamRequests = 0;

try {
  const windowsSettingsPaths = claudeCodeSettingsPaths("C:\\Users\\Ada\\repo\\project", { USERPROFILE: "C:\\Users\\Ada" }, "win32");
  assert.ok(windowsSettingsPaths.includes("C:\\Users\\Ada\\.claude\\settings.json"), JSON.stringify(windowsSettingsPaths));
  assert.ok(windowsSettingsPaths.includes("C:\\Users\\Ada\\repo\\project\\.claude\\settings.local.json"), JSON.stringify(windowsSettingsPaths));
  assert.equal(windowsSettingsPaths.some((item) => item.includes("/.claude/")), false, JSON.stringify(windowsSettingsPaths));

  upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_settings_smoke", type: "message", content: [{ type: "text", text: "ok" }] }));
  });
  const upstreamUrl = await listen(upstream);

  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(
    path.join(fakeHome, ".claude", "settings.json"),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:45679",
          ANTHROPIC_AUTH_TOKEN: "settings-token",
          ANTHROPIC_MODEL: "settings-model",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(workspace, ".claude", "settings.local.json"),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: upstreamUrl,
        },
      },
      null,
      2,
    ),
  );
  writeFakeNodeCommand(
    binDir,
    "claude",
    `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(fakeClaudeLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || null,
  anthropicModel: process.env.ANTHROPIC_MODEL || null
}, null, 2));
const response = await fetch((process.env.ANTHROPIC_BASE_URL || '') + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer smoke-settings' },
  body: JSON.stringify({ model: 'mock-claude', messages: [{ role: 'user', content: 'hello' }] })
});
if (!response.ok) process.exit(2);
console.log("fake claude settings ok");
`,
  );

  viewer = await startViewerServer({ cwd: workspace, port: 0 });
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  };
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_MODEL;
  delete env.PEEK_CLAUDE_TARGET_BASE_URL;

  const result = await runCli(["run", "claude", "--viewer-url", viewer.url, "--watch", "new", "--", "-p", "hello from settings"], env, workspace);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fake claude settings ok/);
  const sourceMatch = result.stderr.match(/source=(live-[^\s]+)/);
  assert.ok(sourceMatch, result.stderr);

  const call = JSON.parse(fs.readFileSync(fakeClaudeLog, "utf8"));
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(workspace));
  assert.match(call.anthropicBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/watch\/claude-code-/);
  assert.equal(call.anthropicAuthToken, "settings-token");
  assert.equal(call.anthropicModel, "settings-model");

  const data = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(sourceMatch[1])}`);
  assert.equal(data.source.agent, "Claude Code");
  assert.equal(data.stats.request_count, 1);
  assert.equal(upstreamRequests, 1);

  console.log("claude settings env smoke passed");
} finally {
  if (viewer) await viewer.close();
  if (upstream) await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
  return new Promise((resolve) => server.close(resolve));
}

function runCli(args, env, workdir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(cwd, "bin/peekmyagent.mjs"), ...args], { cwd: workdir, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 10_000);
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
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
