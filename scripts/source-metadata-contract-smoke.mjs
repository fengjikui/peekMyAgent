#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decorateSources,
  deleteSourceMeta,
  manualConversationTitle,
  mergedSourceMeta,
  readSourceMeta,
  setSourceMeta,
  sourceMetaKeysForSource,
  sourceMetaKeysForSourceId,
  stableSourceMetaKeys,
} from "../src/server/source-metadata.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-source-metadata-"));
const sourceMetaPath = path.join(tmpDir, "source-meta.json");
const policy = {
  sanitizeTitle(value) {
    return String(value || "")
      .replace(/[\x00-\x1F\x7F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  },
  cleanLabel(value) {
    return String(value || "").replace(/^generic:\s*/i, "");
  },
  projectName(workspace) {
    return workspace ? path.basename(workspace) : "unassigned";
  },
};

try {
  const live = {
    id: "live-watch-1",
    live_watch_id: "watch-1",
    label: "generic: Claude Code",
    kind: "proxy_capture",
    available: true,
    agent: "Claude Code",
    conversation_id: "conversation-1",
    workspace: path.join(tmpDir, "project-a"),
  };
  const persisted = {
    ...live,
    id: "stored-watch-1",
    live_watch_id: null,
    store_watch_id: "watch-1",
    kind: "persisted_capture",
  };

  assert.deepEqual(stableSourceMetaKeys(live), ["conversation-Claude Code-conversation-1"]);
  assert.deepEqual(new Set(sourceMetaKeysForSource(live)), new Set(["live-watch-1", "stored-watch-1", "conversation-Claude Code-conversation-1"]));
  assert.deepEqual(
    new Set(sourceMetaKeysForSourceId(persisted.id, { persistedSource: persisted })),
    new Set(["stored-watch-1", "live-watch-1", "conversation-Claude Code-conversation-1"]),
  );

  const sourceMeta = new Map();
  const aliases = sourceMetaKeysForSourceId(live.id, { liveWatch: { ...live, watch_id: "watch-1" } });
  setSourceMeta({ sourceMeta, sourceMetaPath, policy }, aliases, {
    title: "  Renamed\nsource\u0000  ",
    pinned: true,
  });
  assert.equal(fs.existsSync(`${sourceMetaPath}.tmp`), false, "atomic metadata write leaves no temporary file");

  const reloaded = readSourceMeta(sourceMetaPath, policy);
  assert.equal(reloaded.size, 3, "all live, persisted and conversation aliases survive restart");
  assert.deepEqual(mergedSourceMeta(reloaded, aliases), { pinned: true, title: "Renamed source" });
  assert.equal(manualConversationTitle(reloaded, persisted, policy), "Renamed source");

  reloaded.set("unrelated", { hidden: true });
  const decorated = decorateSources(
    [
      { ...live, id: "unrelated", label: "hidden", conversation_id: "other" },
      persisted,
      { ...live, id: "visible-2", live_watch_id: "watch-2", conversation_id: "conversation-2", label: "generic: Visible two" },
    ],
    reloaded,
    policy,
  );
  assert.deepEqual(decorated.map((source) => source.id), [persisted.id, "visible-2"], "hidden sources are removed and pinned sources sort first");
  assert.equal(decorated[0].label, "Renamed source");
  assert.equal(decorated[0].project, "project-a");
  assert.equal(decorated[1].label, "Visible two");

  deleteSourceMeta({ sourceMeta: reloaded, sourceMetaPath, policy }, aliases);
  const afterDelete = readSourceMeta(sourceMetaPath, policy);
  assert.equal(manualConversationTitle(afterDelete, persisted, policy), null);
  assert.deepEqual(afterDelete.get("unrelated"), { hidden: true }, "deleting one source keeps unrelated metadata");

  console.log("source metadata contract smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
