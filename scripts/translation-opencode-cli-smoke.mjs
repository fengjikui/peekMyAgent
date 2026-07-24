import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";
import {
  resolveTranslationProtocol,
  selectOpenCodeTranslationModel,
} from "../src/translation/provider-policy.mjs";

assert.equal(resolveTranslationProtocol({ agent: "OpenCode", env: {} }), "opencode-cli");
assert.equal(resolveTranslationProtocol({ agent: "Open Code CLI", env: {} }), "opencode-cli");
assert.equal(
  resolveTranslationProtocol({ agent: "OpenCode", env: { PEEKMYAGENT_TRANSLATION_PROTOCOL: "opencode" } }),
  "opencode-cli",
);

const config = {
  model: "mimo/mimo-v2.5-pro",
  provider: {
    mimo: {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://provider.invalid/v1",
        apiKey: "provider-secret-must-stay-private",
      },
      models: {
        "mimo-v2.5-pro": { name: "MiMo Pro" },
        "mimo-v2.5": { name: "MiMo Fast" },
      },
    },
  },
};
assert.deepEqual(selectOpenCodeTranslationModel({ config, env: {} }), {
  model: "mimo/mimo-v2.5",
  source: "provider-fast-model",
  fallbackModel: "mimo/mimo-v2.5-pro",
});

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "translate-opencodecli-"));
const binDir = path.join(tmp, "bin");
const invocationPath = path.join(tmp, "opencode-invocations.jsonl");
const materialsPath = path.join(tmp, "materials.jsonl");
const cachePath = path.join(tmp, "zh-CN.json");
fs.mkdirSync(binDir, { recursive: true });

const fakeOpenCode = writeFakeNodeCommand(
  binDir,
  "opencode",
  `
import fs from "node:fs";
const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const inlineConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
fs.appendFileSync(process.env.PEEK_FAKE_OPENCODE_INVOCATION, JSON.stringify({
  args,
  prompt,
  inlineConfig,
  flags: {
    disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    disableClaudeCode: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
  },
}) + "\\n");
if (args[0] === "debug" && args[1] === "config") {
  process.stdout.write(JSON.stringify(${JSON.stringify(config)}) + "\\n");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
  process.exit(0);
}
if (args[0] !== "run") {
  process.stderr.write("unexpected fake OpenCode command\\n");
  process.exit(2);
}
const model = args[args.indexOf("--model") + 1];
if (process.env.PEEK_FAKE_OPENCODE_REJECT_FAST === "1" && model === "mimo/mimo-v2.5") {
  process.stderr.write("The selected model is not available for this account.\\n");
  process.exit(3);
}
const hashes = [...prompt.matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((match) => match[1]);
const text = hashes
  .map((hash) => "@@PEEK_TRANSLATION " + hash + "\\nOpenCode译文-" + hash.slice(0, 6) + "\\n@@PEEK_END_TRANSLATION")
  .join("\\n\\n");
const sessionID = model.endsWith("-pro") ? "ses_fallback" : "ses_fast";
process.stdout.write(JSON.stringify({ type: "step_start", sessionID, part: { type: "step-start" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", sessionID, part: { type: "text", text } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", sessionID, part: { type: "step-finish" } }) + "\\n");
`,
);

const hash = "e5".repeat(32);
fs.writeFileSync(materialsPath, `${JSON.stringify({
  hash,
  id: hash,
  kind: "tool_description",
  source_language: "en",
  source_text: "Translate this OpenCode tool description.",
  metadata: { tool_name: "read" },
})}\n`);

const baseEnv = {
  ...process.env,
  PEEKMYAGENT_TRANSLATION_OPENCODE_BIN: fakeOpenCode.command_path,
  PEEK_FAKE_OPENCODE_INVOCATION: invocationPath,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    provider: {
      mimo: {
        options: {
          apiKey: "inline-secret-must-stay-private",
        },
      },
    },
  }),
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
  "PEEKMYAGENT_TRANSLATION_OPENCODE_MODEL",
]) {
  delete baseEnv[key];
}

const result = await runTranslation(baseEnv, cachePath);
const fallbackInvocationPath = path.join(tmp, "opencode-fallback-invocations.jsonl");
const fallbackCachePath = path.join(tmp, "zh-CN-fallback.json");
const fallbackResult = await runTranslation({
  ...baseEnv,
  PEEK_FAKE_OPENCODE_INVOCATION: fallbackInvocationPath,
  PEEK_FAKE_OPENCODE_REJECT_FAST: "1",
}, fallbackCachePath);

let failed = false;
try {
  assert.equal(result.code, 0, `OpenCode translation should exit 0\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.translated, 1);
  assert.equal(output.concurrency, 2);

  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.provider?.type, "opencode-cli");
  assert.equal(cache.provider?.model, "mimo/mimo-v2.5");
  assert.equal(cache.provider?.model_source, "provider-fast-model");
  assert.equal(cache.provider?.reasoning_effort, "provider-default");
  assert.match(cache.entries[hash]?.translated_text || "", /OpenCode译文-/);

  const invocations = readJsonLines(invocationPath);
  const debugInvocation = invocations.find((entry) => entry.args[0] === "debug");
  const runInvocation = invocations.find((entry) => entry.args[0] === "run");
  const cleanupInvocation = invocations.find((entry) => entry.args[0] === "session");
  assert.ok(debugInvocation, "effective OpenCode config is inspected");
  assert.ok(runInvocation, "OpenCode run is invoked");
  assert.ok(cleanupInvocation, "temporary OpenCode session is deleted");
  for (const required of ["run", "--pure", "--format", "json", "--title", "--agent", "--model"]) {
    assert.ok(runInvocation.args.includes(required), `OpenCode invocation includes ${required}`);
  }
  assert.equal(runInvocation.args[runInvocation.args.indexOf("--model") + 1], "mimo/mimo-v2.5");
  assert.equal(runInvocation.args[runInvocation.args.indexOf("--agent") + 1], "peekmyagent-translation");
  assert.ok(!runInvocation.args.some((value) => value.includes("@@PEEK_SOURCE")));
  assert.match(runInvocation.prompt, /@@PEEK_SOURCE/);
  assert.equal(runInvocation.inlineConfig.provider.mimo.options.apiKey, "inline-secret-must-stay-private");
  assert.equal(runInvocation.inlineConfig.share, "disabled");
  assert.equal(runInvocation.inlineConfig.tools["*"], false);
  assert.equal(runInvocation.inlineConfig.agent["peekmyagent-translation"].permission["*"], "deny");
  assert.equal(runInvocation.inlineConfig.agent["peekmyagent-translation"].tools["*"], false);
  assert.equal(runInvocation.flags.disableProjectConfig, "1");
  assert.equal(runInvocation.flags.disableClaudeCode, "1");
  assert.equal(cleanupInvocation.args.at(-1), "ses_fast");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /inline-secret|provider-secret|ambient-anthropic-token/);

  assert.equal(fallbackResult.code, 0, `OpenCode fallback should exit 0\n${fallbackResult.stderr}`);
  const fallbackCache = JSON.parse(fs.readFileSync(fallbackCachePath, "utf8"));
  assert.equal(fallbackCache.provider?.model, "mimo/mimo-v2.5-pro");
  assert.equal(fallbackCache.provider?.model_source, "opencode-default-fallback");
  const fallbackInvocations = readJsonLines(fallbackInvocationPath);
  const fallbackRuns = fallbackInvocations.filter((entry) => entry.args[0] === "run");
  assert.equal(fallbackRuns.length, 2);
  assert.equal(fallbackRuns[0].args[fallbackRuns[0].args.indexOf("--model") + 1], "mimo/mimo-v2.5");
  assert.equal(fallbackRuns[1].args[fallbackRuns[1].args.indexOf("--model") + 1], "mimo/mimo-v2.5-pro");
  assert.ok(
    fallbackInvocations.some((entry) => entry.args[0] === "session" && entry.args.at(-1) === "ses_fallback"),
    "fallback session is cleaned",
  );
  console.log("translation-opencode-cli smoke: OK (same-agent fast model, stdin privacy, no tools, session cleanup)");
} catch (error) {
  failed = true;
  console.error("translation-opencode-cli smoke FAILED:", error.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;

function runTranslation(env, targetCachePath) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(process.execPath, [
      "scripts/translate-materials-zh.mjs",
      "--materials",
      materialsPath,
      "--cache",
      targetCachePath,
      "--agent",
      "OpenCode",
    ], { env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd,
      env,
      ...spawnConfig.options,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OpenCode translation smoke timed out"));
    }, 20_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}
