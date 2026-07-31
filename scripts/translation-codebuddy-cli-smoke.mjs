import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { resolveTranslationProtocol } from "../src/translation/provider-policy.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

assert.equal(
  resolveTranslationProtocol({
    agent: "CodeBuddy Code",
    env: { ANTHROPIC_AUTH_TOKEN: "ambient-token-must-not-win" },
  }),
  "codebuddy-cli",
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "translate-codebuddy-"));
const invocationPath = path.join(tmp, "invocation.json");
const materialsPath = path.join(tmp, "materials.jsonl");
const cachePath = path.join(tmp, "zh-CN.json");
fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
const fakeCodeBuddy = writeFakeNodeCommand(
  path.join(tmp, "bin"),
  "codebuddy",
  `
import fs from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(process.env.PEEK_FAKE_CODEBUDDY_INVOCATION, JSON.stringify({
  args: process.argv.slice(2),
  prompt,
  cwd: process.cwd(),
}));
const hashes = [...prompt.matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((match) => match[1]);
process.stdout.write(hashes.map((hash) =>
  "@@PEEK_TRANSLATION " + hash + "\\nCodeBuddy译文\\n@@PEEK_END_TRANSLATION"
).join("\\n\\n") + "\\n");
`,
);
const hash = "c7".repeat(32);
fs.writeFileSync(materialsPath, `${JSON.stringify({
  hash,
  id: hash,
  kind: "system_prompt",
  source_language: "en",
  source_text: "Translate this CodeBuddy instruction.",
  metadata: {},
})}\n`);

const env = {
  ...process.env,
  PEEKMYAGENT_TRANSLATION_CODEBUDDY_BIN: fakeCodeBuddy.command_path,
  PEEK_FAKE_CODEBUDDY_INVOCATION: invocationPath,
  ANTHROPIC_AUTH_TOKEN: "ambient-token-must-not-win",
  ANTHROPIC_BASE_URL: "https://ambient.invalid",
};
for (const key of [
  "PEEKMYAGENT_TRANSLATION_PROTOCOL",
  "PEEKMYAGENT_TRANSLATION_MODEL",
  "PEEKMYAGENT_TRANSLATION_CODEBUDDY_MODEL",
]) delete env[key];

const result = await runTranslation(env);
let failed = false;
try {
  assert.equal(result.code, 0, result.stderr);
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.provider?.type, "codebuddy-cli");
  assert.equal(cache.provider?.model, "mimo-v2.5-pro");
  assert.equal(cache.provider?.model_source, "captured-request");
  assert.equal(cache.provider?.reasoning_effort, "low");
  assert.equal(cache.entries[hash]?.translated_text, "CodeBuddy译文");

  const invocation = JSON.parse(fs.readFileSync(invocationPath, "utf8"));
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "mimo-v2.5-pro");
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  assert.equal(invocation.args[invocation.args.indexOf("--setting-sources") + 1], "user");
  assert.ok(invocation.args.includes("--no-session-persistence"));
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.match(path.basename(invocation.cwd), /^peek-translation-codebuddy-/);
  assert.ok(!invocation.args.some((value) => value.includes("@@PEEK_SOURCE")));
  assert.match(invocation.prompt, /@@PEEK_SOURCE/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ambient-token/);
  console.log("translation-codebuddy-cli smoke: OK (captured model reuses CodeBuddy config; no provider re-detection)");
} catch (error) {
  failed = true;
  console.error("translation-codebuddy-cli smoke FAILED:", error.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

function runTranslation(runEnv) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(process.execPath, [
      "scripts/translate-materials-zh.mjs",
      "--materials", materialsPath,
      "--cache", cachePath,
      "--agent", "CodeBuddy Code",
      "--source-model", "mimo-v2.5-pro",
    ], { env: runEnv });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: process.cwd(),
      env: runEnv,
      ...spawnConfig.options,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CodeBuddy translation smoke timed out"));
    }, 20_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
