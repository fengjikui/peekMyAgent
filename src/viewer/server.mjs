import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSharedCaptureProxy } from "../core/capture-proxy.mjs";
import { importedTracesDir } from "../core/app-paths.mjs";
import { resolveClaudeCodeTargetBaseUrl } from "../core/claude-code-settings.mjs";
import { safeProcessCwd } from "../core/platform.mjs";
import { openPersistenceStore } from "../core/persistence-store.mjs";
import { sourceIdForWatch } from "../core/source-identifiers.mjs";
import { clearViewerRegistry, writeViewerRegistry } from "../core/viewer-registry.mjs";
import { resolveTraeCnDynamicRoute } from "../adapters/trae-cn-integration.mjs";
import {
  assertSafeBindHost,
  httpError,
  serveFile,
  writeJson,
} from "../server/http.mjs";
import { VIEWER_API_LIMITS, sanitizeApiLookupId } from "../server/viewer-api-contract.mjs";
import { createViewerRouter } from "../server/viewer-router.mjs";
import { SourceRepository } from "../server/source-repository.mjs";
import { SourceLifecycleService } from "../server/source-lifecycle-service.mjs";
import { SourceCaptureReader } from "../server/source-capture-reader.mjs";
import { JsonArrayFileIndex } from "../server/json-array-file-index.mjs";
import { AgentSendService } from "../server/agent-send-service.mjs";
import { OtelIngestService } from "../server/otel-ingest-service.mjs";
import { WatchRuntimeService } from "../server/watch-runtime-service.mjs";
import { importedTraceSourceFromDir as sourceFromImportedTraceDir, listImportedTraceSources } from "../server/imported-trace-source-provider.mjs";
import { listFileSources } from "../server/file-source-provider.mjs";
import { listPersistedSources } from "../server/persisted-source-provider.mjs";
import { listLiveSources } from "../server/live-source-provider.mjs";
import {
  SOURCE_META_FILE,
  decorateSource as decorateSourceWithMeta,
  decorateSources as decorateSourceList,
  deleteSourceMeta as deleteSourceMetadata,
  manualConversationTitle as manualSourceConversationTitle,
  mergedSourceMeta,
  readSourceMeta,
  setSourceMeta as persistSourceMeta,
  sourceMetaKeysForSourceId,
  stableSourceMetaKeys,
} from "../server/source-metadata.mjs";
import { SOURCE_TEXT_LIMITS, sanitizeSourceText } from "../server/source-text.mjs";
import { TraceBundleService } from "../server/trace-bundle-service.mjs";
import { TimelineCursorService } from "../server/timeline-cursor-service.mjs";
import { TimelinePageAssembler } from "../server/timeline-page-assembler.mjs";
import { resolveViewerStaticAsset } from "../server/viewer-static-assets.mjs";
import { createViewerTranslationAdapter } from "../server/viewer-translation-adapter.mjs";
import {
  createViewerTraceProjector,
  textPreview,
  uniqueValues,
} from "../server/viewer-trace-projector.mjs";
import {
  cleanTitleText,
  isKnownFrameworkReminderText,
} from "../trace/message-semantics.mjs";

const viewerDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(viewerDir, "../..");
const MAX_SOURCE_TITLE_CHARS = SOURCE_TEXT_LIMITS.title;
const MAX_TRACE_TITLE_CHARS = SOURCE_TEXT_LIMITS.traceTitle;
const MAX_SOURCE_AGENT_CHARS = SOURCE_TEXT_LIMITS.agent;
const MAX_SOURCE_WORKSPACE_CHARS = SOURCE_TEXT_LIMITS.workspace;
const MAX_SOURCE_CONVERSATION_CHARS = SOURCE_TEXT_LIMITS.conversation;
const MAX_TRANSLATION_SOURCE_ID_CHARS = 512;
const MAX_TRANSLATION_REQUEST_ID_CHARS = 256;
const MAX_TRANSLATION_SECTION_CHARS = 48;
const MAX_API_SOURCE_ID_CHARS = VIEWER_API_LIMITS.sourceIdChars;
const MAX_API_REQUEST_ID_CHARS = VIEWER_API_LIMITS.requestIdChars;

const viewerTraceProjector = createViewerTraceProjector({
  sourceDisplay: {
    displayProjectName,
    inferWatchMode,
    captureLabel,
    liveStatusLabel,
  },
});

export async function startViewerServer({ cwd = safeProcessCwd(), host = "127.0.0.1", port = 0, demo, evidencePath, storePath, persistenceStore, capturePort = null, captureHost = host, exitOnShutdown = false, unsafeAllowRemote = false } = {}) {
  assertSafeBindHost(host, { unsafeAllowRemote });
  assertSafeBindHost(captureHost, { unsafeAllowRemote });
  const store = persistenceStore || openPersistenceStore(storePath);
  const sourceMetaPath = path.join(path.dirname(store.path), SOURCE_META_FILE);
  const sourceMeta = readSourceMeta(sourceMetaPath, sourceMetadataPolicy());
  const importsDir = importedTracesDir();
  const closeStore = !persistenceStore;
  const watchRuntime = new WatchRuntimeService({
    cwd,
    store,
    resolveTargetBaseUrl,
    labelFor: (agent, mode) => `${agent} · ${modeLabel(mode)}`,
    resolveDynamicRoute: ({ route, body }) => resolveTraeCnDynamicRoute({ route, body }),
    inferCaptureTitle: viewerTraceProjector.inferCaptureTitle,
    conflict: (message) => httpError(409, message),
    metadata: {
      preferredTitle: (source) => preferredConversationTitle({ store, sourceMeta }, source),
      promoteConversation: (watch) => promoteWatchTitleToConversationMeta(watch, { store, sourceMeta, sourceMetaPath }),
      deleteWatch: (watch) => deleteSourceMeta({ sourceMeta, sourceMetaPath }, sourceMetaKeysForSourceId(watch.id, { liveWatch: watch })),
    },
  });
  let sharedCaptureProxy = null;
  let url = null;
  let closePromise = null;
  sharedCaptureProxy =
    capturePort == null
      ? null
      : await startSharedCaptureProxy({
          host: captureHost,
          port: capturePort,
          getWatch: (watchId) => watchRuntime.resolveForCapture(watchId),
          getWatchForAgentRoute: (context) => watchRuntime.resolveForAgentRoute(context),
          onCapture: (capture, watch) => watchRuntime.onCapture(capture, watch),
          onCaptureUpdate: (capture, watch) => watchRuntime.onCaptureUpdate(capture, watch),
          onCaptureSkipped: (watch) => watchRuntime.onCaptureSkipped(watch),
        });
  watchRuntime.attachSharedProxy(sharedCaptureProxy);
  const runtimeOptions = {
    cwd,
    host,
    unsafeAllowRemote,
    demo,
    evidencePath,
    watchRuntime,
    sourceMeta,
    sourceMetaPath,
    store,
    importsDir,
    sharedCaptureProxy,
    requestShutdown() {
      const forceExitTimer = exitOnShutdown
        ? setTimeout(() => {
            process.exit(0);
          }, 1500)
        : null;
      forceExitTimer?.unref?.();
      setImmediate(() => {
        closeViewer()
          .then(() => {
            if (forceExitTimer) clearTimeout(forceExitTimer);
            if (exitOnShutdown) process.exit(0);
          })
          .catch((error) => {
            if (forceExitTimer) clearTimeout(forceExitTimer);
            console.error(`peekMyAgent daemon shutdown failed: ${error.message}`);
            if (exitOnShutdown) process.exit(1);
          });
      });
    },
  };
  const routeViewerRequest = createViewerRouter({
    unsafeAllowRemote,
    defaultSourceId: demo || null,
    operations: viewerRouterOperations(runtimeOptions),
    staticAssets: {
      resolve(pathname) {
        return resolveViewerStaticAsset(pathname, { viewerDir, projectRoot });
      },
      serve(res, asset) {
        return serveFile(res, asset.filePath, asset.contentType);
      },
    },
  });
  const server = http.createServer(async (req, res) => {
    try {
      await routeViewerRequest(req, res);
    } catch (error) {
      writeJson(res, error.statusCode || 500, { error: error.message });
    }
  });
  const address = await listen(server, host, port);
  url = `http://${address.address}:${address.port}`;
  writeViewerRegistry({ url, capture_url: sharedCaptureProxy?.baseUrl || null, cwd, demo: demo || null, evidence_path: evidencePath || null, started_at: new Date().toISOString() });
  function closeViewer() {
    if (closePromise) return closePromise;
    const closers = [watchRuntime.close()];
    closePromise = new Promise((resolve, reject) => {
      Promise.allSettled(closers).finally(() => {
        server.close((error) => {
          clearViewerRegistry(url);
          if (closeStore) store.close();
          return error ? reject(error) : resolve();
        });
        server.closeIdleConnections?.();
      });
    });
    return closePromise;
  }
  return {
    server,
    url,
    captureUrl: sharedCaptureProxy?.baseUrl || null,
    close: closeViewer,
  };
}

function viewerRouterOperations(options) {
  return {
    listSources: () => listSources(options),
    loadTranslations: (input) => viewerTranslationAdapter(options).loadPublicCache(input),
    generateTranslations: (input) => viewerTranslationAdapter(options).generate(input),
    startWatch: async (input) => {
      const result = await options.watchRuntime.start(input);
      return watchResponse(result.watch, { reused: result.disposition !== "new" });
    },
    stopWatch: async (input) => watchStopResponse(await options.watchRuntime.stop(input)),
    pauseWatch: async (input) => {
      const status = normalizeWatchControlStatus(input);
      return watchControlResponse(await options.watchRuntime.setPaused(input, status === "paused"), options.watchRuntime);
    },
    sendAgentMessage: (input) => agentSendService(options).send(input),
    updateSource: (input) => updateSource(input, options),
    importTrace: (buffer) => traceBundleService(options).import(buffer),
    exportTrace: (sourceId) => traceBundleService(options).export(sourceId),
    ingestOtelCaptures: (input) => otelIngestService(options).ingestCaptures(input),
    ingestOtelEvents: (input) => otelIngestService(options).ingestEvents(input),
    listWatchStatus: () => listWatchStatus(options),
    daemonPing: () => daemonPing(options),
    daemonStatus: () => daemonStatus(options),
    requestShutdown: () => options.requestShutdown?.(),
    loadViewerData: ({ sourceId, requireSource, initialLimit }) => loadViewerData(sourceId, options, { requireSource, initialLimit }),
    startTimeline: ({ sourceId, limit }) => timelineCursorService(options).start({ sourceId, limit }),
    nextTimeline: ({ sourceId, cursor, limit }) => timelineCursorService(options).next({ sourceId, cursor, limit }),
    loadRequestDetail: ({ sourceId, requestId, requireSource }) => loadViewerRequestDetail(sourceId, requestId, options, { requireSource }),
  };
}

function viewerTranslationAdapter(options) {
  return createViewerTranslationAdapter({
    projectRoot,
    loadViewerData: ({ sourceId, requireSource }) => loadViewerData(sourceId, options, { requireSource }),
    loadRequestDetail: ({ sourceId, requestId, requireSource }) => loadViewerRequestDetail(sourceId, requestId, options, { requireSource }),
    sanitize: {
      agent: (value) => sanitizeSourceMetadataText(value, { fallback: "Claude Code", limit: MAX_SOURCE_AGENT_CHARS }),
      targetLanguage: (value) => normalizePathBackedLabel(value, "target_language"),
      sourceId: (value) => sanitizeSourceMetadataText(value, { limit: MAX_TRANSLATION_SOURCE_ID_CHARS }),
      section: (value) => sanitizeSourceMetadataText(value, { limit: MAX_TRANSLATION_SECTION_CHARS }),
      requestId: (value) => sanitizeSourceMetadataText(value, { limit: MAX_TRANSLATION_REQUEST_ID_CHARS }),
    },
    slugify,
    tooLarge: (message) => httpError(413, message),
  });
}

function baseSources({ cwd, demo, evidencePath, watchRuntime }, { includeStats = true } = {}) {
  const fileSources = listFileSources({ cwd, demo, evidencePath, includeStats, summarizeDirectory: sourceListStats });
  if (evidencePath) return fileSources;
  return [...activeWatchSources(watchRuntime), ...fileSources];
}

function listSources(options) {
  return viewerSourceRepository(options).list();
}

function viewerSourceRepository(options) {
  return new SourceRepository({
    listBase: ({ includeStats }) => baseSources(options, { includeStats }),
    listPersisted: () => persistedSources(options),
    listImported: () => importedTraceSources(options),
    decorate: (sources) => decorateSources(sources, options.sourceMeta),
    sanitizeId: (sourceId) => sanitizeApiLookupId(sourceId, { limit: MAX_API_SOURCE_ID_CHARS }),
    notFoundError: (sourceId) => httpError(404, `Source not found: ${sourceId}`),
  });
}

function sourceCaptureReader(options) {
  return new SourceCaptureReader({
    store: options.store,
    files: { readJson, readOptionalJson },
    fileIndex: jsonArrayFileIndex(options),
    runtime: {
      resolveWatch: (source) => options.watchRuntime.find({ id: source.id, watch_id: source.live_watch_id }),
      capturesForWatch: (watch) => options.watchRuntime.capturesFor(watch),
      commandForWatch: liveWatchCommand,
    },
    errors: { requestNotFound: (requestId) => httpError(404, `Request not found: ${requestId}`) },
  });
}

function jsonArrayFileIndex(options) {
  if (options.jsonArrayFileIndex) return options.jsonArrayFileIndex;
  const stateRoot = options.store?.path ? path.dirname(options.store.path) : path.dirname(options.importsDir);
  options.jsonArrayFileIndex = new JsonArrayFileIndex({ cacheDir: path.join(stateRoot, "cache", "json-array-indexes") });
  return options.jsonArrayFileIndex;
}

function timelineCursorService(options) {
  if (options.timelineCursorService) return options.timelineCursorService;
  options.timelineCursorService = new TimelineCursorService({
    resolveSource(sourceId) {
      return viewerSourceRepository(options).resolve(sourceId, { requireSource: Boolean(sourceId) });
    },
    readPage(source, page) {
      return sourceCaptureReader(options).readPage(source, page);
    },
    createAssembler() {
      return new TimelinePageAssembler(viewerTraceProjector.timelineAssemblerDependencies());
    },
  });
  return options.timelineCursorService;
}

function persistedSources({ store, watchRuntime, sourceMeta }) {
  return listPersistedSources({
    store,
    watches: watchRuntime,
    titlePolicy: {
      manualTitle: (source) => manualConversationTitle(sourceMeta, source),
      conversationTitle: (source) => conversationTitleForSource(store, source),
      sanitizeTitle: sanitizeSourceTitle,
      cleanLabel: cleanStoredSourceLabel,
      inferCaptureTitle: viewerTraceProjector.inferCaptureTitle,
      modeLabel,
    },
  });
}

function importedTraceSources({ importsDir }) {
  return listImportedTraceSources({ importsDir, summarizeDirectory: sourceListStats, cleanText: cleanTitleText });
}

function importedTraceSourceFromDir(dir, idPart = path.basename(dir)) {
  return sourceFromImportedTraceDir(dir, idPart, { summarizeDirectory: sourceListStats, cleanText: cleanTitleText });
}

function loadViewerData(sourceId, options, { requireSource = false, initialLimit = 0 } = {}) {
  const repository = viewerSourceRepository(options);
  const source = repository.resolve(sourceId, { requireSource });
  const { captures, debugSources, command, totalCount } = sourceCaptureReader(options).read(source, { limit: initialLimit });
  return viewerTraceProjector.buildData({
    source,
    captures,
    debugSources,
    command,
    partial: viewerTraceProjector.initialPartialInfo({ requestedLimit: initialLimit, loadedCount: captures.length, totalCount }),
  });
}

function loadViewerRequestDetail(sourceId, requestId, options, { requireSource = false } = {}) {
  requestId = sanitizeApiLookupId(requestId, { limit: MAX_API_REQUEST_ID_CHARS });
  if (!requestId) throw httpError(400, "Missing request id");
  const repository = viewerSourceRepository(options);
  const source = repository.resolve(sourceId, { requireSource });
  const { captures, debugSources, startIndex } = sourceCaptureReader(options).readRequestWindow(source, requestId, { previousCount: 1 });
  const request = viewerTraceProjector.projectRequestDetailWindow(captures, source, requestId, { startIndex, debugSources });
  if (!request) throw httpError(404, `Request not found: ${requestId}`);
  return {
    generated_at: new Date().toISOString(),
    source,
    request,
    detail_scope: "request_window",
  };
}

function otelIngestService(options) {
  if (options.otelIngestService) return options.otelIngestService;
  options.otelIngestService = new OtelIngestService({
    store: options.store,
    cwd: options.cwd,
    sanitizeTitle: sanitizeSourceTitle,
    conversationTitle: ({ agent, conversation_id }) => conversationTitleForSource(options.store, { agent, conversation_id }),
    badRequest: (message) => httpError(400, message),
  });
  return options.otelIngestService;
}

function agentSendService(options) {
  if (options.agentSendService) return options.agentSendService;
  options.agentSendService = new AgentSendService({
    resolveWatch: (sourceId) => options.watchRuntime.resolveForSend(sourceId),
    sanitizeSourceId: (value) => sanitizeApiLookupId(value, { limit: MAX_API_SOURCE_ID_CHARS }),
  });
  return options.agentSendService;
}

function promoteWatchTitleToConversationMeta(watch, options = {}) {
  if (!watch?.watch_id || !watch?.agent || !watch?.conversation_id || !options.sourceMeta) return;
  const directKeys = [watch.id, `live-${watch.watch_id}`, sourceIdForWatch(watch.watch_id)].filter(Boolean);
  const directMeta = mergedSourceMeta(options.sourceMeta, directKeys);
  const title = sanitizeSourceTitle(directMeta.title);
  if (!title) return;
  const stableKeys = stableSourceMetaKeys(watch);
  if (!stableKeys.length) return;
  const stableMeta = mergedSourceMeta(options.sourceMeta, stableKeys);
  setSourceMeta(options, stableKeys, { ...stableMeta, ...directMeta, title });
  watch.title = title;
  options.store?.updateConversationTitle?.(watch.agent, watch.conversation_id, title);
}

async function updateSource(input, options) {
  const result = await sourceLifecycleService(options).update(input);
  const cursorService = options.timelineCursorService;
  if (cursorService) {
    for (const sourceId of [input.id, ...(result.affected_ids || [])].filter(Boolean)) cursorService.clearSource(sourceId);
  }
  return result;
}

function sourceLifecycleService(options) {
  const repository = viewerSourceRepository(options);
  return new SourceLifecycleService({
    repository,
    runtime: {
      getWatch: (id) => options.watchRuntime.get(id),
      hasWatch: (id) => options.watchRuntime.has(id),
      removeWatch: (id) => options.watchRuntime.remove(id),
      watchValues: () => options.watchRuntime.values(),
      closeWatch: (watch) => options.watchRuntime.closeWatch(watch),
      sourceForWatch(watch) {
        return activeWatchSource(watch, options.watchRuntime) || null;
      },
    },
    store: {
      findSource: (id) => findPersistedWatchSource(options.store, { watch_id: id }),
      deleteWatch: (watchId) => options.store?.deleteWatch(watchId),
      updateWatchStatus: (watchId, status) => options.store?.updateWatchStatus(watchId, status),
      updateWatchTitle: (watchId, title) => options.store?.updateWatchTitle(watchId, title),
      updateConversationTitle: (agent, conversationId, title) => options.store?.updateConversationTitle?.(agent, conversationId, title),
    },
    metadata: {
      sourceMeta: options.sourceMeta,
      sourceMetaPath: options.sourceMetaPath,
      policy: sourceMetadataPolicy(),
    },
    imports: {
      rootDir: options.importsDir,
      list: () => importedTraceSources(options),
    },
    policy: {
      sanitizeId: (id) => sanitizeApiLookupId(id, { limit: MAX_API_SOURCE_ID_CHARS }),
      sanitizeSelector(value, kind) {
        const limits = {
          agent: MAX_SOURCE_AGENT_CHARS,
          workspace: MAX_SOURCE_WORKSPACE_CHARS,
          project: MAX_SOURCE_TITLE_CHARS,
        };
        return sanitizeSourceMetadataText(value, { limit: limits[kind] || MAX_SOURCE_CONVERSATION_CHARS });
      },
      projectName: displayProjectName,
      metadata: sourceMetadataPolicy(),
    },
    errors: {
      clientError: (message) => httpError(400, message),
      notFound: (message) => httpError(404, message),
    },
  });
}

function traceBundleService(options) {
  return new TraceBundleService({
    repository: viewerSourceRepository(options),
    captureReader: sourceCaptureReader(options),
    importsDir: options.importsDir,
    importedSourceFromDir: importedTraceSourceFromDir,
    sanitizeTitle: sanitizeTraceTitle,
    sanitizeSourceId: (value) => sanitizeApiLookupId(value, { limit: MAX_API_SOURCE_ID_CHARS }),
    errors: {
      client: (message) => httpError(400, message),
      tooLarge: (message) => httpError(413, message),
    },
  });
}

function normalizeWatchControlStatus(input) {
  const rawStatus = String(input.status || input.action || "").toLowerCase();
  if (rawStatus === "resume" || rawStatus === "resumed" || rawStatus === "watching") return "watching";
  if (rawStatus === "pause" || rawStatus === "paused" || rawStatus === "recording_paused") return "paused";
  if (Object.prototype.hasOwnProperty.call(input, "paused")) return input.paused ? "paused" : "watching";
  return "paused";
}

function watchResponse(watch, { reused }) {
  return {
    id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    mode: watch.mode,
    mode_label: modeLabel(watch.mode),
    base_url: watch.base_url,
    workspace: watch.workspace,
    conversation_id: watch.conversation_id,
    provider_id: watch.provider_id,
    target_base_url: watch.target_base_url,
    config_patched: watch.config_patched,
    status: watch.status,
    paused_at: watch.paused_at || null,
    resumed_at: watch.resumed_at || null,
    skipped_while_paused: Number(watch.skipped_while_paused) || 0,
    reused,
    instructions: watchInstructions(watch),
  };
}

function watchControlResponse({ watch, action }, watchRuntime) {
  return {
    ...watchResponse(watch, { reused: true }),
    action,
    request_count: watchRuntime.capturesFor(watch).length,
  };
}

function watchStopResponse({ watch, status, cleared, requestCount }) {
  return {
    id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    status,
    cleared,
    provider_id: watch.provider_id,
    target_base_url: watch.target_base_url,
    config_patched: watch.config_patched,
    request_count: requestCount,
    skipped_while_paused: Number(watch.skipped_while_paused) || 0,
  };
}

function findPersistedWatchSource(store, { watch_id: watchId }) {
  if (!store || !watchId) return null;
  const normalized = String(watchId).startsWith("live-") ? String(watchId).slice("live-".length) : String(watchId);
  return (
    store
      .listSources()
      .find((source) => source.store_watch_id === normalized || source.store_watch_id === watchId || source.id === watchId || source.id === `stored-${normalized}`) || null
  );
}

function daemonPing({ sharedCaptureProxy }) {
  return {
    ok: true,
    api: "viewer",
    pid: process.pid,
    capture_url: sharedCaptureProxy?.baseUrl || null,
    shared_capture_proxy: Boolean(sharedCaptureProxy),
  };
}

function daemonStatus({ watchRuntime, sharedCaptureProxy }) {
  return {
    ok: true,
    api: "viewer",
    pid: process.pid,
    capture_url: sharedCaptureProxy?.baseUrl || null,
    shared_capture_proxy: Boolean(sharedCaptureProxy),
    watches: listActiveWatches(watchRuntime),
  };
}

function cleanStoredSourceLabel(text) {
  const value = String(text || "").trim();
  if (!value || /<system-reminder/i.test(value) || isKnownFrameworkReminderText(value)) return "";
  return textPreview(cleanTitleText(value), 48);
}

function sanitizeTitleText(value, { fallback = "", limit = MAX_SOURCE_TITLE_CHARS } = {}) {
  return sanitizeSourceText(value, { fallback, limit, clean: cleanTitleText });
}

function sanitizeSourceTitle(value) {
  return sanitizeTitleText(value, { limit: MAX_SOURCE_TITLE_CHARS });
}

function sanitizeTraceTitle(value, fallback) {
  return sanitizeTitleText(value, { fallback: fallback || "Imported trace", limit: MAX_TRACE_TITLE_CHARS });
}

function sanitizeSourceMetadataText(value, { fallback = "", limit = MAX_SOURCE_CONVERSATION_CHARS } = {}) {
  return sanitizeTitleText(value, { fallback, limit });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOptionalJson(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function hasCaptureFile(dir) {
  return fs.existsSync(path.join(dir, "proxy-captures.json"));
}

function sourceListStats(dir) {
  if (!hasCaptureFile(dir)) return { request_count: 0, subagent_count: 0, raw_body_bytes: 0 };
  try {
    const captures = readJson(path.join(dir, "proxy-captures.json"));
    const debugSources = readOptionalJson(path.join(dir, "debug-api-sources.json")) || [];
    const requests = captures.map((capture, index) =>
      viewerTraceProjector.summarizeCapture(
        capture,
        { agent: "", confidence: "unknown", kind: "proxy_capture" },
        index,
        debugSources[index],
      ),
    );
    const workspaces = uniqueValues(captures.map((capture) => capture.workspace || capture.body?.workspace));
    const workspace = workspaces[0] || null;
    return {
      request_count: captures.length,
      subagent_count: requests.filter((request) => request.is_subagent).length,
      raw_body_bytes: requests.reduce((sum, request) => sum + request.counts.raw_body_bytes, 0),
      workspace,
      project: displayProjectName(workspace),
    };
  } catch {
    return { request_count: 0, subagent_count: 0, raw_body_bytes: 0 };
  }
}

function activeWatchSources(watchRuntime) {
  return listLiveSources({
    watches: watchRuntime,
    capturesForWatch: (watch) => watchRuntime.capturesFor(watch),
    resolveLabel(watch, captures) {
      const inferredTitle = captures.map(viewerTraceProjector.inferCaptureTitle).find(Boolean);
      return cleanStoredSourceLabel(watch.title || watch.label) || textPreview(cleanTitleText(inferredTitle), 48) || watch.label;
    },
  });
}

function activeWatchSource(watch, watchRuntime) {
  return listLiveSources({
    watches: [watch],
    capturesForWatch: (candidate) => watchRuntime.capturesFor(candidate),
    resolveLabel(candidate, captures) {
      const inferredTitle = captures.map(viewerTraceProjector.inferCaptureTitle).find(Boolean);
      return cleanStoredSourceLabel(candidate.title || candidate.label) || textPreview(cleanTitleText(inferredTitle), 48) || candidate.label;
    },
  })[0] || null;
}

function decorateSources(sources, sourceMeta) {
  return decorateSourceList(sources, sourceMeta, sourceMetadataPolicy());
}

function setSourceMeta(options, keys, meta) {
  persistSourceMeta({ ...options, policy: sourceMetadataPolicy() }, keys, meta);
}

function deleteSourceMeta(options, keys) {
  deleteSourceMetadata({ ...options, policy: sourceMetadataPolicy() }, keys);
}

function preferredConversationTitle({ store, sourceMeta } = {}, source) {
  return manualConversationTitle(sourceMeta, source) || conversationTitleForSource(store, source);
}

function manualConversationTitle(sourceMeta, source) {
  return manualSourceConversationTitle(sourceMeta, source, sourceMetadataPolicy());
}

function conversationTitleForSource(store, source) {
  return sanitizeSourceTitle(store?.conversationTitle?.(source?.agent, source?.conversation_id)) || null;
}

function decorateSource(source, meta = {}) {
  return decorateSourceWithMeta(source, meta, sourceMetadataPolicy());
}

function sourceMetadataPolicy() {
  return {
    sanitizeTitle: sanitizeSourceTitle,
    cleanLabel: cleanStoredSourceLabel,
    projectName: displayProjectName,
  };
}

function listActiveWatches(watchRuntime) {
  return activeWatchSources(watchRuntime).map((source) => ({
    id: source.id,
    watch_id: source.live_watch_id,
    agent: source.agent,
    status: source.live_status,
    base_url: source.path,
    mode: source.mode,
    workspace: source.workspace,
    conversation_id: source.conversation_id,
    provider_id: source.provider_id,
    config_patched: source.config_patched,
    request_count: source.request_count,
    created_at: source.created_at,
    restarted_at: source.restarted_at,
    paused_at: source.paused_at,
    resumed_at: source.resumed_at,
    stopped_at: source.stopped_at,
    last_seen: source.last_seen,
    skipped_while_paused: source.skipped_while_paused,
  }));
}

function listWatchStatus({ watchRuntime, store }) {
  const active = listActiveWatches(watchRuntime);
  const activeWatchIds = new Set(active.map((watch) => watch.watch_id));
  const persisted = store
    ? store
        .listSources()
        .filter((source) => !activeWatchIds.has(source.store_watch_id))
        .map((source) => ({
          id: `live-${source.store_watch_id}`,
          watch_id: source.store_watch_id,
          agent: source.agent,
          status: source.live_status || "stored",
          base_url: null,
          mode: source.mode,
          workspace: source.workspace,
          conversation_id: source.conversation_id,
          provider_id: null,
          config_patched: false,
          request_count: source.request_count,
          created_at: source.created_at,
          restarted_at: null,
          paused_at: null,
          resumed_at: null,
          stopped_at: null,
          last_seen: source.last_seen,
          skipped_while_paused: Number(source.skipped_while_paused) || 0,
          persisted: true,
        }))
    : [];
  return [...active, ...persisted];
}

function liveStatusLabel(status) {
  if (status === "watching") return "监听中";
  if (status === "paused") return "已暂停";
  if (status === "stopped") return "已停止";
  return status || "历史记录";
}

function liveWatchCommand(watch) {
  return {
    generated_at: watch.created_at,
    cwd: watch.workspace,
    watch_id: watch.watch_id,
    conversation_id: watch.conversation_id,
    provider_id: watch.provider_id,
    config_patched: watch.config_patched,
    started_by: watch.started_by,
    mode: watch.mode,
    agent: watch.agent,
    proxy_base_url: watch.base_url,
    target_base_url: watch.target_base_url,
  };
}

function resolveTargetBaseUrl(agent, cwd = defaultWorkspace()) {
  if (/claude/i.test(agent)) return resolveClaudeCodeTargetBaseUrl({ cwd, env: process.env });
  if (/openclaw/i.test(agent)) {
    return process.env.PEEK_OPENCLAW_TARGET_BASE_URL || process.env.OPENCLAW_BASE_URL || process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || null;
  }
  return process.env.PEEK_AGENT_TARGET_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || null;
}

function modeLabel(mode) {
  const labels = {
    next_request: "看下一次请求",
    single_session: "监控一个会话",
    privacy_guard: "检查敏感信息",
  };
  return labels[mode] || mode;
}

function watchInstructions(watch) {
  if (/claude/i.test(watch.agent)) {
    return [
      `ANTHROPIC_BASE_URL=${watch.base_url}`,
      "然后在同一个项目目录里运行 Claude Code。捕获到请求后，左侧实时 watch 会出现请求数量。",
    ];
  }
  return [
    `把 ${watch.agent} 的 provider/base URL 临时设置为：${watch.base_url}`,
    "之后运行一次 Agent 任务。捕获到请求后，左侧实时 watch 会出现请求数量。",
  ];
}

function slugify(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "agent";
}

function normalizePathBackedLabel(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, `${fieldName} is required.`);
  if (/[\/\\\x00-\x1F]/.test(text) || text.includes("..")) {
    throw httpError(400, `${fieldName} contains unsafe path characters.`);
  }
  return text.slice(0, 80);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function displayProjectName(workspace) {
  if (!workspace) return "未归属项目";
  const normalized = String(workspace).replace(/\/$/, "");
  return path.basename(normalized) || normalized;
}

function captureLabel(source) {
  if (source.confidence === "exact" && source.kind === "proxy_capture") return "exact proxy capture";
  if (source.kind === "otel_raw_body") return "otel raw body";
  if (source.kind === "official_debug") return "official debug timeline";
  if (source.kind === "imported_history") return "imported history";
  if (source.kind === "imported_trace") return "imported trace";
  return source.confidence || "unknown";
}

function inferWatchMode(source, requests) {
  if (source.mode) return modeLabel(source.mode);
  if (source.id?.includes("resume") || source.id?.includes("multiturn")) return "监控一个会话";
  if (source.id?.includes("subagent")) return "监控一个会话";
  if (requests.length <= 1) return "看下一次请求";
  return "打开证据包";
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address());
    });
  });
}

export function defaultWorkspace() {
  return safeProcessCwd({ fallback: userHome() || os.tmpdir() });
}
