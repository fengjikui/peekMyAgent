import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";
import { jsonHeadersForUrl } from "./lib/http-intents.mjs";
import { launchChromiumPage } from "./lib/chromium-cdp.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-raw-search-browser-"));
const previousStateDir = process.env.PEEKMYAGENT_STATE_DIR;
process.env.PEEKMYAGENT_STATE_DIR = path.join(tmpDir, "state");
const storePath = path.join(tmpDir, "store.sqlite");
const query = "项目记忆";
const system = Array.from({ length: 12 }, (_, index) => ({
  type: "text",
  text: `${String.fromCharCode(65 + index).repeat(420)} ${query} 第 ${index + 1} 段${index === 0 ? ` ${query} 重复命中` : ""}`,
}));
let viewer = null;
let browser = null;

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_raw_search_browser",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "已检查项目记忆。" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 8 },
    }),
  );
});

const upstreamUrl = await listen(upstream);

try {
  viewer = await startViewerServer({ cwd: process.cwd(), storePath });
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: tmpDir,
    conversation_id: "raw-search-browser-contract",
    target_base_url: upstreamUrl,
  });
  await postJson(`${watch.base_url}/v1/messages`, {
    model: "raw-search-browser-model",
    system,
    tools: [
      {
        name: "InspectMemory",
        description: `检查${query}，并说明${query}的加载状态。`,
        input_schema: {
          type: "object",
          properties: {
            scope: { type: "string", description: `要检查的${query}范围。` },
          },
        },
      },
    ],
    messages: [{ role: "user", content: `请检查${query}。` }],
  });

  browser = await launchChromiumPage();
  await browser.navigate(`${viewer.url}/?source=${encodeURIComponent(watch.id)}`);
  await browser.waitFor(
    `Boolean(document.querySelector('.request-card [data-raw-section="system"]'))`,
    { description: "the captured request card" },
  );
  await browser.evaluate(`document.querySelector('.request-card [data-raw-section="system"]').click()`);
  await browser.waitFor(`Boolean(document.querySelector('[data-raw-search]'))`, { description: "the System Raw search field" });

  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-raw-search]');
    window.__rawSearchInputBeforeComposition = input;
    window.__rawSearchEventLog = [];
    window.__rawSearchMutationLog = [];
    for (const type of ['compositionstart', 'input', 'compositionend']) {
      input.addEventListener(type, (event) => window.__rawSearchEventLog.push({
        type: event.type,
        composing: Boolean(event.isComposing),
        value: event.target?.value || '',
        at: Math.round(performance.now()),
      }));
    }
    window.__rawSearchObserver = new MutationObserver(() => {
      const current = document.querySelector('[data-raw-search]');
      if (current !== window.__rawSearchInputBeforeComposition) {
        window.__rawSearchMutationLog.push({
          value: current?.value || '',
          marks: document.querySelectorAll('mark.raw-search-highlight').length,
          at: Math.round(performance.now()),
        });
      }
    });
    window.__rawSearchObserver.observe(document.querySelector('#rawTree'), { childList: true, subtree: true });
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: ${JSON.stringify(query)} }));
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: ${JSON.stringify(query)},
      inputType: 'insertCompositionText',
      isComposing: true,
    }));
    return true;
  })()`);
  await delay(260);
  const composingState = await browser.evaluate(`(() => ({
    sameInput: document.querySelector('[data-raw-search]') === window.__rawSearchInputBeforeComposition,
    value: document.querySelector('[data-raw-search]')?.value,
    marks: document.querySelectorAll('mark.raw-search-highlight').length,
    events: window.__rawSearchEventLog,
    mutations: window.__rawSearchMutationLog,
  }))()`);
  assert.equal(composingState.sameInput, true, `IME composition replaced the input: ${JSON.stringify(composingState)}`);
  assert.equal(composingState.value, query);
  assert.equal(composingState.marks, 0, `IME composition rendered intermediate marks: ${JSON.stringify(composingState)}`);
  await browser.evaluate(`window.__rawSearchObserver?.disconnect()`);

  await browser.evaluate(`(() => {
    const input = document.querySelector('[data-raw-search]');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: ${JSON.stringify(query)} }));
    return true;
  })()`);
  await browser.waitFor(
    `document.querySelector('[data-raw-search-position]')?.textContent === '1/13' && document.querySelectorAll('mark.raw-search-highlight').length === 13`,
    { description: "13 visible System search occurrences" },
  );

  const initialState = await searchState(browser);
  assert.deepEqual(initialState, {
    value: query,
    position: "1/13",
    marks: 13,
    activeIndex: 0,
    activeTargets: 1,
    focused: true,
  });

  await clickSearchNavigation(browser, "next", "2/13", 1);
  await clickSearchNavigation(browser, "previous", "1/13", 0);
  await clickSearchNavigation(browser, "previous", "13/13", 12);
  await clickSearchNavigation(browser, "next", "1/13", 0);

  await browser.evaluate(`(() => {
    const panel = document.querySelector('.raw-panel');
    panel.scrollTop = 700;
    return panel.scrollTop;
  })()`);
  await browser.waitFor(`document.querySelector('.raw-panel').scrollTop > 0`, { description: "Raw panel scrolling" });
  const stickyDelta = await browser.evaluate(`(() => {
    const panel = document.querySelector('.raw-panel').getBoundingClientRect();
    const controls = document.querySelector('.raw-sticky-controls').getBoundingClientRect();
    return Math.abs(panel.top - controls.top);
  })()`);
  assert.ok(stickyDelta <= 2, `Raw navigation and search controls must stay sticky while scrolling; delta=${stickyDelta}`);

  await browser.evaluate(`document.querySelector('.raw-sticky-controls [data-raw-section="tools"]').click()`);
  await browser.waitFor(
    `document.querySelector('[data-raw-search]')?.value === ${JSON.stringify(query)} && document.querySelectorAll('mark.raw-search-highlight').length > 0`,
    { description: "the persisted query in Tools" },
  );
  assert.match(await browser.evaluate(`document.querySelector('[data-raw-search-position]').textContent`), /^1\/\d+$/);

  await browser.evaluate(`document.querySelector('.raw-sticky-controls [data-raw-section="system"]').click()`);
  await browser.waitFor(
    `document.querySelector('[data-raw-search-position]')?.textContent === '1/13' && document.querySelectorAll('mark.raw-search-highlight').length === 13`,
    { description: "the restored System search result set" },
  );
  browser.assertNoRuntimeExceptions();

  console.log(`raw search browser smoke passed (${path.basename(browser.executable)}, Chinese IME, 13 marks, cyclic navigation, sticky controls)`);
} finally {
  await browser?.close();
  await viewer?.close();
  await closeServer(upstream);
  if (previousStateDir === undefined) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = previousStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function clickSearchNavigation(browserPage, direction, expectedPosition, expectedActiveIndex) {
  await browserPage.evaluate(`document.querySelector('[data-raw-search-nav="${direction}"]').click()`);
  await browserPage.waitFor(
    `document.querySelector('[data-raw-search-position]')?.textContent === ${JSON.stringify(expectedPosition)}`,
    { description: `${direction} Raw search navigation` },
  );
  const state = await searchState(browserPage);
  assert.equal(state.position, expectedPosition);
  assert.equal(state.activeIndex, expectedActiveIndex);
  assert.equal(state.activeTargets, 1);
}

function searchState(browserPage) {
  return browserPage.evaluate(`(() => {
    const input = document.querySelector('[data-raw-search]');
    const marks = [...document.querySelectorAll('mark.raw-search-highlight')];
    return {
      value: input?.value || '',
      position: document.querySelector('[data-raw-search-position]')?.textContent || '',
      marks: marks.length,
      activeIndex: marks.findIndex((mark) => mark.classList.contains('raw-search-highlight-active')),
      activeTargets: document.querySelectorAll('.raw-search-target-active').length,
      focused: document.activeElement === input,
    };
  })()`);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeadersForUrl(url),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
