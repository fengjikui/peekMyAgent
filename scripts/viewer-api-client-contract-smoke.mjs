#!/usr/bin/env node
import assert from "node:assert/strict";
import { ViewerApiClient } from "../src/viewer/api-client.js";

const calls = [];
const responses = [];
const fetchContext = { name: "browser-window" };
const api = new ViewerApiClient({
  origin: "http://viewer.test:43110",
  fetchContext,
  fetchImpl: async function fetchWithBrowserContext(path, options = {}) {
    assert.equal(this, fetchContext, "fetch should retain its browser execution context");
    calls.push({ path, options });
    return responses.shift() || jsonResponse({ ok: true });
  },
});

responses.push(jsonResponse([{ id: "source-1" }]));
assert.deepEqual(await api.listSources(), [{ id: "source-1" }]);
assert.deepEqual(calls.at(-1), { path: "/api/sources", options: {} });

responses.push(jsonResponse({ source: { id: "source/a" } }));
await api.viewSource("source/a", { initial: true, limit: 24 });
assert.equal(calls.at(-1).path, "/api/view?source=source%2Fa&compact=1&initial=1&limit=24");

responses.push(jsonResponse({ source: { id: "source/a" } }));
await api.viewSource("source/a", { cursor: "opaque cursor", limit: 100 });
assert.equal(calls.at(-1).path, "/api/view?source=source%2Fa&compact=1&cursor=opaque+cursor&limit=100");

responses.push(jsonResponse({ request: { id: "request 1" } }));
await api.requestDetail("source/a", "request 1");
assert.equal(calls.at(-1).path, "/api/request?source=source%2Fa&request=request%201");

responses.push(jsonResponse({ entries: {} }));
await api.translations("Claude Code", "zh-CN");
assert.equal(calls.at(-1).path, "/api/translations?agent=Claude%20Code&target_language=zh-CN");

responses.push(jsonResponse({ translated: 1 }));
await api.generateTranslations({ source_id: "source-1" });
assertPost(calls.at(-1), "/api/translations/generate", "translation-generate", { source_id: "source-1" });

responses.push(jsonResponse({ sources: [] }));
await api.updateSource({ id: "source-1", archive: true });
assertPost(calls.at(-1), "/api/source/update", "source-update", { id: "source-1", archive: true });

responses.push(jsonResponse({ exit_code: 0 }));
await api.sendAgent({ source_id: "source-1", message: "hello" });
assertPost(calls.at(-1), "/api/agent/send", "agent-send", { source_id: "source-1", message: "hello" });

responses.push(jsonResponse({ ok: true }));
await api.stopWatch({ id: "source-1", clear: false });
assertPost(calls.at(-1), "/api/watch/stop", "watch-stop", { id: "source-1", clear: false });

const bundle = new Uint8Array([1, 2, 3]);
responses.push(jsonResponse({ source_id: "imported-1" }));
await api.importTrace(bundle, "shared.peektrace.json.gz");
assert.equal(calls.at(-1).path, "/api/trace/import");
assert.equal(calls.at(-1).options.method, "POST");
assert.equal(calls.at(-1).options.headers["content-type"], "application/octet-stream");
assert.equal(calls.at(-1).options.headers["x-peekmyagent-intent"], "trace-import");
assert.equal(calls.at(-1).options.headers["x-peekmyagent-file-name"], "shared.peektrace.json.gz");
assert.equal(calls.at(-1).options.body, bundle);

responses.push(new Response(bundle, { status: 200, headers: { "content-type": "application/gzip" } }));
const exportResponse = await api.exportTrace("source/a");
assert.equal(exportResponse.status, 200);
assert.equal(calls.at(-1).path, "/api/trace/export?source=source%2Fa");
assert.equal(calls.at(-1).options.headers["x-peekmyagent-intent"], "trace-export");

const jsonErrorApi = new ViewerApiClient({ fetchImpl: async () => jsonResponse({ error: "denied" }, 403) });
await assert.rejects(() => jsonErrorApi.listSources(), /denied/);
const textErrorApi = new ViewerApiClient({ fetchImpl: async () => new Response("upstream failed", { status: 502 }) });
await assert.rejects(() => textErrorApi.listSources(), /upstream failed/);

console.log("viewer API client contract smoke passed");

function assertPost(call, path, intent, payload) {
  assert.equal(call.path, path);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers["content-type"], "application/json");
  assert.equal(call.options.headers["x-peekmyagent-intent"], intent);
  assert.deepEqual(JSON.parse(call.options.body), payload);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
