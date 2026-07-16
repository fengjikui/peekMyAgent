#!/usr/bin/env node
import assert from "node:assert/strict";
import { WatchRuntimeService } from "../src/server/watch-runtime-service.mjs";

class FakeWatchStore {
  constructor() {
    this.watches = new Map();
    this.captures = new Map();
    this.failWatchUpsert = false;
    this.failCaptureInsert = false;
  }

  upsertWatch(watch) {
    if (this.failWatchUpsert) throw new Error("watch persistence unavailable");
    const previous = this.watches.get(watch.watch_id) || {};
    this.watches.set(watch.watch_id, { ...previous, ...serializableWatch(watch) });
  }

  loadWatch(watchId) {
    const normalized = String(watchId || "").replace(/^(live-|stored-)/, "");
    const watch = this.watches.get(normalized);
    return watch ? { ...watch } : null;
  }

  findReusableWatch({ agent, mode, workspace, conversationId }) {
    return [...this.watches.values()]
      .filter((watch) => watch.agent === agent && watch.workspace === workspace)
      .filter((watch) => !mode || watch.mode === mode || !watch.mode)
      .filter((watch) => !conversationId || watch.conversation_id === conversationId)
      .at(-1) || null;
  }

  upsertCapture({ watch, capture }) {
    if (this.failCaptureInsert) throw new Error("SQLite unavailable");
    const captures = this.captures.get(watch.watch_id) || [];
    if (!captures.some((item) => item.capture_id === capture.capture_id)) captures.push(capture);
    this.captures.set(watch.watch_id, captures);
  }

  updateCaptureResponse(capture) {
    const captures = this.captures.get(capture.watch_id) || [];
    const index = captures.findIndex((item) => item.capture_id === capture.capture_id);
    if (index >= 0) captures[index] = capture;
  }

  loadCaptures(watchId) {
    return [...(this.captures.get(watchId) || [])];
  }

  updateWatchStatus(watchId, status) {
    const watch = this.watches.get(watchId);
    if (watch) watch.status = status;
  }

  deleteWatch(watchId) {
    this.watches.delete(watchId);
    this.captures.delete(watchId);
  }
}

const clock = createClock();
const store = new FakeWatchStore();
const proxies = [];
const metadataEvents = [];
const persistenceErrors = [];
let watchSequence = 0;
const runtime = new WatchRuntimeService({
  cwd: "/workspace/default",
  store,
  now: clock.now,
  createWatchId: () => `watch-${++watchSequence}`,
  resolveTargetBaseUrl: (agent) => (agent === "Claude Code" ? "https://provider.example/anthropic" : "https://provider.example/openai"),
  inferCaptureTitle: (capture) => capture.body?.messages?.at(-1)?.content || null,
  startProxy: async (options) => {
    const proxy = fakeProxy(options, `http://127.0.0.1:${44000 + proxies.length}`);
    proxies.push(proxy);
    return proxy;
  },
  metadata: {
    preferredTitle: ({ conversation_id: conversationId }) => (conversationId === "known-conversation" ? "Manual title" : null),
    promoteConversation: (watch) => metadataEvents.push({ type: "promote", watch_id: watch.watch_id, conversation_id: watch.conversation_id }),
    deleteWatch: (watch) => metadataEvents.push({ type: "delete", watch_id: watch.watch_id }),
  },
  resolveDynamicRoute: ({ route, body }) => ({
    id: `live-route-${body.session}`,
    watch_id: `route-${body.session}`,
    label: `Trae CN · ${body.session}`,
    agent: "Trae CN",
    mode: "single_session",
    confidence: "exact",
    kind: "proxy_capture",
    target_base_url: "https://provider.example/openai",
    workspace: "/workspace/trae",
    conversation_id: body.session,
    provider_id: "deepseek",
    config_patched: true,
    started_by: route.agentSlug,
  }),
  logger: { error: (message) => persistenceErrors.push(message) },
});

const created = await runtime.start({
  agent: "Claude Code",
  mode: "single_session",
  workspace: "/workspace/project",
  conversation_id: "known-conversation",
});
assert.equal(created.disposition, "new");
assert.equal(created.watch.watch_id, "watch-1");
assert.equal(created.watch.title, "Manual title");
assert.equal(created.watch.base_url, "http://127.0.0.1:44000/watch/watch-1");
assert.equal(store.loadWatch("watch-1").status, "watching");

const firstCapture = {
  capture_id: "capture-1",
  watch_id: "watch-1",
  request_index: 1,
  received_at: clock.now(),
  body: { messages: [{ role: "user", content: "first request" }] },
};
proxies[0].options.onCapture(firstCapture);
assert.equal(runtime.capturesFor(created.watch).length, 0, "the fake transport owns insertion into its capture array");
proxies[0].captures.push(firstCapture);
assert.equal(runtime.capturesFor(created.watch).length, 1);
assert.equal(store.captures.get("watch-1").length, 1);

const paused = await runtime.setPaused({ watch_id: "watch-1" }, true);
assert.equal(paused.action, "pause");
assert.equal(created.watch.status, "paused");
proxies[0].options.onCaptureSkipped();
assert.equal(created.watch.skipped_while_paused, 1);

const reusedPaused = await runtime.start({
  agent: "Claude Code",
  mode: "single_session",
  workspace: "/workspace/project",
  conversation_id: "known-conversation",
});
assert.equal(reusedPaused.disposition, "reused");
assert.equal(reusedPaused.watch.status, "watching");
assert.equal(reusedPaused.watch.proxy, proxies[0], "a paused dedicated watch reuses its open proxy instead of leaking a port");
assert.equal(proxies.length, 1);

const stopped = await runtime.stop({ watch_id: "watch-1" });
assert.equal(stopped.status, "stopped");
assert.equal(stopped.requestCount, 1);
assert.equal(proxies[0].closeCalls, 1);

const restoredStopped = await runtime.start({ reuse_watch_id: "watch-1" });
assert.equal(restoredStopped.disposition, "reused");
assert.equal(restoredStopped.watch.watch_id, "watch-1");
assert.equal(proxies.length, 2);
assert.equal(proxies[1].captures.length, 1, "dedicated proxy restart keeps prior captures and request counters");
await assert.rejects(() => runtime.start({ reuse_watch_id: "missing-watch" }), (error) => error.statusCode === 409);

const learned = await runtime.start({ agent: "Claude Code", mode: "single_session", workspace: "/workspace/learned", reuse: false });
const learnedCapture = {
  capture_id: "capture-learned",
  watch_id: learned.watch.watch_id,
  request_index: 1,
  conversation_id: "learned-conversation",
  received_at: clock.now(),
  body: { messages: [{ role: "user", content: "Learn my title" }] },
};
learned.watch.proxy.options.onCapture(learnedCapture);
assert.equal(learned.watch.conversation_id, "learned-conversation");
assert.equal(learned.watch.title, "Learn my title");
assert.ok(metadataEvents.some((event) => event.type === "promote" && event.watch_id === learned.watch.watch_id));

store.upsertWatch({
  watch_id: "paused-stored",
  label: "Claude Code · single_session",
  agent: "Claude Code",
  mode: "single_session",
  workspace: "/workspace/paused",
  conversation_id: "paused-conversation",
  status: "paused",
  created_at: clock.now(),
});
store.captures.set("paused-stored", [
  { capture_id: "capture-paused", watch_id: "paused-stored", request_index: 7, received_at: clock.now(), body: {} },
]);
const shared = fakeSharedProxy();
runtime.attachSharedProxy(shared);
const coldPaused = await Promise.all([
  runtime.resolveForCapture("paused-stored"),
  runtime.resolveForCapture("paused-stored"),
]);
assert.equal(coldPaused[0], coldPaused[1], "concurrent cold restores share one operation");
assert.equal(coldPaused[0].status, "paused", "shared proxy cold restore preserves paused state");
assert.equal(shared.added.filter((capture) => capture.capture_id === "capture-paused").length, 1);

store.upsertWatch({
  watch_id: "send-stored",
  label: "Claude Code · single_session",
  agent: "Claude Code",
  mode: "single_session",
  workspace: "/workspace/send",
  conversation_id: "send-conversation",
  status: "watching",
  created_at: clock.now(),
});
const sendWatch = await runtime.resolveForSend("stored-send-stored");
assert.equal(sendWatch.watch_id, "send-stored");
assert.equal(sendWatch.started_by, "dashboard-composer");

const routed = await runtime.resolveForAgentRoute({
  route: { agentSlug: "trae-cn", installId: "install-1", protocol: "openai" },
  body: { session: "session-1" },
});
assert.equal(routed.watch_id, "route-session-1");
assert.match(routed.base_url, /\/agent\/trae-cn\/install-1\/openai$/);
const routedAgain = await runtime.resolveForAgentRoute({
  route: { agentSlug: "trae-cn", installId: "install-1", protocol: "openai" },
  body: { session: "session-1" },
});
assert.equal(routedAgain, routed);

store.failCaptureInsert = true;
runtime.onCapture({ capture_id: "failed", watch_id: routed.watch_id, received_at: clock.now(), body: {} }, routed);
assert.equal(persistenceErrors.length, 1, "capture persistence failures are isolated from upstream Agent traffic");

const cleared = await runtime.stop({ watch_id: routed.watch_id, clear: true });
assert.equal(cleared.cleared, true);
assert.equal(runtime.get(routed.id), null);
assert.equal(store.loadWatch(routed.watch_id), null);
assert.ok(metadataEvents.some((event) => event.type === "delete" && event.watch_id === routed.watch_id));

const rollbackStore = new FakeWatchStore();
rollbackStore.failWatchUpsert = true;
const rollbackProxies = [];
const rollbackRuntime = new WatchRuntimeService({
  store: rollbackStore,
  createWatchId: () => "rollback-watch",
  resolveTargetBaseUrl: () => "https://provider.example/anthropic",
  startProxy: async (options) => {
    const proxy = fakeProxy(options, "http://127.0.0.1:44999");
    rollbackProxies.push(proxy);
    return proxy;
  },
});
await assert.rejects(() => rollbackRuntime.start({ agent: "Claude Code", workspace: "/workspace/rollback", reuse: false }), /watch persistence unavailable/);
assert.equal(rollbackRuntime.listActive().length, 0, "failed initial persistence must roll back the in-memory registration");
assert.equal(rollbackProxies[0].closeCalls, 1, "failed initial persistence must release the dedicated proxy");

await runtime.close();
await runtime.close();
assert.equal(shared.closeCalls, 1, "runtime close is idempotent and owns the shared proxy lifecycle");
assert.equal(proxies[1].closeCalls, 1);
assert.equal(learned.watch.proxy.closeCalls, 1);

console.log("Watch runtime service contract smoke passed");

function fakeProxy(options, baseUrl) {
  return {
    options,
    baseUrl,
    captures: [...(options.captures || [])],
    closeCalls: 0,
    urlForWatch(watchId) {
      return `${baseUrl}/watch/${watchId}`;
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

function fakeSharedProxy() {
  return {
    baseUrl: "http://127.0.0.1:43111",
    captures: [],
    added: [],
    closeCalls: 0,
    addCaptures(captures) {
      for (const capture of captures) {
        if (this.captures.some((item) => item.capture_id === capture.capture_id)) continue;
        this.captures.push(capture);
        this.added.push(capture);
      }
    },
    urlForWatch(watchId) {
      return `${this.baseUrl}/watch/${watchId}`;
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

function createClock() {
  let tick = 0;
  return {
    now() {
      tick += 1;
      return new Date(Date.UTC(2026, 6, 14, 0, 0, tick)).toISOString();
    },
  };
}

function serializableWatch(watch) {
  return Object.fromEntries(Object.entries(watch).filter(([key]) => !["proxy"].includes(key)));
}
