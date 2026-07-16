#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SourceLifecycleService, removeImportedTraceDir } from "../src/server/source-lifecycle-service.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-source-lifecycle-"));
const sourceMetaPath = path.join(tmpDir, "source-meta.json");
const importsDir = path.join(tmpDir, "imports");
const importedDir = path.join(importsDir, "trace-1");
fs.mkdirSync(importedDir, { recursive: true });
fs.writeFileSync(path.join(importedDir, "manifest.json"), `${JSON.stringify({ title: "Old imported title" })}\n`);

const persisted = {
  id: "stored-watch-1",
  store_watch_id: "watch-1",
  label: "Stored source",
  kind: "persisted_capture",
  available: true,
  agent: "Claude Code",
  conversation_id: "conversation-1",
  workspace: path.join(tmpDir, "project-a"),
};
const imported = {
  id: "imported-trace-1",
  label: "Imported source",
  kind: "imported_trace",
  available: true,
  path: importedDir,
  agent: "Claude Code",
  workspace: path.join(tmpDir, "project-b"),
};
const staticSource = {
  id: "demo-source",
  label: "Demo",
  kind: "fixture",
  available: true,
  agent: "Claude Code",
  workspace: path.join(tmpDir, "project-c"),
};
const sourceMeta = new Map();
const sources = [persisted, imported, staticSource];
const storeCalls = [];
const watches = new Map();
const repository = {
  list: () => sources,
  resolve(id) {
    const source = sources.find((item) => item.id === id);
    if (!source) throw new Error(`Source not found: ${id}`);
    return source;
  },
};
const store = {
  findSource: (id) => (id === persisted.id || id === persisted.store_watch_id ? persisted : null),
  updateWatchTitle: (...args) => storeCalls.push(["watch-title", ...args]),
  updateConversationTitle: (...args) => storeCalls.push(["conversation-title", ...args]),
  updateWatchStatus: (...args) => storeCalls.push(["watch-status", ...args]),
  deleteWatch: (...args) => storeCalls.push(["delete-watch", ...args]),
};
const metadataPolicy = {
  sanitizeTitle: (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 80),
  cleanLabel: (value) => String(value || ""),
  projectName: (workspace) => path.basename(workspace || ""),
};

function createService() {
  return new SourceLifecycleService({
    repository,
    runtime: {
      watches,
      closeWatch: async (watch) => {
        watch.closed = true;
      },
      sourceForWatch: (watch) => ({
        id: watch.id,
        live_watch_id: watch.watch_id,
        label: watch.label,
        kind: "proxy_capture",
        available: true,
        agent: watch.agent,
        conversation_id: watch.conversation_id,
        workspace: watch.workspace,
      }),
    },
    store,
    metadata: { sourceMeta, sourceMetaPath, policy: metadataPolicy },
    imports: { rootDir: importsDir, list: () => sources.filter((source) => source.kind === "imported_trace") },
    policy: {
      sanitizeId: (value) => String(value || "").trim(),
      sanitizeSelector: (value) => String(value || "").trim(),
      projectName: metadataPolicy.projectName,
      metadata: metadataPolicy,
    },
    errors: {
      clientError: (message) => Object.assign(new Error(message), { statusCode: 400 }),
      notFound: (message) => Object.assign(new Error(message), { statusCode: 404 }),
    },
  });
}

try {
  const service = createService();
  const renamed = await service.update({ id: persisted.id, title: "  Renamed\nsource  ", pinned: true });
  assert.equal(renamed.source.label, "Renamed source");
  assert.equal(renamed.source.pinned, true);
  assert.deepEqual(storeCalls.slice(0, 2), [
    ["watch-title", "watch-1", "Renamed source"],
    ["conversation-title", "Claude Code", "conversation-1", "Renamed source"],
  ]);
  assert.equal(sourceMeta.get("live-watch-1")?.title, "Renamed source", "rename is written to live alias");
  assert.equal(sourceMeta.get("stored-watch-1")?.title, "Renamed source", "rename is written to persisted alias");
  assert.equal(sourceMeta.get("conversation-Claude Code-conversation-1")?.title, "Renamed source", "rename is written to conversation alias");

  const importedRename = await service.update({ id: imported.id, title: "Shared trace" });
  assert.equal(importedRename.source.label, "Shared trace");
  assert.equal(JSON.parse(fs.readFileSync(path.join(importedDir, "manifest.json"), "utf8")).title, "Shared trace");

  const liveWatch = {
    id: "live-watch-2",
    watch_id: "watch-2",
    label: "Live source",
    agent: "Claude Code",
    conversation_id: "conversation-2",
    workspace: path.join(tmpDir, "project-live"),
    status: "watching",
  };
  watches.set(liveWatch.id, liveWatch);
  const archived = await service.update({ id: liveWatch.id, archive: true });
  assert.equal(archived.archived, true);
  assert.equal(liveWatch.closed, true);
  assert.equal(watches.has(liveWatch.id), false);
  assert.equal(sourceMeta.get("conversation-Claude Code-conversation-2")?.hidden, true);
  assert.deepEqual(storeCalls.at(-1), ["watch-status", "watch-2", "stopped"]);

  const deleteWatch = { ...liveWatch, id: "live-watch-3", watch_id: "watch-3", conversation_id: "conversation-3", closed: false };
  watches.set(deleteWatch.id, deleteWatch);
  const deletedLive = await service.update({ id: deleteWatch.id, delete: true });
  assert.equal(deletedLive.deleted, true);
  assert.equal(watches.has(deleteWatch.id), false);
  assert.deepEqual(storeCalls.at(-1), ["delete-watch", "watch-3"]);

  await assert.rejects(
    () => service.update({ project: { workspace: staticSource.workspace }, delete: true }),
    (error) => error.statusCode === 400 && /no persisted capture data/i.test(error.message),
  );
  await assert.rejects(() => service.update({ id: staticSource.id, archive: true, delete: true }), /Choose archive or delete/);

  const deletedImported = await service.update({ id: imported.id, delete: true });
  assert.equal(deletedImported.deleted, true);
  assert.equal(fs.existsSync(importedDir), false);
  assert.throws(() => removeImportedTraceDir(tmpDir, importsDir), /outside the imports directory/);

  console.log("source lifecycle service smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
