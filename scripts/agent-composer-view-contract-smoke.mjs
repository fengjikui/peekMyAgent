#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { AgentComposerController } from "../src/viewer/agent-composer-controller.js";
import { buildAgentComposerView, canSendToAgentSource } from "../src/viewer/agent-composer-model.js";
import { renderAgentComposer } from "../src/viewer/agent-composer-renderer.js";
import { UI_I18N } from "../src/viewer/ui-i18n.js";

const translations = {
  composerPlaceholder: "Type a message",
  currentProject: "Current project",
  send: "Send",
  sendFailed: "Failed {code}{preview}",
  sendUnavailable: "Unavailable",
  sendUnsupported: "Unsupported",
  sendViaResumeNote: "Detached resume",
  sending: "Sending",
  sent: "Sent independently",
  sentRefreshingCapture: "Refreshing capture",
  sentRefreshFailed: "Sent, refresh failed: {message}",
  sentWaitingCapture: "Sending independently",
  watchPaused: "Paused",
  watchStopped: "Stopped",
};
const translate = (key, values = {}) =>
  String(translations[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const source = {
  id: "stored-watch-1",
  agent: "Claude Code",
  project: "demo",
  workspace: "/tmp/demo",
  live_watch_id: "watch-1",
  live_status: "watching",
  conversation_id: "12345678-1234-1234-1234-123456789abc",
};

assert.equal(canSendToAgentSource(source), true);
assert.equal(canSendToAgentSource({ agent: "Claude Code", live_status: "watching" }), false);
assert.equal(
  canSendToAgentSource({
    store_watch_id: "watch-2",
    conversation_id: "conversation-2",
    live_status: "paused",
  }),
  true,
);

const view = buildAgentComposerView({
  source,
  sendState: { draft: "hello </textarea><script>" },
  translate,
  shortId: (value) => String(value).slice(0, 8),
});
assert.equal(view.enabled, true);
assert.equal(view.targetText, "demo · 12345678");
assert.equal(view.showResumeNote, true);
assert.equal(view.resumeNote, "Detached resume");
assert.equal(view.draft, "hello </textarea><script>");

const html = renderAgentComposer(view, { escapeHtml });
assert.match(html, /data-source-id="stored-watch-1"/);
assert.match(html, /Detached resume/);
assert.match(html, /hello &lt;\/textarea&gt;&lt;script&gt;/);
assert.doesNotMatch(html, /<script>/);

const pausedView = buildAgentComposerView({
  source: { ...source, live_status: "paused" },
  sendState: {},
  translate,
});
assert.equal(pausedView.enabled, false);
assert.equal(pausedView.targetText, "Paused");

let disabledSendCount = 0;
const disabledController = new AgentComposerController({
  element: createFakeElement(),
  sendMessage: async () => {
    disabledSendCount += 1;
    return { exit_code: 0 };
  },
  refreshSource: async () => {},
  translate,
  escapeHtml,
  nextTick: async () => {},
});
disabledController.render({ ...source, live_status: "paused" });
assert.equal(await disabledController.submit("must not send"), null);
assert.equal(disabledSendCount, 0, "controller must enforce source capability instead of trusting disabled HTML");

const fakeElement = createFakeElement();
const sentPayloads = [];
const refreshedSources = [];
let controller;
controller = new AgentComposerController({
  element: fakeElement,
  sendMessage: async (payload) => {
    sentPayloads.push(payload);
    return { source_id: "live-watch-1", exit_code: 0, stdout: "ok" };
  },
  refreshSource: async (sourceId, options) => {
    refreshedSources.push({ sourceId, options });
    controller.render({ ...source, id: sourceId });
  },
  translate,
  escapeHtml,
  shortId: (value) => String(value).slice(0, 8),
  nextTick: async () => {},
});

controller.render(source);
fakeElement.dispatch("input", {
  target: matchingTarget("textarea[name='message']", { value: "draft <one>" }),
});
controller.render(source);
assert.match(fakeElement.innerHTML, /draft &lt;one&gt;/, "same-source redraw should preserve the draft");

const result = await controller.submit("  hello from dashboard  ");
assert.equal(result.exit_code, 0);
assert.deepEqual(sentPayloads, [{ source_id: "stored-watch-1", message: "hello from dashboard" }]);
assert.deepEqual(refreshedSources, [{ sourceId: "live-watch-1", options: { preserveScroll: true } }]);
assert.match(fakeElement.innerHTML, /Sent independently/);
assert.doesNotMatch(fakeElement.innerHTML, /hello from dashboard/);

controller.render({ ...source, id: "other-source", project: "other" });
assert.doesNotMatch(fakeElement.innerHTML, /Sent independently/, "send result must not leak into another source");

const failureElement = createFakeElement();
const failureController = new AgentComposerController({
  element: failureElement,
  sendMessage: async () => {
    throw new Error("provider <offline>");
  },
  refreshSource: async () => {
    throw new Error("refresh should not run after send failure");
  },
  translate,
  escapeHtml,
  nextTick: async () => {},
});
failureController.render(source);
assert.equal(await failureController.submit("retry <this>"), null);
assert.match(failureElement.innerHTML, /provider &lt;offline&gt;/);
assert.match(failureElement.innerHTML, /retry &lt;this&gt;/, "failed send should restore the draft");
assert.match(failureElement.innerHTML, /agent-compose-status error/);

const refreshFailureElement = createFakeElement();
const refreshFailureController = new AgentComposerController({
  element: refreshFailureElement,
  sendMessage: async () => ({ exit_code: 0, stdout: "sent" }),
  refreshSource: async () => {
    throw new Error("trace unavailable");
  },
  translate,
  escapeHtml,
  nextTick: async () => {},
});
refreshFailureController.render(source);
const refreshFailureResult = await refreshFailureController.submit("send only once");
assert.equal(refreshFailureResult.exit_code, 0, "a refresh failure must not turn a successful send into a failed send");
assert.match(refreshFailureElement.innerHTML, /Sent, refresh failed: trace unavailable/);
assert.doesNotMatch(refreshFailureElement.innerHTML, />send only once</, "successful send must not restore the draft");

const controllerSource = fs.readFileSync(new URL("../src/viewer/agent-composer-controller.js", import.meta.url), "utf8");
const modelSource = fs.readFileSync(new URL("../src/viewer/agent-composer-model.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/viewer/agent-composer-renderer.js", import.meta.url), "utf8");
const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
for (const moduleSource of [controllerSource, modelSource, rendererSource]) {
  assert.doesNotMatch(moduleSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
}
assert.match(controllerSource, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing/);
assert.match(controllerSource, /this\.element\.addEventListener\("submit"/);
assert.match(controllerSource, /this\.element\.addEventListener\("input"/);
assert.equal(
  Object.values(UI_I18N).filter((dictionary) => typeof dictionary.sentRefreshFailed === "string").length,
  Object.keys(UI_I18N).length,
  "refresh failure copy must exist in every UI language",
);

controller.destroy();
failureController.destroy();
refreshFailureController.destroy();
disabledController.destroy();
assert.equal(fakeElement.innerHTML, "");

console.log("agent composer view contract smoke passed");

function createFakeElement() {
  const listeners = new Map();
  return {
    innerHTML: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    },
  };
}

function matchingTarget(selector, values = {}) {
  return {
    ...values,
    matches(value) {
      return value === selector;
    },
  };
}
