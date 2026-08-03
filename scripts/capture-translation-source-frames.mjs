#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { launchChromiumPage } from "./lib/chromium-cdp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "assets", "demo", "source", "translation", "recording", "raw");
const viewport = { width: 1920, height: 1080 };
const timeoutMs = 30_000;

const demo = startDemo();
let browser;

try {
  const viewerUrl = await demo.viewerUrl;
  browser = await launchChromiumPage({ timeoutMs });
  await browser.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  await browser.navigate(viewerUrl, { timeoutMs });
  await browser.waitFor(
    "document.readyState === 'complete' && document.querySelectorAll('main article').length === 2",
    { timeoutMs, description: "two-Request Codex translation Trace" },
  );
  await selectByLabel(browser, "选择界面主题", "Codex");
  await capture(browser, "01-overview.png");

  await clickIndexed(browser, "button.raw-button.compact", 0, 2, "Request 1 details");
  await waitForHeading(browser, "Request 1 · 完整请求");
  await clickExactButton(browser, "System");
  await waitForHeading(browser, "Request 1 · System");
  await clickExactButton(browser, "原文");
  await browser.waitFor(
    "document.body.textContent.includes('You are Codex, a coding agent working in a repository.')",
    { timeoutMs, description: "Codex System source" },
  );
  await capture(browser, "02-system-source.png");

  await clickExactButton(browser, "中文（简体）");
  await browser.waitFor(
    "document.body.textContent.includes('你是 Codex，一名在仓库中工作的编程 Agent。')",
    { timeoutMs, description: "Codex System translation" },
  );
  await capture(browser, "03-system-translated.png");

  await clickIndexed(browser, ".translation-block details summary", 1, 3, "second translated System source disclosure");
  await browser.waitFor(
    "document.body.textContent.includes('Repository instructions:')",
    { timeoutMs, description: "expanded repository instructions source" },
  );
  await capture(browser, "04-system-bilingual.png");

  await clickExactButton(browser, "Tools");
  await waitForHeading(browser, "Request 1 · Tools");
  await clickExactButton(browser, "原文");
  await browser.waitFor(
    "document.body.textContent.includes('List one level of entries in a public directory.')",
    { timeoutMs, description: "Tools source" },
  );
  await capture(browser, "05-tools-source.png");

  await clickExactButton(browser, "中文（简体）");
  await browser.waitFor(
    "document.body.textContent.includes('列出公开目录第一层的条目。')",
    { timeoutMs, description: "Tools translation" },
  );
  await capture(browser, "06-tools-translated.png");

  await clickExactButton(browser, "完整请求");
  await waitForHeading(browser, "Request 1 · 完整请求");
  await browser.waitFor(
    "document.body.textContent.includes('[REDACTED:header]') && document.body.textContent.includes('You are Codex')",
    { timeoutMs, description: "original request and redacted header" },
  );
  await capture(browser, "07-capture-original.png");

  browser.assertNoRuntimeExceptions();
  console.log("Translation Source capture passed: 7 PNG frames at 1920x1080");
} finally {
  if (browser) await browser.close();
  await stopDemo(demo.child);
}

function startDemo() {
  const child = spawn(process.execPath, ["scripts/translation-viewer-demo.mjs"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 80) stderr.shift();
  });
  const viewerUrl = new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for translation Viewer.\n${stderr.join("")}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("Viewer: ")) continue;
        clearTimeout(timer);
        resolve(line.slice("Viewer: ".length).trim());
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Translation demo exited before capture (${code ?? signal}).\n${stderr.join("")}`));
    });
    child.once("error", reject);
  });
  return { child, viewerUrl };
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
