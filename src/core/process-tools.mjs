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

export function listSystemProcesses({ platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform === "win32") return windowsProcessTable({ spawnSyncImpl });
  return unixProcessTable({ spawnSyncImpl });
}

export function runningPidsForExecutable(executablePath, options = {}) {
  const normalized = String(executablePath || "").trim();
  if (!normalized) return { supported: false, method: null, pids: [], error: "Executable path is required" };
  const table = listSystemProcesses(options);
  if (!table.supported) return { supported: false, method: table.method, pids: [], error: table.error };
  const pids = table.processes
    .filter((processInfo) => processMatchesExecutable(processInfo, normalized, options.platform || process.platform))
    .map((processInfo) => processInfo.pid);
  return { supported: true, method: table.method, pids: [...new Set(pids)], error: table.error || null };
}

export function processHasAncestor(pid, ancestorPids, options = {}) {
  const targetPid = Number(pid);
  const ancestors = new Set(
    (ancestorPids || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
  );
  if (!Number.isInteger(targetPid) || targetPid <= 0 || !ancestors.size) return false;
  const table = options.processes
    ? { supported: true, processes: options.processes }
    : listSystemProcesses(options);
  if (!table.supported) return false;
  const parentByPid = new Map(table.processes.map((processInfo) => [processInfo.pid, processInfo.ppid]));
  const visited = new Set();
  let current = targetPid;
  while (Number.isInteger(current) && current > 0 && !visited.has(current)) {
    if (ancestors.has(current)) return true;
    visited.add(current);
    current = parentByPid.get(current);
  }
  return false;
}

function unixListeningPids(port, { spawnSyncImpl }) {
  const result = spawnSyncImpl("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return { supported: false, method: "lsof", pids: [], error: "lsof is not available" };
  if (result.status !== 0 && !result.stdout) return { supported: true, method: "lsof", pids: [], error: result.stderr?.trim() || null };
  return { supported: true, method: "lsof", pids: parsePidLines(result.stdout), error: null };
}

function unixProcessTable({ spawnSyncImpl }) {
  const result = spawnSyncImpl("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    return { supported: false, method: "ps", processes: [], error: "ps is not available" };
  }
  if (result.status !== 0) {
    return {
      supported: false,
      method: "ps",
      processes: [],
      error: result.stderr?.trim() || `ps exited with status ${result.status}`,
    };
  }
  const processes = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        executable_path: null,
        command: match[3].trim(),
      };
    })
    .filter(Boolean);
  return { supported: true, method: "ps", processes, error: null };
}

function windowsProcessTable({ spawnSyncImpl }) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSyncImpl("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    return { supported: false, method: "powershell:Get-CimInstance", processes: [], error: "powershell.exe is not available" };
  }
  if (result.status !== 0) {
    return {
      supported: false,
      method: "powershell:Get-CimInstance",
      processes: [],
      error: result.stderr?.trim() || `PowerShell exited with status ${result.status}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout || "null"));
  } catch (error) {
    return { supported: false, method: "powershell:Get-CimInstance", processes: [], error: error.message };
  }
  const processes = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : [])
    .map((entry) => ({
      pid: Number(entry.ProcessId),
      ppid: Number(entry.ParentProcessId),
      executable_path: String(entry.ExecutablePath || "").trim() || null,
      command: String(entry.CommandLine || "").trim(),
    }))
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  return { supported: true, method: "powershell:Get-CimInstance", processes, error: null };
}

function processMatchesExecutable(processInfo, executablePath, platform) {
  const normalize = platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  const expected = normalize(executablePath);
  const reported = normalize(String(processInfo.executable_path || ""));
  if (reported && reported === expected) return true;
  const command = normalize(String(processInfo.command || "").trim());
  return command === expected || command.startsWith(`${expected} `);
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
