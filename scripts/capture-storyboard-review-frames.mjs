#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const storyboardPath = "/assets/demo/storyboard/index.html";
const catalogPath = path.join(root, "assets", "demo", "storyboard", "catalog.zh-CN.json");
const viewports = [
  { artifact: "review_1920", width: 1920, height: 1080 },
  { artifact: "review_1024", width: 1024, height: 576 },
];
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const catalog = readJson(catalogPath);
const chapter = catalog.chapters?.find((candidate) => candidate.id === options.chapter);
assert(chapter, `unknown storyboard chapter: ${options.chapter}`);
const timelinePath = repoPathFromHref(chapter.timeline, "chapter timeline");
const timeline = readJson(timelinePath);
assert(Array.isArray(timeline.review_points) && timeline.review_points.length > 0,
  `${options.chapter} timeline has no review_points`);
assert(Array.isArray(timeline.scenes) && timeline.scenes.length > 0,
  `${options.chapter} timeline has no scenes`);
validateReviewPoints(timeline);

async function main() {
  const browserPath = discoverBrowser(options.browser);
  const server = createStaticServer();
  const profilePrefix = path.join(os.tmpdir(), "pma-storyboard-capture-");
  const profileDirectory = fs.mkdtempSync(profilePrefix);
  let browserProcess;
  let cdp;
  const stopForSignal = () => {
    if (browserProcess?.exitCode === null) browserProcess.kill("SIGTERM");
    if (server.listening) server.close();
  };
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  try {
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;
    browserProcess = launchBrowser(browserPath, profileDirectory);
    const debuggingPort = await waitForDevToolsPort(profileDirectory, browserProcess);
    const page = await createDebugPage(debuggingPort);
    cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    let frameCount = 0;
    for (const viewport of viewports) {
      const artifactHref = chapter.review?.artifacts?.[viewport.artifact];
      const catalogContactSheetPath = repoPathFromHref(artifactHref, `${viewport.artifact} contact sheet`);
      const outputDirectory = options.outputRoot
        ? path.join(options.outputRoot, viewport.width === 1920 ? "review-1920" : "review-1024")
        : path.dirname(catalogContactSheetPath);
      const contactSheetPath = options.outputRoot
        ? path.join(outputDirectory, "contact-sheet.jpg")
        : catalogContactSheetPath;
      fs.mkdirSync(outputDirectory, { recursive: true });
      await setViewport(cdp, viewport);

      for (const [index, point] of timeline.review_points.entries()) {
        const targetUrl = buildReviewUrl(origin, chapter.timeline, point);
        await cdp.send("Page.navigate", { url: targetUrl });
        await waitForReviewState(cdp, {
          expectedSceneNumber: `${point.scene + 1}/${timeline.scenes.length}`,
          timeoutMs: options.timeoutMs,
        });
        const capture = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: options.quality,
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const bytes = Buffer.from(capture.data, "base64");
        const dimensions = readJpegDimensions(bytes);
        assert.deepEqual(dimensions, { width: viewport.width, height: viewport.height },
          `${point.name} rendered at ${dimensions.width}x${dimensions.height}, expected ${viewport.width}x${viewport.height}`);
        const destination = path.join(outputDirectory, `${point.name}.jpg`);
        writeAtomically(destination, bytes);
        frameCount += 1;
        console.log([
          `[${frameCount}/${timeline.review_points.length * viewports.length}]`,
          `${viewport.width}x${viewport.height}`,
          `${index + 1}/${timeline.review_points.length}`,
          path.relative(root, destination),
        ].join(" "));
      }

      if (!options.skipContactSheet) {
        buildContactSheet(outputDirectory, contactSheetPath);
      }
    }

    console.log([
      "storyboard review capture passed:",
      options.chapter,
      `${frameCount} JPEG frames,`,
      `${timeline.review_points.length} review points,`,
      "1920x1080 + 1024x576",
    ].join(" "));
  } finally {
    process.off("SIGINT", stopForSignal);
    process.off("SIGTERM", stopForSignal);
    if (cdp) await cdp.close();
    if (browserProcess) await stopBrowser(browserProcess);
    await closeServer(server);
    assert(profileDirectory.startsWith(profilePrefix), "refusing to clean an unexpected browser profile path");
    fs.rmSync(profileDirectory, { recursive: true, force: true });
  }
}

function parseArguments(args) {
  const parsed = {
    browser: process.env.PMA_STORYBOARD_BROWSER || null,
    chapter: null,
    help: false,
    outputRoot: null,
    quality: 88,
    skipContactSheet: false,
    timeoutMs: 10_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--browser") {
      parsed.browser = requiredValue(args, ++index, "--browser");
    } else if (argument === "--quality") {
      parsed.quality = Number.parseInt(requiredValue(args, ++index, "--quality"), 10);
    } else if (argument === "--output-root") {
      parsed.outputRoot = path.resolve(root, requiredValue(args, ++index, "--output-root"));
    } else if (argument === "--skip-contact-sheet") {
      parsed.skipContactSheet = true;
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = Number.parseInt(requiredValue(args, ++index, "--timeout-ms"), 10);
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (parsed.chapter) {
      throw new Error(`unexpected argument: ${argument}`);
    } else {
      parsed.chapter = argument;
    }
  }
  if (!parsed.help) assert(parsed.chapter, "a storyboard chapter id is required");
  assert(Number.isInteger(parsed.quality) && parsed.quality >= 40 && parsed.quality <= 100,
    "--quality must be an integer between 40 and 100");
  assert(Number.isInteger(parsed.timeoutMs) && parsed.timeoutMs >= 1_000 && parsed.timeoutMs <= 60_000,
    "--timeout-ms must be between 1000 and 60000");
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/capture-storyboard-review-frames.mjs <chapter-id> [options]

Options:
  --browser <path>          Chrome, Chromium, or Edge executable
  --output-root <path>      Write review-1920/ and review-1024/ below another directory
  --quality <40-100>        JPEG quality (default: 88)
  --timeout-ms <ms>         Per-frame readiness timeout (default: 10000)
  --skip-contact-sheet      Keep existing contact sheets unchanged
  -h, --help                Show this help

Browser discovery also honors PMA_STORYBOARD_BROWSER.`);
}

function validateReviewPoints(timeline) {
  const names = new Set();
  for (const [index, point] of timeline.review_points.entries()) {
    const label = `review_points[${index}]`;
    assert(typeof point.name === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(point.name),
      `${label}.name must be a safe filename stem`);
    assert(!names.has(point.name), `${label}.name is duplicated: ${point.name}`);
    names.add(point.name);
    assert(Number.isInteger(point.scene) && point.scene >= 0 && point.scene < timeline.scenes.length,
      `${label}.scene is outside the timeline`);
    const scene = timeline.scenes[point.scene];
    const durationMs = Math.round((scene.end_seconds - scene.start_seconds) * 1000);
    assert(Number.isInteger(point.at_ms) && point.at_ms >= 0 && point.at_ms <= durationMs,
      `${label}.at_ms is outside scene ${point.scene}`);
  }
}

function discoverBrowser(explicitPath) {
  if (explicitPath) {
    assert(isRunnable(explicitPath), `browser executable is not runnable: ${explicitPath}`);
    return explicitPath;
  }

  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    : process.platform === "win32"
      ? windowsBrowserCandidates()
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

  const browser = candidates.find(isRunnable);
  assert(browser, [
    "no Chrome-family browser was found; pass --browser <path>",
    "or set PMA_STORYBOARD_BROWSER",
  ].join(" "));
  return browser;
}

function windowsBrowserCandidates() {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  return roots.flatMap((directory) => [
    path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
}

function isRunnable(candidate) {
  if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function createStaticServer() {
  return http.createServer((request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(root, relativePath);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": stat.size,
        "Content-Type": contentType(filePath),
      });
      fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    }
  });
}

function contentType(filePath) {
  return {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function launchBrowser(executable, profileDirectory) {
  const args = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-sync",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => {
    child.stderrText = `${child.stderrText}${chunk}`.slice(-12_000);
  });
  return child;
}

async function waitForDevToolsPort(profileDirectory, child) {
  const activePortPath = path.join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`browser exited before DevTools was ready (${child.exitCode})\n${child.stderrText}`);
    }
    if (fs.existsSync(activePortPath)) {
      const [port] = fs.readFileSync(activePortPath, "utf8").trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number.parseInt(port, 10);
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for Chrome DevTools\n${child.stderrText}`);
}

async function createDebugPage(port) {
  const endpoint = new URL("/json/new", `http://127.0.0.1:${port}`);
  endpoint.searchParams.set("url", "about:blank");
  const response = await fetch(endpoint, { method: "PUT" });
  assert(response.ok, `Chrome /json/new failed with HTTP ${response.status}`);
  const page = await response.json();
  assert(typeof page.webSocketDebuggerUrl === "string", "Chrome did not return a page WebSocket URL");
  return page;
}

async function setViewport(session, viewport) {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
}

function buildReviewUrl(origin, timelineHref, point) {
  const url = new URL(storyboardPath, origin);
  url.searchParams.set("timeline", timelineHref);
  url.searchParams.set("present", "1");
  url.searchParams.set("review", "1");
  url.searchParams.set("autoplay", "0");
  url.searchParams.set("scene", String(point.scene));
  url.searchParams.set("at_ms", String(point.at_ms));
  return url.href;
}

async function waitForReviewState(session, { expectedSceneNumber, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  while (Date.now() < deadline) {
    try {
      const result = await session.send("Runtime.evaluate", {
        expression: `(() => {
          const visual = document.querySelector(".visual");
          const image = document.querySelector(".product-frame:not([hidden])");
          return {
            ready: document.readyState === "complete",
            present: document.body.classList.contains("present"),
            review: document.body.classList.contains("review"),
            opacity: visual ? getComputedStyle(visual).opacity : null,
            imageReady: !image || (image.complete && image.naturalWidth > 0),
            sceneNumber: document.querySelector(".scene-number")?.textContent?.trim() || null
          };
        })()`,
        returnByValue: true,
      });
      lastState = result.result?.value;
      if (
        lastState?.ready
        && lastState.present
        && lastState.review
        && lastState.opacity === "1"
        && lastState.imageReady
        && lastState.sceneNumber === expectedSceneNumber
      ) return;
    } catch {
      // Navigation can briefly destroy the previous execution context.
    }
    await delay(50);
  }
  throw new Error(`storyboard review state did not settle: ${JSON.stringify(lastState)}`);
}

function writeAtomically(destination, bytes) {
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes);
  if (process.platform === "win32") {
    fs.copyFileSync(temporary, destination);
    fs.unlinkSync(temporary);
  } else {
    fs.renameSync(temporary, destination);
  }
}

function readJpegDimensions(bytes) {
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, "captured frame is not JPEG");
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    assert(length >= 2, "captured JPEG contains an invalid segment");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  throw new Error("captured JPEG has no readable size marker");
}

function buildContactSheet(directory, outputPath) {
  const python = discoverPython();
  const args = [
    ...python.prefix,
    path.join(root, "scripts", "build-demo-contact-sheet.py"),
    directory,
    outputPath,
    "--columns", "5",
    "--thumbnail-width", "360",
  ];
  const result = spawnSync(python.command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`contact sheet failed (${result.status})\n${result.stdout || ""}${result.stderr || ""}`);
  }
  process.stdout.write(result.stdout);
}

function discoverPython() {
  const candidates = process.platform === "win32"
    ? [{ command: "py", prefix: ["-3"] }, { command: "python", prefix: [] }]
    : [{ command: "python3", prefix: [] }, { command: "python", prefix: [] }];
  const python = candidates.find((candidate) => {
    const result = spawnSync(candidate.command, [...candidate.prefix, "--version"], { stdio: "ignore" });
    return result.status === 0;
  });
  assert(python, "Python with Pillow is required for contact sheets; use --skip-contact-sheet to omit them");
  return python;
}

async function stopBrowser(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(2_000),
    ]);
  }
}

function repoPathFromHref(href, label) {
  assert(typeof href === "string" && href.startsWith("/"), `${label} must be a root-relative path`);
  const resolved = path.resolve(root, href.slice(1));
  assert(resolved.startsWith(`${root}${path.sep}`), `${label} escapes the repository`);
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.rejectPending(new Error("Chrome DevTools connection closed")));
    socket.addEventListener("error", () => this.rejectPending(new Error("Chrome DevTools connection failed")));
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpSession(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("could not connect to Chrome DevTools")), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
    else pending.resolve(message.result || {});
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.addEventListener("close", resolve, { once: true });
      this.socket.close();
    });
  }
}

await main();
