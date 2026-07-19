import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig } from "../core/platform.mjs";

const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const MACOS_OPEN_COMMAND = "/usr/bin/open";
const MACOS_CODEX_BUNDLE_ID = "com.openai.codex";

export function createCodexObservationId({ now = Date.now, randomUUID = crypto.randomUUID } = {}) {
  return `codex-live-${now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function resolveCodexDesktopCaptureMode(requested = "auto") {
  const value = String(requested || "auto").trim().toLowerCase();
  if (!["auto", "rollout", "proxy", "exact"].includes(value)) {
    throw new Error(`Unknown Codex Desktop capture mode: ${requested}. Use auto, rollout, or proxy.`);
  }
  if (value === "proxy" || value === "exact") {
    throw new Error(
      "Codex Desktop does not expose a safe process-scoped provider override. Use plain `pma codex [codex args...]` for exact CLI capture, or `pma codex desktop --capture rollout` for Desktop observation.",
    );
  }
  if (value === "rollout") {
    return { mode: "rollout", confidence: "semantic", fallbackReason: null };
  }
  return {
    mode: "rollout",
    confidence: "semantic",
    fallbackReason: "Codex Desktop has no stable process-scoped exact-proxy injection point",
  };
}

export function launchCodexDesktopWorkspace(
  workspace,
  {
    env = process.env,
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  } = {},
) {
  const normalizedWorkspace = String(workspace || "").trim();
  if (!normalizedWorkspace) throw new Error("Codex Desktop workspace is required.");
  const attempts = [];
  for (const candidate of codexDesktopLaunchCandidates({ env, platform })) {
    const config = childProcessSpawnConfig(candidate.command, candidate.args(normalizedWorkspace), { platform, env });
    const result = spawnSyncImpl(config.command, config.args, {
      ...config.options,
      cwd: normalizedWorkspace,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: positiveInteger(launchTimeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS, 60_000),
    });
    if (!result?.error && result?.status === 0) {
      return { command: config.command, args: config.args, kind: candidate.kind };
    }
    attempts.push(launchFailure(candidate.label, result));
  }
  const installHint = platform === "darwin"
    ? "Install or update Codex Desktop, then run `pma codex desktop` again. To invoke the official installer explicitly, run `codex app`."
    : "Install Codex Desktop or set PEEKMYAGENT_CODEX_DESKTOP_CLI to its launcher command.";
  throw new Error(`Could not open Codex Desktop for ${normalizedWorkspace}. ${attempts.join("; ")} ${installHint}`);
}

export function codexDesktopLaunchCandidates({ env = process.env, platform = process.platform } = {}) {
  const override = String(env.PEEKMYAGENT_CODEX_DESKTOP_CLI || "").trim();
  if (override) {
    return [{
      command: override,
      args: (workspace) => ["app", workspace],
      kind: "configured_cli",
      label: override,
    }];
  }
  if (platform === "darwin") {
    return [{
      command: MACOS_OPEN_COMMAND,
      args: (workspace) => ["-b", MACOS_CODEX_BUNDLE_ID, workspace],
      kind: "macos_launch_services",
      label: `Codex Desktop (${MACOS_CODEX_BUNDLE_ID})`,
    }];
  }
  return [{
    command: "codex",
    args: (workspace) => ["app", workspace],
    kind: "official_cli",
    label: "codex app",
  }];
}

function launchFailure(command, result) {
  if (result?.error) return `${command}: ${result.error.code || result.error.message}`;
  if (result?.signal) return `${command}: stopped by ${result.signal}`;
  const detail = String(result?.stderr || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return `${command}: exit ${result?.status ?? "unknown"}${detail ? ` (${detail})` : ""}`;
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}
