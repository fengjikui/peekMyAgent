#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CodexDesktopDiscovery } from "../src/adapters/codex-desktop-discovery.mjs";
import {
  codexDesktopLaunchCandidates,
  launchCodexDesktopWorkspace,
} from "../src/adapters/codex-desktop-session.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(root, "bin", "peekmyagent.mjs");
const fixturePath = path.join(root, "fixtures", "codex-rollout-sanitized.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-desktop-"));
const workspace = path.join(tmpDir, "workspace");
const binDir = path.join(tmpDir, "bin");
const stateDir = path.join(tmpDir, "pma-state");
const codexHome = path.join(tmpDir, "codex-home");
const stateDbPath = path.join(codexHome, "state_5.sqlite");
const selectionPath = path.join(stateDir, "codex-observation.json");
const storePath = path.join(stateDir, "captures.sqlite");
const launchLogPath = path.join(tmpDir, "desktop-launches.json");
const baselineRolloutPath = path.join(codexHome, "baseline-rollout.jsonl");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.copyFileSync(fixturePath, baselineRolloutPath);
createStateDb(stateDbPath, baselineRolloutPath, workspace);
verifyMacosNativeLauncher(workspace);

const fake = writeFakeNodeCommand(binDir, "codex-desktop-fixture", `
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const args = process.argv.slice(2);
const logPath = process.env.PEEK_FAKE_CODEX_LAUNCH_LOG;
const launches = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
launches.push({ args, cwd: process.cwd() });
fs.writeFileSync(logPath, JSON.stringify(launches, null, 2));
if (process.env.PEEK_FAKE_CODEX_CREATE_THREAD === "1") {
  const id = "thread-desktop-" + launches.length;
  const rolloutPath = path.join(process.env.CODEX_HOME, id + ".jsonl");
  fs.copyFileSync(process.env.PEEK_FAKE_CODEX_FIXTURE, rolloutPath);
  const db = new DatabaseSync(process.env.PEEKMYAGENT_CODEX_STATE_DB);
  try {
    db.prepare("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, tokens_used, archived, cli_version, first_user_message, model, thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, rolloutPath, 200 + launches.length, 200 + launches.length, "desktop", "openai", process.cwd(), "Desktop fixture " + launches.length, 128, 0, "fixture", "desktop fixture", "gpt-fixture", "user");
  } finally {
    db.close();
  }
}
`);

const discovery = new CodexDesktopDiscovery({ stateDbPath, selectionPath, sourceLimit: 20 });
const viewer = await startViewerServer({
  cwd: workspace,
  storePath,
  port: 0,
  codexLocal: true,
  codexDesktopDiscovery: discovery,
});

const baseEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  PEEKMYAGENT_STATE_DIR: stateDir,
  PEEKMYAGENT_CODEX_STATE_DB: stateDbPath,
  PEEKMYAGENT_CODEX_SELECTION_PATH: selectionPath,
  PEEKMYAGENT_CODEX_DESKTOP_CLI: fake.command_path,
  PEEK_FAKE_CODEX_FIXTURE: fixturePath,
  PEEK_FAKE_CODEX_LAUNCH_LOG: launchLogPath,
};

try {
  const waiting = await runCli(["codex", "desktop", "--viewer-url", viewer.url, "--no-open"], {
    ...baseEnv,
    PEEK_FAKE_CODEX_CREATE_THREAD: "0",
  });
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.match(waiting.stdout, /waiting: create a new chat/);
  assert.match(waiting.stdout, /semantic rollout fallback/);
  const pendingSourceId = sourceIdFromOutput(waiting.stdout);
  const pendingView = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(pendingSourceId)}&compact=1`);
  assert.equal(pendingView.source.kind, "codex_rollout_pending");
  assert.equal(pendingView.requests.length, 0);

  const started = await runCli(["codex", "desktop", "--viewer-url", viewer.url, "--no-open"], {
    ...baseEnv,
    PEEK_FAKE_CODEX_CREATE_THREAD: "1",
  });
  assert.equal(started.code, 0, started.stderr);
  const stableSourceId = sourceIdFromOutput(started.stdout);
  const sources = await getJson(`${viewer.url}/api/sources`);
  const bound = sources.find((source) => source.id === stableSourceId);
  assert.ok(bound, "the pending source should bind after Desktop creates a thread");
  assert.equal(bound.conversation_id, "thread-desktop-2");
  assert.equal(bound.kind, "codex_rollout_local");
  assert.equal(bound.live_status, "observing");
  const timeline = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(stableSourceId)}&compact=1`);
  assert.equal(timeline.requests.length, 3);
  assert.equal(timeline.source.id, stableSourceId, "binding must not replace the dashboard source id");

  const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
  assert.equal(selection.active_observation.thread_id, "thread-desktop-2");
  assert.equal(JSON.stringify(selection).includes("Fixture desktop instructions"), false, "selection stores identifiers, never rollout content");

  const continued = await runCli(["codex", "desktop", "-c", "--viewer-url", viewer.url, "--no-open"], {
    ...baseEnv,
    PEEK_FAKE_CODEX_CREATE_THREAD: "0",
  });
  assert.equal(continued.code, 0, continued.stderr);
  assert.match(continued.stdout, /observing: Desktop fixture 2/);
  assert.equal(JSON.parse(fs.readFileSync(selectionPath, "utf8")).active_observation.thread_id, "thread-desktop-2");

  const resumed = await runCli(["codex", "desktop", "--resume", "thread-existing", "--viewer-url", viewer.url, "--no-open"], {
    ...baseEnv,
    PEEK_FAKE_CODEX_CREATE_THREAD: "0",
  });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(selectionPath, "utf8")).active_observation.thread_id, "thread-existing");

  const proxy = await runCli(["codex", "desktop", "--capture", "proxy", "--no-open"], baseEnv);
  assert.equal(proxy.code, 1);
  assert.match(proxy.stderr, /does not expose a safe process-scoped provider override/);
  const removedNewFlag = await runCli(["codex", "desktop", "--new", "--no-open"], baseEnv);
  assert.equal(removedNewFlag.code, 1);
  assert.match(removedNewFlag.stderr, /Unknown pma codex desktop option: --new/);

  const launches = JSON.parse(fs.readFileSync(launchLogPath, "utf8"));
  assert.ok(launches.length >= 4);
  const launchedWorkspace = fs.realpathSync(workspace);
  assert.deepEqual(launches[0], { args: ["app", launchedWorkspace], cwd: launchedWorkspace });
  const sourceKinds = (await getJson(`${viewer.url}/api/sources`)).map((source) => source.kind);
  assert.equal(sourceKinds.includes("persisted_capture"), false, "rollout observation must not create a copied PMA Trace");

  console.log("run Codex Desktop wrapper smoke passed");
} finally {
  await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: workspace, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 15_000);
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

function sourceIdFromOutput(output) {
  const match = String(output).match(/peekMyAgent Codex trace: (\S+)/);
  assert.ok(match, `missing dashboard URL in output: ${output}`);
  return new URL(match[1]).searchParams.get("source");
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(body)}`);
  return body;
}

function createStateDb(filePath, rolloutPath, cwd) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        model_provider TEXT,
        cwd TEXT,
        title TEXT,
        tokens_used INTEGER,
        archived INTEGER,
        cli_version TEXT,
        first_user_message TEXT,
        model TEXT,
        thread_source TEXT
      );
    `);
    db.prepare("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, tokens_used, archived, cli_version, first_user_message, model, thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("thread-existing", rolloutPath, 100, 100, "desktop", "openai", cwd, "Existing Desktop fixture", 64, 0, "fixture", "existing fixture", "gpt-fixture", "user");
  } finally {
    db.close();
  }
}

function verifyMacosNativeLauncher(cwd) {
  const candidates = codexDesktopLaunchCandidates({ env: {}, platform: "darwin" });
  assert.equal(candidates.length, 1, "macOS must not silently fall back to the Codex CLI installer");
  const calls = [];
  const launched = launchCodexDesktopWorkspace(cwd, {
    env: {},
    platform: "darwin",
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(launched.kind, "macos_launch_services");
  assert.deepEqual(calls, [{ command: "/usr/bin/open", args: ["-b", "com.openai.codex", cwd] }]);
  assert.throws(
    () => launchCodexDesktopWorkspace(cwd, {
      env: {},
      platform: "darwin",
      spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "application not found" }),
    }),
    /run `codex app`/,
  );
}
