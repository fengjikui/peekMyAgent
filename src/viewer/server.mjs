import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCaptureProxy, startSharedCaptureProxy } from "../core/capture-proxy.mjs";
import { importedTracesDir } from "../core/app-paths.mjs";
import { claudeCodeProxySettingsArgs, mergeClaudeCodeProcessEnv, resolveClaudeCodeTargetBaseUrl } from "../core/claude-code-settings.mjs";
import { childProcessSpawnConfig, isAccessibleDirectory, safeProcessCwd, userHome } from "../core/platform.mjs";
import { openPersistenceStore } from "../core/persistence-store.mjs";
import { sourceIdForWatch, watchIdFromSourceId } from "../core/source-identifiers.mjs";
import { clearViewerRegistry, writeViewerRegistry } from "../core/viewer-registry.mjs";
import { resolveTraeCnDynamicRoute } from "../adapters/trae-cn-integration.mjs";
import { OTEL_WATCH_KIND, otelDirToCaptures } from "../core/otel-capture.mjs";
import { extractOtelBodyEvents, mergeOtelBodyEvents } from "../core/otel-events.mjs";
import {
  assertSafeBindHost,
  httpError,
  readJsonBody,
  readRawBody,
  rejectWrongMethod,
  serveFile,
  validateAgentSendIntent,
  validateDaemonShutdownIntent,
  validateLocalHttpRequest,
  validateOtelEventIngestIntent,
  validateOtelIngestIntent,
  validateSourceUpdateIntent,
  validateTraceExportIntent,
  validateTraceImportIntent,
  validateTranslationGenerateIntent,
  validateWatchPauseIntent,
  validateWatchStartIntent,
  validateWatchStopIntent,
  viewerSecurityHeaders,
  writeJson,
} from "../server/http.mjs";
import { SourceRepository } from "../server/source-repository.mjs";
import { SourceLifecycleService } from "../server/source-lifecycle-service.mjs";
import { SourceCaptureReader } from "../server/source-capture-reader.mjs";
import { JsonArrayFileIndex } from "../server/json-array-file-index.mjs";
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
import { TRACE_BUNDLE_LIMITS, TraceBundleService } from "../server/trace-bundle-service.mjs";
import { TimelineCursorService } from "../server/timeline-cursor-service.mjs";
import { TimelinePageAssembler } from "../server/timeline-page-assembler.mjs";
import { projectTimelineViewerData } from "../server/timeline-view-projector.mjs";
import { resolveViewerStaticAsset } from "../server/viewer-static-assets.mjs";
import {
  createViewerTraceProjector,
  headerValue,
  textPreview,
  uniqueValues,
} from "../server/viewer-trace-projector.mjs";
import { TranslationMaterialCollector } from "../translation/materials.mjs";
import { TranslationService } from "../translation/service.mjs";
import { extractContentText } from "../trace/content-parts.mjs";
import {
  cleanTitleText,
  compactInjectionText,
  isKnownFrameworkReminderText,
  isSuggestionModeMessage,
  parseCommandMessage,
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
const MAX_API_SOURCE_ID_CHARS = 512;
const MAX_API_REQUEST_ID_CHARS = 256;
const MAX_OTEL_EVENT_WATCHES = 32;
const MAX_OTEL_EVENTS_PER_WATCH = 2400;
const OTEL_WATCH_ID_HEADER = "x-peekmyagent-watch-id";
const INITIAL_VIEW_REQUEST_LIMIT = 32;
const INITIAL_VIEW_REQUEST_LIMIT_MAX = 120;

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
  const watches = new Map();
  const otelBodyEvents = new Map();
  const store = persistenceStore || openPersistenceStore(storePath);
  const sourceMetaPath = path.join(path.dirname(store.path), SOURCE_META_FILE);
  const sourceMeta = readSourceMeta(sourceMetaPath, sourceMetadataPolicy());
  const importsDir = importedTracesDir();
  const closeStore = !persistenceStore;
  let sharedCaptureProxy = null;
  let url = null;
  let closePromise = null;
  sharedCaptureProxy =
    capturePort == null
      ? null
      : await startSharedCaptureProxy({
          host: captureHost,
          port: capturePort,
          async getWatch(watchId) {
            const active = [...watches.values()].find((watch) => watch.watch_id === watchId && ["watching", "paused"].includes(watch.status));
            if (active) return active;
            return restorePersistedWatchForSharedProxy(watchId, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy });
          },
          getWatchForAgentRoute({ route, body }) {
            return resolveDynamicAgentRouteWatch({ route, body, watches, store, sourceMeta, sharedCaptureProxy });
          },
          onCapture(capture, watch) {
            touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
            store?.upsertCapture({ watch, capture });
          },
          onCaptureUpdate(capture, watch) {
            touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
            store?.updateCaptureResponse(capture);
          },
          onCaptureSkipped(watch) {
            touchWatchFromSkippedCapture(watch);
            store?.updateWatchStatus(watch.watch_id, watch.status);
          },
        });
  const runtimeOptions = {
    cwd,
    host,
    unsafeAllowRemote,
    demo,
    evidencePath,
    watches,
    otelBodyEvents,
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
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, runtimeOptions);
    } catch (error) {
      writeJson(res, error.statusCode || 500, { error: error.message });
    }
  });
  const address = await listen(server, host, port);
  url = `http://${address.address}:${address.port}`;
  writeViewerRegistry({ url, capture_url: sharedCaptureProxy?.baseUrl || null, cwd, demo: demo || null, evidence_path: evidencePath || null, started_at: new Date().toISOString() });
  function closeViewer() {
    if (closePromise) return closePromise;
    const uniqueProxies = new Set([...watches.values()].filter((watch) => !watch.proxy_shared).map((watch) => watch.proxy).filter(Boolean));
    const closers = [...uniqueProxies].map((proxy) => proxy.close?.());
    if (sharedCaptureProxy) closers.push(sharedCaptureProxy.close());
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

async function handleRequest(req, res, options) {
  const url = new URL(req.url || "/", "http://peek.local");
  const guard = validateLocalHttpRequest(req, url, options);
  if (guard) return writeJson(res, guard.status, { error: guard.message });
  const staticAsset = resolveViewerStaticAsset(url.pathname, { viewerDir, projectRoot });
  if (staticAsset) return serveFile(res, staticAsset.filePath, staticAsset.contentType);
  if (url.pathname === "/api/sources") {
    if (rejectWrongMethod(req, res, "GET")) return;
    return writeJson(res, 200, listSources(options));
  }
  if (url.pathname === "/api/translations") {
    if (rejectWrongMethod(req, res, "GET")) return;
    return writeJson(
      res,
      200,
      translationService(options).loadPublicCache({
        agent: url.searchParams.get("agent") || "Claude Code",
        targetLanguage: url.searchParams.get("target_language") || "zh-CN",
      }),
    );
  }
  if (url.pathname === "/api/translations/generate") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateTranslationGenerateIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await generateTranslations(req, options));
  }
  if (url.pathname === "/api/watch/start") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateWatchStartIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await startWatch(req, options));
  }
  if (url.pathname === "/api/watch/stop") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateWatchStopIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await stopWatch(req, options));
  }
  if (url.pathname === "/api/watch/pause") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateWatchPauseIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await pauseWatch(req, options));
  }
  if (url.pathname === "/api/agent/send") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateAgentSendIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await sendAgentMessage(req, options));
  }
  if (url.pathname === "/api/source/update") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateSourceUpdateIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await updateSource(req, options));
  }
  if (url.pathname === "/api/trace/import") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateTraceImportIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    const buffer = await readRawBody(req, { maxBytes: TRACE_BUNDLE_LIMITS.importBytes });
    return writeJson(res, 200, traceBundleService(options).import(buffer));
  }
  if (url.pathname === "/api/trace/export") {
    if (rejectWrongMethod(req, res, "GET")) return;
    const intentGuard = validateTraceExportIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return exportTraceBundleResponse(res, url.searchParams.get("source") || "", options);
  }
  if (url.pathname === "/api/capture/otel") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateOtelIngestIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await ingestOtelCaptures(req, options));
  }
  if (url.pathname === "/api/capture/otel/events") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateOtelEventIngestIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    return writeJson(res, 200, await ingestOtelEvents(req, url, options));
  }
  if (url.pathname === "/api/capture/otel/traces") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateOtelEventIngestIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    await readJsonBody(req);
    return writeJson(res, 200, {});
  }
  if (url.pathname === "/api/watch/status") {
    if (rejectWrongMethod(req, res, "GET")) return;
    return writeJson(res, 200, listWatchStatus(options));
  }
  if (url.pathname === "/api/daemon/ping") {
    if (rejectWrongMethod(req, res, "GET")) return;
    return writeJson(res, 200, daemonPing(options));
  }
  if (url.pathname === "/api/daemon/status") {
    if (rejectWrongMethod(req, res, "GET")) return;
    return writeJson(res, 200, daemonStatus(options));
  }
  if (url.pathname === "/api/daemon/shutdown") {
    if (rejectWrongMethod(req, res, "POST")) return;
    const intentGuard = validateDaemonShutdownIntent(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });
    res.once("finish", () => options.requestShutdown?.());
    writeJson(res, 200, { ok: true, action: "shutdown", pid: process.pid });
    return;
  }
  if (url.pathname === "/api/view") {
    if (rejectWrongMethod(req, res, "GET")) return;
    const requestedSource = sanitizeApiLookupId(url.searchParams.get("source"), { limit: MAX_API_SOURCE_ID_CHARS });
    const sourceId = requestedSource || options.demo || null;
    const compact = url.searchParams.get("compact") === "1";
    const cursor = sanitizeApiLookupId(url.searchParams.get("cursor"), { limit: 128 });
    if (compact && (url.searchParams.get("initial") === "1" || cursor)) {
      const limit = boundedPositiveInt(url.searchParams.get("limit"), INITIAL_VIEW_REQUEST_LIMIT, INITIAL_VIEW_REQUEST_LIMIT_MAX);
      const data = cursor
        ? timelineCursorService(options).next({ sourceId, cursor, limit })
        : timelineCursorService(options).start({ sourceId, limit });
      return writeJson(res, 200, data);
    }
    const data = loadViewerData(sourceId, options, {
      requireSource: Boolean(requestedSource),
      initialLimit: initialViewLimit(url.searchParams),
    });
    return writeJson(res, 200, compact ? projectTimelineViewerData(data) : data);
  }
  if (url.pathname === "/api/request") {
    if (rejectWrongMethod(req, res, "GET")) return;
    const requestedSource = sanitizeApiLookupId(url.searchParams.get("source"), { limit: MAX_API_SOURCE_ID_CHARS });
    const sourceId = requestedSource || options.demo || null;
    const requestId = sanitizeApiLookupId(url.searchParams.get("request") || "", { limit: MAX_API_REQUEST_ID_CHARS });
    return writeJson(res, 200, loadViewerRequestDetail(sourceId, requestId, options, { requireSource: Boolean(requestedSource) }));
  }
  writeJson(res, 404, { error: "Not found" });
}

async function generateTranslations(req, options) {
  return translationService(options).generate(await readJsonBody(req));
}

function translationMaterialCollector(targetLanguage) {
  return new TranslationMaterialCollector({
    targetLanguage,
    contentText: extractContentText,
    extractHarnessParts: extractHarnessTranslationParts,
    tooLarge: (message) => httpError(413, message),
  });
}

function translationService(options) {
  return new TranslationService({
    projectRoot,
    materialProvider: {
      fromSource({ sourceId, requestId, section, targetLanguage }) {
        const collector = translationMaterialCollector(targetLanguage);
        if (requestId) {
          const detail = loadViewerRequestDetail(sourceId, requestId, options, { requireSource: true });
          collector.collectRequest(detail.request, detail.source, { section });
        } else {
          const data = loadViewerData(sourceId, options, { requireSource: true });
          for (const request of data.requests || []) collector.collectRequest(request, data.source, { section });
        }
        return { materials: collector.materials(), sourceCount: 1 };
      },
      fromInput({ materials, sourceId, requestId, targetLanguage }) {
        const collector = translationMaterialCollector(targetLanguage);
        collector.collectInput(materials, {
          source_id: sourceId || null,
          watch_id: null,
          request_id: requestId || null,
          request_index: null,
          workspace: null,
          conversation_id: null,
        });
        return { materials: collector.materials(), sourceCount: sourceId ? 1 : 0 };
      },
    },
    sanitize: {
      agent: (value) => sanitizeSourceMetadataText(value, { fallback: "Claude Code", limit: MAX_SOURCE_AGENT_CHARS }),
      targetLanguage: (value) => normalizePathBackedLabel(value, "target_language"),
      sourceId: (value) => sanitizeSourceMetadataText(value, { limit: MAX_TRANSLATION_SOURCE_ID_CHARS }),
      section: (value) => sanitizeSourceMetadataText(value, { limit: MAX_TRANSLATION_SECTION_CHARS }),
      requestId: (value) => sanitizeSourceMetadataText(value, { limit: MAX_TRANSLATION_REQUEST_ID_CHARS }),
    },
    slugify,
  });
}

// Extract the harness-injected prompt fragments from the message history so
// they can be translated + shown original/translated like the system prompt.
// Covers framework reminders (<system-reminder> blocks), the /compact prompt,
// slash-command expansions and suggestion-mode text. Task notifications are
// intentionally excluded (mixed-language content, not a prompt to translate).
function extractHarnessTranslationParts(messages) {
  const output = [];
  const reminderRegex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
  (Array.isArray(messages) ? messages : []).forEach((message, messageIndex) => {
    if (!message || message.role !== "user") return;
    const fullText = extractContentText(message.content);

    const compact = compactInjectionText(message);
    if (compact) {
      output.push({ kind: "harness_compact", text: compact, label: "compact 压缩指令", path: `messages[${messageIndex}]` });
    }

    const commandMessage = parseCommandMessage(message);
    if (commandMessage?.body) {
      output.push({ kind: "harness_command", text: commandMessage.body, label: `命令 ${commandMessage.command}`, path: `messages[${messageIndex}]` });
    }

    if (isSuggestionModeMessage(message)) {
      output.push({ kind: "harness_suggestion", text: fullText, label: "Suggestion 模式", path: `messages[${messageIndex}]` });
    }

    let match;
    let reminderIndex = 0;
    while ((match = reminderRegex.exec(fullText))) {
      const inner = (match[1] || "").trim();
      if (inner) {
        output.push({ kind: "harness_reminder", text: inner, label: `框架提醒 #${reminderIndex + 1}`, path: `messages[${messageIndex}].system-reminder[${reminderIndex}]` });
      }
      reminderIndex += 1;
    }
  });
  return output.filter((part) => part.text);
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boundedPositiveInt(value, fallback, max) {
  return Math.min(positiveInt(value, fallback), max);
}

function baseSources({ cwd, demo, evidencePath, watches }, { includeStats = true } = {}) {
  const fileSources = listFileSources({ cwd, demo, evidencePath, includeStats, summarizeDirectory: sourceListStats });
  if (evidencePath) return fileSources;
  return [...activeWatchSources(watches), ...fileSources];
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
    watches: options.watches,
    store: options.store,
    files: { readJson, readOptionalJson },
    fileIndex: jsonArrayFileIndex(options),
    runtime: { capturesForWatch, commandForWatch: liveWatchCommand },
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

function persistedSources({ store, watches, sourceMeta }) {
  return listPersistedSources({
    store,
    watches,
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

function initialViewLimit(searchParams) {
  if (searchParams.get("initial") !== "1" && !searchParams.has("limit")) return 0;
  return boundedPositiveInt(searchParams.get("limit"), INITIAL_VIEW_REQUEST_LIMIT, INITIAL_VIEW_REQUEST_LIMIT_MAX);
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

// Ingest Claude Code OTel raw-body dumps (subscription/OAuth path). The wrapper
// runs `claude` with OTEL_LOG_RAW_API_BODIES so the agent connects directly to
// the official endpoint (no proxy -> no 403) and dumps request/response bodies
// to a local dir. We read that dir and persist captures exactly like the proxy
// path, so listSources/loadViewerData surface it as a normal persisted source.
async function ingestOtelCaptures(req, options) {
  const input = await readJsonBody(req);
  const { store, cwd, otelBodyEvents } = options;
  const dir = String(input.dir || "").trim();
  if (!dir) throw new Error("ingestOtelCaptures requires a dump dir");
  const watchId = String(input.watch_id || "").trim();
  if (!watchId) throw new Error("ingestOtelCaptures requires watch_id");
  const agent = input.agent || "Claude Code";
  const workspace = input.workspace || cwd;
  const conversationId = input.conversation_id || null;
  const events = otelBodyEvents?.get(watchId) || [];
  const eventCorrelationEnabled = input.event_correlation_enabled === true;
  const finalIngest = input.final === true;
  const captures = otelDirToCaptures(
    dir,
    { watchId, workspace, agent, conversationId },
    {
      events,
      allowHeuristicPairing: !eventCorrelationEnabled || finalIngest,
    },
  );
  const watch = {
    watch_id: watchId,
    label: input.label || `${agent} · OTel`,
    title: sanitizeSourceTitle(input.title || conversationTitleForSource(store, { agent, conversation_id: conversationId })) || null,
    agent,
    mode: input.mode || "single_session",
    confidence: "exact",
    kind: OTEL_WATCH_KIND,
    workspace,
    conversation_id: conversationId,
    status: input.status || "stored",
  };
  let ingested = 0;
  let responses = 0;
  let nextRequestIndex = store?.nextRequestIndex(watchId) || 1;
  for (const capture of captures) {
    if (!store?.hasRequest(capture.capture_id)) {
      capture.request_index = nextRequestIndex;
      nextRequestIndex += 1;
    }
    const result = store?.upsertCapture({ watch, capture });
    if (result?.inserted) ingested += 1;
    // Always attempt the response update: on incremental re-ingest the request
    // may already exist while its response was dumped only afterwards.
    if (capture.response && store?.updateCaptureResponse(capture)?.updated) responses += 1;
  }
  const result = {
    ok: true,
    watch_id: watchId,
    source_id: sourceIdForWatch(watchId),
    total: captures.length,
    ingested,
    responses,
    event_correlations: events.length,
  };
  if (finalIngest) otelBodyEvents?.delete(watchId);
  return result;
}

async function ingestOtelEvents(req, url, { otelBodyEvents }) {
  // OTLP exporters do not consistently preserve endpoint query strings. The
  // dedicated header is the stable transport; the query remains for backward
  // compatibility with older wrappers and direct smoke fixtures.
  const watchId = sanitizeApiLookupId(
    headerValue(req.headers || {}, OTEL_WATCH_ID_HEADER) || url.searchParams.get("watch_id"),
    { limit: MAX_API_REQUEST_ID_CHARS },
  );
  if (!watchId) throw httpError(400, "OTel event ingest requires watch_id");
  const payload = await readJsonBody(req);
  const incoming = extractOtelBodyEvents(payload, { maxEvents: MAX_OTEL_EVENTS_PER_WATCH });
  const merged = mergeOtelBodyEvents(otelBodyEvents?.get(watchId) || [], incoming, { maxEvents: MAX_OTEL_EVENTS_PER_WATCH });
  if (otelBodyEvents) {
    otelBodyEvents.delete(watchId);
    while (otelBodyEvents.size >= MAX_OTEL_EVENT_WATCHES) {
      const oldestWatchId = otelBodyEvents.keys().next().value;
      if (!oldestWatchId) break;
      otelBodyEvents.delete(oldestWatchId);
    }
    otelBodyEvents.set(watchId, merged);
  }
  return { accepted: incoming.length, indexed: merged.length };
}

async function startWatch(req, { cwd, watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy }) {
  const input = await readJsonBody(req);
  const agent = input.agent || "Claude Code";
  const mode = input.mode || "next_request";
  const workspace = input.workspace || cwd;
  const conversationId = input.conversation_id || null;
  if (input.reuse_watch_id) {
    const explicitReusable = findWatch(watches, { id: input.reuse_watch_id, watch_id: input.reuse_watch_id });
    if (explicitReusable) return reuseWatch(explicitReusable, input, { store, sourceMeta, sourceMetaPath, sharedCaptureProxy });
    const persistedReusable = findPersistedWatchSource(store, { watch_id: input.reuse_watch_id });
    if (persistedReusable) return restorePersistedWatch(persistedReusable, input, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy });
    throw httpError(409, `Requested watch is no longer available for reuse: ${input.reuse_watch_id}`);
  }
  if (input.reuse !== false) {
    const existing = findReusableWatch(watches, { agent, mode, workspace, conversationId });
    if (existing) return reuseWatch(existing, input, { store, sourceMeta, sourceMetaPath, sharedCaptureProxy });
    const persisted = findReusablePersistedWatch(store, { agent, mode, workspace, conversationId });
    if (persisted) return restorePersistedWatch(persisted, input, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy });
  }
  const targetBaseUrl = input.target_base_url || resolveTargetBaseUrl(agent, workspace);
  if (!targetBaseUrl) {
    throw new Error(`Missing upstream base URL for ${agent}. Set ANTHROPIC_BASE_URL for Claude Code or OPENAI_BASE_URL/OPENCLAW_BASE_URL for OpenClaw before starting the viewer.`);
  }
  const watchId = `${slugify(agent)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  let watch;
  const proxy =
    sharedCaptureProxy ||
    (await startCaptureProxy({
      targetBaseUrl,
      preserveTargetPathPrefix: true,
      defaultAttribution: {
        watchId,
        agentProfile: agent,
        workspace,
        conversationId,
      },
      shouldCapture() {
        return watch?.status !== "paused";
      },
      onCapture(capture) {
        touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
        store?.upsertCapture({ watch, capture });
      },
      onCaptureUpdate(capture) {
        touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
        store?.updateCaptureResponse(capture);
      },
      onCaptureSkipped() {
        touchWatchFromSkippedCapture(watch);
        store?.updateWatchStatus(watch.watch_id, watch.status);
      },
    }));
  const sourceId = `live-${watchId}`;
  const inheritedTitle = preferredConversationTitle({ store, sourceMeta }, { agent, conversation_id: conversationId });
  watch = {
    id: sourceId,
    watch_id: watchId,
    label: `${agent} · ${modeLabel(mode)}`,
    title: inheritedTitle || null,
    agent,
    mode,
    confidence: "exact",
    kind: "proxy_capture",
    note: "实时监听中；将 Agent base URL 临时指向本地代理后开始捕获。",
    target_base_url: targetBaseUrl,
    base_url: proxy.urlForWatch(watchId),
    proxy,
    proxy_shared: Boolean(sharedCaptureProxy),
    created_at: new Date().toISOString(),
    workspace,
    conversation_id: conversationId,
    provider_id: input.provider_id || null,
    config_patched: Boolean(input.config_patched),
    started_by: input.started_by || "viewer",
    status: "watching",
    skipped_while_paused: 0,
  };
  watches.set(sourceId, watch);
  store?.upsertWatch(watch);
  return watchResponse(watch, { reused: false });
}

async function reuseWatch(watch, input, { store, sourceMeta, sourceMetaPath, sharedCaptureProxy } = {}) {
  if (watch.status === "watching") return watchResponse(watch, { reused: true });
  const targetBaseUrl = input.target_base_url || watch.target_base_url || resolveTargetBaseUrl(watch.agent, watch.workspace);
  if (!targetBaseUrl) throw new Error(`Missing upstream base URL for ${watch.agent}.`);
  if (sharedCaptureProxy) {
    watch.proxy = sharedCaptureProxy;
    watch.proxy_shared = true;
    watch.base_url = sharedCaptureProxy.urlForWatch(watch.watch_id);
    watch.target_base_url = targetBaseUrl;
    watch.status = "watching";
    watch.proxy_closed = false;
    watch.restarted_at = new Date().toISOString();
    watch.stopped_at = null;
    watch.provider_id = input.provider_id || watch.provider_id || null;
    watch.config_patched = Boolean(input.config_patched || watch.config_patched);
    watch.started_by = input.started_by || watch.started_by;
    if (input.conversation_id && !watch.conversation_id) watch.conversation_id = input.conversation_id;
    store?.upsertWatch(watch);
    return watchResponse(watch, { reused: true });
  }
  const captures = watch.proxy?.captures || [];
  const proxy = await startCaptureProxy({
    targetBaseUrl,
    preserveTargetPathPrefix: true,
    captures,
      defaultAttribution: {
        watchId: watch.watch_id,
        agentProfile: watch.agent,
        workspace: watch.workspace,
        conversationId: input.conversation_id || watch.conversation_id || null,
      },
      shouldCapture() {
        return watch.status !== "paused";
      },
      onCapture(capture) {
        touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
        store?.upsertCapture({ watch, capture });
      },
      onCaptureUpdate(capture) {
        touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
        store?.updateCaptureResponse(capture);
      },
      onCaptureSkipped() {
        touchWatchFromSkippedCapture(watch);
        store?.updateWatchStatus(watch.watch_id, watch.status);
      },
    });
  watch.proxy = proxy;
  watch.base_url = proxy.urlForWatch(watch.watch_id);
  watch.target_base_url = targetBaseUrl;
  watch.status = "watching";
  watch.proxy_closed = false;
  watch.restarted_at = new Date().toISOString();
  watch.stopped_at = null;
  watch.provider_id = input.provider_id || watch.provider_id || null;
  watch.config_patched = Boolean(input.config_patched || watch.config_patched);
  watch.started_by = input.started_by || watch.started_by;
  if (input.conversation_id && !watch.conversation_id) watch.conversation_id = input.conversation_id;
  store?.upsertWatch(watch);
  return watchResponse(watch, { reused: true });
}

async function restorePersistedWatch(source, input, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy } = {}) {
  const watchId = source.store_watch_id;
  if (!watchId) throw new Error("Persisted watch is missing store_watch_id");
  const targetBaseUrl = input.target_base_url || resolveTargetBaseUrl(source.agent, source.workspace);
  if (!targetBaseUrl) throw new Error(`Missing upstream base URL for ${source.agent}.`);
  const captures = store?.loadCaptures(watchId) || [];
  let proxy = sharedCaptureProxy;
  if (proxy) {
    proxy.addCaptures?.(captures);
  } else {
    proxy = await startCaptureProxy({
      targetBaseUrl,
      preserveTargetPathPrefix: true,
      captures,
      defaultAttribution: {
        watchId,
        agentProfile: source.agent,
        workspace: source.workspace,
        conversationId: input.conversation_id || source.conversation_id || null,
      },
      shouldCapture() {
        return watch?.status !== "paused";
      },
      onCapture(capture) {
        touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
        store?.upsertCapture({ watch, capture });
      },
      onCaptureUpdate(capture) {
        touchWatchFromCapture(watch, capture, { store, sourceMeta, sourceMetaPath });
        store?.updateCaptureResponse(capture);
      },
      onCaptureSkipped() {
        touchWatchFromSkippedCapture(watch);
        store?.updateWatchStatus(watch.watch_id, watch.status);
      },
    });
  }

  const watch = {
    id: `live-${watchId}`,
    watch_id: watchId,
    label: source.original_label || source.label || `${source.agent} · ${modeLabel(source.mode || input.mode || "single_session")}`,
    title: source.user_title || preferredConversationTitle({ store, sourceMeta }, { agent: source.agent, conversation_id: input.conversation_id || source.conversation_id }) || null,
    agent: source.agent,
    mode: source.mode || input.mode || "single_session",
    confidence: source.confidence || "exact",
    kind: "proxy_capture",
    note: "从本地持久化监听恢复；继续写入同一个 watch。",
    target_base_url: targetBaseUrl,
    base_url: proxy.urlForWatch(watchId),
    proxy,
    proxy_shared: Boolean(sharedCaptureProxy),
    created_at: source.created_at || new Date().toISOString(),
    workspace: source.workspace || input.workspace || null,
    conversation_id: input.conversation_id || source.conversation_id || null,
    provider_id: input.provider_id || null,
    config_patched: Boolean(input.config_patched),
    started_by: input.started_by || "viewer",
    status: "watching",
    restarted_at: new Date().toISOString(),
    stopped_at: null,
    paused_at: null,
    skipped_while_paused: Number(source.skipped_while_paused) || 0,
    last_seen: source.last_seen || null,
  };
  watches?.set(watch.id, watch);
  store?.upsertWatch(watch);
  return watchResponse(watch, { reused: true });
}

async function restorePersistedWatchForSharedProxy(watchId, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy } = {}) {
  if (!sharedCaptureProxy) return null;
  const source = findPersistedWatchSource(store, { watch_id: watchId });
  if (!source || !["watching", "paused"].includes(source.live_status)) return null;
  const response = await restorePersistedWatch(
    source,
    {
      target_base_url: resolveTargetBaseUrl(source.agent, source.workspace),
      workspace: source.workspace,
      conversation_id: source.conversation_id,
      started_by: "shared-proxy-auto-restore",
    },
    { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy },
  );
  return watches.get(response.id) || null;
}

function touchWatchFromCapture(watch, capture, options = {}) {
  if (!watch || !capture) return;
  const learnedConversationId = !watch.conversation_id && capture.conversation_id;
  if (learnedConversationId) {
    watch.conversation_id = capture.conversation_id;
    promoteWatchTitleToConversationMeta(watch, options);
  }
  if (!watch.title) watch.title = viewerTraceProjector.inferCaptureTitle(capture);
  watch.last_seen = capture.response?.received_at || capture.received_at || new Date().toISOString();
  if (capture.response?.received_at) watch.last_response_seen = capture.response.received_at;
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

function touchWatchFromSkippedCapture(watch) {
  if (!watch) return;
  watch.skipped_while_paused = (Number(watch.skipped_while_paused) || 0) + 1;
  watch.last_seen = new Date().toISOString();
}

async function updateSource(req, options) {
  const input = await readJsonBody(req);
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
      watches: options.watches,
      closeWatch: closeWatchProxy,
      sourceForWatch(watch) {
        return activeWatchSources(new Map([[watch.id, watch]])).find((source) => source.id === watch.id) || null;
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

function exportTraceBundleResponse(res, sourceId, options) {
  const exported = traceBundleService(options).export(sourceId);
  res.writeHead(200, {
    ...viewerSecurityHeaders(),
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${exported.filename}"`,
    "cache-control": "no-store",
    "x-peekmyagent-trace-id": exported.bundle.manifest.trace_id,
  });
  res.end(exported.buffer);
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

async function stopWatch(req, { watches, sourceMeta, sourceMetaPath, store }) {
  const input = await readJsonBody(req);
  const watch = findWatch(watches, input);
  if (!watch) throw new Error("Watch not found");
  await closeWatchProxy(watch);
  watch.status = "stopped";
  watch.stopped_at = new Date().toISOString();
  if (input.clear) {
    watches.delete(watch.id);
    deleteSourceMeta({ sourceMeta, sourceMetaPath }, sourceMetaKeysForSourceId(watch.id, { liveWatch: watch }));
    store?.deleteWatch(watch.watch_id);
    return watchStopResponse(watch, { status: "cleared", cleared: true });
  }
  store?.updateWatchStatus(watch.watch_id, watch.status);
  return watchStopResponse(watch, { status: watch.status, cleared: false });
}

async function pauseWatch(req, { watches, store }) {
  const input = await readJsonBody(req);
  const watch = findWatch(watches, input);
  if (!watch) throw new Error("Watch not found");
  const status = normalizeWatchControlStatus(input);
  if (status === "paused") {
    if (watch.status === "stopped") throw new Error("Stopped watches cannot be paused. Start or reuse the watch first.");
    watch.status = "paused";
    watch.paused_at = new Date().toISOString();
    watch.resumed_at = null;
  } else {
    if (watch.status === "stopped") throw new Error("Stopped watches cannot be resumed. Start or reuse the watch first.");
    watch.status = "watching";
    watch.resumed_at = new Date().toISOString();
    watch.paused_at = null;
  }
  store?.updateWatchStatus(watch.watch_id, watch.status);
  return watchControlResponse(watch, { action: status === "paused" ? "pause" : "resume" });
}

async function sendAgentMessage(req, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy }) {
  const input = await readJsonBody(req);
  const sourceId = sanitizeApiLookupId(input.source_id || input.id, { limit: MAX_API_SOURCE_ID_CHARS });
  const message = String(input.message || "").trim();
  if (!sourceId) throw new Error("Missing source_id");
  if (!message) throw new Error("Message is empty");
  if (message.length > 12000) throw new Error("Message is too long; please keep it under 12000 characters.");
  const watch = await resolveAgentSendWatch(sourceId, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy });
  if (!watch) throw new Error("Live Agent session not found. Start the Agent through peekMyAgent first.");
  if (watch.status === "stopped") throw new Error("This Agent watch has stopped. Restart or create a new captured session before sending.");
  const command = buildAgentSendCommand(watch, message);
  const startedAt = new Date().toISOString();
  const result = await execAgentCommand(command);
  return {
    ok: true,
    source_id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    status: watch.status,
    sent_at: startedAt,
    completed_at: new Date().toISOString(),
    command: {
      name: command.command,
      args: redactCommandArgs(command.args),
      cwd: command.cwd,
    },
    delivery: command.delivery || null,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function resolveAgentSendWatch(sourceId, { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy }) {
  const active = findWatch(watches, { id: sourceId, watch_id: sourceId });
  if (active) return active;
  const source = findPersistedWatchSource(store, { watch_id: sourceId });
  if (!source || !["watching", "paused"].includes(source.live_status)) return null;
  const restored = await restorePersistedWatch(
    source,
    {
      workspace: source.workspace,
      conversation_id: source.conversation_id,
      started_by: "dashboard-composer",
    },
    { watches, store, sourceMeta, sourceMetaPath, sharedCaptureProxy },
  );
  return watches.get(restored.id) || null;
}

function buildAgentSendCommand(watch, message) {
  const cwd = agentCommandCwd(watch.workspace);
  if (/claude/i.test(watch.agent)) {
    const args = ["-p", "--output-format", "text"];
    if (watch.conversation_id) args.push("--resume", watch.conversation_id);
    const proxySettings = claudeCodeProxySettingsArgs({ baseUrl: watch.base_url });
    args.push(...proxySettings.args, message);
    return {
      command: "claude",
      args,
      cwd,
      env: mergeClaudeCodeProcessEnv({
        cwd: watch.workspace,
        env: process.env,
        overrides: { ANTHROPIC_BASE_URL: watch.base_url },
      }),
      cleanup: proxySettings.cleanup,
      delivery: {
        mode: "detached_resume",
        terminal_echo: false,
        inherits_active_terminal_context: false,
      },
    };
  }
  if (/openclaw/i.test(watch.agent)) {
    const args = ["agent", "--local"];
    if (watch.conversation_id) args.push("--session-key", watch.conversation_id);
    args.push("--message", message);
    return {
      command: "openclaw",
      args,
      cwd,
      env: {
        ...process.env,
        OPENAI_BASE_URL: watch.base_url,
        OPENCLAW_BASE_URL: watch.base_url,
        DEEPSEEK_BASE_URL: watch.base_url,
      },
      delivery: {
        mode: "detached_message",
        terminal_echo: false,
        inherits_active_terminal_context: false,
      },
    };
  }
  throw new Error(`Sending messages is not implemented for ${watch.agent}.`);
}

function agentCommandCwd(workspace) {
  if (isAccessibleDirectory(workspace)) return workspace;
  const home = userHome();
  if (isAccessibleDirectory(home)) return home;
  return safeProcessCwd();
}

function execAgentCommand({ command, args, cwd, env, cleanup }) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(command, args, { env });
    execFile(spawnConfig.command, spawnConfig.args, {
      cwd,
      env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      ...spawnConfig.options,
    }, (error, stdout, stderr) => {
      cleanup?.();
      if (error && error.code == null && !error.killed) return reject(error);
      resolve({
        exit_code: Number.isInteger(error?.code) ? error.code : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

function redactCommandArgs(args) {
  return (args || []).map((arg) => {
    const text = String(arg || "");
    return text.length > 160 ? `${text.slice(0, 120)}...${text.slice(-20)}` : text;
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

function watchControlResponse(watch, { action }) {
  return {
    ...watchResponse(watch, { reused: true }),
    action,
    request_count: capturesForWatch(watch).length,
  };
}

function watchStopResponse(watch, { status, cleared }) {
  return {
    id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    status,
    cleared,
    provider_id: watch.provider_id,
    target_base_url: watch.target_base_url,
    config_patched: watch.config_patched,
    request_count: capturesForWatch(watch).length,
    skipped_while_paused: Number(watch.skipped_while_paused) || 0,
  };
}

async function closeWatchProxy(watch) {
  if (watch.proxy_shared) {
    watch.proxy_closed = true;
    return;
  }
  if (watch.proxy_closed) return;
  await watch.proxy?.close?.();
  watch.proxy_closed = true;
}

function findReusableWatch(watches, { agent, mode, workspace, conversationId }) {
  if (!conversationId) return null;
  return [...watches.values()].find(
    (watch) =>
      watch.agent === agent &&
      watch.mode === mode &&
      watch.workspace === workspace &&
      watch.conversation_id === conversationId,
  );
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

function findReusablePersistedWatch(store, { agent, mode, workspace, conversationId }) {
  if (!store) return null;
  const sources = store
    .listSources()
    .filter((source) => source.agent === agent)
    .filter((source) => (mode ? source.mode === mode || !source.mode : true))
    .filter((source) => source.workspace === workspace)
    .filter((source) => (conversationId ? source.conversation_id === conversationId : true))
    .sort((a, b) => Date.parse(b.last_seen || b.created_at || 0) - Date.parse(a.last_seen || a.created_at || 0));
  return sources[0] || null;
}

function findWatch(watches, input) {
  if (input.id && watches.has(input.id)) return watches.get(input.id);
  if (input.watch_id) {
    const byWatchId = [...watches.values()].find((watch) => watch.watch_id === input.watch_id);
    if (byWatchId) return byWatchId;
  }
  if (input.conversation_id) {
    return [...watches.values()].find(
      (watch) =>
        watch.conversation_id === input.conversation_id &&
        (!input.workspace || watch.workspace === input.workspace) &&
        (!input.agent || watch.agent === input.agent),
    );
  }
  return null;
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

function daemonStatus({ watches, sharedCaptureProxy }) {
  return {
    ok: true,
    api: "viewer",
    pid: process.pid,
    capture_url: sharedCaptureProxy?.baseUrl || null,
    shared_capture_proxy: Boolean(sharedCaptureProxy),
    watches: listActiveWatches(watches),
  };
}

function resolveDynamicAgentRouteWatch({ route, body, watches, store, sharedCaptureProxy }) {
  if (!sharedCaptureProxy) throw new Error("Shared capture proxy is not running.");
  const resolved = resolveTraeCnDynamicRoute({ route, body });
  const existing = [...watches.values()].find((watch) => watch.watch_id === resolved.watch_id);
  if (existing) {
    existing.target_base_url = resolved.target_base_url || existing.target_base_url;
    existing.workspace = resolved.workspace || existing.workspace;
    existing.conversation_id = resolved.conversation_id || existing.conversation_id;
    existing.provider_id = resolved.provider_id || existing.provider_id;
    existing.native_workspace_id = resolved.native_workspace_id || existing.native_workspace_id;
    existing.native_agent_type = resolved.native_agent_type || existing.native_agent_type;
    if (existing.status === "stopped") existing.status = "watching";
    store?.upsertWatch(existing);
    return existing;
  }
  const baseUrl = `${sharedCaptureProxy.baseUrl}/agent/${encodeURIComponent(route.agentSlug)}/${encodeURIComponent(route.installId)}/${encodeURIComponent(route.protocol)}`;
  const watch = {
    ...resolved,
    base_url: baseUrl,
    proxy: sharedCaptureProxy,
    proxy_shared: true,
    created_at: new Date().toISOString(),
    status: "watching",
    skipped_while_paused: 0,
  };
  watches.set(watch.id, watch);
  store?.upsertWatch(watch);
  return watch;
}

function capturesForWatch(watch) {
  return (watch.proxy?.captures || []).filter((capture) => capture.watch_id === watch.watch_id);
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

function activeWatchSources(watches) {
  return listLiveSources({
    watches,
    capturesForWatch,
    resolveLabel(watch, captures) {
      const inferredTitle = captures.map(viewerTraceProjector.inferCaptureTitle).find(Boolean);
      return cleanStoredSourceLabel(watch.title || watch.label) || textPreview(cleanTitleText(inferredTitle), 48) || watch.label;
    },
  });
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

function listActiveWatches(watches) {
  return activeWatchSources(watches).map((source) => ({
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

function listWatchStatus({ watches, store }) {
  const active = listActiveWatches(watches);
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

function sanitizeApiLookupId(value, { limit = MAX_API_SOURCE_ID_CHARS } = {}) {
  const text = String(value || "")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const maxChars = Math.max(16, Number(limit) || MAX_API_SOURCE_ID_CHARS);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
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
