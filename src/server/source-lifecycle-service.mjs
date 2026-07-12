import fs from "node:fs";
import path from "node:path";
import {
  decorateSource,
  deleteSourceMeta,
  mergedSourceMeta,
  setSourceMeta,
  sourceMetaKeysForSourceId,
} from "./source-metadata.mjs";

export class SourceLifecycleService {
  constructor({ repository, runtime, store, metadata, imports, policy, errors } = {}) {
    if (!repository || typeof repository.list !== "function" || typeof repository.resolve !== "function") {
      throw new Error("source repository is required");
    }
    this.repository = repository;
    this.runtime = runtime || {};
    this.store = store || null;
    this.metadata = metadata || {};
    this.imports = imports || {};
    this.policy = policy || {};
    this.errors = errors || {};
  }

  async update(input = {}) {
    const wantsArchive = Boolean(input.archive || input.remove);
    const wantsDelete = Boolean(input.delete);
    if (wantsArchive && wantsDelete) throw new Error("Choose archive or delete, not both.");
    if (input.project && typeof input.project === "object") {
      return this.updateProject(input.project, { wantsArchive, wantsDelete });
    }

    const id = this.sanitizeId(input.id);
    if (!id) throw new Error("Missing source id");
    const lifecycle = await this.applyLifecycle(id, { wantsArchive, wantsDelete });
    if (lifecycle) return { id, ...lifecycle, sources: this.repository.list() };

    const context = this.resolveContext(id);
    const metaKeys = sourceMetaKeysForSourceId(id, context);
    const meta = mergedSourceMeta(this.metadata.sourceMeta, metaKeys);
    if (Object.prototype.hasOwnProperty.call(input, "pinned")) meta.pinned = Boolean(input.pinned);
    if (Object.prototype.hasOwnProperty.call(input, "title")) {
      const title = this.sanitizeTitle(input.title);
      if (title) meta.title = title;
      else delete meta.title;
      this.updateRuntimeAndStoreTitle(context, title);
      this.syncConversationTitle(context.liveWatch || context.persistedSource || context.source, title);
      if (context.importedSource?.path) this.updateImportedTraceTitle(context.importedSource.path, title);
    }
    this.setMetadata(metaKeys, meta);
    return {
      id,
      source: decorateSource(context.source, meta, this.policy.metadata),
      sources: this.repository.list(),
    };
  }

  async updateProject(rawSelector, { wantsArchive, wantsDelete } = {}) {
    if (!wantsArchive && !wantsDelete) throw new Error("Project update requires archive or delete.");
    const selector = this.normalizeProjectSelector(rawSelector);
    const sources = this.repository.list().filter((source) => this.sourceMatchesProjectSelector(source, selector));
    if (!sources.length) throw this.notFound(`Project sources not found: ${selectorLabel(selector)}`);
    if (wantsDelete) {
      const nonDeletable = sources.filter((source) => !this.isDeletableSource(source));
      if (nonDeletable.length) {
        throw this.clientError(
          `Some sources in ${selectorLabel(selector)} have no persisted capture data to delete: ${nonDeletable
            .map((source) => source.id)
            .slice(0, 5)
            .join(", ")}`,
        );
      }
    }

    const results = [];
    for (const source of sources) {
      const result = await this.applyLifecycle(source.id, { wantsArchive, wantsDelete });
      results.push({ id: source.id, ...result });
    }
    return {
      project: selector,
      affected_ids: results.map((result) => result.id),
      affected: results.length,
      archived: wantsArchive ? results.length : 0,
      deleted: wantsDelete ? results.length : 0,
      results,
      sources: this.repository.list(),
    };
  }

  async applyLifecycle(id, { wantsArchive, wantsDelete } = {}) {
    if (!wantsArchive && !wantsDelete) return null;
    const liveWatch = this.runtime.watches?.get?.(id) || null;
    if (wantsDelete && liveWatch) {
      await this.runtime.closeWatch?.(liveWatch);
      this.runtime.watches.delete(id);
      this.deleteMetadata(sourceMetaKeysForSourceId(id, { liveWatch }));
      this.store?.deleteWatch?.(liveWatch.watch_id);
      return { removed: true, deleted: true };
    }
    if (wantsArchive && liveWatch) {
      await this.runtime.closeWatch?.(liveWatch);
      liveWatch.status = "stopped";
      this.store?.updateWatchStatus?.(liveWatch.watch_id, liveWatch.status);
      this.runtime.watches.delete(id);
      this.setMetadata(sourceMetaKeysForSourceId(id, { liveWatch }), { hidden: true });
      return { archived: true };
    }

    const persistedSource = this.resolvePersistedSource(id);
    if (wantsDelete && persistedSource?.store_watch_id) {
      this.store?.deleteWatch?.(persistedSource.store_watch_id);
      this.deleteMetadata(sourceMetaKeysForSourceId(id, { persistedSource }));
      return { deleted: true };
    }

    const importedSource = this.resolveImportedSource(id);
    if (wantsDelete && importedSource?.path) {
      removeImportedTraceDir(importedSource.path, this.imports.rootDir);
      this.deleteMetadata([id]);
      return { deleted: true };
    }
    if (wantsDelete) throw new Error("This source has no persisted capture data to delete.");

    const context = this.resolveContext(id, { persistedSource, importedSource });
    const metaKeys = sourceMetaKeysForSourceId(id, context);
    const meta = mergedSourceMeta(this.metadata.sourceMeta, metaKeys);
    if (wantsArchive) meta.hidden = true;
    this.setMetadata(metaKeys, meta);
    return { archived: Boolean(wantsArchive) };
  }

  resolveContext(id, resolved = {}) {
    const liveWatch = this.runtime.watches?.get?.(id) || null;
    const persistedSource = resolved.persistedSource || this.resolvePersistedSource(id);
    const importedSource = resolved.importedSource || this.resolveImportedSource(id);
    const liveSource = liveWatch && typeof this.runtime.sourceForWatch === "function" ? this.runtime.sourceForWatch(liveWatch) : null;
    let source = liveSource || persistedSource || importedSource;
    if (!source) source = this.repository.resolve(id, { requireSource: true });
    return { liveWatch, persistedSource, importedSource, source };
  }

  resolvePersistedSource(id) {
    if (typeof this.store?.findSource === "function") return this.store.findSource(id);
    return null;
  }

  resolveImportedSource(id) {
    const sources = typeof this.imports.list === "function" ? this.imports.list() : [];
    return sources.find((source) => source.id === id) || null;
  }

  isDeletableSource(source) {
    if (!source) return false;
    if (source.live_watch_id || source.store_watch_id || source.kind === "persisted_capture" || source.kind === "imported_trace") return true;
    if (this.runtime.watches?.has?.(source.id)) return true;
    return Boolean(this.resolvePersistedSource(source.id));
  }

  normalizeProjectSelector(input = {}) {
    const sanitize = typeof this.policy.sanitizeSelector === "function" ? this.policy.sanitizeSelector : (value) => String(value || "").trim();
    const agent = sanitize(input.agent || "", "agent");
    const workspace = sanitize(input.workspace || "", "workspace");
    const project = sanitize(input.project || "", "project");
    if (!agent && !workspace && !project) throw new Error("Missing project selector.");
    return { agent, workspace, project };
  }

  sourceMatchesProjectSelector(source, selector) {
    if (selector.agent && source.agent !== selector.agent) return false;
    if (selector.workspace) return String(source.workspace || "") === selector.workspace;
    if (selector.project) {
      const projectName = typeof this.policy.projectName === "function" ? this.policy.projectName(source.workspace) : "";
      return String(source.project || projectName || "") === selector.project;
    }
    return false;
  }

  updateRuntimeAndStoreTitle({ liveWatch, persistedSource }, title) {
    if (liveWatch) liveWatch.title = title || null;
    if (liveWatch?.watch_id) this.store?.updateWatchTitle?.(liveWatch.watch_id, title);
    else if (persistedSource?.store_watch_id) this.store?.updateWatchTitle?.(persistedSource.store_watch_id, title);
  }

  syncConversationTitle(source, title) {
    const agent = source?.agent;
    const conversationId = source?.conversation_id;
    if (!agent || !conversationId) return;
    const cleanTitle = this.sanitizeTitle(title);
    this.store?.updateConversationTitle?.(agent, conversationId, cleanTitle);
    for (const watch of this.runtime.watches?.values?.() || []) {
      if (watch.agent === agent && watch.conversation_id === conversationId) watch.title = cleanTitle || null;
    }
  }

  updateImportedTraceTitle(dir, title) {
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = readOptionalJson(manifestPath);
    if (!manifest) return;
    const value = this.sanitizeTitle(title);
    if (value) manifest.title = value;
    else delete manifest.title;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  setMetadata(keys, meta) {
    setSourceMeta(this.metadata, keys, meta);
  }

  deleteMetadata(keys) {
    deleteSourceMeta(this.metadata, keys);
  }

  sanitizeId(value) {
    return typeof this.policy.sanitizeId === "function" ? this.policy.sanitizeId(value) : String(value || "").trim();
  }

  sanitizeTitle(value) {
    return typeof this.policy.metadata?.sanitizeTitle === "function" ? this.policy.metadata.sanitizeTitle(value) : String(value || "").trim();
  }

  clientError(message) {
    return typeof this.errors.clientError === "function" ? this.errors.clientError(message) : new Error(message);
  }

  notFound(message) {
    return typeof this.errors.notFound === "function" ? this.errors.notFound(message) : new Error(message);
  }
}

export function removeImportedTraceDir(dir, importsDir) {
  const root = path.resolve(importsDir || "");
  const target = path.resolve(dir || "");
  const relative = path.relative(root, target);
  if (!root || !target || !relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to delete an imported trace outside the imports directory.");
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function selectorLabel(selector) {
  return selector.workspace || selector.project || selector.agent || "project";
}

function readOptionalJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
