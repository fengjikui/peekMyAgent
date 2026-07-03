import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

// Smoke for the subscription translation path: with NO standalone provider
// credentials, createTranslationClient must auto-fall-back to the local `claude`
// CLI and translate successfully. Uses a fake `claude` that emits marker blocks.

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "translate-claudecli-"));
const fakeAppData = path.join(tmp, "appdata");
const binDir = process.platform === "win32" ? path.join(fakeAppData, "npm") : path.join(tmp, "bin");
fs.mkdirSync(binDir, { recursive: true });
const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
const H3 = "c3".repeat(32);

writeFakeNodeCommand(
  binDir,
  "claude",
  `
import fs from 'node:fs';
const i = process.argv.indexOf('-p');
const prompt = i !== -1 ? process.argv[i + 1] : '';
const hashes = [...prompt.matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((m) => m[1]);
const blocks = hashes.map((h) => '@@PEEK_TRANSLATION ' + h + '\\n译文-' + h.slice(0, 6) + '\\n@@PEEK_END_TRANSLATION').join('\\n\\n');
process.stdout.write(blocks + '\\n');
`,
);

const materialsPath = path.join(tmp, "materials.jsonl");
const cachePath = path.join(tmp, "zh-CN.json");
const mk = (hash, text) => ({ hash, id: hash, kind: "system_block", source_language: "en", source_text: text, metadata: {} });
fs.writeFileSync(materialsPath, `${[mk(H1, "Block one."), mk(H2, "Block two."), mk(H3, "Block three.")].map((m) => JSON.stringify(m)).join("\n")}\n`);

// Simulate subscription mode: strip every standalone provider credential so the
// client must auto-detect claude-cli. Do NOT set PEEKMYAGENT_TRANSLATION_PROTOCOL.
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

const result = await new Promise((resolve, reject) => {
  const spawnConfig = childProcessSpawnConfig(process.execPath, ["scripts/translate-materials-zh.mjs", "--materials", materialsPath, "--cache", cachePath, "--agent", "Mock"], { env });
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
  assert.ok(cache.entries[H1] && cache.entries[H2] && cache.entries[H3], "all blocks cached");
  assert.match(cache.entries[H1].translated_text, /译文-/, "translated text came from the claude CLI");
  console.log("translation-claude-cli smoke: OK (subscription auto-detects claude-cli, translates via local claude)");
} catch (error) {
  failed = true;
  console.error("translation-claude-cli smoke FAILED:", error.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
