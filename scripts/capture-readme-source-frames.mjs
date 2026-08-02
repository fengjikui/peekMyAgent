#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { launchChromiumPage } from "./lib/chromium-cdp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const viewport = { width: 1920, height: 1080 };
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const outputRoot = options.outputRoot || path.join(root, "assets", "demo", "source");
const quickstartOutput = path.join(outputRoot, "quickstart");
const navigationOutput = path.join(outputRoot, "navigation");

async function main() {
  const port = await findFreePort();
  const demo = startDemo(port);
  let browser;
  const stopForSignal = () => demo.child.kill("SIGTERM");
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  try {
    const urls = await demo.urls;
    browser = await launchChromiumPage({ timeoutMs: options.timeoutMs });
    await browser.send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });

    await browser.navigate(urls.quickstart, { timeoutMs: options.timeoutMs });
    await waitForQuickstart(browser);
    await capture(browser, path.join(quickstartOutput, "quickstart-overview-raw.png"));

    await clickIndexed(browser, "button.raw-button.compact", 0, 3, "Request 1 details");
    await waitForHeading(browser, "Request 1 · 完整请求");
    await clickExactButton(browser, "System");
    await browser.waitFor(
      "document.body.textContent.includes('body_instructions') && [...document.querySelectorAll('button.active')].some((button) => button.textContent.trim() === 'System')",
      { timeoutMs: options.timeoutMs, description: "Request 1 System evidence" },
    );
    await capture(browser, path.join(quickstartOutput, "quickstart-system-raw.png"));

    await clickIndexed(browser, "button.tool-exchange", 0, 2, "list_directory tool result");
    await waitForHeading(browser, "Request 2 · Tool result");
    await capture(browser, path.join(quickstartOutput, "quickstart-tool-result-raw.png"));

    await clickIndexed(browser, "button.tool-origin-link", 0, 2, "list_directory origin link");
    await waitForHeading(browser, "Request 1 · function_call");
    await capture(browser, path.join(quickstartOutput, "quickstart-tool-origin-raw.png"));

    await clickIndexed(browser, "button.mini-raw-button", 2, 3, "Request 3 response details");
    await waitForHeading(browser, "Request 3 · Response");
    await capture(browser, path.join(quickstartOutput, "quickstart-final-raw.png"));

    await clickIndexed(browser, "button.raw-button.compact", 2, 3, "Request 3 details");
    await waitForHeading(browser, "Request 3 · 完整请求");
    await clickExactButton(browser, "协议视图");
    await waitForHeading(browser, "Request 3 · 协议视图");
    await browser.waitFor(
      "document.body.textContent.includes('OpenAI Responses') && document.body.textContent.includes('上行输入顺序')",
      { timeoutMs: options.timeoutMs, description: "OpenAI Responses protocol exchange" },
    );
    await capture(browser, path.join(quickstartOutput, "quickstart-protocol-raw.png"));

    await browser.navigate(urls.navigation, { timeoutMs: options.timeoutMs });
    await browser.waitFor(
      "document.readyState === 'complete' && document.querySelectorAll('.turn-mark').length === 6",
      { timeoutMs: options.timeoutMs, description: "navigation Trace with six Turns" },
    );
    await clickAriaLabel(browser, "跳转到 Turn 5");
    await browser.waitFor(
      "document.querySelectorAll('.request-mark').length === 5 && document.querySelector('.request-rail')?.textContent?.includes('#8 · 1 / 5')",
      { timeoutMs: options.timeoutMs, description: "Turn 5 Request Rail" },
    );
    await capture(browser, path.join(navigationOutput, "two-level-navigation-raw.png"));

    browser.assertNoRuntimeExceptions();
    console.log("README Source capture passed: 7 PNG frames at 1920x1080");
  } finally {
    process.off("SIGINT", stopForSignal);
    process.off("SIGTERM", stopForSignal);
    if (browser) await browser.close();
    await stopDemo(demo.child);
  }
}

function startDemo(port) {
  const child = spawn(process.execPath, ["scripts/readme-media-demo.mjs", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 80) stderr.shift();
  });

  const urls = new Promise((resolve, reject) => {
    let stdout = "";
    let quickstart = null;
    let navigation = null;
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for README demo URLs.\n${stderr.join("")}`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("Quick-start source: ")) quickstart = line.slice("Quick-start source: ".length).trim();
        if (line.startsWith("Navigation source: ")) navigation = line.slice("Navigation source: ".length).trim();
      }
      if (quickstart && navigation) {
        clearTimeout(timer);
        resolve({ quickstart, navigation });
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`README demo exited before capture (${code ?? signal}).\n${stderr.join("")}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { child, urls };
}

async function waitForQuickstart(browser) {
  await browser.waitFor(
    "document.readyState === 'complete' && document.querySelectorAll('main article').length === 3 && document.querySelectorAll('button.raw-button.compact').length === 3",
    { timeoutMs: options.timeoutMs, description: "three-request quick-start Trace" },
  );
}

async function clickIndexed(browser, selector, index, expectedCount, description) {
  const result = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (matches.length !== ${expectedCount}) return { count: matches.length, clicked: false };
    matches[${index}].click();
    return { count: matches.length, clicked: true };
  })()`);
  assert.deepEqual(result, { count: expectedCount, clicked: true },
    `${description} expected ${expectedCount} matches for ${selector}`);
}

async function clickExactButton(browser, label) {
  await browser.waitFor(
    `[...document.querySelectorAll("button")].filter((button) => button.textContent.trim() === ${JSON.stringify(label)}).length === 1`,
    { timeoutMs: options.timeoutMs, description: `button ${label}` },
  );
  const result = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent.trim() === ${JSON.stringify(label)});
    if (matches.length !== 1) return { count: matches.length, clicked: false };
    matches[0].click();
    return { count: matches.length, clicked: true };
  })()`);
  assert.deepEqual(result, { count: 1, clicked: true }, `expected one button named ${label}`);
}

async function clickAriaLabel(browser, label) {
  const result = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll("button")]
      .filter((button) => button.getAttribute("aria-label") === ${JSON.stringify(label)});
    if (matches.length !== 1) return { count: matches.length, clicked: false };
    matches[0].click();
    return { count: matches.length, clicked: true };
  })()`);
  assert.deepEqual(result, { count: 1, clicked: true }, `expected one button labelled ${label}`);
}

async function waitForHeading(browser, text) {
  await browser.waitFor(
    `[...document.querySelectorAll("h2")].some((heading) => heading.textContent.trim() === ${JSON.stringify(text)})`,
    { timeoutMs: options.timeoutMs, description: text },
  );
}

async function capture(browser, destination) {
  const layout = await browser.evaluate(`({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.body.scrollWidth,
    scrollHeight: document.body.scrollHeight
  })`);
  assert.deepEqual(layout, {
    width: viewport.width,
    height: viewport.height,
    scrollWidth: viewport.width,
    scrollHeight: viewport.height,
  }, `Viewer must exactly fill ${viewport.width}x${viewport.height}`);

  const screenshot = await browser.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, "base64");
  assert.deepEqual(readPngDimensions(bytes), viewport, "captured PNG dimensions");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { mode: 0o644 });
  fs.renameSync(temporary, destination);
  console.log(`captured ${path.relative(root, destination)}`);
}

function readPngDimensions(bytes) {
  assert(bytes.length >= 24, "PNG is too small");
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", "capture must be PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "failed to allocate loopback port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function stopDemo(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000, "timeout"));
  if (await Promise.race([exited, timeout]) === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function parseArguments(args) {
  const parsed = { help: false, outputRoot: null, timeoutMs: 20_000 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--output-root") {
      parsed.outputRoot = path.resolve(root, requiredValue(args, ++index, argument));
    } else if (argument === "--timeout-ms") {
      parsed.timeoutMs = Number.parseInt(requiredValue(args, ++index, argument), 10);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  assert(Number.isInteger(parsed.timeoutMs) && parsed.timeoutMs >= 5_000 && parsed.timeoutMs <= 60_000,
    "--timeout-ms must be between 5000 and 60000");
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/capture-readme-source-frames.mjs [options]

Options:
  --output-root <path>  Write quickstart/ and navigation/ below this directory
  --timeout-ms <ms>     Browser and source startup timeout (default: 20000)
  -h, --help            Show this help

The script starts the deterministic README demo, operates the real PMA Viewer,
and captures six quick-start states plus one two-level-navigation state at 1920x1080.`);
}

await main();
