#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildTranslationLookup,
  TranslationCacheController,
  translationAgentCandidatesForData,
  translationContextKey,
} from "../src/viewer/translation-cache-controller.js";

testAgentCandidates();
await testLookupConstruction();
await testCacheFallbackAndLatestRequests();
await testUnavailableAndAutoRefreshLifecycle();
await testScheduledRefreshRevalidatesCurrentCacheContext();
await testBusyGenerationSuppressesAutoRefresh();
await testSourceAndLanguageRaceInvalidation();
await testSameContextLatestLoadWins();
await testLookupRefreshLifecycle();
await testLookupRefreshDuringLoadBuild();
await testLookupRefreshAtCommitBoundary();
await testOperationTokens();
await testCacheFailureState();

console.log("translation cache controller contract smoke passed");

function testAgentCandidates() {
  const candidates = translationAgentCandidatesForData({
    source: {
      agent: "custom-openai",
      id: "live-claude-code-source",
      store_watch_id: "watch-1",
    },
    requests: [
      {
        agent_profile: "custom-openai",
        raw: {
          agent_profile: "trae-cn-profile",
          watch_id: "watch-2",
          body: { metadata: { agent: "anthropic-compatible" } },
        },
      },
    ],
  });
  assert.deepEqual(candidates, [
    "custom-openai",
    "live-claude-code-source",
    "watch-1",
    "trae-cn-profile",
    "watch-2",
    "anthropic-compatible",
    "Claude Code",
    "Trae CN",
  ]);
  assert.deepEqual(translationAgentCandidatesForData(null), []);
  assert.equal(translationContextKey({ sourceId: "source-a", targetLanguage: "zh-CN" }), "source-a\0zh-CN");
}

async function testLookupConstruction() {
  const hashed = [];
  const lookup = await buildTranslationLookup({
    requests: [{ id: "request-1" }, { id: "request-2" }],
    translations: {
      available: true,
      entries: {
        "hash-system:Hello": { translated_text: "你好" },
        "hash-tool_description:List files": { translated_text: "列出文件" },
      },
    },
    collectMaterials(request) {
      return request.id === "request-1"
        ? [
            { kind: "system", source_text: " Hello " },
            { kind: "tool_description", source_text: "List files" },
          ]
        : [{ kind: "system", source_text: "Hello" }];
    },
    async hashMaterial(kind, sourceText) {
      hashed.push([kind, sourceText]);
      return `hash-${kind}:${sourceText}`;
    },
    lookupKey: (kind, sourceText) => `${kind}:${sourceText}`,
  });
  assert.equal(lookup.size, 2, "duplicate materials must be hashed and stored once");
  assert.equal(lookup.get("system:Hello").translated_text, "你好");
  assert.equal(lookup.get("tool_description:List files").translated_text, "列出文件");
  assert.deepEqual(hashed, [
    ["system", "Hello"],
    ["tool_description", "List files"],
  ]);

  assert.equal(
    (await buildTranslationLookup({ translations: { available: false } })).size,
    0,
    "an unavailable cache must not require material helpers",
  );
}

async function testCacheFallbackAndLatestRequests() {
  const cacheDeferred = deferred();
  const loadCalls = [];
  const lookupCalls = [];
  let latestRequests = [{ id: "initial" }];
  const controller = new TranslationCacheController({
    loadCache(agent, language) {
      loadCalls.push([agent, language]);
      if (agent === "first") return Promise.resolve({ available: false, entries: {} });
      return cacheDeferred.promise;
    },
    buildLookup(requests, cache) {
      lookupCalls.push([requests.map((request) => request.id), cache.name]);
      return new Map([["system:Hello", { translated_text: "你好" }]]);
    },
  });
  const loading = controller.loadContext({
    sourceId: "source-a",
    targetLanguage: "zh-CN",
    agents: ["first", "second"],
    requests: latestRequests,
    getRequests: () => latestRequests,
  });
  await Promise.resolve();
  latestRequests = [{ id: "hydrated" }];
  cacheDeferred.resolve({ available: true, name: "second-cache", entries: { hash: {} } });
  const snapshot = await loading;

  assert.deepEqual(loadCalls, [
    ["first", "zh-CN"],
    ["second", "zh-CN"],
  ]);
  assert.deepEqual(lookupCalls, [[ ["hydrated"], "second-cache" ]], "lookup must use requests hydrated during cache I/O");
  assert.equal(snapshot.translations.name, "second-cache");
  assert.equal(snapshot.translationLookup.get("system:Hello").translated_text, "你好");
  assert.equal(controller.available, true);
}

async function testUnavailableAndAutoRefreshLifecycle() {
  const scheduled = [];
  const refreshes = [];
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: false, target_language: "zh-CN", entries: {} }),
    buildLookup: async () => new Map(),
    schedule: (callback) => scheduled.push(callback),
    onAutoRefresh: (payload) => refreshes.push(payload),
  });

  const empty = await controller.loadContext({ sourceId: "empty", targetLanguage: "zh-CN" });
  assert.equal(empty.translations, null);
  assert.equal(scheduled.length, 0, "sources without an Agent identity cannot refresh a provider cache");

  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 1, "a cache miss must schedule at most one automatic refresh per context");
  scheduled.shift()();
  assert.deepEqual(refreshes, [{ sourceId: "source-a", targetLanguage: "zh-CN", agent: "Claude Code" }]);

  controller.clearAutoRefreshAttempts();
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 1, "clearing attempts must allow an explicit language/cache retry");

  const staleScheduled = scheduled.shift();
  await controller.loadContext({ sourceId: "source-b", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  staleScheduled();
  assert.equal(refreshes.length, 1, "a scheduled refresh from an old Source must be discarded");
}

async function testScheduledRefreshRevalidatesCurrentCacheContext() {
  const scheduled = [];
  const refreshes = [];
  let cacheAvailable = false;
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: cacheAvailable, entries: cacheAvailable ? { hash: {} } : {} }),
    buildLookup: async () => new Map(),
    schedule: (callback) => scheduled.push(callback),
    onAutoRefresh: (payload) => refreshes.push(payload),
  });

  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 1);
  cacheAvailable = true;
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  scheduled.shift()();
  assert.equal(refreshes.length, 0, "a cache that became available must cancel an older scheduled refresh");

  cacheAvailable = false;
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 1, "a canceled pending refresh must not consume a future cache-miss attempt");
  controller.clearAutoRefreshAttempts();
  scheduled.shift()();
  assert.equal(refreshes.length, 0, "clearing attempts must invalidate callbacks already queued by the scheduler");

  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  const invalidatedCallback = scheduled.shift();
  controller.invalidate();
  invalidatedCallback();
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 1, "invalidate must clear the consumed attempt so a revisited context can refresh");
}

async function testBusyGenerationSuppressesAutoRefresh() {
  let busy = true;
  const scheduled = [];
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: false, entries: {} }),
    buildLookup: async () => new Map(),
    schedule: (callback) => scheduled.push(callback),
    isGenerationBusy: () => busy,
  });
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "ja", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 0);
  busy = false;
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "ja", agents: ["Claude Code"] });
  assert.equal(scheduled.length, 1, "a busy generation must not consume the future refresh attempt");
}

async function testSourceAndLanguageRaceInvalidation() {
  const slow = deferred();
  const controller = new TranslationCacheController({
    loadCache(agent, language) {
      if (agent === "slow") return slow.promise;
      return Promise.resolve({ available: true, name: `${agent}:${language}`, entries: { hash: {} } });
    },
    buildLookup: async (_requests, cache) => new Map([["cache", cache.name]]),
  });

  const stale = controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["slow"] });
  const current = await controller.loadContext({ sourceId: "source-b", targetLanguage: "ja", agents: ["fast"] });
  slow.resolve({ available: true, name: "stale", entries: { hash: {} } });

  assert.equal(await stale, null, "an old Source cache result must not replace the current context");
  assert.equal(current.translations.name, "fast:ja");
  assert.equal(controller.translations.name, "fast:ja");
  assert.equal(controller.translationLookup.get("cache"), "fast:ja");
}

async function testSameContextLatestLoadWins() {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const controller = new TranslationCacheController({
    loadCache() {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    },
    buildLookup: async (_requests, cache) => new Map([["cache", cache.name]]),
  });
  const stale = controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  const current = controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  second.resolve({ available: true, name: "latest", entries: { hash: {} } });
  assert.equal((await current).translations.name, "latest");
  first.resolve({ available: true, name: "older", entries: { hash: {} } });
  assert.equal(await stale, null, "the latest load for one context must own the commit");
  assert.equal(controller.translations.name, "latest");
}

async function testLookupRefreshLifecycle() {
  const pendingRefresh = deferred();
  let buildCount = 0;
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: true, name: "cache", entries: { hash: {} } }),
    buildLookup(requests) {
      buildCount += 1;
      if (requests[0]?.id === "pending") return pendingRefresh.promise;
      return Promise.resolve(new Map([["request", requests[0]?.id || "none"]]));
    },
  });
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"], requests: [{ id: "initial" }] });
  await controller.refreshLookup([{ id: "hydrated" }]);
  assert.equal(controller.translationLookup.get("request"), "hydrated");

  const staleRefresh = controller.refreshLookup([{ id: "pending" }]);
  await controller.loadContext({ sourceId: "source-b", targetLanguage: "zh-CN", agents: ["Claude Code"], requests: [{ id: "source-b" }] });
  pendingRefresh.resolve(new Map([["request", "stale"]]));
  assert.equal(await staleRefresh, null);
  assert.equal(controller.translationLookup.get("request"), "source-b");
  assert.ok(buildCount >= 3);

  const cacheLoad = deferred();
  const loadingController = new TranslationCacheController({
    loadCache: () => cacheLoad.promise,
    buildLookup: async () => new Map([["request", "loaded"]]),
  });
  const loading = loadingController.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(await loadingController.refreshLookup([{ id: "too-early" }]), null, "detail hydration must not race a cache load");
  cacheLoad.resolve({ available: true, entries: { hash: {} } });
  await loading;
  assert.equal(loadingController.translationLookup.get("request"), "loaded");

  const sameContextRefresh = deferred();
  const sameContextController = new TranslationCacheController({
    loadCache: async () => ({ available: true, entries: { hash: {} } }),
    buildLookup(requests) {
      if (requests[0]?.id === "slow-refresh") return sameContextRefresh.promise;
      return Promise.resolve(new Map([["request", requests[0]?.id || "none"]]));
    },
  });
  await sameContextController.loadContext({
    sourceId: "source-a",
    targetLanguage: "zh-CN",
    agents: ["Claude Code"],
    requests: [{ id: "initial" }],
  });
  const supersededRefresh = sameContextController.refreshLookup([{ id: "slow-refresh" }]);
  await sameContextController.loadContext({
    sourceId: "source-a",
    targetLanguage: "zh-CN",
    agents: ["Claude Code"],
    requests: [{ id: "latest-load" }],
  });
  sameContextRefresh.resolve(new Map([["request", "stale-refresh"]]));
  assert.equal(await supersededRefresh, null, "a newer cache load must invalidate an older lookup refresh in the same context");
  assert.equal(sameContextController.translationLookup.get("request"), "latest-load");
}

async function testLookupRefreshDuringLoadBuild() {
  const buildStarted = deferred();
  const firstBuild = deferred();
  const lookupCalls = [];
  let latestRequests = [{ id: "compact" }];
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: true, entries: { hash: {} } }),
    buildLookup(requests) {
      lookupCalls.push(requests.map((request) => request.id));
      if (lookupCalls.length === 1) {
        buildStarted.resolve();
        return firstBuild.promise;
      }
      return Promise.resolve(new Map([["request", requests[0]?.id || "none"]]));
    },
  });

  const loading = controller.loadContext({
    sourceId: "source-a",
    targetLanguage: "zh-CN",
    agents: ["Claude Code"],
    requests: latestRequests,
    getRequests: () => latestRequests,
  });
  await buildStarted.promise;
  latestRequests = [{ id: "hydrated" }];
  assert.equal(await controller.refreshLookup(latestRequests), null, "detail hydration during a cache load is queued");
  firstBuild.resolve(new Map([["request", "compact"]]));
  await loading;

  assert.deepEqual(lookupCalls, [["compact"], ["hydrated"]]);
  assert.equal(controller.translationLookup.get("request"), "hydrated", "a dirty lookup must rebuild before commit");
}

async function testLookupRefreshAtCommitBoundary() {
  const firstBuild = deferred();
  const lookupCalls = [];
  let latestRequests = [{ id: "compact" }];
  let boundaryRefresh = null;
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: true, entries: { hash: {} } }),
    buildLookup(requests) {
      lookupCalls.push(requests.map((request) => request.id));
      if (lookupCalls.length === 1) return firstBuild.promise;
      return Promise.resolve(new Map([["request", requests[0]?.id || "none"]]));
    },
  });

  const loading = controller.loadContext({
    sourceId: "source-a",
    targetLanguage: "zh-CN",
    agents: ["Claude Code"],
    requests: latestRequests,
    getRequests: () => latestRequests,
  });
  await Promise.resolve();
  firstBuild.resolve(new Map([["request", "compact"]]));
  queueMicrotask(() => {
    latestRequests = [{ id: "hydrated-at-boundary" }];
    boundaryRefresh = controller.refreshLookup(latestRequests);
  });
  await loading;
  await boundaryRefresh;

  assert.deepEqual(lookupCalls, [["compact"], ["hydrated-at-boundary"]]);
  assert.equal(controller.translationLookup.get("request"), "hydrated-at-boundary");
}

async function testOperationTokens() {
  const controller = new TranslationCacheController({
    loadCache: async () => ({ available: true, entries: { hash: {} } }),
    buildLookup: async () => new Map(),
  });
  await controller.loadContext({ sourceId: "source-a", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  const operation = controller.captureOperation({ sourceId: "source-a", targetLanguage: "zh-CN", agent: "Claude Code" });
  assert.ok(operation);
  assert.equal(controller.isOperationCurrent(operation), true);
  assert.equal(controller.captureOperation({ sourceId: "source-a", targetLanguage: "ja", agent: "Claude Code" }), null);
  assert.equal(controller.captureOperation({ sourceId: "source-a", targetLanguage: "zh-CN", agent: "Other" }), null);

  controller.invalidate();
  assert.equal(controller.isOperationCurrent(operation), false, "explicit invalidation must revoke in-flight generation work");
  await controller.loadContext({ sourceId: "source-b", targetLanguage: "zh-CN", agents: ["Claude Code"] });
  assert.equal(controller.isOperationCurrent(operation), false, "a Source switch must keep the old operation revoked");
}

async function testCacheFailureState() {
  const warnings = [];
  const controller = new TranslationCacheController({
    loadCache: async () => {
      throw new Error("cache offline");
    },
    buildLookup: async () => new Map(),
    onWarning: (message, error) => warnings.push([message, error.message]),
  });
  const result = await controller.loadContext({ sourceId: "source-a", targetLanguage: "fr", agents: ["Claude Code"] });
  assert.equal(result.translations.available, false);
  assert.equal(result.translations.error, "cache offline");
  assert.equal(result.translations.target_language, "fr");
  assert.deepEqual(warnings, [["translation cache unavailable", "cache offline"]]);

  controller.invalidate();
  assert.equal(controller.translations, null);
  assert.equal(controller.translationLookup.size, 0);
  assert.equal(controller.snapshot().context, null);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
