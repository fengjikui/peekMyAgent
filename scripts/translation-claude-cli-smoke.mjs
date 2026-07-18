import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

// A Claude Code capture must use Claude's own subscription CLI even when
// unrelated provider credentials exist in the parent environment.

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "translate-claudecli-"));
const fakeAppData = path.join(tmp, "appdata");
const binDir = process.platform === "win32" ? path.join(fakeAppData, "npm") : path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
const H3 = "c3".repeat(32);

const invocationPath = path.join(tmp, "claude-invocation.json");
const fakeClaude = writeFakeNodeCommand(
  binDir,
  "claude",
  `
import fs from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(process.env.PEEK_FAKE_CLAUDE_INVOCATION, JSON.stringify({ args: process.argv.slice(2), prompt }));
const hashes = [...prompt.matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((m) => m[1]);
const blocks = hashes.map((h) => '@@PEEK_TRANSLATION ' + h + '\\n译文-' + h.slice(0, 6) + '\\n@@PEEK_END_TRANSLATION').join('\\n\\n');
process.stdout.write(blocks + '\\n');
`,
);

const materialsPath = path.join(tmp, "materials.jsonl");
const cachePath = path.join(tmp, "zh-CN.json");
const mk = (hash, text) => ({ hash, id: hash, kind: "system_block", source_language: "en", source_text: text, metadata: {} });
fs.writeFileSync(materialsPath, `${[mk(H1, "Block one."), mk(H2, "Block two."), mk(H3, "Block three.")].map((m) => JSON.stringify(m)).join("\n")}\n`);

const env = { ...process.env, APPDATA: fakeAppData, USERPROFILE: path.join(tmp, "home") };
if (process.platform === "win32") {
  env.Path = path.dirname(process.execPath);
  env.PATH = path.dirname(process.execPath);
} else {
  env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
}
for (const key of [
  "PEEKMYAGENT_TRANSLATION_PROTOCOL",
  "PEEKMYAGENT_TRANSLATION_API_KEY",
  "PEEKMYAGENT_TRANSLATION_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
]) {
  delete env[key];
}
env.PEEKMYAGENT_TRANSLATION_CLAUDE_BIN = fakeClaude.command_path;
env.PEEK_FAKE_CLAUDE_INVOCATION = invocationPath;
env.OPENAI_API_KEY = "ambient-openai-key-must-not-win";
env.DEEPSEEK_API_KEY = "ambient-deepseek-key-must-not-win";

const result = await new Promise((resolve, reject) => {
  const spawnConfig = childProcessSpawnConfig(process.execPath, ["scripts/translate-materials-zh.mjs", "--materials", materialsPath, "--cache", cachePath, "--agent", "Claude Code"], { env });
  const child = spawn(spawnConfig.command, spawnConfig.args, { cwd, env, ...spawnConfig.options });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error("translate timed out"));
  }, 20_000);
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

let failed = false;
try {
  assert.equal(result.code, 0, `claude-cli auto translation should exit 0\n${result.stderr}`);
  const out = JSON.parse(result.stdout);
  assert.equal(out.translated, 3, "all blocks translated via claude CLI");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.provider?.type, "claude-cli", "auto-detected the claude-cli provider");
  assert.equal(cache.provider?.reasoning_effort, "low", "Claude translation uses low effort by default");
  assert.ok(cache.entries[H1] && cache.entries[H2] && cache.entries[H3], "all blocks cached");
  assert.match(cache.entries[H1].translated_text, /译文-/, "translated text came from the claude CLI");
  const invocation = JSON.parse(fs.readFileSync(invocationPath, "utf8"));
  assert.ok(invocation.args.includes("--no-session-persistence"), "Claude translation does not persist a session");
  assert.ok(invocation.args.includes("--tools"), "Claude translation explicitly configures tools");
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "", "Claude translation disables all tools");
  assert.ok(invocation.args.includes("--effort"), "Claude translation sets effort explicitly");
  assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "low", "Claude translation uses low effort");
  assert.ok(!invocation.args.some((value) => value.includes("@@PEEK_SOURCE")), "translation material is not exposed in process arguments");
  assert.match(invocation.prompt, /@@PEEK_SOURCE/, "translation material is delivered over stdin");
  console.log("translation-claude-cli smoke: OK (Claude capture stays on Claude, ephemeral low-effort translation)");
} catch (error) {
  failed = true;
  console.error("translation-claude-cli smoke FAILED:", error.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
