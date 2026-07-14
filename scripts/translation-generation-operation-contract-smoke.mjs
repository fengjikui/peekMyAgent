#!/usr/bin/env node
import assert from "node:assert/strict";
import { runTranslationGenerationOperation } from "../src/viewer/translation-generation-operation.js";

await testStaleAfterPrepareSkipsProvider();
await testStaleProviderResultSkipsCacheAndUi();
await testStaleCacheReloadSkipsUi();
await testSuccessAndCurrentError();

console.log("translation generation operation contract smoke passed");

async function testStaleAfterPrepareSkipsProvider() {
  const preparation = deferred();
  let current = true;
  let providerCalls = 0;
  const staleStages = [];
  const running = runTranslationGenerationOperation({
    prepare: () => preparation.promise,
    generate: async () => {
      providerCalls += 1;
    },
    isCurrent: () => current,
    onStale: (stage) => staleStages.push(stage),
  });

  current = false;
  preparation.resolve();
  const result = await running;
  assert.equal(result.status, "stale");
  assert.equal(result.stage, "prepare");
  assert.equal(providerCalls, 0, "a Source/language switch during detail hydration must prevent the provider request");
  assert.deepEqual(staleStages, ["prepare"]);
}

async function testStaleProviderResultSkipsCacheAndUi() {
  const provider = deferred();
  let current = true;
  let cacheReloads = 0;
  let uiCommits = 0;
  const running = runTranslationGenerationOperation({
    generate: () => provider.promise,
    reloadCache: async () => {
      cacheReloads += 1;
    },
    isCurrent: () => current,
    onSuccess: () => {
      uiCommits += 1;
    },
  });

  await Promise.resolve();
  current = false;
  provider.resolve({ translated: 1 });
  const result = await running;
  assert.equal(result.stage, "generate");
  assert.equal(cacheReloads, 0);
  assert.equal(uiCommits, 0, "a stale provider result must not update translation UI state");
}

async function testStaleCacheReloadSkipsUi() {
  const cacheReload = deferred();
  let current = true;
  let uiCommits = 0;
  const running = runTranslationGenerationOperation({
    generate: async () => ({ translated: 1 }),
    reloadCache: () => cacheReload.promise,
    isCurrent: () => current,
    onSuccess: () => {
      uiCommits += 1;
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  current = false;
  cacheReload.resolve();
  const result = await running;
  assert.equal(result.stage, "reload-cache");
  assert.equal(uiCommits, 0);
}

async function testSuccessAndCurrentError() {
  const successes = [];
  const success = await runTranslationGenerationOperation({
    generate: async () => ({ translated: 2 }),
    isCurrent: () => true,
    onSuccess: (result) => successes.push(result.translated),
  });
  assert.equal(success.status, "completed");
  assert.deepEqual(successes, [2]);

  const failures = [];
  const failure = await runTranslationGenerationOperation({
    generate: async () => {
      throw new Error("provider offline");
    },
    isCurrent: () => true,
    onError: (error) => failures.push(error.message),
  });
  assert.equal(failure.status, "failed");
  assert.deepEqual(failures, ["provider offline"]);
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
