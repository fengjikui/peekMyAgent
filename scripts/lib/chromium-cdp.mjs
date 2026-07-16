import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 12_000;

export async function launchChromiumPage({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const executable = findChromiumExecutable({ env });
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-browser-profile-"));
  const stderr = [];
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-dev-shm-usage",
    "--metrics-recording-only",
    "--mute-audio",
    "--window-size=1440,900",
    "about:blank",
  ];
  const child = spawn(executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: chromiumSpawnEnvironment({ env }),
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 80) stderr.shift();
  });

  try {
    const target = await waitForPageTarget({ port, child, stderr, timeoutMs });
    const socket = await openWebSocket(target.webSocketDebuggerUrl, timeoutMs);
    const page = new ChromiumCdpPage({ socket, child, profileDir, executable, stderr, timeoutMs });
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable").catch(() => {});
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  } catch (error) {
    await terminateBrowser(child);
    removeDirectory(profileDir);
    throw error;
  }
}

export function findChromiumExecutable({ env = process.env, platform = process.platform } = {}) {
  const configured = [env.PEEKMYAGENT_BROWSER_PATH, env.CHROME_PATH, env.CHROME_BIN, env.GOOGLE_CHROME_BIN].find(Boolean);
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    throw new Error(`Configured Chromium browser does not exist: ${configured}`);
  }

  const candidates = chromiumExecutableCandidates({ platform, env });
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  for (const command of chromiumExecutableCommands(platform)) {
    const resolved = resolveCommand(command, platform);
    if (resolved) return resolved;
  }
  throw new Error(
    "Raw browser smoke requires Chrome, Chromium, or Edge. Install one or set PEEKMYAGENT_BROWSER_PATH to its executable.",
  );
}

export function chromiumSpawnEnvironment({ env = process.env, platform = process.platform } = {}) {
  const browserEnv = { ...env };
  if (platform === "darwin" && env.PEEKMYAGENT_RELEASE_CHECK_ISOLATED === "1") {
    delete browserEnv.HOME;
    delete browserEnv.USERPROFILE;
  }
  return browserEnv;
}

class ChromiumCdpPage {
  constructor({ socket, child, profileDir, executable, stderr, timeoutMs }) {
    this.socket = socket;
    this.child = child;
    this.profileDir = profileDir;
    this.executable = executable;
    this.stderr = stderr;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.runtimeExceptions = [];
    this.closed = false;
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => this.rejectPending(new Error("Chromium DevTools connection closed")));
    socket.addEventListener("error", () => this.rejectPending(new Error("Chromium DevTools connection failed")));
  }

  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error(`Cannot send ${method}: Chromium page is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Timed out waiting for Chromium CDP command ${method}`));
      }, timeoutMs);
      const pending = {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pending.set(id, pending);
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        pending.reject(error);
      }
    });
  }

  async navigate(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const result = await this.send("Page.navigate", { url });
    if (result?.errorText) throw new Error(`Chromium navigation failed: ${result.errorText}`);
    await this.waitFor("document.readyState === 'complete'", { timeoutMs, description: `page load for ${url}` });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "unknown browser exception";
      throw new Error(description);
    }
    return response.result?.value;
  }

  async waitFor(expression, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 50, description = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    const suffix = lastError ? ` Last error: ${lastError.message}` : "";
    throw new Error(`Timed out waiting for ${description}.${suffix}`);
  }

  assertNoRuntimeExceptions() {
    if (!this.runtimeExceptions.length) return;
    throw new Error(`Browser runtime exceptions:\n${this.runtimeExceptions.join("\n\n")}`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const id = this.nextId++;
      this.socket.send(JSON.stringify({ id, method: "Browser.close", params: {} }));
    } catch {
      // The browser may already have exited after a failed assertion.
    }
    await terminateBrowser(this.child);
    try {
      this.socket.close();
    } catch {
      // Ignore a socket already closed by Browser.close.
    }
    removeDirectory(this.profileDir);
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      this.runtimeExceptions.push(details?.exception?.description || details?.text || "unknown runtime exception");
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function chromiumExecutableCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    // Chrome 136+ may reject CDP on managed Windows hosts even with an
    // ephemeral profile. Edge and Chromium exercise the same browser contract.
    return [
      ...roots.map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((root) => path.join(root, "Chromium", "Application", "chrome.exe")),
      ...roots.map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ];
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ];
}

function chromiumExecutableCommands(platform) {
  if (platform === "win32") return ["msedge.exe", "chromium.exe", "chrome.exe"];
  return ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge-stable", "microsoft-edge"];
}

function resolveCommand(command, platform) {
  const resolver = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(resolver, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean) || null;
}

async function waitForPageTarget({ port, child, stderr, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chromium exited before DevTools was ready.\n${stderr.join("").trim()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chromium has not opened the debugging socket yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Chromium DevTools.\n${stderr.join("").trim()}`);
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to Chromium DevTools"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to connect to Chromium DevTools"));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function terminateBrowser(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(1500).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1000)]);
  }
}

function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Browser profile cleanup is best-effort after the child has exited.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
