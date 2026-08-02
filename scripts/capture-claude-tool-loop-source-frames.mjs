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
const chapterOutput = path.join(outputRoot, "claude-tool-loop", "recording", "raw");

async function main() {
  const port = await findFreePort();
  const demo = startDemo(port);
  let browser;
  const stopForSignal = () => demo.child.kill("SIGTERM");
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  try {
    const sourceUrl = await demo.sourceUrl;
    browser = await launchChromiumPage({ timeoutMs: options.timeoutMs });
    await browser.send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });

    await browser.navigate(sourceUrl, { timeoutMs: options.timeoutMs });
    await waitForToolLoop(browser);
    await selectByLabel(browser, "选择界面主题", "Claude");
    await browser.waitFor(
      "document.documentElement.dataset.theme === 'studio'",
      { timeoutMs: options.timeoutMs, description: "Claude Viewer theme" },
    );
    await capture(browser, "02-overview.png");

    await clickIndexed(browser, "button.raw-button.compact", 0, 2, "Request 1 details");
    await waitForHeading(browser, "Request 1 · 完整请求");
    await clickExactButton(browser, "Metadata");
    await waitForHeading(browser, "Request 1 · 请求 Metadata");
    await browser.waitFor(
      "document.body.textContent.includes('claude-sonnet-4-20250514') && document.body.textContent.includes('1,024')",
      { timeoutMs: options.timeoutMs, description: "Request 1 model parameters" },
    );
    await capture(browser, "03-metadata.png");

    await clickExactButton(browser, "System");
    await waitForHeading(browser, "Request 1 · System");
    await browser.waitFor(
      "document.body.textContent.includes('deterministic public Claude Code teaching trace')",
      { timeoutMs: options.timeoutMs, description: "Request 1 System evidence" },
    );
    await capture(browser, "04-system.png");

    await clickExactButton(browser, "Tools");
    await waitForHeading(browser, "Request 1 · Tools");
    await browser.waitFor(
      "document.body.textContent.includes('Read a bounded range') && document.body.textContent.includes('Glob') && document.body.textContent.includes('Bash')",
      { timeoutMs: options.timeoutMs, description: "Request 1 Tools evidence" },
    );
    await capture(browser, "05-tools.png");

    await clickIndexed(browser, "button.assistant-tool-summary", 0, 1, "Read tool call");
    await waitForHeading(browser, "Request 1 · tool_use");
    await browser.waitFor(
      "document.body.textContent.includes('read_hello') && document.body.textContent.includes('README.md')",
      { timeoutMs: options.timeoutMs, description: "Read tool_use parameters" },
    );
    await capture(browser, "06-tool-use.png");

    await clickIndexed(browser, "button.tool-exchange", 0, 1, "Read tool result");
    await waitForHeading(browser, "Request 2 · Tool result");
    await browser.waitFor(
      "document.body.textContent.includes('read_hello') && document.body.textContent.includes('# hello-agent')",
      { timeoutMs: options.timeoutMs, description: "Read tool_result content" },
    );
    await capture(browser, "07-tool-result.png");

    await clickIndexed(browser, "button.tool-origin-link", 0, 1, "Read result source link");
    await waitForHeading(browser, "Request 1 · tool_use");
    await browser.waitFor(
      "document.body.textContent.includes('正在查看调用 read_hello 的来源') && document.body.textContent.includes('返回结果 #2')",
      { timeoutMs: options.timeoutMs, description: "tool result source navigation" },
    );
    await capture(browser, "08-source-jump.png");

    await clickIndexed(browser, "button.raw-button.compact", 1, 2, "Request 2 details");
    await waitForHeading(browser, "Request 2 · 完整请求");
    await clickExactButton(browser, "协议视图");
    await waitForHeading(browser, "Request 2 · 协议视图");
    await browser.waitFor(
      "document.body.textContent.includes('Anthropic Messages') && document.body.textContent.includes('tool_result') && document.body.textContent.includes('上行输入顺序')",
      { timeoutMs: options.timeoutMs, description: "Anthropic Messages protocol exchange" },
    );
    await capture(browser, "09-protocol.png");

    await clickIndexed(browser, "button[data-raw-section='full']", 0, 2, "Request 2 full Raw");
    await waitForHeading(browser, "Request 2 · 完整请求");
    await browser.waitFor(
      "document.body.textContent.includes('header_redactions') && document.body.textContent.includes('[REDACTED:header]') && document.body.textContent.includes('body:')",
      { timeoutMs: options.timeoutMs, description: "Request 2 Raw evidence and redactions" },
    );
    await capture(browser, "10-raw-search.png");

    await clickIndexed(browser, "button.mini-raw-button", 1, 2, "Request 2 response details");
    await waitForHeading(browser, "Request 2 · Response");
    await browser.waitFor(
      "document.body.textContent.includes('项目名是 hello-agent。')",
      { timeoutMs: options.timeoutMs, description: "Request 2 final response" },
    );
    await capture(browser, "11-final-response.png");

    browser.assertNoRuntimeExceptions();
    console.log("Claude tool-loop Source capture passed: 10 PNG frames at 1920x1080 in Claude theme");
  } finally {
    process.off("SIGINT", stopForSignal);
    process.off("SIGTERM", stopForSignal);
    if (browser) await browser.close();
    await stopDemo(demo.child);
  }
}

function startDemo(port) {
  const child = spawn(process.execPath, ["scripts/claude-mechanisms-media-demo.mjs", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 80) stderr.shift();
  });

  const sourceUrl = new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for Claude tool-loop Source URL.\n${stderr.join("")}`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("toolLoop: ")) continue;
        clearTimeout(timer);
        resolve(line.slice("toolLoop: ".length).trim());
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Claude mechanisms demo exited before capture (${code ?? signal}).\n${stderr.join("")}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { child, sourceUrl };
}

async function waitForToolLoop(browser) {
  await browser.waitFor(
    "document.readyState === 'complete' && document.querySelectorAll('main article').length === 2 && document.querySelectorAll('button.assistant-tool-summary').length === 1 && document.querySelectorAll('button.tool-exchange').length === 1 && document.querySelectorAll('button.raw-button.compact').length === 2",
    { timeoutMs: options.timeoutMs, description: "one-Turn, two-request Claude tool loop" },
  );
}

async function selectByLabel(browser, ariaLabel, optionLabel) {
  const result = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll("select")]
      .filter((select) => select.getAttribute("aria-label") === ${JSON.stringify(ariaLabel)});
    if (matches.length !== 1) return { count: matches.length, selected: false };
    const select = matches[0];
    const option = [...select.options].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(optionLabel)});
    if (!option) return { count: 1, selected: false };
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { count: 1, selected: select.selectedOptions[0]?.textContent.trim() === ${JSON.stringify(optionLabel)} };
  })()`);
  assert.deepEqual(result, { count: 1, selected: true }, `expected one ${ariaLabel} option named ${optionLabel}`);
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

async function waitForHeading(browser, text) {
  await browser.waitFor(
    `[...document.querySelectorAll("h2")].some((heading) => heading.textContent.trim() === ${JSON.stringify(text)})`,
    { timeoutMs: options.timeoutMs, description: text },
  );
}

async function capture(browser, filename) {
  await browser.evaluate("document.fonts?.ready");
  await browser.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const layout = await browser.evaluate(`({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.body.scrollWidth,
    scrollHeight: document.body.scrollHeight,
    theme: document.documentElement.dataset.theme
  })`);
  assert.deepEqual(layout, {
    width: viewport.width,
    height: viewport.height,
    scrollWidth: viewport.width,
    scrollHeight: viewport.height,
    theme: "studio",
  }, `Viewer must exactly fill ${viewport.width}x${viewport.height} in Claude theme`);

  const screenshot = await browser.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, "base64");
  assert.deepEqual(readPngDimensions(bytes), viewport, "captured PNG dimensions");
  const destination = path.join(chapterOutput, filename);
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
  node scripts/capture-claude-tool-loop-source-frames.mjs [options]

Options:
  --output-root <path>  Write claude-tool-loop/recording/raw below this directory
  --timeout-ms <ms>     Browser and source startup timeout (default: 20000)
  -h, --help            Show this help

The script starts the deterministic Claude mechanisms demo, selects the Claude
Viewer theme, operates the real PMA Viewer, and captures ten tool-loop states at
1920x1080 without a device shell or letterbox.`);
}

await main();
