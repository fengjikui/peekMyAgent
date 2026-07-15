#!/usr/bin/env node
import assert from "node:assert/strict";
import { RawInspectorController } from "../src/viewer/raw-inspector-controller.js";

const requests = new Map([
  ["request-1", { id: "request-1", request_index: 1, compact: true }],
  ["request-2", { id: "request-2", request_index: 2, compact: false }],
  ["request-error", { id: "request-error", request_index: 3, compact: true }],
]);
const root = { className: "empty", innerHTML: "" };
const titleElement = { textContent: "" };
const calls = [];
let context = { requestId: null, section: "full", mode: "request" };
let pendingRequestOne = deferred();
let pendingError = deferred();
let refreshAllowed = true;

const controller = new RawInspectorController({
  root,
  titleElement,
  getRequest: (requestId) => requests.get(requestId) || null,
  getContext: () => context,
  setContext(next) {
    context = { ...next };
    calls.push(["context", next]);
  },
  onContextChanged: () => calls.push(["context-changed"]),
  clearActions: () => calls.push(["clear-actions"]),
  openPanel: () => calls.push(["open-panel"]),
  needsDetail: (request) => request.compact,
  loadDetails(request) {
    calls.push(["load-details", request.id]);
    if (request.id === "request-1") return pendingRequestOne.promise;
    if (request.id === "request-error") return pendingError.promise;
    return Promise.resolve({ ...request, hydrated: true });
  },
  titleFor: (request, section, mode) => `${request.request_index}:${section}:${mode}`,
  renderLoading: (request) => `loading:${request.id}`,
  renderContent: (request, section, mode) => `content:${request.id}:${section}:${mode}:${Boolean(request.hydrated)}`,
  renderError: (error) => `error:${error.message}`,
  decorate: () => calls.push(["decorate"]),
  canRefresh: () => refreshAllowed,
});

const firstShow = controller.show("request-1", "system", { mode: "request" });
assert.equal(root.innerHTML, "loading:request-1");
assert.equal(root.className, "raw-tree");
assert.equal(titleElement.textContent, "1:system:request");
assert.deepEqual(context, { requestId: "request-1", section: "system", mode: "request" });
assert.equal(calls.filter(([name]) => name === "context-changed").length, 1);
assert.equal(calls.some(([name]) => name === "open-panel"), true);

const immediateShow = controller.show("request-2", "response", { mode: "response" });
assert.equal(
  root.innerHTML,
  "content:request-2:response:response:false",
  "a complete request must replace the previous Raw section synchronously",
);
assert.equal(await immediateShow, true);
assert.equal(calls.some(([name, requestId]) => name === "load-details" && requestId === "request-2"), false);
assert.equal(titleElement.textContent, "2:response:response");
pendingRequestOne.resolve({ ...requests.get("request-1"), hydrated: true });
assert.equal(await firstShow, false, "a late detail response must not replace a newer selection");
assert.equal(root.innerHTML, "content:request-2:response:response:false");

const contextChangeCount = calls.filter(([name]) => name === "context-changed").length;
await controller.refresh();
assert.equal(
  calls.filter(([name]) => name === "context-changed").length,
  contextChangeCount,
  "refreshing the same Raw context must preserve search position",
);
assert.equal(root.innerHTML, "content:request-2:response:response:false");

refreshAllowed = false;
const callsBeforeBlockedRefresh = calls.length;
assert.equal(await controller.refresh(), false, "a blocked background refresh must not replace active interaction DOM");
assert.equal(calls.length, callsBeforeBlockedRefresh);
assert.equal(root.innerHTML, "content:request-2:response:response:false");
refreshAllowed = true;

const errorShow = controller.show("request-error", "tools");
assert.equal(root.innerHTML, "loading:request-error");
pendingError.reject(new Error("detail unavailable"));
assert.equal(await errorShow, false);
assert.equal(root.innerHTML, "error:detail unavailable");

const callCount = calls.length;
assert.equal(await controller.show("missing"), false);
assert.equal(calls.length, callCount, "unknown requests must not mutate the panel");

pendingRequestOne = deferred();
const invalidatedShow = controller.show("request-1", "messages");
controller.invalidate();
pendingRequestOne.resolve({ ...requests.get("request-1"), hydrated: true });
assert.equal(await invalidatedShow, false);
assert.equal(root.innerHTML, "loading:request-1", "invalidated work must not render stale content");

console.log("raw inspector controller contract smoke passed");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
