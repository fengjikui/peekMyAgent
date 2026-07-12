#!/usr/bin/env node
import assert from "node:assert/strict";
import { decoratePersistedSourceTitle, isGenericPersistedSourceLabel, listPersistedSources } from "../src/server/persisted-source-provider.mjs";

const sources = [
  source("active", "Claude Code · 监控一个会话"),
  source("manual", "Claude Code · 监控一个会话"),
  source("stored", "Claude Code · 监控一个会话", { user_title: "Stored title" }),
  source("conversation", "Claude Code · 监控一个会话"),
  source("custom", "Existing useful title"),
  source("inferred", "Claude Code · 监控一个会话"),
];
const initialCaptureLoads = [];
const store = {
  listSources: () => sources,
  loadInitialCaptures(watchId, options) {
    initialCaptureLoads.push({ watchId, options });
    return watchId === "inferred" ? [{ title: "First user request" }] : [];
  },
};
const policy = {
  manualTitle: (item) => (item.store_watch_id === "manual" ? "Manual title" : null),
  conversationTitle: (item) => (item.store_watch_id === "conversation" ? "Conversation title" : null),
  sanitizeTitle: (value) => String(value || "").trim(),
  cleanLabel: (value) => String(value || "").replace(/<[^>]+>/g, "").trim(),
  inferCaptureTitle: (capture) => capture.title,
  modeLabel: () => "监控一个会话",
};

const listed = listPersistedSources({
  store,
  watches: new Map([["live-active", { watch_id: "active" }]]),
  titlePolicy: policy,
});
assert.deepEqual(
  listed.map((item) => item.store_watch_id),
  ["manual", "stored", "conversation", "custom", "inferred"],
  "active watches hide the duplicate persisted source",
);
assert.equal(listed.find((item) => item.store_watch_id === "manual").label, "Manual title");
assert.equal(listed.find((item) => item.store_watch_id === "stored").label, "Stored title");
assert.equal(listed.find((item) => item.store_watch_id === "conversation").label, "Conversation title");
assert.equal(listed.find((item) => item.store_watch_id === "custom").label, "Existing useful title");
assert.equal(listed.find((item) => item.store_watch_id === "inferred").label, "First user request");
assert.deepEqual(initialCaptureLoads, [{ watchId: "inferred", options: { limit: 5 } }], "only generic untitled sources read capture previews");

const priority = decoratePersistedSourceTitle(source("priority", "Useful label", { user_title: "Stored" }), {
  store,
  titlePolicy: { ...policy, manualTitle: () => "Manual" },
});
assert.equal(priority.label, "Manual", "manual conversation metadata wins over stored and inferred titles");
assert.equal(priority.user_title, "Manual");

assert.equal(isGenericPersistedSourceLabel("Claude Code · 监控一个会话", source("x", "", { mode: "single_session" }), { modeLabel: () => "监控一个会话" }), true);
assert.equal(isGenericPersistedSourceLabel("A real task", source("x", ""), { modeLabel: () => "监控一个会话" }), false);
assert.deepEqual(listPersistedSources({ store: null, watches: new Map(), titlePolicy: policy }), []);

console.log("persisted source provider smoke passed");

function source(watchId, label, extra = {}) {
  return {
    id: `stored-${watchId}`,
    store_watch_id: watchId,
    label,
    agent: "Claude Code",
    mode: "single_session",
    confidence: "exact",
    kind: "persisted_capture",
    available: true,
    request_count: 1,
    ...extra,
  };
}
