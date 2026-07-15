#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { VIEWER_INTENTS } from "../src/server/http.mjs";
import { VIEWER_API_ROUTES } from "../src/contracts/viewer-api.mjs";
import { createViewerRouter } from "../src/server/viewer-router.mjs";

const calls = [];
let shutdowns = 0;
const operations = operationFixture(calls, () => {
  shutdowns += 1;
});
const router = createViewerRouter({
  defaultSourceId: "demo-source",
  operations,
  pid: 4242,
  staticAssets: {
    resolve: (pathname) => (pathname === "/asset.js" ? { pathname } : null),
    serve(res) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("asset");
    },
  },
});

assert.throws(() => createViewerRouter({ operations: {} }), /missing operations/);
assert.throws(() => createViewerRouter({ operations, staticAssets: { resolve() {} } }), /resolve and serve/);

for (const { pathname, method } of VIEWER_API_ROUTES) {
  const routeCase = requestCase(pathname, method);
  const response = responseRecorder();
  await router(request(routeCase), response);
  assert.notEqual(response.status, 404, `${method} ${pathname} must be implemented by ViewerRouter`);
  assert.equal(response.status, 200, `${method} ${pathname} should accept its contract request`);
}

const sources = await route(router, requestCase("/api/sources", "GET"));
assert.deepEqual(JSON.parse(sources.text()), [{ id: "source-a" }]);

await route(
  router,
  requestCase("/api/translations?agent=OpenClaw&target_language=ja", "GET"),
);
assert.deepEqual(lastCall(calls, "loadTranslations").input, { agent: "OpenClaw", targetLanguage: "ja" });

await route(
  router,
  requestCase("/api/translations/generate", "POST", {
    intent: VIEWER_INTENTS.translationGenerate,
    body: { source_id: "source-a", force: true },
  }),
);
assert.deepEqual(lastCall(calls, "generateTranslations").input, { source_id: "source-a", force: true });

const missingIntent = await route(
  router,
  requestCase("/api/watch/start", "POST", { body: { agent: "Claude Code" }, intent: null }),
);
assert.equal(missingIntent.status, 403);
assert.match(missingIntent.text(), /explicit local wrapper start intent/);

const wrongMethod = await route(router, requestCase("/api/sources", "POST", { contentType: "" }));
assert.equal(wrongMethod.status, 405);
assert.equal(wrongMethod.headers.allow, "GET");

const crossOrigin = await route(
  router,
  requestCase("/api/sources", "GET", { headers: { host: "evil.example" } }),
);
assert.equal(crossOrigin.status, 403);

const staticAsset = await route(router, requestCase("/asset.js", "GET"));
assert.equal(staticAsset.status, 200);
assert.equal(staticAsset.text(), "asset");

const unknown = await route(router, requestCase("/api/unknown", "GET"));
assert.equal(unknown.status, 404);

await route(router, requestCase("/api/view?source=%20source-a%20", "GET"));
assert.deepEqual(lastCall(calls, "loadViewerData").input, {
  sourceId: "source-a",
  requireSource: true,
  initialLimit: 0,
});

await route(router, requestCase("/api/view?compact=1&initial=1&limit=999", "GET"));
assert.deepEqual(lastCall(calls, "startTimeline").input, {
  sourceId: "demo-source",
  limit: 120,
});

await route(router, requestCase("/api/view?source=source-a&compact=1&cursor=cursor-a&limit=7", "GET"));
assert.deepEqual(lastCall(calls, "nextTimeline").input, {
  sourceId: "source-a",
  cursor: "cursor-a",
  limit: 7,
});

await route(router, requestCase("/api/request?source=source-a&request=request-9", "GET"));
assert.deepEqual(lastCall(calls, "loadRequestDetail").input, {
  sourceId: "source-a",
  requestId: "request-9",
  requireSource: true,
});

await route(
  router,
  requestCase("/api/capture/otel/events?watch_id=query-watch", "POST", {
    intent: VIEWER_INTENTS.otelEventIngest,
    headers: { "x-peekmyagent-watch-id": "header-watch" },
    body: { resourceLogs: [] },
  }),
);
assert.deepEqual(lastCall(calls, "ingestOtelEvents").input, {
  watchId: "header-watch",
  payload: { resourceLogs: [] },
});

const imported = await route(
  router,
  requestCase("/api/trace/import", "POST", {
    intent: VIEWER_INTENTS.traceImport,
    contentType: "application/gzip",
    rawBody: Buffer.from("trace-bundle"),
  }),
);
assert.equal(imported.status, 200);
assert.equal(lastCall(calls, "importTrace").input.toString("utf8"), "trace-bundle");

const exported = await route(
  router,
  requestCase("/api/trace/export?source=source-a", "GET", { intent: VIEWER_INTENTS.traceExport }),
);
assert.equal(exported.status, 200);
assert.equal(exported.headers["content-type"], "application/gzip");
assert.equal(exported.headers["x-peekmyagent-trace-id"], "trace-a");
assert.equal(exported.text(), "bundle");

const shutdown = await route(
  router,
  requestCase("/api/daemon/shutdown", "POST", {
    intent: VIEWER_INTENTS.daemonShutdown,
    body: {},
  }),
);
assert.equal(shutdowns, 0, "shutdown must wait until the HTTP response is flushed");
assert.deepEqual(JSON.parse(shutdown.text()), { ok: true, action: "shutdown", pid: 4242 });
shutdown.emit("finish");
assert.equal(shutdowns, 1);

console.log("viewer router contract smoke passed");

function operationFixture(log, onShutdown) {
  const operation = (name, result) => async (input) => {
    log.push({ name, input });
    return typeof result === "function" ? result(input) : result;
  };
  return {
    listSources: operation("listSources", [{ id: "source-a" }]),
    loadTranslations: operation("loadTranslations", { blocks: [] }),
    generateTranslations: operation("generateTranslations", { generated: 1 }),
    startWatch: operation("startWatch", { watch_id: "watch-a" }),
    stopWatch: operation("stopWatch", { status: "stopped" }),
    pauseWatch: operation("pauseWatch", { status: "paused" }),
    sendAgentMessage: operation("sendAgentMessage", { ok: true }),
    updateSource: operation("updateSource", { ok: true }),
    importTrace: operation("importTrace", { source_id: "imported-a" }),
    exportTrace: operation("exportTrace", {
      filename: "trace-a.pma-trace.gz",
      buffer: Buffer.from("bundle"),
      bundle: { manifest: { trace_id: "trace-a" } },
    }),
    ingestOtelCaptures: operation("ingestOtelCaptures", { ingested: 1 }),
    ingestOtelEvents: operation("ingestOtelEvents", { accepted: 1 }),
    listWatchStatus: operation("listWatchStatus", []),
    daemonPing: operation("daemonPing", { ok: true }),
    daemonStatus: operation("daemonStatus", { ok: true }),
    requestShutdown: onShutdown,
    loadViewerData: operation("loadViewerData", { source: { id: "source-a" }, requests: [], turns: [] }),
    startTimeline: operation("startTimeline", { mode: "initial", requests: [] }),
    nextTimeline: operation("nextTimeline", { mode: "next", requests: [] }),
    loadRequestDetail: operation("loadRequestDetail", { request: { capture_id: "request-9" } }),
  };
}

function requestCase(pathname, method, options = {}) {
  const intentByPath = {
    "/api/translations/generate": VIEWER_INTENTS.translationGenerate,
    "/api/watch/start": VIEWER_INTENTS.watchStart,
    "/api/watch/stop": VIEWER_INTENTS.watchStop,
    "/api/watch/pause": VIEWER_INTENTS.watchPause,
    "/api/agent/send": VIEWER_INTENTS.agentSend,
    "/api/source/update": VIEWER_INTENTS.sourceUpdate,
    "/api/trace/import": VIEWER_INTENTS.traceImport,
    "/api/trace/export": VIEWER_INTENTS.traceExport,
    "/api/capture/otel": VIEWER_INTENTS.otelIngest,
    "/api/capture/otel/events": VIEWER_INTENTS.otelEventIngest,
    "/api/capture/otel/traces": VIEWER_INTENTS.otelEventIngest,
    "/api/daemon/shutdown": VIEWER_INTENTS.daemonShutdown,
  };
  return {
    pathname,
    method,
    body: method === "POST" ? {} : undefined,
    intent: intentByPath[pathname] || null,
    ...options,
  };
}

function request({ pathname = "/", method = "GET", headers = {}, body, rawBody, intent, contentType } = {}) {
  const payload = rawBody ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
  const requestHeaders = { host: "127.0.0.1:43110", ...headers };
  if (method !== "GET" && contentType !== "") requestHeaders["content-type"] = contentType || "application/json";
  if (intent) requestHeaders["x-peekmyagent-intent"] = intent;
  const req = Readable.from(payload.length ? [payload] : []);
  req.url = pathname;
  req.method = method;
  req.headers = requestHeaders;
  return req;
}

function responseRecorder() {
  const response = new EventEmitter();
  response.headers = {};
  response.status = null;
  response.chunks = [];
  response.setHeader = function setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  };
  response.writeHead = function writeHead(status, headers = {}) {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.headers[String(name).toLowerCase()] = value;
  };
  response.end = function end(value = "") {
    this.chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
  };
  response.text = function text() {
    return Buffer.concat(this.chunks).toString("utf8");
  };
  return response;
}

async function route(routerInstance, options) {
  const response = responseRecorder();
  await routerInstance(request(options), response);
  return response;
}

function lastCall(log, name) {
  return [...log].reverse().find((entry) => entry.name === name);
}
