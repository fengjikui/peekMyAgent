#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  VIEWER_CLIENT_STATE_DEFAULTS,
  ViewerClientStore,
  viewerClientManagedKeys,
} from "../src/viewer/client-store.js";

const store = new ViewerClientStore();
assert.deepEqual(store.snapshot(), VIEWER_CLIENT_STATE_DEFAULTS);

const changes = [];
const unsubscribe = store.subscribe((change) => changes.push(change));
const selectionChange = store.setSelection(
  {
    activeSourceId: "source-1",
    activeId: "turn-2",
    activeRequestId: "request-3",
  },
  { reason: "load-source" },
);
assert.equal(selectionChange.changed, true);
assert.deepEqual(selectionChange.changedKeys, ["activeSourceId", "activeId", "activeRequestId"]);
assert.deepEqual(selectionChange.previous, {
  activeSourceId: null,
  activeId: null,
  activeRequestId: null,
});
assert.equal(selectionChange.reason, "load-source");
assert.equal(changes.length, 1, "one user action should emit one atomic store notification");
assert.equal(changes[0].state.activeRequestId, "request-3");

const noChange = store.setSelection({ activeId: "turn-2" }, { reason: "same-turn" });
assert.equal(noChange.changed, false);
assert.equal(changes.length, 1, "an idempotent write should not notify subscribers");

const rawContext = store.setRawContext(
  {
    requestId: "request-4",
    section: "messages",
    mode: "request",
  },
  { reason: "show-raw" },
);
assert.deepEqual(rawContext.changedKeys, ["activeRequestId", "activeRawSection"]);
assert.equal(changes.length, 2, "Raw selection and view mode should change atomically");
assert.equal(changes[1].state.activeRequestId, "request-4");
assert.equal(changes[1].state.activeRawSection, "messages");

assert.throws(
  () => store.setLayout({ activeId: "turn-5" }),
  /layout domain does not own state key: activeId/,
);
assert.throws(() => store.update({ sources: [] }), /does not own state key: sources/);
assert.throws(() => store.subscribe(null), /listener must be a function/);

unsubscribe();
store.setTimeline({ latestOnly: true }, { reason: "toggle-latest" });
assert.equal(changes.length, 2, "unsubscribed listeners should not receive updates");

const initialized = new ViewerClientStore({
  uiLanguage: "en-US",
  targetTranslationLanguage: "ja",
  rawOpen: false,
});
assert.equal(initialized.state.uiLanguage, "en-US");
assert.equal(initialized.state.targetTranslationLanguage, "ja");
assert.equal(initialized.state.rawOpen, false);
assert.equal(initialized.state.activeSourceId, null);
assert.ok(Object.isFrozen(initialized.snapshot()));
assert.deepEqual(viewerClientManagedKeys().sort(), Object.keys(VIEWER_CLIENT_STATE_DEFAULTS).sort());

const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
assert.match(clientSource, /import\s+\{\s*ViewerClientStore\s*\}\s+from\s+"\.\/client-store\.js"/);
assert.match(clientSource, /const\s+clientStore\s*=\s*new\s+ViewerClientStore\(\)/);
for (const key of viewerClientManagedKeys()) {
  const directAssignment = new RegExp(`\\bstate\\.${key}\\s*=(?!=)`, "g");
  assert.equal(
    directAssignment.test(clientSource),
    false,
    `client.js must update ViewerClientStore-managed field through the store: ${key}`,
  );
}

console.log("viewer client store contract smoke passed");
