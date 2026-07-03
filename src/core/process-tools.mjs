import net from "node:net";
import { spawnSync } from "node:child_process";

export function canConnect(host, port, { timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function portFromUrl(url) {
  const parsed = new URL(String(url || ""));
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

export function listeningPidsForUrl(url, options = {}) {
  return listeningPidsForPort(portFromUrl(url), options);
}

export function listeningPidsForPort(port, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65535) {
    return { supported: false, method: null, pids: [], error: `Invalid port: ${port}` };
  }
  if (platform === "win32") return windowsListeningPids(normalizedPort, { spawnSyncImpl });
  return unixListeningPids(normalizedPort, { spawnSyncImpl });
}

export function terminatePids(pids, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  const uniquePids = [...new Set((pids || []).map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0))];
  const results = [];
  for (const pid of uniquePids) {
    results.push(terminatePid(pid, { platform, spawnSyncImpl }));
  }
  return results;
}

function unixListeningPids(port, { spawnSyncImpl }) {
  const result = spawnSyncImpl("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return { supported: false, method: "lsof", pids: [], error: "lsof is not available" };
  if (result.status !== 0 && !result.stdout) return { supported: true, method: "lsof", pids: [], error: result.stderr?.trim() || null };
  return { supported: true, method: "lsof", pids: parsePidLines(result.stdout), error: null };
}

function windowsListeningPids(port, { spawnSyncImpl }) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess`,
  ].join(" ");
  const result = spawnSyncImpl("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return { supported: false, method: "powershell:Get-NetTCPConnection", pids: [], error: "powershell.exe is not available" };
  if (result.status !== 0 && !result.stdout) return { supported: true, method: "powershell:Get-NetTCPConnection", pids: [], error: result.stderr?.trim() || null };
  return { supported: true, method: "powershell:Get-NetTCPConnection", pids: parsePidLines(result.stdout), error: null };
}

function terminatePid(pid, { platform, spawnSyncImpl }) {
  if (platform === "win32") {
    const result = spawnSyncImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
    return {
      pid,
      ok: result.status === 0,
      method: "taskkill",
      error: result.status === 0 ? null : result.stderr?.trim() || result.stdout?.trim() || "taskkill failed",
    };
  }
  try {
    process.kill(pid, "SIGTERM");
    return { pid, ok: true, method: "SIGTERM", error: null };
  } catch (error) {
    return { pid, ok: false, method: "SIGTERM", error: error.message };
  }
}

function parsePidLines(output) {
  return [
    ...new Set(
      String(output || "")
        .split(/\s+/)
        .map((pid) => Number(pid.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}
