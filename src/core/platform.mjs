import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function userHome({ env = process.env, platform = process.platform, systemHome = os.homedir() } = {}) {
  if (platform === "win32") {
    const driveHome = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null;
    return env.USERPROFILE || driveHome || systemHome || env.HOME || null;
  }
  return env.HOME || systemHome || env.USERPROFILE || null;
}

export function safeProcessCwd({ fallback, getCwd = () => process.cwd() } = {}) {
  const resolvedFallback = fallback || userHome() || os.tmpdir();
  try {
    const cwd = getCwd();
    if (isAccessibleDirectory(cwd)) return cwd;
  } catch {
    // Keep CLI startup usable if the launching shell's cwd disappeared or is no longer accessible.
  }
  return resolvedFallback;
}

export function workspaceFromEnv({ env = process.env, fallback } = {}) {
  const preferred = env.PEEKMYAGENT_WORKSPACE || env.PWD;
  if (preferred && isAccessibleDirectory(preferred)) return preferred;
  return safeProcessCwd({ fallback });
}

export function isAccessibleDirectory(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function expandHomePath(value, options = {}) {
  const text = String(value || "");
  const home = userHome(options);
  if (text === "~") return home || text;
  if (text.startsWith("~/") || text.startsWith("~\\")) return home ? joinPlatformPath(options.platform || process.platform, home, text.slice(2)) : text;
  return text;
}

export function joinPlatformPath(platform = process.platform, ...parts) {
  return pathForPlatform(platform).join(...parts);
}

export function pathForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function openBrowserCommand(url, { platform = process.platform } = {}) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function launchBrowserUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { command, args } = openBrowserCommand(url, { platform });
  const child = spawnImpl(command, args, { stdio: "ignore", detached: true, ...backgroundProcessSpawnOptions({ platform }) });
  if (typeof child?.unref === "function") child.unref();
  return { command, args };
}

export function childProcessSpawnOptions(command, { platform = process.platform } = {}) {
  return {
    shell: shouldSpawnViaShell(command, { platform }),
    ...(platform === "win32" ? { windowsHide: true } : {}),
  };
}

export function childProcessSpawnConfig(command, args = [], { platform = process.platform, env = process.env } = {}) {
  const finalArgs = [...(args || [])];
  if (platform !== "win32") {
    return { command, args: finalArgs, options: { shell: false } };
  }

  const resolved = resolveWindowsCommand(command, { env }) || command;
  const shimTarget = windowsShimSpawnTarget(resolved, finalArgs, { env });
  if (shimTarget) {
    return { ...shimTarget, options: { shell: false, windowsHide: true } };
  }

  if (isWindowsBatchCommand(resolved)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", windowsCmdCommandLine(resolved, finalArgs)],
      options: { shell: false, windowsHide: true },
    };
  }

  return { command: resolved, args: finalArgs, options: { shell: false, windowsHide: true } };
}

export function backgroundProcessSpawnOptions({ platform = process.platform } = {}) {
  return platform === "win32" ? { windowsHide: true } : {};
}

export function shellQuote(value, { platform = process.platform } = {}) {
  const text = String(value);
  if (platform === "win32") return `'${text.replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export function shellInlineEnv(name, value, { platform = process.platform } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) throw new Error(`Invalid environment variable name: ${name}`);
  const quoted = shellQuote(value, { platform });
  if (platform === "win32") return `$env:${name}=${quoted};`;
  return `${name}=${quoted}`;
}

export function npmGlobalBinPath(prefix, commandName, { platform = process.platform } = {}) {
  if (!prefix) throw new Error("npmGlobalBinPath requires an install prefix.");
  if (!commandName) throw new Error("npmGlobalBinPath requires a command name.");
  if (platform === "win32") return joinPlatformPath(platform, prefix, `${commandName}.cmd`);
  return joinPlatformPath(platform, prefix, "bin", commandName);
}

export function shouldSpawnViaShell(command, { platform = process.platform } = {}) {
  if (platform !== "win32") return false;
  const extension = path.extname(String(command || "")).toLowerCase();
  return extension !== ".exe";
}

function resolveWindowsCommand(command, { env = process.env } = {}) {
  const text = String(command || "");
  if (!text) return text;
  const pathApi = path.win32;
  const hasPath = pathApi.isAbsolute(text) || /[\\/]/.test(text);
  if (hasPath) return resolveWindowsPathCandidate(text, { env }) || text;

  const pathValue = [env.Path, env.PATH].filter(Boolean).join(path.delimiter);
  const dirs = [...pathValue.split(path.delimiter), ...windowsLikelyCommandDirs(env)]
    .filter(Boolean)
    .filter((dir, index, list) => list.findIndex((item) => item.toLowerCase() === dir.toLowerCase()) === index);
  for (const dir of dirs) {
    const candidate = resolveWindowsPathCandidate(pathApi.join(dir, text), { env });
    if (candidate) return candidate;
  }
  return null;
}

function windowsLikelyCommandDirs(env = process.env) {
  const output = [];
  if (env.APPDATA) output.push(path.win32.join(env.APPDATA, "npm"));
  const home = userHome({ env, platform: "win32" });
  if (home) output.push(path.win32.join(home, "AppData", "Roaming", "npm"));
  return output;
}

function resolveWindowsPathCandidate(candidate, { env = process.env } = {}) {
  const extension = path.win32.extname(candidate);
  if (extension && fs.existsSync(candidate)) return candidate;
  if (extension) return null;
  for (const ext of windowsPathExtensions(env)) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt)) return withExt;
  }
  return fs.existsSync(candidate) ? candidate : null;
}

function windowsPathExtensions(env = process.env) {
  const configured = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const preferred = [".exe", ".cmd", ".bat", ".com"];
  return [...new Set([...preferred, ...configured])];
}

function windowsShimSpawnTarget(commandPath, args, { env = process.env } = {}) {
  if (!isWindowsBatchCommand(commandPath)) return null;
  let text = "";
  try {
    text = fs.readFileSync(commandPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.win32.dirname(commandPath);

  const npmCli = path.win32.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  if (/node_modules\\npm\\bin\\npm-cli\.js/i.test(text) && fs.existsSync(npmCli)) {
    return { command: windowsNodeExeForShim(dir, { env }), args: [npmCli, ...args] };
  }

  const scriptTarget = firstExpandedShimTarget(text, dir, /\.(?:mjs|cjs|js)$/i);
  if (scriptTarget && fs.existsSync(scriptTarget)) {
    return { command: windowsNodeExeForShim(dir, { env, text }), args: [scriptTarget, ...args] };
  }

  const exeTarget = firstExpandedShimTarget(text, dir, /\.exe$/i);
  if (exeTarget && fs.existsSync(exeTarget)) return { command: exeTarget, args };

  return null;
}

function firstExpandedShimTarget(text, dir, extensionPattern) {
  for (const match of text.matchAll(/"([^"]+)"/g)) {
    const expanded = expandWindowsShimPath(match[1], dir);
    if (extensionPattern.test(expanded)) return expanded;
  }
  return null;
}

function expandWindowsShimPath(value, dir) {
  return path.win32.normalize(
    String(value || "")
      .replace(/%dp0%/gi, dir)
      .replace(/%~dp0/gi, `${dir}\\`),
  );
}

function windowsNodeExeForShim(dir, { env = process.env, text = "" } = {}) {
  const localNode = path.win32.join(dir, "node.exe");
  if (fs.existsSync(localNode)) return localNode;
  const quotedNode = [...String(text).matchAll(/"([^"]*node(?:\.exe)?)"/gi)]
    .map((match) => expandWindowsShimPath(match[1], dir))
    .find((candidate) => path.win32.extname(candidate).toLowerCase() === ".exe" && fs.existsSync(candidate));
  return quotedNode || resolveWindowsCommand("node", { env }) || process.execPath;
}

function isWindowsBatchCommand(command) {
  return [".cmd", ".bat"].includes(path.win32.extname(String(command || "")).toLowerCase());
}

function windowsCmdCommandLine(command, args) {
  return `"${[command, ...args].map(windowsCmdQuote).join(" ")}"`;
}

function windowsCmdQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
