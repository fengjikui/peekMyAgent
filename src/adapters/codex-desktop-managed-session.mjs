import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { codexHttpProviderDefinition } from "./codex-exact-proxy.mjs";
import { startCodexAppServerRelay } from "./codex-app-server-relay.mjs";
import { canConnect } from "../core/process-tools.mjs";
import { redactText } from "../core/redaction.mjs";

const DEFAULT_START_TIMEOUT_MS = 12_000;
const DEFAULT_STOP_TIMEOUT_MS = 4_000;
const MAX_DIAGNOSTIC_CHARS = 8_000;

export async function startManagedCodexDesktopInfrastructure({
  installation,
  watchBaseUrl,
  workspace,
  captureThreadId = null,
  captureNextNewThread = !captureThreadId,
  env = process.env,
  spawnImpl = spawn,
  relayFactory = startCodexAppServerRelay,
  reservePort = reserveLoopbackPort,
  connectProbe = canConnect,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  if (!installation?.supported || !installation?.embedded_codex_path) {
    throw new Error(installation?.reason || "Managed Codex Desktop installation is unavailable.");
  }
  const normalizedWatchBaseUrl = String(watchBaseUrl || "").trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(normalizedWatchBaseUrl)) {
    throw new Error("Managed Codex Desktop capture requires a loopback watch URL.");
  }
  const normalizedWorkspace = String(workspace || "").trim();
  if (!normalizedWorkspace) throw new Error("Managed Codex Desktop workspace is required.");

  const appServerPort = await reservePort();
  const appServerUrl = `ws://127.0.0.1:${appServerPort}`;
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-app-server-"));
  let backendToken;
  let backendTokenPath;
  let args;
  let appServer;
  try {
    fs.chmodSync(authDir, 0o700);
    backendToken = crypto.randomBytes(32).toString("hex");
    backendTokenPath = path.join(authDir, "capability-token");
    fs.writeFileSync(backendTokenPath, `${backendToken}\n`, { mode: 0o600 });
    args = codexDesktopAppServerArgs({
      listenUrl: appServerUrl,
      wsTokenFile: backendTokenPath,
    });
    appServer = spawnImpl(installation.embedded_codex_path, args, {
      cwd: normalizedWorkspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    fs.rmSync(authDir, { recursive: true, force: true });
    throw error;
  }
  const diagnostics = createBoundedDiagnostics(appServer);
  const appServerExit = childExit(appServer);
  let relay = null;
  let closed = false;

  try {
    await waitForPortOrExit({
      host: "127.0.0.1",
      port: appServerPort,
      child: appServer,
      childExitPromise: appServerExit,
      connectProbe,
      timeoutMs: startTimeoutMs,
      diagnostics,
    });
    relay = await relayFactory({
      targetHost: "127.0.0.1",
      targetPort: appServerPort,
      targetAuthorizationToken: backendToken,
      threadCapture: {
        workspace: normalizedWorkspace,
        targetThreadId: captureThreadId,
        captureNextNewThread,
        providerDefinition: codexHttpProviderDefinition(normalizedWatchBaseUrl),
      },
    });
  } catch (error) {
    await stopChild(appServer, { timeoutMs: stopTimeoutMs });
    fs.rmSync(authDir, { recursive: true, force: true });
    throw error;
  }

  return {
    app_server_pid: appServer.pid || null,
    app_server_url: appServerUrl,
    relay_url: relay.url,
    app_server_args: args,
    relay_stats: relay.stats,
    capture_route: relay.stats.thread_capture,
    app_server_exit: appServerExit,
    diagnostics,
    async close() {
      if (closed) return;
      closed = true;
      await relay?.close();
      await stopChild(appServer, { timeoutMs: stopTimeoutMs });
      fs.rmSync(authDir, { recursive: true, force: true });
    },
  };
}

export function codexDesktopAppServerArgs({ listenUrl, wsTokenFile } = {}) {
  const normalizedListenUrl = String(listenUrl || "").trim();
  if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(normalizedListenUrl)) {
    throw new Error("Managed Codex App Server must listen on an ephemeral ws://127.0.0.1 port.");
  }
  const normalizedTokenFile = String(wsTokenFile || "").trim();
  if (!path.isAbsolute(normalizedTokenFile)) {
    throw new Error("Managed Codex App Server capability token file must use an absolute path.");
  }
  return [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--analytics-default-enabled",
    "--listen",
    normalizedListenUrl,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    normalizedTokenFile,
  ];
}

async function waitForPortOrExit({
  host,
  port,
  child,
  childExitPromise,
  connectProbe,
  timeoutMs,
  diagnostics,
}) {
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || DEFAULT_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      const result = await childExitPromise;
      throw new Error(`Managed Codex App Server exited before listening (${formatChildExit(result)}).${diagnosticSuffix(diagnostics)}`);
    }
    if (await connectProbe(host, port, { timeoutMs: 150 })) return;
    await delay(80);
  }
  throw new Error(`Managed Codex App Server did not listen on ${host}:${port} within ${timeoutMs}ms.${diagnosticSuffix(diagnostics)}`);
}

function createBoundedDiagnostics(child) {
  const state = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => {
    state.stdout = appendBounded(state.stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr = appendBounded(state.stderr, chunk);
  });
  return state;
}

function appendBounded(existing, chunk) {
  const next = `${existing}${String(chunk || "")}`;
  return next.length <= MAX_DIAGNOSTIC_CHARS ? next : next.slice(-MAX_DIAGNOSTIC_CHARS);
}

function diagnosticSuffix(diagnostics) {
  const compact = `${diagnostics.stderr || ""}\n${diagnostics.stdout || ""}`
    .replace(/[\r\n\t ]+/g, " ")
    .trim()
    .slice(-1_000);
  const text = sanitizeManagedCodexDiagnostic(compact);
  return text ? ` App Server diagnostic: ${text}` : "";
}

export function sanitizeManagedCodexDiagnostic(value) {
  const keyedSecretsRedacted = String(value || "").replace(
    /\b(authorization|api[-_ ]?key|access[-_ ]?token|capability[-_ ]?token|token|secret)(\s*[:=]\s*)(?:Bearer\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1$2[REDACTED]",
  );
  return redactText(keyedSecretsRedacted, "managed_codex_diagnostic").value;
}

function childExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null }));
  });
}

async function stopChild(child, { timeoutMs }) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    childExit(child).then(() => true),
    delay(Math.max(100, Number(timeoutMs) || DEFAULT_STOP_TIMEOUT_MS)).then(() => false),
  ]);
  if (stopped || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGKILL");
  await Promise.race([childExit(child), delay(1_000)]);
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not reserve a loopback port for the managed Codex App Server.");
  return port;
}

function formatChildExit(result) {
  if (result?.error) return result.error.message;
  if (result?.signal) return `signal ${result.signal}`;
  return `exit ${result?.code ?? "unknown"}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
