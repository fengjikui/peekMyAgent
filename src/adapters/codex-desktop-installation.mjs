import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runningPidsForExecutable } from "../core/process-tools.mjs";

export const CODEX_DESKTOP_APP_SERVER_ENV = "CODEX_APP_SERVER_WS_URL";
export const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";
const DEFAULT_MACOS_BUNDLE = "/Applications/ChatGPT.app";
const DEFAULT_MACOS_OPEN = "/usr/bin/open";
const APP_SERVER_MARKER = "CODEX_APP_SERVER_WS_URL";
const MARKER_CHUNK_BYTES = 1024 * 1024;

export function inspectCodexDesktopInstallation({
  env = process.env,
  platform = process.platform,
  files = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "darwin") {
    return {
      supported: false,
      platform,
      reason: "Managed Codex Desktop exact capture is currently implemented for macOS only.",
    };
  }

  const bundlePath = env.PEEKMYAGENT_CODEX_DESKTOP_BUNDLE || DEFAULT_MACOS_BUNDLE;
  const appExecutable = env.PEEKMYAGENT_CODEX_DESKTOP_EXECUTABLE || path.join(bundlePath, "Contents", "MacOS", "ChatGPT");
  const embeddedCodexPath = env.PEEKMYAGENT_CODEX_DESKTOP_CODEX || path.join(bundlePath, "Contents", "Resources", "codex");
  const asarPath = env.PEEKMYAGENT_CODEX_DESKTOP_ASAR || path.join(bundlePath, "Contents", "Resources", "app.asar");
  const launcher = env.PEEKMYAGENT_CODEX_DESKTOP_LAUNCHER || DEFAULT_MACOS_OPEN;
  const missing = [appExecutable, embeddedCodexPath, asarPath, launcher].filter((filePath) => !files.existsSync(filePath));
  if (missing.length) {
    return {
      supported: false,
      platform,
      bundle_path: bundlePath,
      app_executable: appExecutable,
      embedded_codex_path: embeddedCodexPath,
      asar_path: asarPath,
      launcher,
      reason: `Codex Desktop installation is incomplete or unreadable: ${missing.join(", ")}`,
    };
  }

  const supportsAppServerOverride = fileContainsAsciiMarker(asarPath, APP_SERVER_MARKER, { files });
  const appVersion = String(env.PEEKMYAGENT_CODEX_DESKTOP_VERSION || readMacBundleVersion(bundlePath, { spawnSyncImpl })).trim() || null;
  const codexVersion = String(env.PEEKMYAGENT_CODEX_DESKTOP_CODEX_VERSION || readCodexVersion(embeddedCodexPath, { spawnSyncImpl })).trim() || null;
  return {
    supported: supportsAppServerOverride,
    platform,
    bundle_id: CODEX_DESKTOP_BUNDLE_ID,
    bundle_path: bundlePath,
    app_executable: appExecutable,
    embedded_codex_path: embeddedCodexPath,
    asar_path: asarPath,
    launcher,
    app_version: appVersion,
    codex_version: codexVersion,
    supports_app_server_override: supportsAppServerOverride,
    reason: supportsAppServerOverride
      ? null
      : `This Codex Desktop build does not expose the ${APP_SERVER_MARKER} managed App Server override.`,
  };
}

export function codexDesktopRunningProcesses(installation, options = {}) {
  if (!installation?.app_executable) {
    return { supported: false, method: null, pids: [], error: "Codex Desktop executable is unavailable" };
  }
  return runningPidsForExecutable(installation.app_executable, options);
}

export function managedCodexDesktopLaunchSpec({
  installation,
  workspace,
  appServerWsUrl,
  env = process.env,
} = {}) {
  assertManagedInstallation(installation);
  const normalizedWorkspace = String(workspace || "").trim();
  const normalizedWsUrl = String(appServerWsUrl || "").trim();
  if (!normalizedWorkspace) throw new Error("Managed Codex Desktop workspace is required.");
  if (!/^ws:\/\/127\.0\.0\.1:\d+\//.test(normalizedWsUrl)) {
    throw new Error("Managed Codex Desktop App Server URL must be a tokenized ws://127.0.0.1 loopback URL.");
  }
  return {
    command: installation.app_executable,
    args: [normalizedWorkspace],
    env: { ...env, [CODEX_DESKTOP_APP_SERVER_ENV]: normalizedWsUrl },
    cwd: normalizedWorkspace,
  };
}

export function normalCodexDesktopLaunchSpec({ installation, workspace, env = process.env } = {}) {
  if (!installation?.launcher) throw new Error("Codex Desktop launcher is unavailable.");
  const normalizedWorkspace = String(workspace || "").trim();
  if (!normalizedWorkspace) throw new Error("Codex Desktop workspace is required.");
  return {
    command: installation.launcher,
    args: ["-n", "-b", installation.bundle_id || CODEX_DESKTOP_BUNDLE_ID, normalizedWorkspace],
    env,
    cwd: normalizedWorkspace,
  };
}

export function requestCodexDesktopQuit({
  installation,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "darwin") {
    return { ok: false, method: null, error: "Graceful Codex Desktop restart is currently implemented for macOS only." };
  }
  const bundleId = installation?.bundle_id || CODEX_DESKTOP_BUNDLE_ID;
  const result = spawnSyncImpl("/usr/bin/osascript", ["-e", `tell application id "${bundleId}" to quit`], {
    encoding: "utf8",
  });
  return {
    ok: !result.error && result.status === 0,
    method: "osascript",
    error: result.error?.message || (result.status === 0 ? null : String(result.stderr || result.stdout || "Codex Desktop quit request failed").trim()),
  };
}

export async function waitForCodexDesktopExit(installation, {
  timeoutMs = 15_000,
  pollMs = 150,
  processLookup = codexDesktopRunningProcesses,
  processLookupOptions = {},
} = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 15_000);
  while (Date.now() < deadline) {
    const result = processLookup(installation, processLookupOptions);
    if (result.supported && result.pids.length === 0) return { exited: true, pids: [] };
    if (!result.supported) return { exited: false, pids: [], error: result.error || "Process inspection is unavailable" };
    await delay(Math.max(10, Number(pollMs) || 150));
  }
  const result = processLookup(installation, processLookupOptions);
  return { exited: false, pids: result.pids || [], error: result.error || "Codex Desktop did not exit before the timeout" };
}

function assertManagedInstallation(installation) {
  if (!installation?.supported || !installation?.supports_app_server_override) {
    throw new Error(installation?.reason || "Codex Desktop managed App Server capture is unavailable.");
  }
  if (!installation.launcher || !installation.embedded_codex_path) {
    throw new Error("Codex Desktop managed capture paths are incomplete.");
  }
}

function readMacBundleVersion(bundlePath, { spawnSyncImpl }) {
  const plistPath = path.join(bundlePath, "Contents", "Info.plist");
  const result = spawnSyncImpl("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plistPath], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

function readCodexVersion(executablePath, { spawnSyncImpl }) {
  const result = spawnSyncImpl(executablePath, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

function fileContainsAsciiMarker(filePath, marker, { files = fs } = {}) {
  const markerBuffer = Buffer.from(marker);
  const overlap = Math.max(0, markerBuffer.length - 1);
  let descriptor;
  try {
    descriptor = files.openSync(filePath, "r");
    const chunk = Buffer.allocUnsafe(MARKER_CHUNK_BYTES + overlap);
    let carried = 0;
    let position = 0;
    while (true) {
      const bytesRead = files.readSync(descriptor, chunk, carried, MARKER_CHUNK_BYTES, position);
      if (bytesRead <= 0) return false;
      const available = carried + bytesRead;
      if (chunk.subarray(0, available).includes(markerBuffer)) return true;
      carried = Math.min(overlap, available);
      if (carried) chunk.copy(chunk, 0, available - carried, available);
      position += bytesRead;
    }
  } catch {
    return false;
  } finally {
    if (descriptor != null) files.closeSync(descriptor);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
