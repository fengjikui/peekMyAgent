import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { formatTrackedSnapshot, readTrackedSnapshot, trackedSnapshotChanged } from "./lib/tracked-snapshot.mjs";

const args = process.argv.slice(2);
const profile = optionValue("--profile") || "current";
const listOnly = hasFlag("--list");
const repoRoot = process.cwd();
const MIN_NODE_MAJOR = 24;
const MIN_NODE_VERSION = ">=24.0.0";
const allowTrackedChanges = process.env.PEEKMYAGENT_RELEASE_CHECK_ALLOW_TRACKED_CHANGES === "1";
const coreCommands = [
  ["npm", "run", "smoke:platform"],
  ["npm", "run", "smoke:security-boundary"],
  ["npm", "run", "smoke:viewer-http-contract"],
  ["npm", "run", "smoke:source-list-performance"],
  ["npm", "run", "smoke:source-repository-contract"],
  ["npm", "run", "smoke:imported-source-provider"],
  ["npm", "run", "smoke:file-source-provider"],
  ["npm", "run", "smoke:persisted-source-provider"],
  ["npm", "run", "smoke:live-source-provider"],
  ["npm", "run", "smoke:source-metadata-contract"],
  ["npm", "run", "smoke:source-lifecycle-service"],
  ["npm", "run", "smoke:source-capture-reader"],
  ["npm", "run", "smoke:trace-bundle-service-contract"],
  ["npm", "run", "smoke:message-equivalence-contract"],
  ["npm", "run", "smoke:context-delta-contract"],
  ["npm", "run", "smoke:turn-timeline-contract"],
  ["npm", "run", "smoke:subagent-graph-contract"],
  ["npm", "run", "smoke:translation-materials-contract"],
  ["npm", "run", "smoke:translation-service-contract"],
  ["npm", "run", "smoke:source-meta"],
  ["npm", "run", "smoke:doctor"],
  ["npm", "run", "smoke:source-install"],
  ["npm", "run", "smoke:source-uninstall"],
  ["npm", "run", "smoke:package"],
  ["npm", "run", "smoke:cli"],
  ["npm", "run", "smoke:normalize"],
  ["npm", "run", "smoke:global-install"],
  ["npm", "run", "smoke:maintenance"],
  ["npm", "run", "smoke:dashboard-open"],
  ["npm", "run", "smoke:watch-current"],
  ["npm", "run", "smoke:watch-pause-resume"],
  ["npm", "run", "smoke:claude-settings-env"],
  ["npm", "run", "smoke:run-claude"],
  ["npm", "run", "smoke:daemon-claude"],
  ["npm", "run", "smoke:run-openclaw"],
  ["npm", "run", "smoke:openclaw-profile-cleanup"],
  ["npm", "run", "smoke:agent-send"],
  ["npm", "run", "smoke:trae-cn-stable-route"],
  ["npm", "run", "smoke:audit-data-sources"],
  ["npm", "run", "smoke:release-workflow"],
  ["npm", "run", "smoke:release-check"],
  ["npm", "run", "smoke:governance"],
];
const viewerCommands = [
  ["npm", "run", "smoke:viewer-api-client-contract"],
  ["npm", "run", "smoke:request-detail-cache-contract"],
  ["npm", "run", "smoke:raw-view-model-contract"],
  ["npm", "run", "smoke:raw-search-model-contract"],
  ["npm", "run", "smoke:raw-search-controller-contract"],
  ["npm", "run", "smoke:viewer-static-assets-contract"],
  ["npm", "run", "smoke:response-capture"],
  ["npm", "run", "smoke:large-response-compact"],
  ["npm", "run", "smoke:compact-view-performance"],
  ["npm", "run", "smoke:view-compact-detail"],
  ["npm", "run", "smoke:tool-exchange-delta"],
  ["npm", "run", "smoke:timeline-display"],
  ["npm", "run", "smoke:timeline-window"],
  ["npm", "run", "smoke:turn-rail-contract"],
  ["npm", "run", "smoke:markdown-safety"],
  ["npm", "run", "smoke:claude-internal-turn"],
  ["npm", "run", "smoke:suggestion-mode"],
  ["npm", "run", "smoke:current-entry"],
  ["npm", "run", "smoke:harness-translation"],
  ["npm", "run", "smoke:subagent-otel"],
  ["npm", "run", "smoke:agent-trace-view"],
  ["npm", "run", "smoke:translation-contract"],
  ["npm", "run", "smoke:translation-tolerance"],
  ["npm", "run", "smoke:translation-claude-cli"],
];
const protocolCommands = [
  ["npm", "run", "smoke:provenance-contract"],
  ["npm", "run", "smoke:proxy-openai"],
  ["npm", "run", "smoke:proxy-anthropic"],
  ["npm", "run", "smoke:proxy-attribution"],
];
const persistenceCommands = [
  ["npm", "run", "smoke:persistence-migrations"],
  ["npm", "run", "smoke:persistence-store"],
  ["npm", "run", "smoke:project-source-actions"],
  ["npm", "run", "smoke:request-tree"],
  ["npm", "run", "smoke:shared-proxy-auto-restore"],
];
const otelCommands = [
  ["npm", "run", "smoke:otel-capture"],
  ["npm", "run", "smoke:otel-ingest"],
  ["npm", "run", "smoke:otel-e2e"],
];

const profiles = {
  current: {
    description: "Core cross-platform release gate for the current host.",
    commands: [...coreCommands, ...protocolCommands, ...viewerCommands, ...persistenceCommands, ...otelCommands],
  },
  linux: {
    description: "Linux host release gate. Run this on a real Linux machine or Linux CI runner.",
    requirePlatform: "linux",
    commands: [...coreCommands, ...protocolCommands, ...viewerCommands, ...persistenceCommands, ...otelCommands],
  },
  macos: {
    description: "macOS host release gate. Run this on a real macOS machine or macOS CI runner.",
    requirePlatform: "darwin",
    commands: [...coreCommands, ...protocolCommands, ...viewerCommands, ...persistenceCommands, ...otelCommands],
  },
  windows: {
    description: "Windows host gate. Run this on a real Windows machine.",
    requirePlatform: "win32",
    commands: [...coreCommands, ...protocolCommands, ...viewerCommands, ...persistenceCommands, ...otelCommands],
  },
};

const selected = profiles[profile];
if (!selected) {
  console.error(`Unknown release-check profile: ${profile}`);
  console.error(`Available profiles: ${Object.keys(profiles).join(", ")}`);
  process.exit(1);
}

if (selected.requirePlatform && process.platform !== selected.requirePlatform && !listOnly) {
  console.error(`Profile "${profile}" must be run on ${selected.requirePlatform}; current platform is ${process.platform}.`);
  console.error(`Use --list to print the commands for that machine without running them.`);
  process.exit(1);
}

if (!listOnly && nodeMajorVersion(process.version) < MIN_NODE_MAJOR) {
  console.error(`release-check requires Node.js ${MIN_NODE_VERSION}; current runtime is ${process.version}.`);
  console.error("peekMyAgent uses node:sqlite for its local store. Install Node.js 24 or newer and rerun this command.");
  process.exit(1);
}

if (listOnly) {
  console.log(`release-check profile: ${profile}`);
  console.log(selected.description);
  for (const command of selected.commands) console.log(formatCommand(command));
  process.exit(0);
}

const startedAt = Date.now();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `peek-release-${profile}-`));
const results = [];
let failedExitCode = 0;

try {
  console.log(`release-check profile: ${profile}`);
  console.log(selected.description);
  console.log(`platform: ${process.platform} ${process.arch}, node ${process.version}`);
  console.log(`temp: ${tempRoot}`);
  for (const command of selected.commands) {
    const started = Date.now();
    const commandEnv = await isolatedCommandEnv(command);
    const trackedBefore = readTrackedSnapshot({ cwd: repoRoot, allowTrackedChanges });
    console.log(`\n$ ${formatCommand(command)}`);
    try {
      const result = await run(command, commandEnv);
      const elapsedMs = Date.now() - started;
      const trackedAfter = readTrackedSnapshot({ cwd: repoRoot, allowTrackedChanges });
      const trackedChange = trackedSnapshotChanged(trackedBefore, trackedAfter, { allowTrackedChanges });
      const exitCode = result.code === 0 && trackedChange ? 1 : result.code;
      const summary = { command: formatCommand(command), exit_code: exitCode, elapsed_ms: elapsedMs };
      if (trackedChange) {
        summary.error = "Command changed tracked files.";
        summary.tracked_before = trackedBefore;
        summary.tracked_after = trackedAfter;
        console.error("release-check detected tracked file changes after command.");
        console.error(`Before: ${formatTrackedSnapshot(trackedBefore)}`);
        console.error(`After: ${formatTrackedSnapshot(trackedAfter)}`);
      }
      results.push(summary);
      if (exitCode !== 0) {
        writeSummary({ ok: false });
        failedExitCode = exitCode || 1;
      }
    } finally {
      await shutdownDaemon(commandEnv);
    }
    if (failedExitCode) break;
  }
  if (failedExitCode) {
    process.exitCode = failedExitCode;
  } else {
    writeSummary({ ok: true });
    console.log(`\nrelease-check passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function writeSummary({ ok }) {
  const summary = {
    ok,
    profile,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    elapsed_ms: Date.now() - startedAt,
    results,
  };
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
}

function run(command, env) {
  return new Promise((resolve, reject) => {
    const [program, ...commandArgs] = command;
    const spawnConfig = childProcessSpawnConfig(program, commandArgs, { env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      ...spawnConfig.options,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}

async function isolatedCommandEnv(command) {
  const slug = command.map((part) => part.replace(/[^a-z0-9_-]+/gi, "-")).join("-").replace(/^-+|-+$/g, "").slice(0, 80) || "command";
  const commandRoot = fs.mkdtempSync(path.join(tempRoot, `${slug}-`));
  const homeDir = path.join(commandRoot, "home");
  const localAppDataDir = path.join(commandRoot, "local-app-data");
  const appDataDir = path.join(commandRoot, "app-data");
  const xdgConfigDir = path.join(commandRoot, "xdg-config");
  const npmCacheDir = path.join(commandRoot, "npm-cache");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(localAppDataDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(xdgConfigDir, { recursive: true });
  fs.mkdirSync(npmCacheDir, { recursive: true });
  const [apiPort, capturePort] = await Promise.all([freePort(), freePort()]);
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    LOCALAPPDATA: localAppDataDir,
    APPDATA: appDataDir,
    XDG_CONFIG_HOME: xdgConfigDir,
    PWD: repoRoot,
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    PEEKMYAGENT_RELEASE_CHECK: "1",
    PEEKMYAGENT_STATE_DIR: path.join(commandRoot, "state"),
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
    PEEKMYAGENT_WORKSPACE: repoRoot,
  };
}

async function shutdownDaemon(env) {
  await runQuiet([process.execPath, "bin/peekmyagent.mjs", "shutdown", "--force", "--json"], env);
}

function runQuiet(command, env) {
  return new Promise((resolve) => {
    const [program, ...commandArgs] = command;
    const spawnConfig = childProcessSpawnConfig(program, commandArgs, { env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: repoRoot,
      env,
      stdio: "ignore",
      ...spawnConfig.options,
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      if (!port) {
        server.close(() => reject(new Error("Unable to allocate a free local port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function formatCommand(command) {
  return command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function hasFlag(name) {
  return args.includes(name);
}

function nodeMajorVersion(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}
