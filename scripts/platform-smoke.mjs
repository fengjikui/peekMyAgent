import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { traeCnAppDataRoot } from "../src/adapters/trae-cn-integration.mjs";
import { appConfigDir, defaultStateDir, defaultStorePath, ideRegistryPath, safePathSegment, slugify, translationsDir, viewerRegistryPath } from "../src/core/app-paths.mjs";
import { childProcessSpawnConfig, childProcessSpawnOptions, expandHomePath, launchBrowserUrl, npmGlobalBinPath, openBrowserCommand, safeProcessCwd, shellInlineEnv, shellQuote, shouldSpawnViaShell, userHome, workspaceFromEnv } from "../src/core/platform.mjs";
import { canConnect, listeningPidsForPort, terminatePids } from "../src/core/process-tools.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-platform-"));
try {
  const home = path.join(tmpDir, "home");
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  assert.equal(
    userHome({
      env: { HOME: "/msys/home", USERPROFILE: "C:\\Users\\Ada" },
      platform: "win32",
      systemHome: "C:\\Users\\Ada",
    }),
    "C:\\Users\\Ada",
  );
  assert.equal(
    userHome({
      env: { HOME: "/msys/home", HOMEDRIVE: "D:", HOMEPATH: "\\Dev" },
      platform: "win32",
      systemHome: "",
    }),
    "D:\\Dev",
  );
  assert.equal(
    userHome({
      env: { HOME: "/msys/home", USERPROFILE: "C:\\Users\\Ada" },
      platform: "win32",
      systemHome: "",
    }),
    "C:\\Users\\Ada",
  );
  assert.equal(userHome({ env: { HOME: home }, platform: "linux" }), home);
  assert.equal(workspaceFromEnv({ env: { PWD: workspace }, fallback: home }), workspace);
  assert.equal(workspaceFromEnv({ env: { PWD: path.join(tmpDir, "missing") }, fallback: home }), process.cwd());
  assert.equal(safeProcessCwd({ fallback: home, getCwd: () => { throw new Error("uv_cwd"); } }), home);
  assert.equal(expandHomePath("~\\project", { env: { USERPROFILE: "C:\\Users\\Ada" }, platform: "win32", systemHome: "" }), "C:\\Users\\Ada\\project");

  assert.deepEqual(openBrowserCommand("http://127.0.0.1:43110", { platform: "darwin" }), {
    command: "open",
    args: ["http://127.0.0.1:43110"],
  });
  assert.deepEqual(openBrowserCommand("http://127.0.0.1:43110", { platform: "win32" }), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:43110"],
  });
  assert.deepEqual(openBrowserCommand("http://127.0.0.1:43110", { platform: "linux" }), {
    command: "xdg-open",
    args: ["http://127.0.0.1:43110"],
  });
  const browserLaunches = [];
  const launched = launchBrowserUrl("http://127.0.0.1:43110", {
    platform: "win32",
    spawnImpl(command, args, options) {
      browserLaunches.push({ command, args, options });
      return { unref() {} };
    },
  });
  assert.deepEqual(launched, {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:43110"],
  });
  assert.deepEqual(browserLaunches, [{
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:43110"],
    options: { stdio: "ignore", detached: true, windowsHide: true },
  }]);
  assert.equal(shouldSpawnViaShell("claude", { platform: "win32" }), true);
  assert.equal(shouldSpawnViaShell("claude.cmd", { platform: "win32" }), true);
  assert.equal(shouldSpawnViaShell("npm", { platform: "win32" }), true);
  assert.equal(shouldSpawnViaShell("C:\\Program Files\\nodejs\\node.exe", { platform: "win32" }), false);
  assert.equal(shouldSpawnViaShell("claude", { platform: "darwin" }), false);
  assert.deepEqual(childProcessSpawnOptions("claude", { platform: "win32" }), { shell: true, windowsHide: true });
  assert.deepEqual(childProcessSpawnOptions("npm", { platform: "win32" }), { shell: true, windowsHide: true });
  assert.deepEqual(childProcessSpawnOptions("claude", { platform: "linux" }), { shell: false });
  assert.deepEqual(childProcessSpawnConfig("C:\\Program Files\\nodejs\\node.exe", ["--version"], { platform: "win32" }), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["--version"],
    options: { shell: false, windowsHide: true },
  });
  if (process.platform === "win32") {
    const fakeAppData = path.join(tmpDir, "appdata");
    const fakeNpmBin = path.join(fakeAppData, "npm");
    const fakeClaudeScript = path.join(fakeNpmBin, "claude.mjs");
    fs.mkdirSync(fakeNpmBin, { recursive: true });
    fs.writeFileSync(fakeClaudeScript, "process.stdout.write('ok');\n");
    fs.writeFileSync(path.join(fakeNpmBin, "claude.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0claude.mjs" %*\r\n`);
    assert.deepEqual(
      childProcessSpawnConfig("claude", ["-p", "hello world"], {
        platform: "win32",
        env: {
          APPDATA: fakeAppData,
          USERPROFILE: path.join(tmpDir, "home"),
          Path: path.dirname(process.execPath),
          PATH: path.dirname(process.execPath),
        },
      }),
      {
        command: process.execPath,
        args: [fakeClaudeScript, "-p", "hello world"],
        options: { shell: false, windowsHide: true },
      },
    );
  }
  assert.equal(shellQuote("simple path", { platform: "linux" }), "'simple path'");
  assert.equal(shellQuote("O'Reilly", { platform: "linux" }), "'O'\\''Reilly'");
  assert.equal(shellQuote("simple path", { platform: "win32" }), "'simple path'");
  assert.equal(shellQuote("O'Reilly", { platform: "win32" }), "'O''Reilly'");
  assert.equal(shellInlineEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:43111", { platform: "linux" }), "ANTHROPIC_BASE_URL='http://127.0.0.1:43111'");
  assert.equal(shellInlineEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:43111", { platform: "win32" }), "$env:ANTHROPIC_BASE_URL='http://127.0.0.1:43111';");
  assert.throws(() => shellInlineEnv("BAD-NAME", "value"), /Invalid environment variable name/);
  assert.equal(npmGlobalBinPath("C:\\Users\\Ada\\AppData\\Roaming\\npm", "peekmyagent", { platform: "win32" }), "C:\\Users\\Ada\\AppData\\Roaming\\npm\\peekmyagent.cmd");
  assert.equal(npmGlobalBinPath("/usr/local", "peekmyagent", { platform: "linux" }), "/usr/local/bin/peekmyagent");
  assert.equal(defaultStateDir({ env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, platform: "win32" }), "C:\\Users\\Ada\\AppData\\Local\\peekMyAgent");
  assert.equal(defaultStorePath({ env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, platform: "win32" }), "C:\\Users\\Ada\\AppData\\Local\\peekMyAgent\\store.sqlite");
  assert.equal(defaultStateDir({ env: { PEEKMYAGENT_STATE_DIR: path.join(tmpDir, "state") }, platform: "linux" }), path.join(tmpDir, "state"));
  assert.equal(defaultStorePath({ env: { PEEKMYAGENT_STATE_DIR: path.join(tmpDir, "state") }, platform: "linux" }), path.posix.join(path.join(tmpDir, "state"), "store.sqlite"));
  assert.equal(viewerRegistryPath({ env: { PEEKMYAGENT_STATE_DIR: path.join(tmpDir, "state") }, platform: "linux" }), path.posix.join(path.join(tmpDir, "state"), "viewer.json"));
  assert.equal(translationsDir("Claude Code", "zh-CN", { env: { PEEKMYAGENT_STATE_DIR: path.join(tmpDir, "state") } }), path.join(tmpDir, "state", "translations", "claude-code", "zh-CN"));
  assert.equal(slugify(".."), "agent");
  assert.equal(slugify(".Claude Code."), "claude-code");
  assert.equal(safePathSegment("..", "fallback"), "fallback");
  assert.equal(safePathSegment("../escape", "fallback"), "escape");
  assert.equal(safePathSegment("CON", "fallback"), "CON-item");
  const translationRoot = path.join(tmpDir, "state", "translations");
  const unsafeTranslationDir = translationsDir("..", "..", { env: { PEEKMYAGENT_STATE_DIR: path.join(tmpDir, "state") } });
  assert.equal(unsafeTranslationDir, path.join(translationRoot, "agent", "target-language"));
  assert.equal(path.relative(translationRoot, unsafeTranslationDir).startsWith(".."), false, "unsafe translation labels must stay under translations root");
  assert.equal(ideRegistryPath({ env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, platform: "win32" }), "C:\\Users\\Ada\\AppData\\Local\\peekMyAgent\\ide-integrations.json");
  assert.equal(appConfigDir("Demo App", { env: { HOME: home }, platform: "darwin" }), path.posix.join(home, "Library", "Application Support", "Demo App"));
  assert.equal(appConfigDir("Demo App", { env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, platform: "win32" }), "C:\\Users\\Ada\\AppData\\Roaming\\Demo App");
  assert.equal(appConfigDir("Demo App", { env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, platform: "win32" }), "C:\\Users\\Ada\\AppData\\Local\\Demo App");
  assert.equal(appConfigDir("Demo App", { env: { XDG_CONFIG_HOME: path.join(tmpDir, "config") }, platform: "linux" }), path.posix.join(path.join(tmpDir, "config"), "Demo App"));
  assert.equal(appConfigDir("Demo App", { env: {}, platform: "linux", override: "/custom/demo" }), "/custom/demo");
  assert.equal(traeCnAppDataRoot({ env: { HOME: home }, platform: "darwin" }), path.posix.join(home, "Library", "Application Support", "Trae CN"));
  assert.equal(traeCnAppDataRoot({ env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" }, platform: "win32" }), "C:\\Users\\Ada\\AppData\\Roaming\\Trae CN");
  assert.equal(traeCnAppDataRoot({ env: { PEEKMYAGENT_TRAE_CN_APPDATA: "D:\\TraeData" }, platform: "win32" }), "D:\\TraeData");
  assert.equal(traeCnAppDataRoot({ env: { XDG_CONFIG_HOME: path.join(tmpDir, "config") }, platform: "linux" }), path.posix.join(path.join(tmpDir, "config"), "Trae CN"));

  const server = net.createServer();
  const port = await listen(server);
  try {
    assert.equal(await canConnect("127.0.0.1", port), true);
    const owner = listeningPidsForPort(port);
    assert.equal(typeof owner.supported, "boolean");
    if (owner.supported) assert.ok(owner.pids.includes(process.pid), `expected ${process.pid} in ${JSON.stringify(owner)}`);
    else assert.ok(owner.error);
  } finally {
    await closeServer(server);
  }

  const winOwnerCalls = [];
  const winOwners = listeningPidsForPort(43110, {
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      winOwnerCalls.push({ command, args, options });
      return { status: 0, stdout: "1234\r\n1234\r\n5678\r\n", stderr: "" };
    },
  });
  assert.deepEqual(winOwners, {
    supported: true,
    method: "powershell:Get-NetTCPConnection",
    pids: [1234, 5678],
    error: null,
  });
  assert.equal(winOwnerCalls[0]?.command, "powershell.exe");
  assert.deepEqual(winOwnerCalls[0]?.args.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.match(winOwnerCalls[0]?.args[2] || "", /Get-NetTCPConnection -LocalPort 43110 -State Listen/);
  assert.deepEqual(winOwnerCalls[0]?.options, { encoding: "utf8" });

  const noPowerShell = listeningPidsForPort(43110, {
    platform: "win32",
    spawnSyncImpl() {
      return { error: { code: "ENOENT" } };
    },
  });
  assert.deepEqual(noPowerShell, {
    supported: false,
    method: "powershell:Get-NetTCPConnection",
    pids: [],
    error: "powershell.exe is not available",
  });

  const taskkillCalls = [];
  const killResult = terminatePids([1234, "1234", 5678], {
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      taskkillCalls.push({ command, args, options });
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    },
  });
  assert.deepEqual(killResult, [
    { pid: 1234, ok: true, method: "taskkill", error: null },
    { pid: 5678, ok: true, method: "taskkill", error: null },
  ]);
  assert.deepEqual(taskkillCalls.map((call) => [call.command, call.args, call.options]), [
    ["taskkill.exe", ["/PID", "1234", "/T", "/F"], { encoding: "utf8" }],
    ["taskkill.exe", ["/PID", "5678", "/T", "/F"], { encoding: "utf8" }],
  ]);

  console.log("platform smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
