import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { codexCliCandidates } from "../src/core/app-paths.mjs";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
assert.deepEqual(
  codexCliCandidates({ env: { PEEKMYAGENT_TRANSLATION_CODEX_BIN: "custom-codex" }, platform: "win32" }),
  ["custom-codex"],
  "an explicit Codex binary override is platform independent",
);
assert.equal(
  codexCliCandidates({ env: { HOME: "/Users/test" }, platform: "darwin" })[0],
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "macOS prefers the Codex Desktop bundled binary",
);
assert.deepEqual(
  codexCliCandidates({ env: {}, platform: "win32" }),
  ["codex"],
  "Windows uses the cross-platform PATH command until a binary override is provided",
);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "translate-codexcli-"));
const binDir = path.join(tmp, "bin");
const codexHome = path.join(tmp, "codex-home");
const invocationPath = path.join(tmp, "codex-invocation.json");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });

const fakeCodex = writeFakeNodeCommand(
  binDir,
  "codex",
  `
import fs from 'node:fs';
const args = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex === -1 || !args[outputIndex + 1]) {
  process.stderr.write('missing --output-last-message\\n');
  process.exit(2);
}
fs.appendFileSync(process.env.PEEK_FAKE_CODEX_INVOCATION, JSON.stringify({ args, prompt }) + '\\n');
if (process.env.PEEK_FAKE_CODEX_REJECT_MODEL === '1' && args.includes('--model')) {
  process.stderr.write('The selected model is not available for this account.\\n');
  process.exit(3);
}
const hashes = [...prompt.matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((match) => match[1]);
const blocks = hashes
  .map((hash) => '@@PEEK_TRANSLATION ' + hash + '\\nCodex译文-' + hash.slice(0, 6) + '\\n@@PEEK_END_TRANSLATION')
  .join('\\n\\n');
fs.writeFileSync(args[outputIndex + 1], blocks + '\\n');
`,
);

fs.writeFileSync(
  path.join(codexHome, "models_cache.json"),
  `${JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-5.3-codex-spark", visibility: "list" },
    ],
  }, null, 2)}\n`,
);

const hash = "d4".repeat(32);
const materialsPath = path.join(tmp, "materials.jsonl");
const cachePath = path.join(tmp, "zh-CN.json");
fs.writeFileSync(materialsPath, `${JSON.stringify({
  hash,
  id: hash,
  kind: "system_block",
  source_language: "en",
  source_text: "Translate this Codex system instruction.",
  metadata: {},
})}\n`);

const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  PEEKMYAGENT_TRANSLATION_CODEX_BIN: fakeCodex.command_path,
  PEEK_FAKE_CODEX_INVOCATION: invocationPath,
  ANTHROPIC_AUTH_TOKEN: "ambient-anthropic-token-must-not-win",
  ANTHROPIC_BASE_URL: "https://ambient-anthropic.invalid",
  DEEPSEEK_API_KEY: "ambient-deepseek-token-must-not-win",
  DEEPSEEK_BASE_URL: "https://ambient-deepseek.invalid",
  PEEKMYAGENT_TRANSLATION_CLAUDE_BIN: path.join(tmp, "claude-must-not-run"),
};
for (const key of [
  "PEEKMYAGENT_TRANSLATION_PROTOCOL",
  "PEEKMYAGENT_TRANSLATION_API_KEY",
  "PEEKMYAGENT_TRANSLATION_BASE_URL",
  "PEEKMYAGENT_TRANSLATION_MODEL",
  "PEEKMYAGENT_TRANSLATION_CODEX_MODEL",
]) {
  delete env[key];
}

const runTranslation = (runEnv, runCachePath) => new Promise((resolve, reject) => {
  const spawnConfig = childProcessSpawnConfig(process.execPath, [
    "scripts/translate-materials-zh.mjs",
    "--materials",
    materialsPath,
    "--cache",
    runCachePath,
    "--agent",
    "Codex",
  ], { env: runEnv });
  const child = spawn(spawnConfig.command, spawnConfig.args, { cwd, env: runEnv, ...spawnConfig.options });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error("Codex translation smoke timed out"));
  }, 20_000);
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});

const result = await runTranslation(env, cachePath);
const fallbackInvocationPath = path.join(tmp, "codex-fallback-invocations.jsonl");
const fallbackCachePath = path.join(tmp, "zh-CN-fallback.json");
const fallbackResult = await runTranslation({
  ...env,
  PEEK_FAKE_CODEX_INVOCATION: fallbackInvocationPath,
  PEEK_FAKE_CODEX_REJECT_MODEL: "1",
}, fallbackCachePath);

let failed = false;
try {
  assert.equal(result.code, 0, `Codex translation should exit 0\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.translated, 1, "Codex translated the pending block");
  assert.equal(output.concurrency, 2, "CLI translation limits process concurrency");

  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.provider?.type, "codex-cli", "Codex capture selects the Codex CLI");
  assert.equal(cache.provider?.model, "gpt-5.3-codex-spark", "fast available Codex model is preferred");
  assert.equal(cache.provider?.model_source, "models-cache", "model selection records its source");
  assert.equal(cache.provider?.reasoning_effort, "low", "Codex translation uses low reasoning effort");
  assert.match(cache.entries[hash]?.translated_text || "", /Codex译文-/, "translation came from the Codex CLI");

  const invocation = readJsonLines(invocationPath)[0];
  for (const required of ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message"]) {
    assert.ok(invocation.args.includes(required), `Codex invocation includes ${required}`);
  }
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "gpt-5.3-codex-spark", "Codex receives the selected fast model");
  assert.match(invocation.args[invocation.args.indexOf("-c") + 1], /model_reasoning_effort="low"/, "Codex receives low effort config");
  assert.equal(invocation.args.at(-1), "-", "Codex reads the translation prompt from stdin");
  assert.ok(!invocation.args.some((value) => value.includes("@@PEEK_SOURCE")), "translation material is not exposed in process arguments");
  assert.match(invocation.prompt, /@@PEEK_SOURCE/, "translation material is delivered over stdin");

  assert.equal(fallbackResult.code, 0, `Codex default-model fallback should exit 0\n${fallbackResult.stderr}`);
  const fallbackCache = JSON.parse(fs.readFileSync(fallbackCachePath, "utf8"));
  assert.equal(fallbackCache.provider?.model, "codex-default-low", "unavailable fast model falls back to Codex default");
  assert.equal(fallbackCache.provider?.model_source, "codex-default-fallback", "fallback source is recorded");
  const fallbackInvocations = readJsonLines(fallbackInvocationPath);
  assert.equal(fallbackInvocations.length, 2, "fallback makes one preferred-model attempt and one default-model attempt");
  assert.ok(fallbackInvocations[0].args.includes("--model"), "first fallback attempt uses the preferred fast model");
  assert.ok(!fallbackInvocations[1].args.includes("--model"), "second fallback attempt delegates model choice to Codex");
  console.log("translation-codex-cli smoke: OK (Codex capture uses ephemeral Codex translation with a fast low-effort model)");
} catch (error) {
  failed = true;
  console.error("translation-codex-cli smoke FAILED:", error.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}
