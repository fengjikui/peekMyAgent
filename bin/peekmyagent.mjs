#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { DEFAULT_OPENCLAW_PROFILE, patchOpenClawProviderBaseUrl, prepareOpenClawProfilePatch } from "../src/adapters/openclaw-config.mjs";
import { buildOpenCodeProxyEnv, inspectOpenCodeConfiguration } from "../src/adapters/opencode-config.mjs";
import { normalizeClaudeOtelRequestFile } from "../src/adapters/claude-otel.mjs";
import { CodexDesktopDiscovery } from "../src/adapters/codex-desktop-discovery.mjs";
import {
  createCodexObservationId,
  launchCodexDesktopWorkspace,
  resolveCodexDesktopCaptureMode,
} from "../src/adapters/codex-desktop-session.mjs";
import {
  codexDesktopRunningProcesses,
  inspectCodexDesktopInstallation,
  managedCodexDesktopLaunchSpec,
  normalCodexDesktopLaunchSpec,
  requestCodexDesktopQuit,
  waitForCodexDesktopExit,
} from "../src/adapters/codex-desktop-installation.mjs";
import { startManagedCodexDesktopInfrastructure } from "../src/adapters/codex-desktop-managed-session.mjs";
import { CODEX_CHATGPT_ORIGIN, codexHttpProviderOverrides } from "../src/adapters/codex-exact-proxy.mjs";
import { disableTraeCn, enableTraeCn, inspectTraeCn, syncTraeCn } from "../src/adapters/trae-cn-integration.mjs";
import { claudeCodeProjectDir, claudeCodeProxySettingsArgs, claudeCodeUserDir, inspectClaudeCodeSettings, mergeClaudeCodeProcessEnv, resolveClaudeCodeTargetBaseUrl } from "../src/core/claude-code-settings.mjs";
import { defaultStateDir, defaultStorePath, ideRegistryPath as defaultIdeRegistryPath, viewerRegistryPath as resolveViewerRegistryPath } from "../src/core/app-paths.mjs";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
import { otelTelemetryEnv } from "../src/core/otel-capture.mjs";
import { backgroundProcessSpawnOptions, childProcessSpawnConfig, launchBrowserUrl, safeProcessCwd, shellInlineEnv, shellQuote, userHome, workspaceFromEnv } from "../src/core/platform.mjs";
import { canConnect, listeningPidsForUrl, processHasAncestor, terminatePids } from "../src/core/process-tools.mjs";
import { clearViewerRegistry, readViewerRegistry, viewerRegistryPath } from "../src/core/viewer-registry.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args[0];
let rest = args.slice(1);
const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DEFAULT_DAEMON_API_PORT = 43110;
const DEFAULT_DAEMON_CAPTURE_PORT = 43111;
const MIN_NODE_MAJOR = 24;
const MIN_NODE_VERSION = ">=24.0.0";

function usage(exitCode = 0) {
  const showAll = args.includes("--all") || args.includes("--advanced");
  const text = showAll
    ? `pma advanced help (alias: peekmyagent)

Usage:
  pma [--reuse|--ask] [--open] claude [claude args...]
  pma [--reuse] [--open] opencode [opencode args...]
  pma [--reuse] [--open] openclaw [openclaw args...]
  pma normalize openclaw-capture <capture.json> [--out <file>]
  pma normalize claude-otel <request.json> [--out <file>] [--delete-raw-after-import]
  pma daemon [--host <host>] [--api-port <port>] [--capture-port <port>] [--open]
  pma open [--source <id>] [--print] [--no-open]
  pma codex [peekMyAgent options] [codex args...]
  pma codex desktop [--capture auto|exact|rollout] [--restart] [--print] [--no-open]
  pma codex desktop [-c|--continue] [--resume <thread-id>] [--capture exact|rollout] [--print] [--no-open]
  pma codex desktop [--select|--thread <id>|--list]
  pma codex capture [--viewer-url <url>] [--no-open] -- [codex args...]  # compatibility alias
  pma doctor [--json]
  pma compact [--watch <watch-id>] [--limit <n>] [--no-vacuum] [--json]
  pma clear --all-sessions [--json]
  pma uninstall [--scope user|project|all] [--keep-data|--remove-data] [--keep-cli] [--prefix <npm-prefix>] [--json]
  pma shutdown [--viewer-url <url>] [--force] [--json]
  pma restart [--print] [--no-open] [--force] [--json]
  pma enable trae-cn [--json]
  pma disable trae-cn [--json]
  pma sync trae-cn [--json]
  pma status trae-cn [--json]
  pma dev view [--demo openclaw-subagent|openclaw-multiturn|claude-subagent|claude-proxy-resume] [--evidence <dir>] [--port <port>] [--open]
  pma run claude [--watch ask|reuse|new] [peekMyAgent options] -- [claude args...]
  pma run opencode [--watch reuse|new] [peekMyAgent options] -- [opencode args...]
  pma run openclaw [--watch reuse|new] [peekMyAgent options] -- [openclaw args...]
  pma watch-current [--agent claude-code|openclaw] [--mode next_request|single_session|privacy_guard] [--viewer-url <url>] [--json] [--open] [--pause] [--resume] [--stop] [--clear] [--session-key <key>] [--patch-openclaw] [--openclaw-profile <name>] [--provider <id>] [--model <id>] [--target-base-url <url>] [--refresh-profile]
  pma install-claude-skill [--scope user|project] [--commands] [--dest <claude-dir>] [--json]
  pma install-openclaw-skill [--agent <id>] [--global] [--force] [--json]

Notes:
  - The shortest daily path is to prefix the original Agent command: "pma claude -c", "pma opencode", or "pma openclaw chat".
  - Claude Code capture defaults to auto: proxy capture when a configurable upstream base URL exists, otherwise OTel raw-body capture for subscription/OAuth sessions. Use --capture proxy|otel, --proxy, or --otel to force a mode.
  - Codex capture defaults to exact selected-thread routing. "pma codex desktop" keeps the native Desktop UI, routes only the first new thread in the current workspace through Capture Proxy, and asks before a graceful restart when Desktop is already running. Use --capture rollout for no-restart semantic observation.
  - openclaw-capture expects one proxy capture record with method/path/headers/body.
  - claude-otel expects one Claude Code OTel .request.json file.
  - output is normalized JSON and does not print raw secrets beyond adapter redaction.
  - run is the advanced compatibility path. Starting an Agent through peekMyAgent is the user's explicit consent to capture that process. For Claude --continue/--resume, peekMyAgent asks where to write capture by default when a matching watch exists; use --reuse to reuse automatically or choose option 2 to start a separate recording.
  - daemon starts the stable local API/dashboard plus fixed capture proxy. open opens that shared dashboard and starts the daemon if needed. shutdown stops it, and restart reloads it on the fixed ports.
  - doctor explains current paths, daemon status, installed helpers, and common cross-platform configuration issues. clear --all-sessions removes captured session storage after stopping the daemon. uninstall removes the CLI, peekMyAgent helpers, and optionally local data, but does not modify Agent provider configs unless a future restore adapter explicitly owns them.
  - compact stops the daemon, removes duplicated raw request bodies that can be rebuilt from content blocks, and VACUUMs the SQLite store unless --no-vacuum is set.
  - enable/disable/sync/status trae-cn manages Trae CN's selected custom OpenAI-compatible model URL through a reversible stable proxy route.
  - dev view starts a foreground viewer for development only. Demo/evidence sources load only when --demo or --evidence is provided. Use Ctrl-C to stop it.
  - watch-current is intended to run inside an Agent shell/tool call. It reads current session env and registers, reuses, pauses, resumes, stops, or clears a live watch with a running dashboard. Pause keeps forwarding requests but stops saving captures until resume. For OpenClaw, --patch-openclaw only modifies an isolated profile, never the original profile.
  - install-claude-skill copies the peekMyAgent control skill into Claude Code's skill directory. Use --commands to also install /peekmyagent slash-command templates.
  - install-openclaw-skill installs the local OpenClaw peek-watch skill through "openclaw skills install".
`
    : `pma (alias: peekmyagent)

Usage:
  pma open
  pma codex
  pma claude -c
  pma claude -c --dangerously-skip-permissions
  pma claude -r <session-id>
  pma opencode
  pma openclaw chat
  pma doctor

Common:
  pma open                         Open the local dashboard.
  pma codex                        Start Codex CLI with exact proxy capture.
  pma codex resume --last          Resume the latest Codex CLI session with exact capture.
  pma codex exec "Inspect this repository"
                                   Run one Codex task with exact capture.
  pma codex desktop                Open Codex Desktop with managed exact capture (restart confirmation when needed).
  pma codex desktop --capture rollout
                                   Observe the next Desktop session semantically without restarting.
  pma codex desktop -c             Observe this folder's latest Desktop session.
  pma codex desktop --select       Choose a Desktop session for read-only observation.
  pma codex desktop --select --capture exact
                                   Restart once and exactly capture the selected thread on cold resume.
  pma claude -c                    Start Claude Code and capture this session.
  pma claude -c --dangerously-skip-permissions
                                   Start Claude Code without permission prompts in a trusted repo.
  pma opencode                     Start OpenCode with exact process-local proxy capture.
  pma opencode --continue          Continue OpenCode while capturing only this process.
  pma openclaw chat                Start OpenClaw and capture this session.
  pma doctor                       Check install, paths, daemon, and integrations.
  pma install-claude-skill --commands
                                   Install /peekmyagent slash commands for Claude Code.

Maintenance:
  pma restart                      Restart the local dashboard daemon.
  pma shutdown                     Stop the local dashboard daemon.
  pma compact                      Shrink stored traces without deleting sessions.
  pma clear --all-sessions         Remove captured sessions after stopping the daemon.
  pma uninstall --keep-data        Uninstall pma/peekmyagent but keep captured data.
  pma uninstall --remove-data      Uninstall pma/peekmyagent and peekMyAgent-owned local data.

Notes:
  - Daily use is usually: "pma open", then "pma claude -c" in your project.
  - The full command name "peekmyagent" still works exactly like "pma".
  - Advanced/debug commands are hidden from this quick help. Run "pma help --all" to show them.
`;
  (exitCode ? console.error : console.log)(text);
  process.exit(exitCode);
}

function optionValue(name) {
  return optionValueIn(rest, name);
}

function hasFlag(name) {
  return rest.includes(name);
}

function writeOutput(value) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  const outPath = optionValue("--out");
  if (outPath) fs.writeFileSync(outPath, output);
  else process.stdout.write(output);
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function installClaudeSkill() {
  const scope = optionValue("--scope") || "user";
  if (!["user", "project"].includes(scope)) throw new Error(`Invalid --scope: ${scope}`);
  const claudeDir = optionValue("--dest") || (scope === "project" ? claudeCodeProjectDir(safeProcessCwd()) : claudeCodeUserDir());
  const sourceSkill = path.join(repoRoot, "integrations/claude-code/skills/peekmyagent-control/SKILL.md");
  const targetSkillDir = path.join(claudeDir, "skills", "peekmyagent-control");
  const targetSkill = path.join(targetSkillDir, "SKILL.md");
  fs.rmSync(path.join(claudeDir, "skills", "peek-watch"), { recursive: true, force: true });
  fs.mkdirSync(targetSkillDir, { recursive: true });
  fs.copyFileSync(sourceSkill, targetSkill);

  const commandPaths = [];
  if (hasFlag("--commands")) {
    const sourceCommandDir = path.join(repoRoot, "integrations/claude-code/commands");
    const targetCommandDir = path.join(claudeDir, "commands");
    fs.mkdirSync(targetCommandDir, { recursive: true });
    fs.rmSync(path.join(targetCommandDir, "peek-watch.md"), { force: true });
    for (const fileName of claudeCommandFileNames(sourceCommandDir)) {
      const sourceCommand = path.join(sourceCommandDir, fileName);
      const targetCommand = path.join(targetCommandDir, fileName);
      fs.copyFileSync(sourceCommand, targetCommand);
      commandPaths.push(targetCommand);
    }
  }

  return {
    scope,
    claude_dir: claudeDir,
    skill_path: targetSkill,
    command_path: commandPaths[0] || null,
    command_paths: commandPaths,
    removed_legacy: ["commands/peek-watch.md", "skills/peek-watch"],
  };
}

function claudeCommandFileNames(sourceCommandDir) {
  const preferred = [
    "peekmyagent.md",
    "peekmyagent-status.md",
    "peekmyagent-pause.md",
    "peekmyagent-resume.md",
    "peekmyagent-stop.md",
    "peekmyagent-clear.md",
  ];
  const available = new Set(fs.readdirSync(sourceCommandDir).filter((file) => file.endsWith(".md")));
  return [...preferred.filter((file) => available.delete(file)), ...[...available].sort()];
}

function installOpenClawSkill() {
  const skillDir = path.join(repoRoot, "integrations/openclaw/skills/peek-watch");
  const slug = "peek-watch";
  const installArgs = ["skills", "install", skillDir, "--as", slug];
  const agent = optionValue("--agent");
  if (agent) installArgs.push("--agent", agent);
  if (hasFlag("--global")) installArgs.push("--global");
  if (hasFlag("--force")) installArgs.push("--force");
  const spawnConfig = childProcessSpawnConfig("openclaw", installArgs);
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd: safeProcessCwd(),
    encoding: "utf8",
    ...spawnConfig.options,
  });
  if (result.status !== 0) throw new Error(`openclaw ${installArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  return {
    slug,
    skill_dir: skillDir,
    agent: agent || null,
    global: hasFlag("--global"),
    stdout: result.stdout.trim(),
  };
}

function parseAgentShortcut(values) {
  const wrapperArgs = [];
  let watchPolicy = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isAgentName(value)) {
      if (watchPolicy) wrapperArgs.push("--watch", watchPolicy);
      return {
        agent: normalizeShortcutAgent(value),
        runRest: [normalizeShortcutAgent(value), ...wrapperArgs, "--", ...values.slice(index + 1)],
      };
    }
    if (value === "--new") throw new Error("The --new shortcut was removed. Plain Agent starts already create new recordings; for continue/resume choose option 2, or use advanced --watch new.");
    if (value === "--reuse" || value === "--ask") {
      watchPolicy = mergeWatchPolicy(watchPolicy, value.slice(2));
      continue;
    }
    if (value === "--open") {
      wrapperArgs.push("--open-viewer");
      continue;
    }
    if (value === "--watch") {
      const policy = values[index + 1];
      if (!policy || isFlagLike(policy)) throw new Error("--watch requires a value.");
      watchPolicy = mergeWatchPolicy(watchPolicy, policy);
      index += 1;
      continue;
    }
    if (isOptionAssignment(value, "--watch")) {
      watchPolicy = mergeWatchPolicy(watchPolicy, optionValueIn([value], "--watch"));
      continue;
    }
    if (isShortcutWrapperValueOption(value)) {
      const next = values[index + 1];
      if (!next || isFlagLike(next)) throw new Error(`${value} requires a value.`);
      wrapperArgs.push(value, next);
      index += 1;
      continue;
    }
    const assignmentOption = shortcutWrapperAssignmentOption(value);
    if (assignmentOption) {
      wrapperArgs.push(assignmentOption, optionValueIn([value], assignmentOption));
      continue;
    }
    if (isShortcutWrapperFlag(value)) {
      wrapperArgs.push(value);
      continue;
    }
    return null;
  }
  return null;

  function mergeWatchPolicy(current, next) {
    if (current && current !== next) throw new Error(`Conflicting watch policies: ${current} and ${next}`);
    return next;
  }
}

function isAgentName(value) {
  return /^(claude|claude-code|opencode|openclaw)$/i.test(value || "");
}

function normalizeShortcutAgent(value) {
  if (/^claude(?:-code)?$/i.test(value)) return "claude";
  if (/^opencode$/i.test(value)) return "opencode";
  return "openclaw";
}

function isShortcutWrapperValueOption(value) {
  return ["--viewer-url", "--mode", "--openclaw-profile", "--provider", "--model", "--target-base-url", "--capture"].includes(value);
}

function shortcutWrapperAssignmentOption(value) {
  return ["--viewer-url", "--mode", "--openclaw-profile", "--provider", "--model", "--target-base-url", "--capture"].find((option) => isOptionAssignment(value, option)) || null;
}

function isShortcutWrapperFlag(value) {
  return ["--open-viewer", "--refresh-profile", "--otel", "--proxy"].includes(value);
}

try {
  if (!command || command === "--help" || command === "-h" || command === "help") usage(0);
  const shortcut = parseAgentShortcut(args);
  if (shortcut) {
    rest = shortcut.runRest;
    const result = await runAgent();
    process.exitCode = result.exit_code;
  } else if (command === "run") {
    const result = await runAgent();
    process.exitCode = result.exit_code;
  } else if (command === "daemon") {
    await startForegroundDaemon();
  } else if (command === "open" || command === "dashboard") {
    await openDashboard();
  } else if (command === "codex") {
    await openCodexDashboard();
  } else if (command === "doctor") {
    const result = await runDoctor();
    printDoctor(result);
  } else if (command === "compact") {
    const result = await compactStore();
    printMaintenanceResult(result);
  } else if (command === "clear") {
    const result = await clearSessions();
    printMaintenanceResult(result);
  } else if (command === "uninstall") {
    const result = await uninstallPeekMyAgent();
    printMaintenanceResult(result);
  } else if (command === "shutdown") {
    const result = await shutdownDashboard();
    printDaemonControlResult(result);
  } else if (command === "restart") {
    const result = await restartDashboard();
    printDaemonControlResult(result);
  } else if (command === "view") {
    // Hidden compatibility alias for older scripts; user-facing docs and help prefer `open`.
    if (hasLegacyViewOptions(rest)) await startForegroundDevViewer();
    else await openDashboard();
  } else if (["enable", "disable", "sync", "status"].includes(command)) {
    await manageIntegration(command);
  } else if (command === "dev") {
    const [subcommand, ...devRest] = rest;
    rest = devRest;
    if (subcommand === "view") await startForegroundDevViewer();
    else usage(1);
  } else if (command === "watch-current") {
    const result = hasFlag("--pause")
      ? await controlCurrentWatch({ status: "paused" })
      : hasFlag("--resume")
        ? await controlCurrentWatch({ status: "watching" })
        : hasFlag("--stop") || hasFlag("--clear")
          ? await stopCurrentWatch({ clear: hasFlag("--clear") })
          : await watchCurrent();
    if (hasFlag("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.action === "stop") {
      console.log(`peekMyAgent watch ${result.status}: ${result.watch_id}`);
      console.log(`dashboard: ${result.viewer_url}`);
      console.log(`conversation: ${result.conversation_id || "not detected"}`);
      if (result.request_count != null) console.log(`captured requests: ${result.request_count}`);
    } else if (result.action === "pause" || result.action === "resume") {
      console.log(`peekMyAgent watch ${result.action === "pause" ? "paused" : "resumed"}: ${result.watch_id}`);
      console.log(`dashboard: ${result.viewer_url}?source=${encodeURIComponent(result.id)}`);
      console.log(`conversation: ${result.conversation_id || "not detected"}`);
      console.log(`captured requests: ${result.request_count}`);
      if (result.skipped_while_paused) console.log(`skipped while paused: ${result.skipped_while_paused}`);
    } else {
      console.log(`peekMyAgent watch ${result.reused ? "reused" : "registered"}: ${result.watch_id}`);
      console.log(`dashboard: ${result.viewer_url}?source=${encodeURIComponent(result.id)}`);
      console.log(`agent: ${result.agent}`);
      console.log(`workspace: ${result.workspace}`);
      console.log(`conversation: ${result.conversation_id || "not detected"}`);
      console.log(`proxy base URL: ${result.base_url}`);
      if (result.resume_command) {
        console.log("exact capture for this Claude session:");
        console.log(result.resume_command);
      }
      if (result.openclaw_command_hint) {
        console.log("run OpenClaw through the isolated peekMyAgent profile:");
        console.log(result.openclaw_command_hint);
      }
      console.log(result.note);
    }
    if (hasFlag("--open") && result.id) {
      launchBrowserUrl(`${result.viewer_url}?source=${encodeURIComponent(result.id)}`);
    }
  } else if (command === "install-claude-skill") {
    const result = installClaudeSkill();
    if (hasFlag("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`Installed Claude Code skill: ${result.skill_path}`);
      for (const commandPath of result.command_paths || []) console.log(`Installed slash command: ${commandPath}`);
      console.log(`scope: ${result.scope}`);
    }
  } else if (command === "install-openclaw-skill") {
    const result = installOpenClawSkill();
    if (hasFlag("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`Installed OpenClaw skill: ${result.skill_dir}`);
      console.log(`as: ${result.slug}`);
      if (result.agent) console.log(`agent: ${result.agent}`);
      if (result.global) console.log("scope: global");
    }
  } else if (command === "normalize") {
    const [adapter, file, ...normalizeRest] = rest;
    rest = normalizeRest;
    if (!adapter || !file) usage(1);

    if (adapter === "openclaw-capture") {
      writeOutput(normalizeOpenClawProxyCapture(readJson(file)));
    } else if (adapter === "claude-otel") {
      writeOutput(normalizeClaudeOtelRequestFile(file, { deleteRaw: hasFlag("--delete-raw-after-import") }));
    } else {
      usage(1);
    }
  } else {
    usage(1);
  }
} catch (error) {
  console.error(`peekmyagent error: ${error.message}`);
  process.exitCode = 1;
}

async function runDoctor() {
  const cwd = safeProcessCwd();
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  const macosPrivacy = inspectMacosPrivacyLocation(cwd);
  const daemonUrl = defaultDaemonUrl();
  const registry = readViewerRegistry();
  const daemonReachable = await canReachDaemon(daemonUrl);
  const apiPortOpen = await canConnect(defaultDaemonHost(), defaultDaemonApiPort());
  const capturePortOpen = await canConnect(defaultDaemonHost(), defaultDaemonCapturePort());
  const apiPortOwner = apiPortOpen ? listeningPidsForUrl(daemonUrl) : null;
  const captureUrl = registry?.capture_url || `http://${defaultDaemonHost()}:${defaultDaemonCapturePort()}`;
  const capturePortOwner = capturePortOpen ? listeningPidsForUrl(captureUrl) : null;
  const stateDir = defaultStateDir();
  const storePath = defaultStorePath();
  const registryPath = resolveViewerRegistryPath();
  const ideRegistryPath = defaultIdeRegistryPath();
  const translationsRoot = path.join(stateDir, "translations");
  const claudeSettings = inspectClaudeCodeSettings({ cwd, env: process.env });
  const claudeTargetBaseUrl = resolveClaudeCodeTargetBaseUrl({ cwd, env: process.env });
  const claudeDefaultCapture = claudeDefaultCaptureMode(claudeTargetBaseUrl);
  const stateSummary = inspectStateDir(stateDir, {
    storePath,
    registryPath,
    ideRegistryPath,
    translationsRoot,
  });
  const claudeInstall = inspectClaudeSkillInstall({ cwd });
  const storeSummary = inspectStore(storePath);
  const cliCommand = commandAvailable("peekmyagent", ["--help"]);
  const nodeOk = nodeMajorVersion(process.version) >= MIN_NODE_MAJOR;
  const checks = [
    {
      id: "node-version",
      status: nodeOk ? "ok" : "error",
      message: nodeOk ? `Node ${process.version} satisfies ${MIN_NODE_VERSION}` : `Node ${process.version} does not satisfy ${MIN_NODE_VERSION}`,
      next_action: nodeOk ? null : "Install Node.js 24 or newer. peekMyAgent uses the built-in node:sqlite runtime.",
    },
    {
      id: "cli-command",
      status: cliCommand.available ? "ok" : "info",
      message: cliCommand.available ? "peekmyagent command is available on PATH" : "peekmyagent command is not available on PATH",
      next_action: cliCommand.available ? null : "Run node scripts/install.mjs, npm link, or use node /path/to/peekMyAgent/bin/peekmyagent.mjs.",
    },
    {
      id: "daemon",
      status: daemonReachable ? "ok" : apiPortOpen ? "warn" : "info",
      message: daemonReachable ? "daemon reachable" : apiPortOpen ? portOwnerMessage("daemon API port is occupied", apiPortOwner) : "daemon is not running",
      next_action: daemonReachable ? null : apiPortOpen ? "Stop the process on that port, or set PEEKMYAGENT_DAEMON_PORT to another free port." : "Run peekmyagent open to start the local dashboard.",
    },
    {
      id: "capture-port",
      status: daemonReachable || !capturePortOpen ? "ok" : "warn",
      message: daemonReachable && capturePortOpen ? "capture port is open for peekMyAgent daemon" : capturePortOpen ? portOwnerMessage("capture port is occupied", capturePortOwner) : "capture port is free",
      next_action: daemonReachable || !capturePortOpen ? null : "Stop the process on that port, or set PEEKMYAGENT_CAPTURE_PORT to another free port.",
    },
    ...(macosPrivacy.protected_location
      ? [
          {
            id: "macos-privacy-location",
            status: "info",
            message: `workspace is under macOS privacy-protected ${macosPrivacy.name}`,
            next_action:
              "If shell commands later report 'Operation not permitted' in this workspace, grant Full Disk Access to your terminal app, Node.js, and Claude Code, or move projects outside Desktop/Documents/Downloads.",
          },
        ]
      : []),
    {
      id: "claude-settings",
      status: claudeSettings.some((item) => item.exists && !item.valid_json) ? "warn" : "ok",
      message: claudeSettings.some((item) => item.exists) ? "Claude Code settings discovered" : "no Claude Code settings files found",
      next_action: claudeSettings.some((item) => item.exists && !item.valid_json) ? "Fix or remove the invalid Claude Code settings JSON file listed below." : null,
    },
    {
      id: "claude-commands",
      status: claudeInstall.user.skill_installed && claudeInstall.user.commands_installed ? "ok" : "info",
      message: claudeInstall.user.skill_installed && claudeInstall.user.commands_installed ? "Claude Code slash commands are installed for this user" : "Claude Code slash commands are not installed for this user",
      next_action: claudeInstall.user.skill_installed && claudeInstall.user.commands_installed ? null : "Run peekmyagent install-claude-skill --commands if you want /peekmyagent commands inside Claude Code.",
    },
    {
      id: "store",
      status: storeSummary.error ? "warn" : "ok",
      message: storeSummary.error ? `Could not inspect store: ${storeSummary.error}` : `${storeSummary.source_count || 0} stored session source(s)`,
      next_action: storeSummary.error ? "Run peekmyagent clear --all-sessions only if you are comfortable deleting local captured sessions." : null,
    },
  ];
  return {
    ok: !checks.some((check) => check.status === "warn" || check.status === "error"),
    generated_at: new Date().toISOString(),
    package: {
      name: packageJson.name,
      version: packageJson.version,
      private: packageJson.private === true,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      node_requirement: MIN_NODE_VERSION,
      node_ok: nodeOk,
      cwd,
      home: userHome(),
      macos_privacy: macosPrivacy,
    },
    paths: {
      state_dir: stateDir,
      store_path: storePath,
      store_exists: fs.existsSync(storePath),
      viewer_registry_path: registryPath,
      viewer_registry_exists: fs.existsSync(registryPath),
      ide_registry_path: ideRegistryPath,
      ide_registry_exists: fs.existsSync(ideRegistryPath),
      translations_root: translationsRoot,
      translations_root_exists: fs.existsSync(translationsRoot),
      state_exists: stateSummary.exists,
      state_bytes: stateSummary.bytes,
    },
    store: storeSummary,
    data: {
      local_only: true,
      owned_paths: stateSummary.owned_paths,
      cleanup_commands: {
        clear_sessions: "peekmyagent clear --all-sessions",
        uninstall_keep_data: "peekmyagent uninstall --keep-data",
        uninstall_remove_data: "peekmyagent uninstall --remove-data",
      },
      remove_data_note: "uninstall --remove-data removes known peekMyAgent-owned paths and only removes the state directory when it becomes empty.",
    },
    cli: {
      invoked_path: fileURLToPath(import.meta.url),
      command: cliCommand,
    },
    daemon: {
      url: daemonUrl,
      reachable: daemonReachable,
      api_port_open: apiPortOpen,
      api_port_owner: apiPortOwner,
      capture_url: captureUrl,
      capture_port_open: capturePortOpen,
      capture_port_owner: capturePortOwner,
      registry,
    },
    agents: {
      claude_code: {
        command: commandAvailable("claude", ["--version"]),
        target_base_url_source: claudeTargetBaseUrl ? "configured" : "missing",
        default_capture: claudeDefaultCapture,
        settings: claudeSettings,
        install: claudeInstall,
      },
      openclaw: {
        command: commandAvailable("openclaw", ["--version"]),
      },
    },
    checks,
    next_actions: checks.map((check) => check.next_action).filter(Boolean),
  };
}

function inspectMacosPrivacyLocation(cwd, { env = process.env, platform = process.platform } = {}) {
  const result = {
    protected_location: false,
    name: null,
    path: null,
  };
  if (platform !== "darwin") return result;
  const home = userHome({ env, platform });
  if (!home || !cwd) return result;
  const cwdPath = path.resolve(cwd);
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    const protectedPath = path.resolve(path.join(home, name));
    if (isPathWithin(cwdPath, protectedPath)) {
      return {
        protected_location: true,
        name,
        path: protectedPath,
      };
    }
  }
  return result;
}

function isPathWithin(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function portOwnerMessage(prefix, owner) {
  if (!owner) return prefix;
  if (!owner.supported) return `${prefix}; owner lookup unavailable (${owner.error})`;
  if (owner.pids?.length) return `${prefix}; pid(s): ${owner.pids.join(", ")}`;
  return `${prefix}; owner not found by ${owner.method}`;
}

function inspectStateDir(stateDir, { storePath, registryPath, ideRegistryPath, translationsRoot }) {
  const ownedPaths = [
    ...storeRelatedFiles(storePath),
    registryPath,
    ideRegistryPath,
    translationsRoot,
  ].map((filePath) => ({
    path: filePath,
    exists: fs.existsSync(filePath),
    bytes: pathSize(filePath),
  }));
  return {
    exists: fs.existsSync(stateDir),
    bytes: directorySize(stateDir),
    store_related_files: storeRelatedFiles(storePath).filter((filePath) => fs.existsSync(filePath)),
    owned_paths: ownedPaths,
  };
}

function inspectStore(storePath) {
  if (!fs.existsSync(storePath)) return { exists: false, source_count: 0, error: null };
  let store = null;
  try {
    store = openPersistenceStore(storePath);
    const sources = store.listSources();
    const storage = store.storageStats();
    return {
      exists: true,
      source_count: sources.length,
      request_count: sources.reduce((sum, source) => sum + (Number(source.request_count) || 0), 0),
      bytes: fileSize(storePath),
      storage,
      error: null,
    };
  } catch (error) {
    return { exists: true, source_count: null, request_count: null, bytes: fileSize(storePath), error: error.message };
  } finally {
    store?.close?.();
  }
}

function inspectClaudeSkillInstall({ cwd }) {
  return {
    user: inspectClaudeInstallScope(claudeCodeUserDir()),
    project: inspectClaudeInstallScope(claudeCodeProjectDir(cwd)),
  };
}

function inspectClaudeInstallScope(claudeDir) {
  const skillPath = path.join(claudeDir, "skills", "peekmyagent-control", "SKILL.md");
  const commandDir = path.join(claudeDir, "commands");
  const commandFiles = claudeCommandFileNames(path.join(repoRoot, "integrations", "claude-code", "commands"));
  const commands = commandFiles.map((fileName) => {
    const filePath = path.join(commandDir, fileName);
    return { name: fileName.replace(/\.md$/, ""), path: filePath, installed: fs.existsSync(filePath) };
  });
  return {
    claude_dir: claudeDir,
    skill_path: skillPath,
    skill_installed: fs.existsSync(skillPath),
    commands_installed: commands.every((item) => item.installed),
    commands,
    legacy: {
      peek_watch_command: fs.existsSync(path.join(commandDir, "peek-watch.md")),
      peek_watch_skill: fs.existsSync(path.join(claudeDir, "skills", "peek-watch")),
    },
  };
}

function commandAvailable(commandName, commandArgs = ["--version"]) {
  const spawnConfig = childProcessSpawnConfig(commandName, commandArgs);
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd: safeProcessCwd(),
    encoding: "utf8",
    timeout: 3000,
    ...spawnConfig.options,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    available: result.status === 0 || Boolean(output),
    exit_code: Number.isInteger(result.status) ? result.status : null,
    error: result.error?.message || null,
  };
}

function printDoctor(result) {
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`peekMyAgent doctor: ${result.ok ? "ok" : "needs attention"}`);
  console.log(`version: ${result.package.version}`);
  console.log(`platform: ${result.runtime.platform} ${result.runtime.arch}, node ${result.runtime.node} (${result.runtime.node_requirement})`);
  console.log(`cwd: ${result.runtime.cwd}`);
  if (result.runtime.macos_privacy?.protected_location) {
    console.log(`macOS privacy: cwd is under ${result.runtime.macos_privacy.name} (${result.runtime.macos_privacy.path})`);
  }
  console.log(`state: ${result.paths.state_dir}`);
  console.log(`store: ${result.paths.store_path}${result.paths.store_exists ? ` (${result.store.source_count ?? "?"} sessions, ${formatBytes(result.paths.state_bytes)} state)` : " (missing)"}`);
  console.log(`registry: ${result.paths.viewer_registry_path}${result.paths.viewer_registry_exists ? " (exists)" : " (missing)"}`);
  console.log(`ide registry: ${result.paths.ide_registry_path}${result.paths.ide_registry_exists ? " (exists)" : " (missing)"}`);
  console.log(`translations: ${result.paths.translations_root}${result.paths.translations_root_exists ? " (exists)" : " (missing)"}`);
  console.log(`cli: ${result.cli.command.available ? "command found" : "command not found"} (${result.cli.invoked_path})`);
  console.log(`daemon: ${result.daemon.reachable ? "reachable" : result.daemon.api_port_open ? "port occupied" : "not running"} ${result.daemon.url}`);
  if (result.daemon.api_port_owner?.pids?.length) console.log(`daemon port owner: ${result.daemon.api_port_owner.pids.join(", ")} (${result.daemon.api_port_owner.method})`);
  console.log(`capture: ${result.daemon.capture_port_open ? "port open" : "port free"} ${result.daemon.capture_url}`);
  if (result.daemon.capture_port_owner?.pids?.length) console.log(`capture port owner: ${result.daemon.capture_port_owner.pids.join(", ")} (${result.daemon.capture_port_owner.method})`);
  console.log(`claude: ${result.agents.claude_code.command.available ? "command found" : "command not found"}, upstream ${result.agents.claude_code.target_base_url_source}`);
  console.log(`claude capture: auto -> ${result.agents.claude_code.default_capture.mode} (${result.agents.claude_code.default_capture.reason})`);
  console.log(`claude helpers: user ${formatInstallStatus(result.agents.claude_code.install.user)}, project ${formatInstallStatus(result.agents.claude_code.install.project)}`);
  console.log(`openclaw: ${result.agents.openclaw.command.available ? "command found" : "command not found"}`);
  console.log(`data cleanup: ${result.data.cleanup_commands.clear_sessions}; ${result.data.cleanup_commands.uninstall_remove_data}`);
  const existingSettings = result.agents.claude_code.settings.filter((item) => item.exists);
  if (existingSettings.length) {
    console.log("Claude Code settings:");
    for (const item of existingSettings) {
      console.log(`  - ${item.path}: ${item.valid_json ? "valid" : `invalid (${item.error})`} keys=${item.env_keys.join(",") || "none"}`);
    }
  }
  for (const check of result.checks.filter((item) => item.status === "warn" || item.status === "error")) {
    console.log(`${check.status}: ${check.message}`);
  }
  if (result.next_actions.length) {
    console.log("Next actions:");
    for (const action of result.next_actions) console.log(`  - ${action}`);
  }
}

function formatInstallStatus(scope) {
  if (scope.skill_installed && scope.commands_installed) return "installed";
  if (scope.skill_installed || scope.commands.some((item) => item.installed)) return "partial";
  return "not installed";
}

function nodeMajorVersion(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function clearSessions() {
  if (!hasFlag("--all-sessions")) throw new Error("clear currently requires --all-sessions so data removal is explicit.");
  const stopped = await shutdownDashboard().catch((error) => ({ action: "shutdown", status: "error", error: error.message }));
  const storePath = defaultStorePath();
  const deleted = await removeFiles(storeRelatedFiles(storePath));
  return {
    action: "clear",
    scope: "all-sessions",
    stopped,
    store_path: storePath,
    deleted,
    retained_state_dir: defaultStateDir(),
  };
}

async function compactStore() {
  const stopped = await shutdownDashboard().catch((error) => ({ action: "shutdown", status: "error", error: error.message }));
  const storePath = defaultStorePath();
  if (!fs.existsSync(storePath)) {
    return {
      action: "compact",
      stopped,
      store_path: storePath,
      exists: false,
      compacted: 0,
      cleared_raw_body_json_bytes: 0,
      vacuumed: false,
      before: null,
      after: null,
    };
  }
  const watchId = optionValue("--watch") || null;
  const limit = Number(optionValue("--limit")) || 10000;
  const vacuum = !hasFlag("--no-vacuum");
  let store = null;
  try {
    store = openPersistenceStore(storePath);
    const before = { ...store.storageStats(), file_bytes: fileSize(storePath) };
    const compacted = store.compactRawBodies({ watchId, limit });
    if (vacuum && compacted.compacted > 0) store.vacuum();
    const after = { ...store.storageStats(), file_bytes: fileSize(storePath) };
    return {
      action: "compact",
      stopped,
      store_path: storePath,
      exists: true,
      watch_id: watchId,
      vacuumed: vacuum && compacted.compacted > 0,
      before,
      after,
      ...compacted,
    };
  } finally {
    store?.close?.();
  }
}

async function uninstallPeekMyAgent() {
  const scope = optionValue("--scope") || "user";
  if (!["user", "project", "all"].includes(scope)) throw new Error(`Invalid --scope: ${scope}`);
  if (hasFlag("--keep-data") && hasFlag("--remove-data")) throw new Error("Use only one of --keep-data or --remove-data.");
  if (hasFlag("--keep-cli") && hasFlag("--remove-cli")) throw new Error("Use only one of --keep-cli or --remove-cli.");
  const removeData = hasFlag("--remove-data");
  const keepCli = hasFlag("--keep-cli");
  const cwd = safeProcessCwd();
  const stopped = await shutdownDashboard().catch((error) => ({ action: "shutdown", status: "error", error: error.message }));
  const removed = [];
  const scopes = scope === "all" ? ["user", "project"] : [scope];
  for (const item of scopes) {
    const claudeDir = item === "project" ? claudeCodeProjectDir(cwd) : claudeCodeUserDir();
    removed.push(...removeClaudeHelpers(claudeDir, item));
  }
  const stateDir = defaultStateDir();
  const dataRemoved = removeData ? await removePeekMyAgentData(stateDir) : [];
  if (!removeData) clearViewerRegistry();
  const cli = keepCli ? skippedCliRemoval() : removeGlobalCli({ prefix: optionValue("--prefix") });
  if (!cli.ok) throw new Error(`CLI uninstall failed with exit code ${cli.exit_code}: ${cli.stderr || cli.stdout || cli.command}`);
  return {
    action: "uninstall",
    scope,
    stopped,
    removed_helpers: removed,
    data: removeData ? "removed" : "kept",
    removed_data: dataRemoved,
    state_dir: stateDir,
    state_dir_removed: !fs.existsSync(stateDir),
    cli,
    note: "Provider configs are not modified by uninstall. Use adapter-specific restore commands for future global proxy takeover features.",
  };
}

function skippedCliRemoval() {
  return {
    ok: true,
    skipped: true,
    command: null,
    exit_code: null,
    note: "CLI kept because --keep-cli was set.",
  };
}

function removeGlobalCli({ prefix = null } = {}) {
  const args = ["uninstall", "-g", "peekmyagent", ...npmPrefixArgs(prefix)];
  const command = formatCommand("npm", args);
  const spawnConfig = childProcessSpawnConfig("npm", args);
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd: userHome(),
    encoding: "utf8",
    ...spawnConfig.options,
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  return {
    ok: exitCode === 0 && !result.error,
    skipped: false,
    prefix: prefix || null,
    command,
    exit_code: exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null,
  };
}

function npmPrefixArgs(prefix) {
  return prefix ? ["--prefix", prefix] : [];
}

function removeClaudeHelpers(claudeDir, scope) {
  const removed = [];
  const paths = [
    path.join(claudeDir, "skills", "peekmyagent-control"),
    path.join(claudeDir, "skills", "peek-watch"),
    path.join(claudeDir, "commands", "peek-watch.md"),
    ...claudeCommandFileNames(path.join(repoRoot, "integrations", "claude-code", "commands")).map((fileName) => path.join(claudeDir, "commands", fileName)),
  ];
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { recursive: true, force: true });
    removed.push({ scope, path: filePath });
  }
  return removed;
}

async function removePeekMyAgentData(stateDir) {
  const removed = [];
  for (const filePath of [
    ...storeRelatedFiles(defaultStorePath()),
    resolveViewerRegistryPath(),
    defaultIdeRegistryPath(),
  ]) {
    removed.push(...(await removeOwnedFile(filePath)));
  }
  removed.push(...(await removeOwnedStateSubdir(stateDir, "translations")));
  removed.push(...removeEmptyStateDir(stateDir));
  return removed;
}

async function removeOwnedFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.lstatSync(filePath);
  if (stat.isDirectory()) {
    throw new Error(`Refusing to remove directory as file-backed peekMyAgent data: ${filePath}`);
  }
  await rmWithRetry(filePath, { force: true });
  return [{ path: filePath }];
}

async function removeOwnedStateSubdir(stateDir, name) {
  const dirPath = path.join(stateDir, name);
  if (!fs.existsSync(dirPath)) return [];
  assertStateChildPath(dirPath, stateDir, name);
  await rmWithRetry(dirPath, { recursive: true, force: true });
  return [{ path: dirPath }];
}

function assertStateChildPath(childPath, stateDir, expectedName) {
  const root = path.resolve(stateDir || "");
  const target = path.resolve(childPath || "");
  const relative = path.relative(root, target);
  if (!root || !relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(target) !== expectedName) {
    throw new Error(`Refusing to remove path outside peekMyAgent state: ${childPath}`);
  }
}

function removeEmptyStateDir(stateDir) {
  if (!fs.existsSync(stateDir)) return [];
  try {
    if (fs.readdirSync(stateDir).length > 0) return [];
    fs.rmdirSync(stateDir);
    return [{ path: stateDir }];
  } catch {
    return [];
  }
}

async function removeFiles(paths) {
  const deleted = [];
  for (const filePath of paths) {
    const removed = await removeOwnedFile(filePath);
    deleted.push(...removed.map((item) => item.path));
  }
  return deleted;
}

async function rmWithRetry(filePath, options) {
  const attempts = process.platform === "win32" ? 20 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(filePath, options);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRetryableRemoveError(error)) throw error;
      await delay(100);
    }
  }
}

function isRetryableRemoveError(error) {
  return ["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code);
}

function storeRelatedFiles(storePath) {
  return [storePath, `${storePath}-shm`, `${storePath}-wal`];
}

function printMaintenanceResult(result) {
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.action === "clear") {
    console.log(`peekMyAgent cleared all stored sessions: ${result.deleted.length} file(s) removed`);
    console.log(`store: ${result.store_path}`);
    return;
  }
  if (result.action === "compact") {
    if (!result.exists) {
      console.log("peekMyAgent compact skipped: store does not exist");
      console.log(`store: ${result.store_path}`);
      return;
    }
    console.log(`peekMyAgent compact complete: ${result.compacted} request(s) compacted`);
    console.log(`raw body duplicates removed: ${formatBytes(result.cleared_raw_body_json_bytes || 0)}`);
    if (result.vacuumed) console.log(`store file: ${formatBytes(result.before?.file_bytes || 0)} -> ${formatBytes(result.after?.file_bytes || 0)}`);
    else console.log("store vacuum: skipped");
    console.log(`store: ${result.store_path}`);
    return;
  }
  if (result.action === "uninstall") {
    console.log(`peekMyAgent uninstall complete: helpers removed ${result.removed_helpers.length}`);
    console.log(`data: ${result.data} (${result.state_dir})`);
    if (result.cli?.skipped) console.log("cli: kept (--keep-cli)");
    else console.log(`cli: removed (${result.cli?.command || "npm uninstall -g peekmyagent"})`);
    console.log(result.note);
  }
}

function formatCommand(command, commandArgs = []) {
  return [command, ...commandArgs].map((part) => (needsShellQuoting(part) ? shellQuote(part) : String(part))).join(" ");
}

function needsShellQuoting(value) {
  const text = String(value);
  return text.length === 0 || /\s/.test(text);
}

function directorySize(dir, { maxEntries = 20_000 } = {}) {
  let total = 0;
  let visited = 0;
  function walk(current) {
    if (!fs.existsSync(current) || visited >= maxEntries) return;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    visited += 1;
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      total += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) walk(path.join(current, entry));
  }
  walk(dir);
  return total;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function pathSize(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const stat = fs.statSync(filePath);
    return stat.isDirectory() ? directorySize(filePath) : stat.size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function watchCurrent() {
  if (hasFlag("--new")) throw new Error("The --new flag was removed. Current-session registration reuses its active recording; clear it first if a replacement is required.");
  const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || (await ensureDashboard({ open: false })).url;
  if (!viewerUrl) {
    throw new Error(`No running peekMyAgent dashboard found. Run "peekmyagent open" or pass --viewer-url. Registry checked: ${viewerRegistryPath()}`);
  }
  const agent = normalizeAgent(optionValue("--agent") || detectAgent());
  const conversationId = detectConversationId(agent);
  const workspace = workspaceFromEnv();
  const mode = optionValue("--mode") || "single_session";
  const openclawPatch = /openclaw/i.test(agent) && hasFlag("--patch-openclaw") ? prepareOpenClawProfilePatch(openClawPatchOptionsFromArgs(rest)) : null;
  const response = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent,
    mode,
    workspace,
    conversation_id: conversationId,
    started_by: "agent-command",
    reuse: true,
    target_base_url: openclawPatch?.target_base_url,
    provider_id: openclawPatch?.provider_id,
    config_patched: Boolean(openclawPatch),
  }, { headers: { "x-peekmyagent-intent": "watch-start" } });
  if (openclawPatch) patchOpenClawProviderBaseUrl(openclawPatch.profile, openclawPatch.provider_id, response.base_url);
  return {
    ...response,
    viewer_url: trimSlash(viewerUrl),
    workspace,
    conversation_id: conversationId,
    openclaw_profile: openclawPatch?.profile || null,
    openclaw_provider: openclawPatch?.provider_id || null,
    openclaw_command_hint: openclawPatch ? buildOpenClawCommandHint(openclawPatch.profile, conversationId) : null,
    resume_command: buildResumeCommand(agent, response.base_url, conversationId),
    note: buildWatchCurrentNote(agent, conversationId),
  };
}

async function runAgent() {
  const parsed = parseRunArgs(rest);
  if (!parsed.agent || ["--help", "-h"].includes(parsed.agent)) {
    console.log(`Usage:
  peekmyagent run claude [--watch ask|reuse|new] [--viewer-url <url>] [--open-viewer] [--mode <mode>] -- [claude args...]
  peekmyagent run opencode [--watch reuse|new] [--viewer-url <url>] [--open-viewer] [--mode <mode>] [--provider <id>] [--target-base-url <url>] -- [opencode args...]
  peekmyagent run openclaw [--watch reuse|new] [--viewer-url <url>] [--open-viewer] [--mode <mode>] [--session-key <key>] [--openclaw-profile <name>] [--provider <id>] -- [openclaw args...]`);
    return { exit_code: 0 };
  }

  const viewer = await ensureViewerForRun(parsed);
  if (hasFlagIn(parsed.wrapperArgs, "--open-viewer")) {
    launchBrowserUrl(viewer.url);
  }

  if (/^claude(?:-code)?$/i.test(parsed.agent)) return runClaudeAgent(parsed, viewer.url);
  if (/^opencode$/i.test(parsed.agent)) return runOpenCodeAgent(parsed, viewer.url);
  if (/^openclaw$/i.test(parsed.agent)) return runOpenClawAgent(parsed, viewer.url);
  throw new Error(`Unsupported agent for run: ${parsed.agent}`);
}

async function runClaudeAgent(parsed, viewerUrl) {
  const workspace = safeProcessCwd();
  const targetBaseUrl = resolveClaudeCodeTargetBaseUrl({ cwd: workspace, env: process.env });
  const captureMode = resolveClaudeCaptureMode(parsed.wrapperArgs, { targetBaseUrl });
  if (captureMode.mode !== "otel" && !targetBaseUrl) throw new Error("Missing ANTHROPIC_BASE_URL or PEEK_CLAUDE_TARGET_BASE_URL for Claude Code upstream.");
  const conversationId = inferClaudeConversationId(parsed.childArgs);
  const reuseWatchId = await resolveClaudeRunWatchChoice({ parsed, viewerUrl, conversationId });
  if (captureMode.mode === "otel") {
    if (captureMode.explicit) console.error("peekMyAgent capture: OTel raw body (forced)");
    else console.error("peekMyAgent capture: OTel raw body (auto fallback; no Claude Code upstream base URL found)");
    return runClaudeOtelAgent(parsed, viewerUrl, { conversationId, reuseWatchId });
  }
  console.error(captureMode.explicit ? "peekMyAgent capture: proxy (forced)" : "peekMyAgent capture: proxy (auto; Claude Code upstream base URL found)");
  const watch = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent: "Claude Code",
    mode: optionValueIn(parsed.wrapperArgs, "--mode") || "single_session",
    workspace,
    conversation_id: conversationId,
    started_by: "peekmyagent-run",
    reuse: Boolean(reuseWatchId),
    reuse_watch_id: reuseWatchId,
    target_base_url: targetBaseUrl,
  }, { headers: { "x-peekmyagent-intent": "watch-start" } });
  const proxySettings = claudeCodeProxySettingsArgs({ baseUrl: watch.base_url });
  printRunStarted({ viewerUrl, watch, command: "claude", args: parsed.childArgs });
  return runChildWithWatchCleanup({
    command: "claude",
    args: [...parsed.childArgs, ...proxySettings.args],
    env: mergeClaudeCodeProcessEnv({ cwd: workspace, env: process.env, overrides: { ANTHROPIC_BASE_URL: watch.base_url } }),
    viewerUrl,
    watch,
    openclawProfile: null,
    cleanup: proxySettings.cleanup,
  });
}

function resolveClaudeCaptureMode(wrapperArgs, { targetBaseUrl } = {}) {
  const capture = optionValueIn(wrapperArgs, "--capture");
  const hasOtel = hasFlagIn(wrapperArgs, "--otel");
  const hasProxy = hasFlagIn(wrapperArgs, "--proxy");
  const explicit = [capture ? "capture" : null, hasOtel ? "otel" : null, hasProxy ? "proxy" : null].filter(Boolean);
  if (explicit.length > 1) throw new Error("Use only one Claude Code capture selector: --capture, --otel, or --proxy.");
  if (hasOtel) return { mode: "otel", explicit: true };
  if (hasProxy) return { mode: "proxy", explicit: true };
  if (capture) {
    const normalized = String(capture).toLowerCase();
    if (!["auto", "proxy", "otel"].includes(normalized)) throw new Error("Invalid --capture for Claude Code. Expected auto, proxy, or otel.");
    if (normalized !== "auto") return { mode: normalized, explicit: true };
  }
  return { mode: targetBaseUrl ? "proxy" : "otel", explicit: false };
}

function claudeDefaultCaptureMode(targetBaseUrl) {
  return targetBaseUrl
    ? {
        mode: "proxy",
        reason: "Claude Code upstream base URL is configured",
      }
    : {
        mode: "otel",
        reason: "no Claude Code upstream base URL found; use raw-body telemetry fallback",
      };
}

// Subscription/OAuth capture path. Anthropic rejects (403) OAuth requests that
// arrive via a rewriting proxy, so instead of injecting ANTHROPIC_BASE_URL we
// let Claude Code connect directly and dump raw request/response bodies via
// OTEL_LOG_RAW_API_BODIES. The wrapper tails that dir into the daemon, which
// persists the captures like any other source. No proxy, no 403.
async function runClaudeOtelAgent(parsed, viewerUrl, { conversationId, reuseWatchId } = {}) {
  const workspace = safeProcessCwd();
  const watchId = reuseWatchId || `claude-code-otel-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const reused = Boolean(reuseWatchId);
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-otel-"));
  const env = mergeClaudeCodeProcessEnv({
    cwd: workspace,
    env: process.env,
    overrides: otelTelemetryEnv(dumpDir, {
      logsEndpoint: `${trimSlash(viewerUrl)}/api/capture/otel/events`,
      tracesEndpoint: `${trimSlash(viewerUrl)}/api/capture/otel/traces`,
      headers: `x-peekmyagent-intent=otel-event-ingest,x-peekmyagent-watch-id=${watchId}`,
    }),
  });
  const ingestPayload = {
    dir: dumpDir,
    watch_id: watchId,
    agent: "Claude Code",
    workspace,
    conversation_id: conversationId,
    mode: optionValueIn(parsed.wrapperArgs, "--mode") || "single_session",
    event_correlation_enabled: true,
  };
  const ingest = async ({ final = false } = {}) => {
    try {
      return await postJson(
        `${trimSlash(viewerUrl)}/api/capture/otel`,
        { ...ingestPayload, final },
        { headers: { "x-peekmyagent-intent": "otel-ingest" } },
      );
    } catch {
      return null;
    }
  };

  console.error(`peekMyAgent dashboard: ${trimSlash(viewerUrl)}?source=${encodeURIComponent(`stored-${watchId}`)}`);
  console.error(`peekMyAgent watch (OTel raw body, subscription-safe): ${watchId} (${reused ? "reused" : "new"})`);
  console.error(`running: claude ${parsed.childArgs.join(" ")}`);

  const timer = setInterval(() => {
    ingest();
  }, 1500);

  let childResult = null;
  let childError = null;
  try {
    childResult = await runChild("claude", parsed.childArgs, env);
  } catch (error) {
    childError = error;
  }
  clearInterval(timer);
  const flushed = await ingest({ final: true });
  fs.rmSync(dumpDir, { recursive: true, force: true });
  if (flushed) {
    console.error(`peekMyAgent captured ${flushed.total ?? 0} OTel request(s), ${flushed.responses ?? 0} response(s).`);
  }
  if (childError) throw childError;
  return childResult;
}

async function runOpenClawAgent(parsed, viewerUrl) {
  const workspace = safeProcessCwd();
  const openclawPatch = prepareOpenClawProfilePatch(openClawPatchOptionsFromArgs(parsed.wrapperArgs));
  const conversationId = optionValueIn([...parsed.wrapperArgs, ...parsed.childArgs], "--session-key") || null;
  const watchPolicy = normalizeWatchPolicy(optionValueIn(parsed.wrapperArgs, "--watch"), { allowAsk: false });
  const watch = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent: "OpenClaw",
    mode: optionValueIn(parsed.wrapperArgs, "--mode") || "single_session",
    workspace,
    conversation_id: conversationId,
    started_by: "peekmyagent-run",
    reuse: watchPolicy === "reuse",
    target_base_url: openclawPatch.target_base_url,
    provider_id: openclawPatch.provider_id,
    config_patched: true,
  }, { headers: { "x-peekmyagent-intent": "watch-start" } });
  patchOpenClawProviderBaseUrl(openclawPatch.profile, openclawPatch.provider_id, watch.base_url);
  const childArgs = ["--profile", openclawPatch.profile, ...normalizeOpenClawChildArgs(parsed.childArgs)];
  printRunStarted({ viewerUrl, watch, command: "openclaw", args: childArgs });
  return runChildWithWatchCleanup({
    command: "openclaw",
    args: childArgs,
    env: process.env,
    viewerUrl,
    watch,
    openclawProfile: openclawPatch.profile,
  });
}

async function runOpenCodeAgent(parsed, viewerUrl) {
  const workspace = safeProcessCwd();
  const configuration = inspectOpenCodeConfiguration({
    args: parsed.childArgs,
    cwd: workspace,
    env: process.env,
    targetBaseUrl: optionValueIn(parsed.wrapperArgs, "--target-base-url"),
    providerId: optionValueIn(parsed.wrapperArgs, "--provider"),
    model: optionValueIn(parsed.wrapperArgs, "--model"),
  });
  const watchPolicy = normalizeWatchPolicy(optionValueIn(parsed.wrapperArgs, "--watch"), { allowAsk: false });
  const watch = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent: "OpenCode",
    mode: optionValueIn(parsed.wrapperArgs, "--mode") || "single_session",
    workspace,
    conversation_id: configuration.conversation_id,
    started_by: "peekmyagent-run",
    reuse: watchPolicy === "reuse",
    target_base_url: configuration.target_base_url,
    provider_id: configuration.provider_id,
    config_patched: false,
    kind: "opencode_proxy_exact",
    confidence: "exact",
    note: "OpenCode 子进程通过进程级配置覆盖连接本地 Capture Proxy；用户配置文件未修改。",
  }, { headers: { "x-peekmyagent-intent": "watch-start" } });
  const env = buildOpenCodeProxyEnv({
    env: process.env,
    providerId: configuration.provider_id,
    proxyBaseUrl: watch.base_url,
  });
  console.error("peekMyAgent capture: OpenCode exact proxy (process-local; user config unchanged)");
  printRunStarted({ viewerUrl, watch, command: "opencode", args: parsed.childArgs });
  return runChildWithWatchCleanup({
    command: "opencode",
    args: parsed.childArgs,
    env,
    viewerUrl,
    watch,
    openclawProfile: null,
  });
}

function normalizeOpenClawChildArgs(childArgs) {
  const args = childArgs.length ? [...childArgs] : ["chat"];
  const command = args[0];
  if (/^(tui|terminal)$/i.test(command) && !hasFlagIn(args, "--local") && !hasFlagIn(args, "--url")) {
    return [...args, "--local"];
  }
  if (/^agent$/i.test(command) && !hasFlagIn(args, "--local")) {
    return [...args, "--local"];
  }
  return args;
}

function parseRunArgs(values) {
  const [agent, ...runArgs] = values;
  const separatorIndex = runArgs.indexOf("--");
  const wrapperArgs = separatorIndex === -1 ? runArgs : runArgs.slice(0, separatorIndex);
  if (hasFlagIn(wrapperArgs, "--new")) throw new Error("The --new wrapper flag was removed. Use --watch new on the advanced run command.");
  const childArgs = separatorIndex === -1 ? stripRunWrapperArgs(runArgs) : runArgs.slice(separatorIndex + 1);
  return { agent, wrapperArgs, childArgs };
}

function stripRunWrapperArgs(values) {
  const output = [];
  const skipNext = new Set(["--viewer-url", "--mode", "--openclaw-profile", "--provider", "--model", "--target-base-url", "--watch", "--capture"]);
  const skipSingle = new Set(["--open-viewer", "--refresh-profile", "--otel", "--proxy"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (skipSingle.has(value)) continue;
    if ([...skipNext].some((option) => isOptionAssignment(value, option))) continue;
    if (skipNext.has(value)) {
      if (!values[index + 1] || isFlagLike(values[index + 1])) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    output.push(value);
  }
  return output;
}

async function resolveClaudeRunWatchChoice({ parsed, viewerUrl, conversationId }) {
  const explicitPolicy = optionValueIn(parsed.wrapperArgs, "--watch");
  const continuation = Boolean(conversationId || isClaudeContinue(parsed.childArgs));
  const watchPolicy = explicitPolicy ? normalizeWatchPolicy(explicitPolicy, { allowAsk: true }) : continuation ? "ask" : "new";
  if (watchPolicy === "new") return null;
  const shouldConsiderReuse = Boolean(continuation || watchPolicy === "reuse" || explicitPolicy === "ask");
  if (!shouldConsiderReuse) return null;

  const candidates = await findClaudeRunWatchCandidates({ parsed, viewerUrl, conversationId });
  const best = candidates[0] || null;
  if (watchPolicy === "reuse") {
    if (!best) console.error("peekMyAgent: 没有找到可复用的 Claude Code 监听，本次将新建监听。");
    return watchCandidateId(best);
  }

  if (!best) return null;
  if (!isInteractiveStdio()) {
    console.error("peekMyAgent: 检测到 Claude Code continue/resume，但当前不是交互式终端；本次将新建监听。可用 --watch reuse 显式复用。");
    return null;
  }
  return (await askClaudeWatchReuse({ conversationId, candidate: best })) ? watchCandidateId(best) : null;
}

function watchCandidateId(candidate) {
  return candidate?.watch_id || candidate?.id || null;
}

function normalizeWatchPolicy(value, { allowAsk = false } = {}) {
  if (!value) return allowAsk ? "ask" : "new";
  if (["reuse", "new"].includes(value)) return value;
  if (allowAsk && value === "ask") return value;
  throw new Error(`Invalid --watch: ${value}. Expected ${allowAsk ? "ask, " : ""}reuse, or new.`);
}

async function findClaudeRunWatchCandidates({ parsed, viewerUrl, conversationId }) {
  const mode = optionValueIn(parsed.wrapperArgs, "--mode") || "single_session";
  const workspace = safeProcessCwd();
  const data = await fetchJson(`${trimSlash(viewerUrl)}/api/watch/status`);
  return (Array.isArray(data) ? data : [])
    .filter((watch) => watch.agent === "Claude Code")
    .filter((watch) => watch.mode === mode)
    .filter((watch) => watch.workspace === workspace)
    .filter((watch) => (conversationId ? watch.conversation_id === conversationId : true))
    .sort((a, b) => Date.parse(b.last_seen || b.stopped_at || b.created_at || 0) - Date.parse(a.last_seen || a.stopped_at || a.created_at || 0));
}

async function askClaudeWatchReuse({ conversationId, candidate }) {
  const heading = conversationId
    ? `检测到你正在恢复 Claude Code 会话：\n  ${conversationId}`
    : "检测到你使用了 claude --continue。";
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\n${heading}\n\n`);
    process.stderr.write("peekMyAgent 找到了可能对应的历史监听：\n");
    process.stderr.write(`  1. 继续写入已有监听：${formatWatchCandidate(candidate)}\n`);
    process.stderr.write("  2. 新建一个监听\n\n");
    process.stderr.write("你希望这次捕获写到哪里？\n");
    const answer = await rl.question("请选择 [1/2]，默认 1：");
    return !answer.trim() || answer.trim() === "1";
  } finally {
    rl.close();
  }
}

function formatWatchCandidate(candidate) {
  const parts = [];
  parts.push(candidate.conversation_id ? shorten(candidate.conversation_id, 18) : shorten(candidate.watch_id, 18));
  parts.push(`状态 ${candidate.status === "watching" ? "监听中" : "已停止"}`);
  parts.push(`请求数 ${candidate.request_count || 0}`);
  if (candidate.last_seen) parts.push(`上次捕获 ${new Date(candidate.last_seen).toLocaleString()}`);
  return parts.join("，");
}

function isClaudeContinue(childArgs) {
  return hasFlagIn(childArgs, "--continue") || hasFlagIn(childArgs, "-c");
}

function isInteractiveStdio() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function shorten(value, length) {
  const text = String(value || "");
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}

async function ensureViewerForRun(parsed) {
  const explicitUrl = optionValueIn(parsed.wrapperArgs, "--viewer-url");
  if (explicitUrl) return ensureDashboard({ explicitUrl });
  return ensureDashboard({ open: false });
}

async function ensureDashboard({ explicitUrl = null } = {}) {
  if (explicitUrl) {
    await waitForViewer(trimSlash(explicitUrl));
    return { url: trimSlash(explicitUrl) };
  }
  const daemonUrl = defaultDaemonUrl();
  if (await canReachDaemon(daemonUrl)) return { url: daemonUrl };
  const registered = readViewerRegistry();
  if (!hasDaemonEndpointOverride() && registered?.url && registered?.capture_url && (await canReachDaemon(registered.url))) return { url: trimSlash(registered.url) };
  if (await canConnect(defaultDaemonHost(), defaultDaemonApiPort())) {
    const owner = listeningPidsForUrl(defaultDaemonUrl());
    throw new Error(`Port ${defaultDaemonApiPort()} is already in use, but it is not a peekMyAgent daemon. ${portOwnerMessage("Port owner", owner)}. Stop that process or set PEEKMYAGENT_DAEMON_PORT.`);
  }
  if (await canConnect(defaultDaemonHost(), defaultDaemonCapturePort())) {
    const owner = listeningPidsForUrl(`http://${defaultDaemonHost()}:${defaultDaemonCapturePort()}`);
    throw new Error(`Port ${defaultDaemonCapturePort()} is already in use, but the peekMyAgent daemon is not reachable. ${portOwnerMessage("Port owner", owner)}. Stop that process or set PEEKMYAGENT_CAPTURE_PORT.`);
  }

  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "daemon",
    "--host",
    defaultDaemonHost(),
    "--api-port",
    String(defaultDaemonApiPort()),
    "--capture-port",
    String(defaultDaemonCapturePort()),
  ], {
    cwd: safeProcessCwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
    ...backgroundProcessSpawnOptions(),
  });
  child.unref();
  const started = await waitForDaemon(daemonUrl);
  return { url: trimSlash(started.url) };
}

async function openDashboard() {
  const explicitUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const dashboard = await ensureDashboard({ explicitUrl });
  const url = buildDashboardUrl(dashboard.url, optionValue("--source"));
  const shouldOpen = !hasFlag("--no-open") && !hasFlag("--print");
  if (shouldOpen || hasFlag("--open")) {
    launchBrowserUrl(url);
  }
  console.log(`peekMyAgent dashboard: ${url}`);
}

async function openCodexDashboard() {
  if (["--help", "-h"].includes(rest[0])) usage(0);
  if (rest[0] === "desktop") {
    rest = rest.slice(1);
    await openCodexDesktopDashboard();
    return;
  }
  if (rest[0] === "capture") {
    rest = rest.slice(1);
    if (["--help", "-h"].includes(rest[0])) usage(0);
    const result = await runCodexCapture({ directArgs: false, invocationLabel: "compatibility alias" });
    process.exitCode = result.exit_code;
    return;
  }
  assertNoLegacyCodexDesktopSyntax(rest);
  const result = await runCodexCapture({ directArgs: true, invocationLabel: "default" });
  process.exitCode = result.exit_code;
}

async function openCodexDesktopDashboard() {
  if (["--help", "-h"].includes(rest[0])) usage(0);
  assertCodexDesktopOptions(rest);
  const discovery = new CodexDesktopDiscovery();
  if (hasFlag("--clear")) {
    discovery.clearSelection();
    console.log("peekMyAgent Codex observation selection cleared. No Codex history was deleted.");
    return;
  }
  if (hasFlag("--list")) {
    printCodexCandidates(discovery.listCandidates());
    return;
  }

  const historyObservation = codexDesktopHistoryObservationRequested();
  const requestedCapture = optionValue("--capture") || "auto";
  const exactHistoryRequested = historyObservation && ["exact", "proxy"].includes(String(requestedCapture).toLowerCase());
  const capture = historyObservation && !exactHistoryRequested
    ? { mode: "rollout", confidence: "semantic", fallbackReason: null, requested: "rollout" }
    : resolveCodexDesktopCaptureMode(requestedCapture);
  if (capture.mode === "exact") {
    const target = exactHistoryRequested ? await resolveManagedCodexDesktopTarget(discovery) : null;
    const exact = await openManagedCodexDesktopExact({ requestedCapture, target });
    if (exact.handled) return;
    console.error(`peekMyAgent Codex Desktop exact capture unavailable: ${exact.fallbackReason}`);
    console.error("falling back to read-only semantic rollout observation; use `--capture exact` to fail instead");
    await openCodexDesktopRolloutDashboard({
      discovery,
      capture: {
        mode: "rollout",
        confidence: "semantic",
        fallbackReason: exact.fallbackReason,
        requested: "rollout",
      },
    });
    return;
  }
  await openCodexDesktopRolloutDashboard({ discovery, capture });
}

async function resolveManagedCodexDesktopTarget(discovery) {
  const workspace = safeProcessCwd();
  const explicitThreadId = optionValue("--resume") || optionValue("-r") || optionValue("--thread");
  const continueMode = hasFlag("-c") || hasFlag("--continue");
  if (explicitThreadId && continueMode) throw new Error("Use either --continue or --resume <thread-id>, not both.");

  let target;
  if (hasFlag("--select")) {
    const candidates = discovery.listCandidates({ workspace, includeArchived: false, limit: 40 });
    if (!candidates.length) throw new Error(`No readable Codex Desktop sessions were found in the current project: ${workspace}`);
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error("Interactive selection requires a terminal. Run `pma codex desktop --list`, then `pma codex desktop --resume <thread-id> --capture exact`.");
    }
    const threadId = await promptForCodexThread(candidates, { workspace, action: "capture exactly" });
    target = discovery.findCandidate(threadId);
  } else if (explicitThreadId) {
    target = discovery.findCandidate(explicitThreadId);
  } else if (continueMode) {
    target = discovery.listCandidates({ workspace, includeArchived: false, limit: 20 })
      .find((source) => source.available);
  }
  if (!target) throw new Error(`No matching Codex Desktop session was found for exact capture in ${workspace}.`);
  if (!target.available) throw new Error(`Codex session rollout is no longer readable: ${target.conversation_id}`);
  return {
    thread_id: target.conversation_id,
    workspace: target.workspace || workspace,
    title: target.title || target.label || target.conversation_id,
  };
}

async function openCodexDesktopRolloutDashboard({ discovery = new CodexDesktopDiscovery(), capture } = {}) {
  const resolvedCapture = capture || resolveCodexDesktopCaptureMode("rollout");

  const workspace = safeProcessCwd();
  const explicitThreadId = optionValue("--resume") || optionValue("-r") || optionValue("--thread");
  const continueMode = hasFlag("-c") || hasFlag("--continue");
  if (explicitThreadId && continueMode) throw new Error("Use either --continue or --resume <thread-id>, not both.");
  const explicitUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const dashboard = await ensureDashboard({ explicitUrl });
  const previousSelection = discovery.readSelection();

  let selectedSource;
  let launchWorkspace = workspace;
  let launchDesktop = true;
  let waitingForNewSession = false;
  if (hasFlag("--select")) {
    const candidates = discovery.listCandidates({ workspace, includeArchived: false, limit: 40 });
    if (!candidates.length) {
      throw new Error(`No readable Codex Desktop sessions were found in the current project: ${workspace}`);
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error("Interactive selection requires a terminal. Run `pma codex desktop --list`, then `pma codex desktop --resume <thread-id>`. ");
    }
    selectedSource = discovery.selectThread(await promptForCodexThread(candidates, { workspace }));
    launchDesktop = false;
  } else if (explicitThreadId) {
    const target = discovery.findCandidate(explicitThreadId);
    if (!target) throw new Error(`Codex session not found: ${explicitThreadId}`);
    if (!target.available) throw new Error(`Codex session rollout is no longer readable: ${explicitThreadId}`);
    launchWorkspace = target.workspace || workspace;
    selectedSource = beginBoundCodexObservation(discovery, target, {
      workspace: launchWorkspace,
      mode: "resume",
      capture: resolvedCapture,
    });
  } else if (continueMode) {
    const target = discovery.listCandidates({ workspace, includeArchived: false, limit: 20 })
      .find((source) => source.available);
    if (!target) throw new Error(`No resumable Codex Desktop session was found in ${workspace}. Run \`pma codex desktop\` to start observing a new one.`);
    selectedSource = beginBoundCodexObservation(discovery, target, {
      workspace,
      mode: "continue",
      capture: resolvedCapture,
    });
  } else {
    const baselineThreadIds = discovery.listCandidates({ workspace, includeArchived: false, limit: 100 })
      .map((source) => source.conversation_id);
    selectedSource = discovery.beginObservation({
      sourceId: createCodexObservationId(),
      workspace,
      baselineThreadIds,
      mode: "new",
      captureMode: resolvedCapture.mode,
      fallbackReason: resolvedCapture.fallbackReason,
    });
    waitingForNewSession = true;
  }

  const sources = await fetchJson(`${trimSlash(dashboard.url)}/api/sources`);
  const source = (Array.isArray(sources) ? sources : []).find((item) => item.id === selectedSource.id && item.available);
  if (!source) {
    restoreCodexSelection(discovery, previousSelection, selectedSource.id);
    throw new Error("The Codex observation source is not readable. Run `pma codex desktop --list` to inspect available sessions.");
  }
  const url = buildDashboardUrl(dashboard.url, source.id);
  const shouldOpen = !hasFlag("--no-open") && !hasFlag("--print");
  if (shouldOpen || hasFlag("--open")) launchBrowserUrl(url);
  if (launchDesktop) {
    try {
      launchCodexDesktopWorkspace(launchWorkspace);
    } catch (error) {
      restoreCodexSelection(discovery, previousSelection, selectedSource.id);
      throw error;
    }
  }
  console.log(`peekMyAgent Codex trace: ${url}`);
  if (launchDesktop) console.log(`Codex Desktop workspace: ${launchWorkspace}`);
  if (waitingForNewSession) {
    console.log("waiting: create a new chat in this Codex Desktop workspace and send its first message");
  } else {
    console.log(`observing: ${source.title || source.label || source.conversation_id}`);
  }
  if (resolvedCapture.fallbackReason) console.log(`capture: semantic rollout fallback (${resolvedCapture.fallbackReason})`);
  else console.log("capture: semantic rollout observation");
  console.log("storage: the rollout remains in CODEX_HOME and is not copied into peekMyAgent SQLite");
}

function codexDesktopHistoryObservationRequested() {
  return Boolean(
    hasFlag("--select") ||
    hasFlag("-c") ||
    hasFlag("--continue") ||
    optionValue("--resume") ||
    optionValue("-r") ||
    optionValue("--thread"),
  );
}

async function openManagedCodexDesktopExact({ requestedCapture = "auto", target = null } = {}) {
  const explicitlyRequired = ["exact", "proxy"].includes(String(requestedCapture || "").toLowerCase());
  const workspace = target?.workspace || safeProcessCwd();
  const installation = inspectCodexDesktopInstallation();
  if (!installation.supported) {
    if (explicitlyRequired) throw new Error(installation.reason || "Managed Codex Desktop exact capture is unavailable.");
    return { handled: false, fallbackReason: installation.reason || "managed Desktop exact capture is unavailable" };
  }

  const running = codexDesktopRunningProcesses(installation);
  if (!running.supported) {
    if (explicitlyRequired) throw new Error(`Could not inspect the running Codex Desktop process: ${running.error}`);
    return { handled: false, fallbackReason: running.error || "Codex Desktop process inspection is unavailable" };
  }
  if (running.pids.length && processHasAncestor(process.pid, running.pids)) {
    throw new Error(
      "This pma command is running from inside Codex Desktop, so restarting Desktop would terminate its own controller. " +
      "Run the command from an external Terminal, or use `pma codex desktop --capture rollout` without restarting.",
    );
  }

  if (running.pids.length && !hasFlag("--restart")) {
    if (!isInteractiveStdio()) {
      if (explicitlyRequired) {
        throw new Error(
          "Codex Desktop is already running. Exact capture requires a graceful managed restart. " +
          "Run interactively to review the warning, pass `--restart` as explicit consent, or use `--capture rollout`.",
        );
      }
      return { handled: false, fallbackReason: "Codex Desktop is already running and restart consent was not available" };
    }
    const choice = await askCodexDesktopRestartChoice({ workspace, pids: running.pids });
    if (choice === "cancel") {
      console.error("peekMyAgent Codex Desktop capture cancelled; no process or configuration was changed.");
      return { handled: true };
    }
    if (choice === "rollout") {
      return { handled: false, fallbackReason: "User chose no-restart semantic rollout observation" };
    }
  }

  const explicitUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const dashboard = await ensureDashboard({ explicitUrl });
  const watch = await postJson(`${trimSlash(dashboard.url)}/api/watch/start`, {
    agent: "Codex",
    mode: "single_session",
    workspace,
    conversation_id: target?.thread_id || null,
    started_by: "codex-desktop-managed",
    reuse: false,
    target_base_url: CODEX_CHATGPT_ORIGIN,
    kind: "codex_proxy_exact",
    confidence: "exact",
    label: target ? `Codex Desktop · ${target.title}` : "Codex Desktop · selected-thread exact capture",
    note: target
      ? `Managed Codex Desktop App Server capture. Only thread ${target.thread_id} is routed through Capture Proxy; other Desktop threads keep their original provider.`
      : "Managed Codex Desktop App Server capture. Only the first new thread started in the selected workspace is routed through Capture Proxy; other Desktop threads keep their original provider.",
  }, { headers: { "x-peekmyagent-intent": "watch-start" } });

  let infrastructure = null;
  let desktopWasStopped = false;
  let managedDesktopLaunched = false;
  let operationError = null;
  try {
    infrastructure = await startManagedCodexDesktopInfrastructure({
      installation,
      watchBaseUrl: watch.base_url,
      workspace,
      captureThreadId: target?.thread_id || null,
      env: process.env,
    });

    if (running.pids.length) {
      const quit = requestCodexDesktopQuit({ installation });
      if (!quit.ok) throw new Error(`Could not ask Codex Desktop to quit cleanly: ${quit.error}`);
      desktopWasStopped = true;
      const exited = await waitForCodexDesktopExit(installation);
      if (!exited.exited) {
        throw new Error(
          `Codex Desktop did not exit cleanly; no process was force-killed. Remaining PID(s): ${exited.pids.join(", ") || "unknown"}.`,
        );
      }
    }

    const sourceUrl = buildDashboardUrl(dashboard.url, watch.id);
    if (!hasFlag("--no-open") || hasFlag("--open")) launchBrowserUrl(sourceUrl);
    console.error("peekMyAgent Codex Desktop capture: managed exact Responses API");
    console.error(`peekMyAgent dashboard: ${sourceUrl}`);
    console.error(`peekMyAgent watch: ${watch.watch_id} (new)`);
    console.error(`Codex Desktop workspace: ${workspace}`);
    console.error(`Codex Desktop: ${installation.app_version || "unknown"}; embedded ${installation.codex_version || "Codex version unknown"}`);
    console.error("config: process-scoped App Server relay with thread-selective provider injection; CODEX_HOME auth is reused in memory; user config files are unchanged");
    console.error(target
      ? `capture scope: selected thread ${target.thread_id}; open this conversation in Desktop after restart`
      : "capture scope: the first new thread started in this workspace; other Desktop threads keep their original provider");

    const launchSpec = managedCodexDesktopLaunchSpec({
      installation,
      workspace,
      appServerWsUrl: infrastructure.relay_url,
      env: process.env,
    });
    managedDesktopLaunched = true;
    const desktopCompletion = runManagedDesktopChild(launchSpec).then((result) => ({ kind: "desktop", result }));
    const appServerCompletion = infrastructure.app_server_exit.then((result) => ({ kind: "app_server", result }));
    const outcome = await Promise.race([desktopCompletion, appServerCompletion]);
    if (outcome.kind === "app_server") {
      requestCodexDesktopQuit({ installation });
      await waitForCodexDesktopExit(installation, { timeoutMs: 8_000 });
      throw new Error(`Managed Codex App Server stopped while Desktop was running (${managedChildExitLabel(outcome.result)}).`);
    }
    if (infrastructure.capture_route?.rewritten_requests > 0 && infrastructure.capture_route?.selected_thread_id) {
      console.error(`captured Codex thread: ${infrastructure.capture_route.selected_thread_id}`);
    } else {
      console.error(target
        ? "peekMyAgent capture note: the selected thread was not cold-resumed before Codex Desktop exited"
        : "peekMyAgent capture note: no matching new thread was started before Codex Desktop exited");
    }
    process.exitCode = outcome.result.exit_code;
    return { handled: true };
  } catch (error) {
    operationError = error;
    if (desktopWasStopped || managedDesktopLaunched) {
      await restoreNormalCodexDesktopAfterFailure({ installation, workspace });
    }
    throw error;
  } finally {
    let cleanupError = null;
    try {
      await infrastructure?.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await stopRunWatch(dashboard.url, watch, null);
    } catch (error) {
      if (!isMissingWatchCleanupError(error) && !cleanupError) cleanupError = error;
    }
    if (cleanupError) {
      if (operationError) console.error(`peekMyAgent managed Desktop cleanup warning: ${cleanupError.message}`);
      else throw cleanupError;
    }
  }
}

async function askCodexDesktopRestartChoice({ workspace, pids }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write("\nCodex Desktop is already running.\n\n");
    process.stderr.write("Exact capture requires one graceful managed restart so the native Desktop can connect to a PMA-managed App Server.\n");
    process.stderr.write("Running Codex tasks will stop. Existing projects, conversations, login state, and config files are not deleted or rewritten.\n");
    process.stderr.write(`Workspace to reopen: ${workspace}\n`);
    process.stderr.write(`Detected Desktop PID(s): ${pids.join(", ")}\n\n`);
    process.stderr.write("  1. Restart for complete exact capture (recommended)\n");
    process.stderr.write("  2. Do not restart; use semantic rollout observation\n");
    process.stderr.write("  3. Cancel\n\n");
    const answer = (await rl.question("Choose [1/2/3], default 3: ")).trim();
    if (answer === "1") return "exact";
    if (answer === "2") return "rollout";
    return "cancel";
  } finally {
    rl.close();
  }
}

function runManagedDesktopChild({ command, args, env, cwd }) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(command, args, { env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd,
      env,
      stdio: "ignore",
      ...spawnConfig.options,
    });
    const forward = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    if (process.platform !== "win32") process.once("SIGHUP", forward);
    const removeSignalHandlers = () => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      if (process.platform !== "win32") process.off("SIGHUP", forward);
    };
    child.once("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      resolve({ exit_code: code ?? signalExitCode(signal) });
    });
  });
}

async function restoreNormalCodexDesktopAfterFailure({ installation, workspace }) {
  const running = codexDesktopRunningProcesses(installation);
  if (running.supported && running.pids.length) {
    requestCodexDesktopQuit({ installation });
    const exited = await waitForCodexDesktopExit(installation, { timeoutMs: 8_000 });
    if (!exited.exited) {
      console.error(
        `peekMyAgent recovery warning: Codex Desktop is still running (PID(s): ${exited.pids.join(", ") || "unknown"}); ` +
        "a second Desktop instance was not opened. Quit and reopen Codex Desktop manually to remove capture overrides.",
      );
      return false;
    }
  }
  try {
    const spec = normalCodexDesktopLaunchSpec({ installation, workspace, env: process.env });
    const spawnConfig = childProcessSpawnConfig(spec.command, spec.args, { env: spec.env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: "ignore",
      ...spawnConfig.options,
      ...backgroundProcessSpawnOptions(),
    });
    child.unref();
    console.error("peekMyAgent recovery: reopened Codex Desktop normally without capture overrides");
    return true;
  } catch (error) {
    console.error(`peekMyAgent recovery warning: reopen Codex Desktop normally (${error.message})`);
    return false;
  }
}

function managedChildExitLabel(result) {
  if (result?.error) return result.error.message;
  if (result?.signal) return `signal ${result.signal}`;
  return `exit ${result?.code ?? "unknown"}`;
}

function restoreCodexSelection(discovery, previousSelection, sourceId) {
  if (previousSelection && typeof previousSelection === "object") discovery.writeSelection(previousSelection);
  else if (!discovery.cancelObservation(sourceId)) discovery.clearSelection();
}

function beginBoundCodexObservation(discovery, target, { workspace, mode, capture }) {
  const pending = discovery.beginObservation({
    sourceId: createCodexObservationId(),
    workspace,
    baselineThreadIds: [],
    mode,
    captureMode: capture.mode,
    fallbackReason: capture.fallbackReason,
  });
  return discovery.bindObservation(pending.id, target.conversation_id);
}

function assertNoLegacyCodexDesktopSyntax(values) {
  const movedFlags = new Set(["--continue", "--select", "--list", "--clear"]);
  const movedValueOptions = ["--resume", "--thread", "--capture"];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-c" && (!values[index + 1] || isFlagLike(values[index + 1]))) {
      throw new Error(
        "`pma codex -c` now follows the Codex CLI, where -c requires a config value. " +
        "Use `pma codex resume --last` for an exact captured resume, or `pma codex desktop -c` for Desktop rollout observation.",
      );
    }
    if (movedFlags.has(value) || movedValueOptions.some((name) => value === name || isOptionAssignment(value, name))) {
      throw new Error(
        `Desktop rollout option ${value} moved to \`pma codex desktop ...\`. ` +
        "Plain `pma codex` now starts exact proxy capture and forwards Codex CLI arguments.",
      );
    }
  }
}

function assertCodexDesktopOptions(values) {
  const valueOptions = new Set(["--viewer-url", "--capture", "--resume", "-r", "--thread"]);
  const flags = new Set(["--clear", "--list", "--select", "-c", "--continue", "--restart", "--no-open", "--open", "--print", "--json", "--help", "-h"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (flags.has(value)) continue;
    const assigned = [...valueOptions].find((name) => isOptionAssignment(value, name));
    if (assigned) continue;
    if (valueOptions.has(value)) {
      const next = values[index + 1];
      if (!next || isFlagLike(next)) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown pma codex desktop option: ${value}. Run \`pma codex --help\` for supported commands.`);
  }
}

async function runCodexCapture({ directArgs = false, invocationLabel = "explicit opt-in" } = {}) {
  const parsed = parseCodexCaptureArgs(rest, { directArgs });
  const explicitUrl = optionValueIn(parsed.wrapperArgs, "--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const dashboard = await ensureDashboard({ explicitUrl });
  const workspace = safeProcessCwd();
  const watch = await postJson(`${trimSlash(dashboard.url)}/api/watch/start`, {
    agent: "Codex",
    mode: "single_session",
    workspace,
    conversation_id: null,
    started_by: "codex-wrapper",
    reuse: false,
    target_base_url: CODEX_CHATGPT_ORIGIN,
    kind: "codex_proxy_exact",
    confidence: "exact",
    label: "Codex · exact capture",
    note: "Only the Codex process started by this command is captured through the verified first-party route allowlist.",
  }, { headers: { "x-peekmyagent-intent": "watch-start" } });

  const sourceUrl = buildDashboardUrl(dashboard.url, watch.id);
  if (!hasFlagIn(parsed.wrapperArgs, "--no-open") || hasFlagIn(parsed.wrapperArgs, "--open")) {
    launchBrowserUrl(sourceUrl);
  }
  const childArgs = [...codexHttpProviderOverrides(watch.base_url), ...parsed.childArgs];
  console.error(`peekMyAgent Codex capture: exact Responses API (${invocationLabel})`);
  printRunStarted({ viewerUrl: dashboard.url, watch, command: "codex", args: parsed.childArgs });
  console.error("config: one-process HTTP-only provider override; ~/.codex/config.toml is unchanged");
  return runChildWithWatchCleanup({
    command: "codex",
    args: childArgs,
    env: process.env,
    viewerUrl: dashboard.url,
    watch,
    openclawProfile: null,
  });
}

function parseCodexCaptureArgs(values, { directArgs = false } = {}) {
  const separatorIndex = values.indexOf("--");
  if (directArgs && separatorIndex === -1) {
    const wrapperArgs = [];
    const childArgs = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (["--no-open", "--open"].includes(value)) {
        wrapperArgs.push(value);
        continue;
      }
      if (value === "--viewer-url") {
        const next = values[index + 1];
        if (!next || isFlagLike(next)) throw new Error("--viewer-url requires a value.");
        wrapperArgs.push(value, next);
        index += 1;
        continue;
      }
      if (isOptionAssignment(value, "--viewer-url")) {
        wrapperArgs.push("--viewer-url", optionValueIn([value], "--viewer-url"));
        continue;
      }
      childArgs.push(value);
    }
    return { wrapperArgs, childArgs };
  }
  const wrapperArgs = separatorIndex === -1 ? values : values.slice(0, separatorIndex);
  const allowedFlags = new Set(["--no-open", "--open"]);
  for (let index = 0; index < wrapperArgs.length; index += 1) {
    const value = wrapperArgs[index];
    if (allowedFlags.has(value)) continue;
    if (value === "--viewer-url") {
      const next = wrapperArgs[index + 1];
      if (!next || isFlagLike(next)) throw new Error("--viewer-url requires a value.");
      index += 1;
      continue;
    }
    if (isOptionAssignment(value, "--viewer-url")) continue;
    throw new Error(`Unknown pma codex capture option: ${value}. Put Codex arguments after --.`);
  }
  return {
    wrapperArgs,
    childArgs: separatorIndex === -1 ? [] : values.slice(separatorIndex + 1),
  };
}

async function promptForCodexThread(candidates, { workspace = null, action = "observe" } = {}) {
  const visible = candidates.slice(0, 20);
  const scope = workspace ? ` in ${workspace}` : "";
  const detail = action === "observe"
    ? "read-only; no Trace copy is created"
    : "Codex Desktop will restart once; only the selected thread will use Capture Proxy";
  console.error(`Choose one Codex session${scope} to ${action} (${detail}):`);
  visible.forEach((source, index) => {
    const project = source.project ? ` · ${source.project}` : "";
    const updated = source.updated_at ? ` · ${source.updated_at.slice(0, 16).replace("T", " ")}` : "";
    console.error(`  ${index + 1}. ${source.title || source.label}${project}${updated}`);
  });
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(`Select 1-${visible.length}: `);
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= visible.length) throw new Error("Invalid Codex session selection.");
    return visible[index].conversation_id;
  } finally {
    terminal.close();
  }
}

function printCodexCandidates(candidates) {
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(candidates.map(codexCandidateSummary), null, 2)}\n`);
    return;
  }
  if (!candidates.length) {
    console.log("No readable Codex Desktop sessions found.");
    return;
  }
  for (const source of candidates) {
    const summary = codexCandidateSummary(source);
    console.log(`${summary.thread_id}\t${summary.updated_at || "-"}\t${summary.project || "-"}\t${summary.title || "Untitled Codex session"}`);
  }
}

function codexCandidateSummary(source) {
  return {
    thread_id: source.conversation_id,
    title: source.title || source.label || null,
    project: source.project || null,
    updated_at: source.updated_at || null,
    model: source.model || null,
  };
}

async function shutdownDashboard() {
  const explicitUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const targets = daemonControlTargets(explicitUrl);
  const errors = [];
  for (const target of targets) {
    const result = await shutdownDaemonTarget(target).catch((error) => {
      errors.push(`${target.url}: ${error.message}`);
      return null;
    });
    if (result) return result;
  }
  if (errors.length) throw new Error(`Could not stop peekMyAgent daemon. ${errors.join("; ")}`);
  return {
    action: "shutdown",
    status: "not_running",
    url: explicitUrl || defaultDaemonUrl(),
    message: "No running peekMyAgent daemon was found.",
  };
}

async function restartDashboard() {
  const stopped = await shutdownDashboard();
  const dashboard = await ensureDashboard({ explicitUrl: null });
  const url = buildDashboardUrl(dashboard.url, optionValue("--source"));
  const shouldOpen = !hasFlag("--no-open") && !hasFlag("--print");
  if (shouldOpen || hasFlag("--open")) {
    launchBrowserUrl(url);
  }
  return {
    action: "restart",
    status: "started",
    stopped,
    url,
  };
}

function daemonControlTargets(explicitUrl) {
  if (explicitUrl) return [{ url: trimSlash(explicitUrl), source: "explicit" }];
  const output = [{ url: defaultDaemonUrl(), source: "default" }];
  const registered = readViewerRegistry();
  if (registered?.url && trimSlash(registered.url) !== output[0].url) {
    output.push({ url: trimSlash(registered.url), source: "registry", pid: registered.pid });
  } else if (registered?.pid) {
    output[0].pid = registered.pid;
  }
  return output;
}

async function shutdownDaemonTarget(target) {
  let allowPidFallback = false;
  if (await canReachDaemon(target.url)) {
    try {
      const result = await postJson(`${trimSlash(target.url)}/api/daemon/shutdown`, {}, { headers: { "x-peekmyagent-intent": "daemon-shutdown" } });
      const pid = result.pid || target.pid || null;
      await waitForDaemonDown(target.url);
      await waitForPidExit(pid);
      return {
        action: "shutdown",
        status: "stopped",
        url: trimSlash(target.url),
        pid,
        method: "api",
      };
    } catch (error) {
      if (!isMissingShutdownEndpoint(error)) throw error;
      allowPidFallback = true;
    }
  } else if (!(await canConnectToUrl(target.url))) {
    return null;
  }

  const registry = readViewerRegistry();
  const registryPid = registry?.url && trimSlash(registry.url) === trimSlash(target.url) ? registry.pid : null;
  const owner = allowPidFallback || hasFlag("--force") ? listeningPidsForUrl(target.url) : null;
  const pid = target.pid || registryPid || null;
  if (!allowPidFallback && !hasFlag("--force")) return null;
  if (!pid) {
    const ownerNote = owner && !owner.supported ? ` Owner lookup is unavailable: ${owner.error}.` : "";
    const ownerPids = owner?.pids?.length ? ` Detected listener pid(s): ${owner.pids.join(", ")}.` : "";
    throw new Error(`No peekMyAgent registry PID for ${target.url}${allowPidFallback ? " after detecting an older daemon" : ""}.${ownerPids}${ownerNote} Refusing to kill an unknown port owner.`);
  }
  if (Number(pid) === process.pid) {
    throw new Error("Refusing to terminate the current peekMyAgent CLI process.");
  }
  if (owner?.supported && owner.pids.length && !owner.pids.includes(Number(pid))) {
    throw new Error(`Registry PID ${pid} is not the listener for ${target.url}. Detected listener pid(s): ${owner.pids.join(", ")}. Refusing to kill an unknown port owner.`);
  }
  const killResults = terminatePids([pid]);
  const failed = killResults.find((item) => !item.ok);
  if (failed) throw new Error(`Could not stop PID ${failed.pid}: ${failed.error}`);
  await waitForDaemonDown(target.url);
  await waitForPidExit(pid);
  clearViewerRegistry(trimSlash(target.url));
  return {
    action: "shutdown",
    status: "stopped",
    url: trimSlash(target.url),
    pid: Number(pid),
    method: killResults[0]?.method || "pid",
  };
}

function isMissingShutdownEndpoint(error) {
  return /HTTP 404|Not found/i.test(error?.message || "");
}

async function waitForDaemonDown(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (!(await canConnectToUrl(url))) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for peekMyAgent daemon to stop at ${url}.`);
}

async function waitForPidExit(pid) {
  if (process.platform !== "win32") return;
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized === process.pid) return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (!isPidRunning(normalized)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for peekMyAgent daemon PID ${normalized} to exit.`);
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function canConnectToUrl(url) {
  const parsed = new URL(trimSlash(url));
  return canConnect(parsed.hostname, Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)));
}

function printDaemonControlResult(result) {
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.action === "restart") {
    console.log(`peekMyAgent restarted: ${result.url}`);
    if (result.stopped?.status === "not_running") console.log("previous daemon: not running");
    return;
  }
  if (result.status === "not_running") {
    console.log("peekMyAgent daemon: not running");
    return;
  }
  console.log(`peekMyAgent daemon stopped: ${result.url}`);
  if (result.pid) console.log(`pid: ${result.pid}`);
}

async function manageIntegration(action) {
  const target = rest[0];
  if (target !== "trae-cn") usage(1);
  let result;
  if (action === "enable" || action === "sync") {
    const dashboard = await ensureDashboard({ explicitUrl: optionValue("--viewer-url") });
    const status = await fetchJson(`${trimSlash(dashboard.url)}/api/daemon/status`);
    if (!status.capture_url) throw new Error("peekMyAgent daemon has no shared capture proxy.");
    result = action === "enable" ? enableTraeCn({ captureBaseUrl: status.capture_url }) : syncTraeCn({ captureBaseUrl: status.capture_url });
  } else if (action === "disable") {
    result = disableTraeCn();
  } else if (action === "status") {
    result = inspectTraeCn();
  } else {
    usage(1);
  }
  if (hasFlag("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printIntegrationResult(result);
}

function printIntegrationResult(result) {
  if (result.action === "enable" || result.action === "sync") {
    console.log(`peekMyAgent ${result.action} ${result.id}: ${result.enabled ? "enabled" : "disabled"}`);
    console.log(`stable URL: ${result.stable_url}`);
    console.log(`patched models: ${result.patched_count || 0}`);
  } else if (result.action === "disable") {
    console.log(`peekMyAgent disable ${result.id}: disabled`);
    console.log(`restored models: ${result.restored_count || 0}`);
  } else {
    console.log(`peekMyAgent status ${result.id}: ${result.enabled ? "enabled" : "disabled"}`);
    console.log(`available: ${result.available ? "yes" : "no"}`);
    if (result.stable_url) console.log(`stable URL: ${result.stable_url}`);
    console.log(`selected models: ${(result.selected_models || []).join(", ") || "none"}`);
    console.log(`custom models: ${result.custom_model_count || 0}`);
    console.log(`patched models: ${result.patched_models || 0}`);
    console.log(`workspaces: ${result.workspace_count || 0}`);
  }
  for (const warning of result.warnings || []) console.error(`warning: ${warning}`);
}

async function startForegroundDaemon() {
  const host = optionValue("--host") || process.env.PEEKMYAGENT_DAEMON_HOST || DEFAULT_DAEMON_HOST;
  const apiPort = parsePort(optionValue("--api-port") || process.env.PEEKMYAGENT_DAEMON_PORT || DEFAULT_DAEMON_API_PORT, "api port");
  const capturePort = parsePort(optionValue("--capture-port") || process.env.PEEKMYAGENT_CAPTURE_PORT || DEFAULT_DAEMON_CAPTURE_PORT, "capture port");
  const daemon = await startViewerServer({
    cwd: safeProcessCwd(),
    host,
    port: apiPort,
    captureHost: host,
    capturePort,
    codexLocal: !hasFlag("--no-codex"),
    exitOnShutdown: true,
  });
  console.log(`peekMyAgent daemon: ${daemon.url}`);
  console.log(`peekMyAgent capture proxy: ${daemon.captureUrl}`);
  console.log("Press Ctrl-C to stop.");
  if (hasFlag("--open")) {
    launchBrowserUrl(daemon.url);
  }
  process.on("SIGINT", async () => {
    await daemon.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await daemon.close();
    process.exit(0);
  });
}

async function startForegroundDevViewer() {
  const demo = optionValue("--demo") || null;
  const evidencePath = optionValue("--evidence");
  const portValue = optionValue("--port");
  const port = portValue ? Number(portValue) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${portValue}`);
  const viewer = await startViewerServer({ cwd: safeProcessCwd(), demo, evidencePath, port, codexLocal: hasFlag("--codex") });
  console.log(`peekMyAgent dev viewer: ${viewer.url}`);
  console.log(`demo=${demo || "none"}${evidencePath ? ` evidence=${evidencePath}` : ""}`);
  console.log("Press Ctrl-C to stop.");
  if (hasFlag("--open")) {
    launchBrowserUrl(viewer.url);
  }
  process.on("SIGINT", async () => {
    await viewer.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await viewer.close();
    process.exit(0);
  });
}

function hasLegacyViewOptions(values) {
  return ["--demo", "--evidence", "--port"].some((flag) => values.includes(flag) || values.some((value) => isOptionAssignment(value, flag)));
}

function buildDashboardUrl(baseUrl, sourceId) {
  const url = new URL(trimSlash(baseUrl));
  if (sourceId) url.searchParams.set("source", sourceId);
  return url.toString().replace(/\/$/, "");
}

function defaultDaemonHost() {
  return process.env.PEEKMYAGENT_DAEMON_HOST || DEFAULT_DAEMON_HOST;
}

function defaultDaemonApiPort() {
  return parsePort(process.env.PEEKMYAGENT_DAEMON_PORT || DEFAULT_DAEMON_API_PORT, "daemon api port");
}

function defaultDaemonCapturePort() {
  return parsePort(process.env.PEEKMYAGENT_CAPTURE_PORT || DEFAULT_DAEMON_CAPTURE_PORT, "daemon capture port");
}

function defaultDaemonUrl() {
  return `http://${defaultDaemonHost()}:${defaultDaemonApiPort()}`;
}

function hasDaemonEndpointOverride() {
  return Boolean(process.env.PEEKMYAGENT_DAEMON_HOST || process.env.PEEKMYAGENT_DAEMON_PORT || process.env.PEEKMYAGENT_CAPTURE_PORT);
}

async function waitForDaemon(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await canReachDaemon(url)) return { url };
    await delay(100);
  }
  throw new Error(`Timed out waiting for peekMyAgent daemon at ${url}.`);
}

async function waitForViewer(url) {
  if (await canReachViewer(url)) return;
  throw new Error(`Could not reach peekMyAgent dashboard at ${url}`);
}

async function canReachViewer(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const response = await fetch(`${trimSlash(url)}/api/sources`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function canReachDaemon(url) {
  const ping = await fetchDaemonProbe(`${trimSlash(url)}/api/daemon/ping`, 600);
  if (ping) return true;
  const status = await fetchDaemonProbe(`${trimSlash(url)}/api/daemon/status`, 2500);
  return Boolean(status);
}

async function fetchDaemonProbe(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data?.shared_capture_proxy) ? data : false;
  } catch {
    return false;
  }
}

function inferClaudeConversationId(childArgs) {
  return optionValueIn(childArgs, "--resume") || optionValueIn(childArgs, "-r") || optionAssignmentValueIn(childArgs, "--resume") || null;
}

function optionValueIn(values, name) {
  const assignment = values.find((item) => isOptionAssignment(item, name));
  if (assignment) {
    const value = String(assignment).slice(`${name}=`.length);
    if (!value) throw new Error(`${name} requires a value.`);
    return value;
  }
  const index = values.indexOf(name);
  if (index === -1) return null;
  const value = values[index + 1] || "";
  if (!value || isFlagLike(value)) throw new Error(`${name} requires a value.`);
  return value;
}

function hasFlagIn(values, name) {
  return values.includes(name);
}

function optionAssignmentValueIn(values, name) {
  const value = optionValueIn(values, name);
  return value || null;
}

function isOptionAssignment(value, name) {
  return String(value || "").startsWith(`${name}=`);
}

function isFlagLike(value) {
  return /^--?[^-]/.test(String(value || ""));
}

function printRunStarted({ viewerUrl, watch, command, args }) {
  console.error(`peekMyAgent dashboard: ${trimSlash(viewerUrl)}?source=${encodeURIComponent(watch.id)}`);
  console.error(`peekMyAgent watch: ${watch.watch_id} (${watch.reused ? "reused" : "new"})`);
  console.error(`running: ${[command, ...args].join(" ")}`);
}

function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(command, args, { env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: safeProcessCwd(),
      env,
      stdio: "inherit",
      ...spawnConfig.options,
    });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.on("error", (error) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      reject(error);
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve({ exit_code: code ?? signalExitCode(signal) });
    });
  });
}

async function runChildWithWatchCleanup({ command, args, env, viewerUrl, watch, openclawProfile, cleanup }) {
  let childResult = null;
  let childError = null;
  try {
    childResult = await runChild(command, args, env);
  } catch (error) {
    childError = error;
  } finally {
    cleanup?.();
  }

  let cleanupError = null;
  try {
    await stopRunWatch(viewerUrl, watch, openclawProfile);
  } catch (error) {
    if (!isMissingWatchCleanupError(error)) cleanupError = error;
  }

  if (childError) {
    if (cleanupError) console.error(`peekMyAgent cleanup warning: ${cleanupError.message}`);
    throw childError;
  }
  if (cleanupError) throw cleanupError;
  return childResult;
}

async function stopRunWatch(viewerUrl, watch, openclawProfile) {
  const stopped = await postJson(`${trimSlash(viewerUrl)}/api/watch/stop`, {
    id: watch.id,
    clear: false,
  }, { headers: { "x-peekmyagent-intent": "watch-stop" } });
  if (openclawProfile && stopped.config_patched && stopped.provider_id && stopped.target_base_url) {
    patchOpenClawProviderBaseUrl(openclawProfile, stopped.provider_id, stopped.target_base_url);
  }
}

function isMissingWatchCleanupError(error) {
  return /\bWatch not found\b/i.test(error?.message || "");
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function controlCurrentWatch({ status }) {
  const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || (await ensureDashboard({ open: false })).url;
  if (!viewerUrl) {
    throw new Error(`No running peekMyAgent dashboard found. Run "peekmyagent open" or pass --viewer-url. Registry checked: ${viewerRegistryPath()}`);
  }
  const agent = normalizeAgent(optionValue("--agent") || detectAgent());
  const conversationId = detectConversationId(agent);
  const workspace = workspaceFromEnv();
  const response = await postJson(`${trimSlash(viewerUrl)}/api/watch/pause`, {
    agent,
    workspace,
    conversation_id: conversationId,
    status,
  }, { headers: { "x-peekmyagent-intent": "watch-pause" } });
  return {
    ...response,
    viewer_url: trimSlash(viewerUrl),
    workspace,
    conversation_id: conversationId,
  };
}

async function stopCurrentWatch({ clear }) {
  const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || (await ensureDashboard({ open: false })).url;
  if (!viewerUrl) {
    throw new Error(`No running peekMyAgent dashboard found. Run "peekmyagent open" or pass --viewer-url. Registry checked: ${viewerRegistryPath()}`);
  }
  const agent = normalizeAgent(optionValue("--agent") || detectAgent());
  const conversationId = detectConversationId(agent);
  const workspace = workspaceFromEnv();
  const response = await postJson(`${trimSlash(viewerUrl)}/api/watch/stop`, {
    agent,
    workspace,
    conversation_id: conversationId,
    clear,
  }, { headers: { "x-peekmyagent-intent": "watch-stop" } });
  const openclawProfile = optionValue("--openclaw-profile") || process.env.PEEK_OPENCLAW_PROFILE || DEFAULT_OPENCLAW_PROFILE;
  if (/openclaw/i.test(agent) && response.config_patched && response.provider_id && response.target_base_url) {
    patchOpenClawProviderBaseUrl(openclawProfile, response.provider_id, response.target_base_url);
  }
  return {
    ...response,
    action: "stop",
    viewer_url: trimSlash(viewerUrl),
    workspace,
    conversation_id: conversationId,
    openclaw_profile: /openclaw/i.test(agent) ? openclawProfile : null,
  };
}

function detectAgent() {
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE) return "Claude Code";
  if (process.env.OPENCLAW_SESSION_KEY || process.env.OPENCLAW_BASE_URL || hasFlag("--patch-openclaw")) return "OpenClaw";
  return "Claude Code";
}

function normalizeAgent(value) {
  if (/openclaw/i.test(value)) return "OpenClaw";
  return "Claude Code";
}

function detectConversationId(agent) {
  if (/claude/i.test(agent)) return process.env.CLAUDE_CODE_SESSION_ID || null;
  return optionValue("--session-key") || process.env.OPENCLAW_SESSION_KEY || process.env.PEEK_CONVERSATION_ID || null;
}

function buildResumeCommand(agent, proxyBaseUrl, conversationId) {
  if (!/claude/i.test(agent) || !conversationId) return null;
  return `${shellInlineEnv("ANTHROPIC_BASE_URL", proxyBaseUrl)} claude --resume ${shellQuote(conversationId)}`;
}

function buildWatchCurrentNote(agent, conversationId) {
  if (/claude/i.test(agent) && conversationId) {
    return "The current Claude Code session was identified from CLAUDE_CODE_SESSION_ID. A shell command cannot rewrite the already-running parent Claude process, so exact proxy capture begins after resuming or starting Claude Code with the proxy base URL.";
  }
  if (/openclaw/i.test(agent) && hasFlag("--patch-openclaw")) {
    return "OpenClaw capture is active on the isolated peekMyAgent profile. Run OpenClaw with the reported --profile value so the original profile remains untouched.";
  }
  return "The watch is registered with the dashboard. Point the Agent provider/base URL at the proxy base URL before the requests you want to inspect.";
}

function openClawPatchOptionsFromArgs(values) {
  return {
    profile: optionValueIn(values, "--openclaw-profile") || process.env.PEEK_OPENCLAW_PROFILE || DEFAULT_OPENCLAW_PROFILE,
    refresh: hasFlagIn(values, "--refresh-profile"),
    model: optionValueIn(values, "--model"),
    providerId: optionValueIn(values, "--provider"),
    targetBaseUrl: optionValueIn(values, "--target-base-url"),
    env: process.env,
  };
}

function buildOpenClawCommandHint(profile, conversationId) {
  const session = conversationId ? ` --session-key ${shellQuote(conversationId)}` : "";
  return `openclaw --profile ${shellQuote(profile)} agent${session} --message '<your message>'`;
}

async function postJson(url, payload, { headers = {} } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`Could not reach peekMyAgent dashboard at ${url}: ${error.message}`);
  }
  const body = await response.text();
  const data = body ? JSON.parse(body) : {};
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Could not reach peekMyAgent dashboard at ${url}: ${error.message}`);
  }
  const body = await response.text();
  const data = body ? JSON.parse(body) : {};
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function parsePort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid ${label}: ${value}`);
  return port;
}
