#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-run-codex-"));
const binDir = path.join(tmpDir, "bin");
const stateDir = path.join(tmpDir, "state");
const codexHome = path.join(tmpDir, "codex-home");
const argsPath = path.join(tmpDir, "codex-args.json");
const storePath = path.join(stateDir, "captures.sqlite");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
const configPath = path.join(codexHome, "config.toml");
const configSentinel = 'model = "fixture-model"\n';
fs.writeFileSync(configPath, configSentinel);

const viewer = await startViewerServer({ cwd, storePath, capturePort: 0 });
try {
  writeFakeNodeCommand(
    binDir,
    "codex",
    `
import fs from 'node:fs';
fs.writeFileSync(process.env.PEEK_FAKE_CODEX_ARGS_PATH, JSON.stringify(process.argv.slice(2), null, 2));
console.log('fake codex capture ok');
`,
  );

  const result = await runCli(
    ["codex", "--viewer-url", viewer.url, "--no-open", "exec", "fixture prompt"],
    {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      PEEKMYAGENT_STATE_DIR: stateDir,
      PEEK_FAKE_CODEX_ARGS_PATH: argsPath,
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Codex capture: exact Responses API \(default\)/);
  assert.match(result.stderr, /config: one-process HTTP-only provider override/);
  assert.match(result.stdout, /fake codex capture ok/);

  const childArgs = JSON.parse(fs.readFileSync(argsPath, "utf8"));
  assert.deepEqual(childArgs.slice(0, 12).filter((_, index) => index % 2 === 0), Array(6).fill("-c"));
  assert.equal(childArgs[1], 'model_provider="peekmyagent_http"');
  assert.equal(childArgs[3], 'model_providers.peekmyagent_http.name="peekMyAgent HTTP capture"');
  assert.match(childArgs[5], /^model_providers\.peekmyagent_http\.base_url="http:\/\/127\.0\.0\.1:\d+\/watch\/[^/]+\/v1"$/);
  assert.equal(childArgs[7], 'model_providers.peekmyagent_http.wire_api="responses"');
  assert.equal(childArgs[9], "model_providers.peekmyagent_http.requires_openai_auth=true");
  assert.equal(childArgs[11], "model_providers.peekmyagent_http.supports_websockets=false");
  assert.deepEqual(childArgs.slice(12), ["exec", "fixture prompt"]);
  assert.equal(fs.readFileSync(configPath, "utf8"), configSentinel, "capture must not edit Codex config.toml");

  const compatibilityAlias = await runCli(
    ["codex", "capture", "--viewer-url", viewer.url, "--no-open", "--", "exec", "alias prompt"],
    {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      PEEKMYAGENT_STATE_DIR: stateDir,
      PEEK_FAKE_CODEX_ARGS_PATH: argsPath,
    },
  );
  assert.equal(compatibilityAlias.code, 0, compatibilityAlias.stderr);
  assert.match(compatibilityAlias.stderr, /Codex capture: exact Responses API \(compatibility alias\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")).slice(12), ["exec", "alias prompt"]);

  const sources = await getJson(`${viewer.url}/api/sources`);
  const source = sources.find((item) => item.agent === "Codex" && (item.kind === "codex_proxy_exact" || item.capture_kind === "codex_proxy_exact"));
  assert.ok(source, "the stopped exact-capture watch remains available as a stored Trace");
  assert.equal(source.live_status, "stopped");
  assert.equal(source.request_count, 0);

  const invalid = await runCli(
    ["codex", "capture", "--bad-option"],
    { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  );
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Put Codex arguments after --/);

  const movedDesktopOption = await runCli(
    ["codex", "--select"],
    { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  );
  assert.equal(movedDesktopOption.code, 1);
  assert.match(movedDesktopOption.stderr, /moved to `pma codex desktop/);

  const ambiguousContinue = await runCli(
    ["codex", "-c"],
    { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  );
  assert.equal(ambiguousContinue.code, 1);
  assert.match(ambiguousContinue.stderr, /pma codex resume --last/);

  console.log("run Codex capture wrapper smoke passed");
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
    }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal || null, stdout, stderr });
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
