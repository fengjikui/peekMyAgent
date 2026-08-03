#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { launchChromiumPage } from "./lib/chromium-cdp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "assets", "demo", "source", "custom-harness", "recording", "raw");
const viewport = { width: 1920, height: 1080 };
const timeoutMs = 30_000;
const demo = startDemo();
let browser;

try {
  const ready = await demo.ready;
  browser = await launchChromiumPage({ timeoutMs });
  await browser.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });

  await openSource(browser, ready.viewerUrl, ready.baselineSource, 3, "Codex");
  await capture(browser, "01-before-overview.png");

  await clickIndexed(browser, "button.raw-button.compact", 0, 3, "baseline Request 1 details");
  await waitForHeading(browser, "Request 1 · 完整请求");
  await clickExactButton(browser, "Tools");
  await waitForHeading(browser, "Request 1 · Tools");
  await browser.waitFor(
    "document.body.textContent.includes('读取项目文档') && document.body.textContent.includes('文件')",
    { timeoutMs, description: "baseline vague read_file schema" },
  );
  await capture(browser, "02-before-tools.png");

  await clickIndexed(browser, "button.assistant-tool-summary", 0, 2, "baseline first read_file call");
  await waitForHeading(browser, "Request 1 · function_call");
  await browser.waitFor(
    "document.body.textContent.includes('call_harness_baseline_read_1')",
    { timeoutMs, description: "baseline empty read_file call" },
  );
  await capture(browser, "03-before-empty-call.png");

  await clickIndexed(browser, "button.tool-exchange", 0, 2, "baseline error result");
  await waitForHeading(browser, "Request 2 · Tool result");
  await browser.waitFor(
    "document.body.textContent.includes('path is required')",
    { timeoutMs, description: "baseline path-is-required result" },
  );
  await capture(browser, "04-before-error-result.png");

  await clickIndexed(browser, "button.raw-button.compact", 0, 3, "baseline Request 1 Raw");
  await waitForHeading(browser, "Request 1 · 完整请求");
  await browser.waitFor(
    "document.body.textContent.includes('strict: false') && !document.body.textContent.includes('required: [1]')",
    { timeoutMs, description: "baseline Raw without required path" },
  );
  await scrollTextIntoView(browser, "strict");
  await capture(browser, "05-before-raw-schema.png");

  await openSource(browser, ready.viewerUrl, ready.improvedSource, 2, "Codex");
  await capture(browser, "06-after-overview.png");

  await clickIndexed(browser, "button.raw-button.compact", 0, 2, "improved Request 1 details");
  await waitForHeading(browser, "Request 1 · 完整请求");
  await clickExactButton(browser, "Tools");
  await waitForHeading(browser, "Request 1 · Tools");
  await browser.waitFor(
    "document.body.textContent.includes('README.md') && document.body.textContent.includes('相对于项目根目录的文件路径')",
    { timeoutMs, description: "improved read_file schema" },
  );
  await capture(browser, "07-after-tools.png");

  await clickExactButton(browser, "完整请求");
  await waitForHeading(browser, "Request 1 · 完整请求");
  await browser.waitFor(
    "document.body.textContent.includes('required: [1]') && document.body.textContent.includes('strict: true')",
    { timeoutMs, description: "improved required and strict Raw" },
  );
  await scrollTextIntoView(browser, "strict");
  await capture(browser, "08-after-raw-schema.png");

  await clickIndexed(browser, "button.tool-exchange", 0, 1, "improved read_file result");
  await waitForHeading(browser, "Request 2 · Tool result");
  await browser.waitFor(
    "document.body.textContent.includes('src/main.mjs')",
    { timeoutMs, description: "improved README tool result" },
  );
  await capture(browser, "09-after-result.png");

  await openSource(browser, ready.viewerUrl, ready.anthropicSource, 2, "Claude");
  await clickIndexed(browser, "button.tool-exchange", 0, 1, "Anthropic tool_result");
  await waitForHeading(browser, "Request 2 · Tool result");
  await browser.waitFor(
    "document.body.textContent.includes('tool_result') && document.body.textContent.includes('toolu_protocol_lab_list')",
    { timeoutMs, description: "Anthropic tool_result protocol boundary" },
  );
  await capture(browser, "10-anthropic-boundary.png");

  browser.assertNoRuntimeExceptions();
  console.log("Custom Harness Source capture passed: 10 PNG frames at 1920x1080");
} finally {
  if (browser) await browser.close();
  await stopDemo(demo.child);
}

function startDemo() {
  const child = spawn(process.execPath, ["scripts/custom-harness-protocol-demo.mjs"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 80) stderr.shift();
  });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    const values = {};
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for custom Harness Viewer.\n${stderr.join("")}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("Viewer: ")) values.viewerUrl = line.slice("Viewer: ".length).trim();
        if (line.startsWith("Baseline Source: ")) values.baselineSource = line.slice("Baseline Source: ".length).trim();
        if (line.startsWith("Improved Source: ")) values.improvedSource = line.slice("Improved Source: ".length).trim();
        if (line.startsWith("Anthropic Source: ")) values.anthropicSource = line.slice("Anthropic Source: ".length).trim();
      }
      if (values.viewerUrl && values.baselineSource && values.improvedSource && values.anthropicSource) {
        clearTimeout(timer);
        resolve(values);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Custom Harness demo exited before capture (${code ?? signal}).\n${stderr.join("")}`));
    });
    child.once("error", reject);
  });
  return { child, ready };
}

async function openSource(browser, viewerUrl, sourceId, requestCount, theme) {
  await browser.navigate(`${viewerUrl}/?source=${encodeURIComponent(sourceId)}`, { timeoutMs });
  await browser.waitFor(
    `document.readyState === 'complete' && document.querySelectorAll('main article').length === ${requestCount}`,
    { timeoutMs, description: `${sourceId} with ${requestCount} Requests` },
  );
  await selectByLabel(browser, "选择界面主题", theme);
}

async function selectByLabel(browser, ariaLabel, optionLabel) {
  const result = await browser.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(`select[aria-label="${ariaLabel}"]`)});
    if (!select) return { found: false };
    const option = [...select.options].find((item) => item.textContent.trim() === ${JSON.stringify(optionLabel)});
    if (!option) return { found: true, selected: false };
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, selected: true, label: option.textContent.trim() };
  })()`);
  assert.deepEqual(result, { found: true, selected: true, label: optionLabel });
}

async function clickIndexed(browser, selector, index, expectedCount, description) {
  const result = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (matches.length !== ${expectedCount}) return { count: matches.length, clicked: false };
    matches[${index}].click();
    return { count: matches.length, clicked: true };
  })()`);
  assert.deepEqual(result, { count: expectedCount, clicked: true }, `${description}: ${selector}`);
}

async function clickExactButton(browser, label) {
  const result = await browser.evaluate(`(() => {
    const matches = [...document.querySelectorAll('button')]
      .filter((button) => button.textContent.trim() === ${JSON.stringify(label)} && button.offsetParent !== null);
    if (matches.length !== 1) return { count: matches.length, clicked: false };
    matches[0].click();
    return { count: 1, clicked: true };
  })()`);
  assert.deepEqual(result, { count: 1, clicked: true }, `expected one visible button named ${label}`);
}

async function scrollTextIntoView(browser, text) {
  const result = await browser.evaluate(`(() => {
    const target = [...document.querySelectorAll('*')]
      .find((element) => element.children.length === 0 && element.textContent.trim() === ${JSON.stringify(text)});
    if (!target) return false;
    (target.parentElement || target).scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
  assert.equal(result, true, `expected visible Raw text ${text}`);
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function waitForHeading(browser, text) {
  await browser.waitFor(
    `[...document.querySelectorAll('h2')].some((heading) => heading.textContent.trim() === ${JSON.stringify(text)})`,
    { timeoutMs, description: text },
  );
}

async function capture(browser, filename) {
  const layout = await browser.evaluate(`({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.body.scrollWidth,
    scrollHeight: document.body.scrollHeight
  })`);
  assert.deepEqual(layout, { width: 1920, height: 1080, scrollWidth: 1920, scrollHeight: 1080 });
  const screenshot = await browser.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, "base64");
  assert.equal(bytes.readUInt32BE(16), 1920);
  assert.equal(bytes.readUInt32BE(20), 1080);
  fs.mkdirSync(outputDir, { recursive: true });
  const destination = path.join(outputDir, filename);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { mode: 0o644 });
  fs.renameSync(temporary, destination);
  console.log(`captured ${path.relative(root, destination)}`);
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
