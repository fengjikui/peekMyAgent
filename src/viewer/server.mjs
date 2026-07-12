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
import {
  normalizeTranslationSourceText,
} from "../translation/blocks.mjs";
import { TranslationMaterialCollector } from "../translation/materials.mjs";
import { TranslationService } from "../translation/service.mjs";
import { annotateRequestContextChanges } from "../trace/context-delta.mjs";
import { buildTurnTimeline as buildTraceTurnTimeline } from "../trace/turn-timeline.mjs";
import {
  annotateSubagentLineage as annotateTraceSubagentLineage,
  attachSubagentGraphToTurns,
  buildSubagentGraph,
} from "../trace/subagent-graph.mjs";

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
const VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES = 16 * 1024;
const TIMELINE_RESPONSE_TEXT_CHARS = 700;
const TIMELINE_RESPONSE_THINKING_CHARS = 360;
const TIMELINE_TOOL_ARGUMENT_CHARS = 360;
const TIMELINE_CURRENT_USER_CHARS = 520;
const TIMELINE_SYSTEM_PREVIEW_CHARS = 320;
const TIMELINE_ASSISTANT_PREVIEW_CHARS = 320;
const TIMELINE_INTERNAL_PREVIEW_CHARS = 320;
const TIMELINE_ENTRY_TEXT_CHARS = 320;
const TIMELINE_SUBAGENT_RESULT_CHARS = 700;
const TIMELINE_RESPONSE_PREVIEW_CHARS = 240;
const TIMELINE_THINKING_PREVIEW_CHARS = 160;
const TIMELINE_COMPOSITION_SECTION_KEYS = ["current_user", "history_context", "system", "tools", "tool_result", "params"];
const TIMELINE_ROLE_LIMIT = 48;
const TIMELINE_TOOL_NAME_LIMIT = 24;
const TIMELINE_CONTEXT_PREVIEW_LIMIT = 4;
const TIMELINE_CONTEXT_PREVIEW_CHARS = 140;
const INITIAL_VIEW_REQUEST_LIMIT = 32;
const INITIAL_VIEW_REQUEST_LIMIT_MAX = 120;

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
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
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
      });
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
  if (url.pathname === "/") return serveFile(res, path.join(viewerDir, "index.html"), "text/html; charset=utf-8");
  if (url.pathname === "/styles.css") return serveFile(res, path.join(viewerDir, "styles.css"), "text/css; charset=utf-8");
  if (url.pathname === "/client.js") return serveFile(res, path.join(viewerDir, "client.js"), "text/javascript; charset=utf-8");
  if (url.pathname === "/markdown.js") return serveFile(res, path.join(viewerDir, "markdown.js"), "text/javascript; charset=utf-8");
  if (url.pathname === "/translation-blocks.js") {
    return serveFile(res, path.join(projectRoot, "src", "translation", "blocks.mjs"), "text/javascript; charset=utf-8");
  }
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
    const data = loadViewerData(sourceId, options, {
      requireSource: Boolean(requestedSource),
      initialLimit: initialViewLimit(url.searchParams),
    });
    return writeJson(res, 200, url.searchParams.get("compact") === "1" ? compactViewerDataForTimeline(data) : data);
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
    runtime: { capturesForWatch, commandForWatch: liveWatchCommand },
    errors: { requestNotFound: (requestId) => httpError(404, `Request not found: ${requestId}`) },
  });
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
      inferCaptureTitle,
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
  return buildViewerDataFromCaptures({
    source,
    captures,
    debugSources,
    command,
    partial: initialPartialInfo({ requestedLimit: initialLimit, loadedCount: captures.length, totalCount }),
  });
}

function loadViewerRequestDetail(sourceId, requestId, options, { requireSource = false } = {}) {
  requestId = sanitizeApiLookupId(requestId, { limit: MAX_API_REQUEST_ID_CHARS });
  if (!requestId) throw httpError(400, "Missing request id");
  const repository = viewerSourceRepository(options);
  const source = repository.resolve(sourceId, { requireSource });
  const { captures, debugSources, startIndex } = sourceCaptureReader(options).readRequestWindow(source, requestId, { previousCount: 1 });
  const request = summarizeRequestDetailWindow(captures, source, requestId, { startIndex, debugSources });
  return {
    generated_at: new Date().toISOString(),
    source,
    request,
    detail_scope: "request_window",
  };
}

function summarizeRequestDetailWindow(captures, source, requestId, { startIndex = 0, debugSources = [] } = {}) {
  const requests = captures.map((capture, index) => {
    const requestIndex = Number(capture.request_index);
    const sourceIndex = Number.isFinite(requestIndex) && requestIndex > 0 ? requestIndex - 1 : startIndex + index;
    return summarizeCapture(capture, source, sourceIndex, debugSources[index] || null);
  });
  annotateRequestChanges(requests);
  const request = requests.find((item) => item.id === requestId || String(item.request_index) === String(requestId)) || requests.at(-1);
  if (!request) throw httpError(404, `Request not found: ${requestId}`);
  request.detail_scope = "request_window";
  return request;
}

function compactViewerDataForTimeline(data) {
  return {
    ...data,
    requests: (data.requests || []).map(compactRequestForTimeline),
  };
}

function compactRequestForTimeline(request) {
  const summary = request.summary || {};
  const historyStack = Array.isArray(summary.history_stack) ? summary.history_stack : [];
  const { history_stack, tool_calls, tool_results, roles, tool_names, ...summaryWithoutHeavyFields } = summary;
  return {
    ...request,
    context_delta: compactContextDeltaForTimeline(request.context_delta),
    summary: {
      ...summaryWithoutHeavyFields,
      history_stack: [],
      history_stack_omitted: {
        count: historyStack.length,
      },
      roles: compactArrayForTimeline(roles, TIMELINE_ROLE_LIMIT),
      roles_omitted: Array.isArray(roles) && roles.length > TIMELINE_ROLE_LIMIT ? { count: roles.length - TIMELINE_ROLE_LIMIT, total: roles.length } : undefined,
      tool_names: compactArrayForTimeline(tool_names, TIMELINE_TOOL_NAME_LIMIT),
      tool_names_omitted: Array.isArray(tool_names) && tool_names.length > TIMELINE_TOOL_NAME_LIMIT ? { count: tool_names.length - TIMELINE_TOOL_NAME_LIMIT, total: tool_names.length } : undefined,
      current_user: textPreview(summary.current_user || "", TIMELINE_CURRENT_USER_CHARS),
      system_preview: textPreview(summary.system_preview || "", TIMELINE_SYSTEM_PREVIEW_CHARS),
      assistant_preview: textPreview(summary.assistant_preview || "", TIMELINE_ASSISTANT_PREVIEW_CHARS),
      internal_request_preview: textPreview(summary.internal_request_preview || "", TIMELINE_INTERNAL_PREVIEW_CHARS),
      entry: compactEntryForTimeline(summary.entry),
      composition: compactCompositionForTimeline(summary.composition),
      tool_calls_omitted: Array.isArray(tool_calls) ? { count: tool_calls.length } : undefined,
      tool_results_omitted: Array.isArray(tool_results) ? { count: tool_results.length } : undefined,
      current_tool_calls: (summary.current_tool_calls || []).map(compactToolCallForTimeline),
      current_tool_results: (summary.current_tool_results || []).map(compactToolResultForTimeline),
      response: compactResponseSummaryForTimeline(summary.response),
    },
    raw: compactRawCaptureForTimeline(request.raw),
    detail_omitted: true,
  };
}

function compactArrayForTimeline(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function compactContextDeltaForTimeline(delta) {
  if (!delta || typeof delta !== "object") return delta || null;
  return {
    ...delta,
    previews: (delta.previews || []).slice(0, TIMELINE_CONTEXT_PREVIEW_LIMIT).map((preview) => ({
      role: preview?.role || "unknown",
      kind: preview?.kind || "message",
      text: textPreview(preview?.text || "", TIMELINE_CONTEXT_PREVIEW_CHARS),
    })),
    previews_omitted: Array.isArray(delta.previews) && delta.previews.length > TIMELINE_CONTEXT_PREVIEW_LIMIT
      ? { count: delta.previews.length - TIMELINE_CONTEXT_PREVIEW_LIMIT, total: delta.previews.length }
      : undefined,
  };
}

function compactCompositionForTimeline(composition) {
  if (!composition || typeof composition !== "object") return composition || null;
  const sections = {};
  for (const key of TIMELINE_COMPOSITION_SECTION_KEYS) {
    if (composition.sections?.[key]) sections[key] = composition.sections[key];
  }
  return {
    unit: composition.unit,
    total_payload_chars: composition.total_payload_chars,
    input_chars: composition.input_chars,
    sections,
  };
}

function compactEntryForTimeline(entry) {
  if (!entry || typeof entry !== "object") return entry || null;
  const output = { ...entry };
  if (typeof output.text === "string") output.text = textPreview(output.text, TIMELINE_ENTRY_TEXT_CHARS);
  if (output.value && typeof output.value === "string") output.value = textPreview(output.value, TIMELINE_ENTRY_TEXT_CHARS);
  if (output.subagent && typeof output.subagent === "object") output.subagent = compactSubagentEntryForTimeline(output.subagent);
  return output;
}

function compactSubagentEntryForTimeline(subagent) {
  return {
    ...subagent,
    preview: textPreview(subagent.preview || "", TIMELINE_ENTRY_TEXT_CHARS),
    result: textPreview(subagent.result || "", TIMELINE_SUBAGENT_RESULT_CHARS),
  };
}

function compactResponseSummaryForTimeline(response) {
  if (!response || typeof response !== "object") return response || null;
  const { complete_response, preview: _preview, ...rest } = response;
  return {
    ...rest,
    text: textPreview(response.text || "", TIMELINE_RESPONSE_TEXT_CHARS),
    thinking: textPreview(response.thinking || "", TIMELINE_RESPONSE_THINKING_CHARS),
    thinking_preview: textPreview(response.thinking_preview || "", TIMELINE_THINKING_PREVIEW_CHARS),
    tool_calls: (response.tool_calls || []).map(compactToolCallForTimeline),
    ...(complete_response ? { complete_response_omitted: true } : {}),
  };
}

function compactToolCallForTimeline(call) {
  if (!call || typeof call !== "object") return call;
  return {
    ...call,
    arguments: compactPreviewValue(call.arguments),
  };
}

function compactToolResultForTimeline(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    content: textPreview(result.content || "", Math.min(800, TIMELINE_TOOL_ARGUMENT_CHARS)),
  };
}

function compactPreviewValue(value) {
  const serialized = stableJson(value ?? null);
  if (serialized.length <= TIMELINE_TOOL_ARGUMENT_CHARS) return value;
  return {
    preview: textPreview(serialized, TIMELINE_TOOL_ARGUMENT_CHARS),
    omitted: {
      reason: "compact_view",
      chars: serialized.length,
    },
  };
}

function compactRawCaptureForTimeline(raw) {
  if (!raw || typeof raw !== "object") return raw || null;
  const body = raw.body && typeof raw.body === "object" ? raw.body : null;
  const response = raw.response && typeof raw.response === "object" ? raw.response : null;
  return {
    body_source: raw.body_source || "original",
    body: compactRawBodyMetadata(body),
    body_omitted: body
      ? {
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
          system: Array.isArray(body.system) ? body.system.length : body.system ? 1 : 0,
          raw_body_length: raw.raw_body_length || byteLength(body),
        }
      : null,
    response: compactRawResponseMetadata(response),
    detail_omitted: true,
  };
}

function compactRawBodyMetadata(body) {
  if (!body || typeof body !== "object") return null;
  const output = {};
  for (const key of ["model", "stream", "max_tokens", "temperature", "top_p"]) {
    if (body[key] !== undefined) output[key] = body[key];
  }
  return output;
}

function compactRawResponseMetadata(response) {
  if (!response || typeof response !== "object") return response || null;
  const output = {};
  for (const key of ["status", "received_at", "duration_ms", "raw_body_length", "captured_body_length", "truncated", "body_text_omitted"]) {
    if (response[key] !== undefined) output[key] = response[key];
  }
  if (response.body_json !== undefined && response.body_json !== null) output.body_json_omitted = true;
  if (typeof response.body_text === "string") {
    output.body_text_omitted =
      response.body_text_omitted || {
        reason: "compact_view",
        byte_size: Buffer.byteLength(response.body_text, "utf8"),
        raw_body_length: response.raw_body_length || Buffer.byteLength(response.body_text, "utf8"),
        captured_body_length: response.captured_body_length || Buffer.byteLength(response.body_text, "utf8"),
      };
  }
  return output;
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
  if (!watch.title) watch.title = inferCaptureTitle(capture);
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
  return sourceLifecycleService(options).update(input);
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

function buildViewerDataFromCaptures({ source, captures, debugSources = [], command = null, partial = null }) {
  const requests = captures.map((capture, index) => summarizeCapture(capture, source, index, debugSources[index] || null));
  const graphSemantics = subagentGraphSemantics();
  annotateTraceSubagentLineage(requests, graphSemantics);
  annotateRequestChanges(requests);
  const turns = buildTurnTimeline(requests);
  const agentTrace = buildSubagentGraph(requests, graphSemantics);
  attachSubagentGraphToTurns(turns, agentTrace);
  const stats = viewerStatsWithSourceTotals(buildStats(requests, agentTrace), source, partial);
  return {
    generated_at: new Date().toISOString(),
    source: { ...source, command, workbench: buildWorkbenchSummary(source, requests, command) },
    stats,
    requests,
    turns,
    agent_trace: agentTrace,
    ...(partial?.has_more ? { partial } : {}),
  };
}

function initialPartialInfo({ requestedLimit, loadedCount, totalCount }) {
  const limit = Number(requestedLimit) || 0;
  if (!limit) return null;
  const loaded = Number(loadedCount) || 0;
  const total = Math.max(Number(totalCount) || 0, loaded);
  return {
    mode: "initial",
    request_limit: limit,
    loaded_request_count: loaded,
    total_request_count: total,
    has_more: total > loaded,
  };
}

function viewerStatsWithSourceTotals(stats, source, partial) {
  if (!partial?.has_more) return stats;
  return {
    ...stats,
    request_count: Number(source.request_count) || partial.total_request_count || stats.request_count,
    response_count: Number(source.response_count) || stats.response_count,
    raw_body_bytes: Number(source.raw_body_bytes) || stats.raw_body_bytes,
    partial_loaded_request_count: partial.loaded_request_count,
  };
}

function summarizeCapture(capture, source, index, debugSource) {
  const body = capture.body || {};
  const responseSummary = summarizeModelResponse(capture.response);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = extractSystemParts(body, messages);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const lastUser = lastMessage(messages, "user");
  const currentUser = lastRealUserMessage(messages);
  const currentUserRealText = realUserVisibleText(currentUser);
  const commandMessage = currentUserRealText ? null : parseCommandMessage(currentUser);
  const entry = isContextTokenCountingRequest(capture)
    ? { kind: "context_count", label: "上下文统计 (/context)", text: "Claude Code 为 /context 统计上下文 token 用量发出的内部请求" }
    : classifyCurrentEntry(messages);
  const currentUserText = entry.kind === "compact" || entry.kind === "context_count" ? "" : currentUserRealText || (commandMessage ? commandUserVisibleText(commandMessage) : "");
  const internalRequestText = isSuggestionModeMessage(lastUser) ? extractContentText(lastUser.content) : "";
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolMessages = messages.filter((message) => message.role === "tool");
  const toolCalls = extractToolCalls(messages);
  const toolResults = extractToolResults(messages);
  const sourceHint = inferRequestSource(capture, body, currentUser, debugSource, lastUser);
  const protocolProfile = inferProtocolProfile(capture, body);
  const historyCount = Math.max(0, messages.length - (currentUser ? 1 : 0) - systemParts.length);
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  const claudeSessionId = headerValue(capture.headers, "x-claude-code-session-id");

  return {
    id: capture.capture_id || `request-${index + 1}`,
    request_index: capture.request_index || index + 1,
    captured_at: capture.received_at || capture.captured_at || null,
    method: capture.method || "POST",
    path: capture.path || null,
    model: body.model || null,
    protocol: protocolProfile.protocol,
    provider: protocolProfile.provider,
    upstream_status: capture.upstream_status || null,
    watch_id: capture.watch_id || null,
    conversation_id: capture.conversation_id || null,
    agent_profile: capture.agent_profile || source.agent,
    confidence: source.confidence,
    source_kind: source.kind,
    source_hint: sourceHint,
    debug_source: debugSource?.source || null,
    is_subagent: sourceHint.type === "subagent",
    trace: {
      actor_type: sourceHint.type === "subagent" ? "child" : sourceHint.type === "metadata" ? "side" : "main",
      claude_agent_id: claudeAgentId || null,
      claude_session_id_prefix: claudeSessionId ? claudeSessionId.slice(0, 12) : null,
      debug_source: debugSource?.source || null,
    },
    redaction_count: Array.isArray(capture.header_redactions) ? capture.header_redactions.length : 0,
    fingerprints: {
      system: hashJson(systemParts.map((part) => part.text)),
      tools: hashJson(tools.map((tool) => tool.function?.name || tool.name || tool.type || "unknown")),
      params: hashJson(Object.fromEntries(Object.entries(body).filter(([key]) => !["messages", "system", "tools"].includes(key)))),
    },
    counts: {
      messages: messages.length,
      system: systemParts.length,
      tools: tools.length,
      tool_calls: toolCalls.length,
      tool_results: toolResults.length,
      assistant_messages: assistantMessages.length,
      tool_messages: toolMessages.length,
      history: historyCount,
      raw_body_bytes: capture.raw_body_length || byteLength(body),
      response_body_bytes: capture.response?.raw_body_length || 0,
    },
    summary: {
      current_user: textPreview(currentUserText, 1200),
      entry,
      command_message: commandMessage,
      internal_request_preview: textPreview(internalRequestText, 1200),
      system_preview: textPreview(systemParts.map((part) => part.text).join("\n\n"), 1000),
      assistant_preview: textPreview(assistantMessages.map((message) => extractContentText(message.content)).filter(Boolean).join("\n\n"), 1000),
      tool_calls: toolCalls,
      current_tool_calls: toolCalls,
      tool_results: toolResults.map((result) => ({ ...result, content: textPreview(result.content, 800) })),
      current_tool_results: toolResults.map((result) => ({ ...result, content: textPreview(result.content, 800) })),
      tool_names: tools.map((tool) => tool.function?.name || tool.name || tool.type).filter(Boolean),
      roles: messages.map((message) => message.role || "unknown"),
      history_stack: summarizeHistoryStack(messages, currentUser),
      response: responseSummary,
      protocol: protocolProfile,
      composition: analyzeRequestComposition(body, messages, systemParts, tools, currentUser, responseSummary, capture.raw_body_length),
    },
    raw: compactCaptureForViewer(capture, responseSummary),
  };
}

function compactCaptureForViewer(capture, responseSummary) {
  if (!capture || typeof capture !== "object") return capture;
  const response = compactResponseForViewer(capture.response, responseSummary);
  return response === capture.response ? capture : { ...capture, response };
}

function compactResponseForViewer(response, responseSummary) {
  if (!response || typeof response !== "object") return response || null;
  if (typeof response.body_text !== "string") return response;
  const bodyText = response.body_text;
  const byteSize = Buffer.byteLength(bodyText, "utf8");
  const contentType = headerValue(response.headers, "content-type");
  const stream = Boolean(responseSummary?.stream) || /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(bodyText);
  const hasBodyJson = response.body_json !== undefined && response.body_json !== null;
  const tooLarge = byteSize > VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES;
  if (!stream && !hasBodyJson && !tooLarge) return response;
  const { body_text, ...rest } = response;
  return {
    ...rest,
    body_text_omitted: {
      reason: stream ? "stream" : hasBodyJson ? "duplicated_body_json" : "large",
      byte_size: byteSize,
      raw_body_length: response.raw_body_length || byteSize,
      captured_body_length: response.captured_body_length || byteSize,
      body_json_available: hasBodyJson,
      stream,
    },
  };
}

function summarizeModelResponse(response) {
  if (!response) {
    return {
      captured: false,
      message_id: null,
      preview: "",
      text: "",
      thinking: "",
      thinking_preview: "",
      usage: null,
      finish_reason: null,
      latency_ms: null,
      status: null,
      stream: false,
      event_count: 0,
      truncated: false,
    };
  }
  const contentType = headerValue(response.headers, "content-type");
  const stream = /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(response.body_text || "");
  const parsed = stream ? summarizeSseResponse(response.body_text || "") : summarizeJsonResponse(response.body_json);
  const completeResponse = assembleCompleteResponse(parsed, { stream, truncated: Boolean(response.truncated) });
  return {
    captured: true,
    message_id: parsed.message_id || null,
    preview: textPreview(parsed.text, 1200),
    text: textPreview(parsed.text, 8000),
    thinking: textPreview(parsed.thinking, 8000),
    thinking_preview: textPreview(parsed.thinking, 240),
    tool_calls: parsed.tool_calls || [],
    usage: parsed.usage,
    finish_reason: parsed.finish_reason || null,
    complete_response: completeResponse,
    latency_ms: response.duration_ms ?? null,
    status: response.status ?? null,
    stream,
    event_count: parsed.event_count || 0,
    truncated: Boolean(response.truncated),
    raw_body_bytes: response.raw_body_length || 0,
    captured_body_bytes: response.captured_body_length || 0,
    received_at: response.received_at || null,
  };
}

function summarizeJsonResponse(body) {
  if (!body || typeof body !== "object") return { message_id: null, role: null, model: null, text: "", thinking: "", tool_calls: [], usage: null, finish_reason: null, event_count: 0 };
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];
  const finishReasons = [];
  if (Array.isArray(body.content)) textParts.push(extractContentText(body.content));
  if (Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (Array.isArray(body.content)) toolCalls.push(...extractToolCallsFromContent(body.content));
  if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (typeof body.content === "string") textParts.push(body.content);
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (choice?.message?.content) textParts.push(extractContentText(choice.message.content));
      if (choice?.message?.content) thinkingParts.push(extractThinkingText(choice.message.content));
      if (choice?.message?.reasoning_content) thinkingParts.push(choice.message.reasoning_content);
      if (choice?.message?.content) toolCalls.push(...extractToolCallsFromContent(choice.message.content));
      if (Array.isArray(choice?.message?.tool_calls)) toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
      if (choice?.delta?.content) textParts.push(extractContentText(choice.delta.content));
      if (choice?.delta?.reasoning_content) thinkingParts.push(choice.delta.reasoning_content);
      if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...extractToolCalls([{ tool_calls: choice.delta.tool_calls }]));
      if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
    }
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (Array.isArray(item?.content)) textParts.push(extractContentText(item.content));
      if (Array.isArray(item?.content)) thinkingParts.push(extractThinkingText(item.content));
      if (Array.isArray(item?.content)) toolCalls.push(...extractToolCallsFromContent(item.content));
      if (item?.content && typeof item.content === "object" && !Array.isArray(item.content)) thinkingParts.push(extractThinkingText(item.content));
      if (item?.content) textParts.push(extractContentText(item.content));
    }
  }
  if (body.stop_reason) finishReasons.push(body.stop_reason);
  if (body.finish_reason) finishReasons.push(body.finish_reason);
  return {
    message_id: body.id || null,
    role: body.role || null,
    model: body.model || null,
    text: textParts.filter(Boolean).join("\n"),
    thinking: thinkingParts.filter(Boolean).join("\n"),
    tool_calls: dedupeToolCalls(toolCalls),
    usage: body.usage || null,
    finish_reason: uniqueValues(finishReasons).join(", ") || null,
    event_count: 0,
  };
}

function summarizeSseResponse(text) {
  const events = parseSseEvents(text);
  const textParts = [];
  const thinkingParts = [];
  const fallbackTextParts = [];
  const fallbackThinkingParts = [];
  const toolCalls = [];
  const toolCallBlocks = new Map();
  const openAiToolCallBlocks = new Map();
  const finishReasons = [];
  let usage = null;
  let messageId = null;
  let role = null;
  let model = null;
  for (const event of events) {
    if (!event.data || event.data === "[DONE]") continue;
    const data = parseJson(event.data);
    if (!data || typeof data !== "object") continue;
    if (data.model) model = data.model;
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice?.delta?.role) role = choice.delta.role;
        if (choice?.delta?.content) textParts.push(extractContentText(choice.delta.content));
        if (choice?.delta?.reasoning_content) thinkingParts.push(choice.delta.reasoning_content);
        if (choice?.message?.content) fallbackTextParts.push(extractContentText(choice.message.content));
        if (choice?.message?.content) fallbackThinkingParts.push(extractThinkingText(choice.message.content));
        if (choice?.message?.reasoning_content) fallbackThinkingParts.push(choice.message.reasoning_content);
        if (choice?.message?.role) role = choice.message.role;
        if (choice?.message?.content) toolCalls.push(...extractToolCallsFromContent(choice.message.content));
        if (Array.isArray(choice?.message?.tool_calls)) toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
        if (Array.isArray(choice?.delta?.tool_calls)) mergeOpenAiStreamToolCalls(openAiToolCallBlocks, choice.delta.tool_calls);
        if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
      }
    }
    if (data.delta?.type === "text_delta" && data.delta.text) textParts.push(data.delta.text);
    if (data.delta?.type === "thinking_delta" && data.delta.thinking) thinkingParts.push(data.delta.thinking);
    else if (!data.delta?.type && data.delta?.text) textParts.push(data.delta.text);
    if (data.content_block?.type === "text" && data.content_block.text) fallbackTextParts.push(data.content_block.text);
    if (data.content_block?.type === "thinking" && data.content_block.thinking) fallbackThinkingParts.push(data.content_block.thinking);
    if (data.content_block?.type === "tool_use") {
      const call = toolCallFromPart(data.content_block);
      if (call) {
        toolCalls.push(call);
        toolCallBlocks.set(data.index, { call, partialJson: "" });
      }
    }
    if (data.delta?.type === "input_json_delta" && data.index != null) {
      const block = toolCallBlocks.get(data.index);
      if (block) block.partialJson += data.delta.partial_json || "";
    }
    if (data.message?.content) fallbackTextParts.push(extractContentText(data.message.content));
    if (data.message?.content) fallbackThinkingParts.push(extractThinkingText(data.message.content));
    if (data.message?.content) toolCalls.push(...extractToolCallsFromContent(data.message.content));
    if (data.type === "message_start" && data.message?.id) {
      messageId = data.message.id;
      if (data.message.role) role = data.message.role;
      if (data.message.model) model = data.message.model;
    }
    if (data.id && data.type === "message") messageId = data.id;
    if (data.delta?.stop_reason) finishReasons.push(data.delta.stop_reason);
    if (data.stop_reason) finishReasons.push(data.stop_reason);
    if (data.finish_reason) finishReasons.push(data.finish_reason);
    if (data.usage) usage = data.usage;
    if (data.message?.usage) usage = data.message.usage;
  }
  const visibleText = textParts.filter(Boolean).join("") || fallbackTextParts.filter(Boolean).join("\n");
  const thinkingText = thinkingParts.filter(Boolean).join("") || fallbackThinkingParts.filter(Boolean).join("\n");
  return {
    message_id: messageId,
    role,
    model,
    text: visibleText,
    thinking: thinkingText,
    tool_calls: dedupeToolCalls([...mergeStreamToolCallInputs(toolCalls, toolCallBlocks), ...finalizeOpenAiStreamToolCalls(openAiToolCallBlocks)]),
    usage,
    finish_reason: uniqueValues(finishReasons).join(", ") || null,
    event_count: events.length,
  };
}

function assembleCompleteResponse(parsed, { stream = false, truncated = false } = {}) {
  const content = [];
  if (parsed?.thinking) content.push({ type: "thinking", thinking: parsed.thinking });
  if (parsed?.text) content.push({ type: "text", text: parsed.text });
  for (const call of parsed?.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || null,
      name: call.name || "unknown",
      input: call.arguments ?? null,
    });
  }
  return {
    id: parsed?.message_id || null,
    role: parsed?.role || "assistant",
    model: parsed?.model || null,
    content,
    text: parsed?.text || "",
    thinking: parsed?.thinking || "",
    tool_use: parsed?.tool_calls || [],
    stop_reason: parsed?.finish_reason || null,
    finish_reason: parsed?.finish_reason || null,
    usage: parsed?.usage || null,
    stream: Boolean(stream),
    event_count: parsed?.event_count || 0,
    truncated: Boolean(truncated),
  };
}

function mergeOpenAiStreamToolCalls(blocks, chunks) {
  for (const chunk of chunks || []) {
    const key = chunk.index ?? chunk.id ?? blocks.size;
    const current = blocks.get(key) || { id: null, name: null, argumentsText: "", type: null };
    if (chunk.id) current.id = chunk.id;
    if (chunk.type) current.type = chunk.type;
    if (chunk.function?.name) current.name = chunk.function.name;
    if (chunk.name) current.name = chunk.name;
    if (chunk.function?.arguments) current.argumentsText += chunk.function.arguments;
    else if (chunk.arguments) current.argumentsText += chunk.arguments;
    blocks.set(key, current);
  }
}

function finalizeOpenAiStreamToolCalls(blocks) {
  return [...blocks.values()]
    .filter((block) => block.id || block.name || block.argumentsText)
    .map((block) => ({
      name: block.name || "unknown",
      id: block.id || null,
      arguments: parseMaybeJson(block.argumentsText),
    }));
}

function mergeStreamToolCallInputs(toolCalls, blocks) {
  if (!blocks.size) return toolCalls;
  return toolCalls.map((call) => {
    const block = [...blocks.values()].find((item) => item.call === call || (item.call.id && item.call.id === call.id));
    if (!block?.partialJson) return call;
    return { ...call, arguments: parseMaybeJson(block.partialJson) };
  });
}

function parseSseEvents(text) {
  const events = [];
  let current = { event: null, data: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
      current = { event: null, data: [] };
      continue;
    }
    if (line.startsWith("event:")) current.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) current.data.push(line.slice("data:".length).trim());
  }
  if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
  return events;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function annotateRequestChanges(requests) {
  return annotateRequestContextChanges(requests, contextDeltaSemantics());
}

function contextDeltaSemantics() {
  return {
    extractToolCalls,
    extractToolResults,
    classifyMessage: messageDeltaKind,
    previewMessage: messageDeltaPreview,
    previewText: textPreview,
    isInternalRequest,
    isRealUserMessage(message) {
      return message?.role === "user" && !isToolResultMessage(message) && !isSuggestionModeMessage(message) && !isFrameworkReminderMessage(message);
    },
  };
}

function buildTurnTimeline(requests) {
  return buildTraceTurnTimeline(requests, {
    normalizeUserKey: normalizeTurnUserKey,
    isInternalRequest: isTimelineInternalRequest,
    titleFor: turnTitle,
    cleanUserText: cleanTitleText,
    previewText: textPreview,
  });
}

function subagentGraphSemantics() {
  return {
    extractHistoryToolCalls(request) {
      return extractToolCalls(Array.isArray(request.raw?.body?.messages) ? request.raw.body.messages : []);
    },
    firstUserPromptText,
    normalizePrompt: normalizeTranslationSourceText,
    previewText: textPreview,
    stableJson,
    childAgentType(request, spawn) {
      if (spawn?.subagent_type) return spawn.subagent_type;
      const debug = request?.debug_source || request?.trace?.debug_source || "";
      if (debug.startsWith("agent:")) return debug.replace(/^agent:/, "");
      return "Subagent";
    },
  };
}

// Subagent attribution that survives OTel (subscription) capture. The header
// (x-claude-code-agent-id) and debug source agent:* signals only exist on the
// proxy path; OTel dumps the body only. But the body still links parent↔child:
// a subagent's first user message equals the prompt of a parent `Agent` tool_use,
// and all rounds of one subagent share that same initial prompt. We derive a
// synthetic per-instance id (body:<promptHash>) so the subagent graph groups the
// branch, and mark source_hint=subagent so turn grouping nests it under the
// parent turn instead of spawning a phantom turn.
function firstUserPromptText(request) {
  const messages = request.raw?.body?.messages;
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (message?.role !== "user") continue;
    if (isToolResultMessage(message)) continue;
    const text = realUserVisibleText(message);
    if (text) return text;
    return "";
  }
  return "";
}

function normalizeTurnUserKey(text) {
  return cleanTitleText(text).replace(/\s+/g, " ").trim();
}

function turnTitle(userText, commandMessage = null) {
  if (commandMessage) {
    const suffix = textPreview(cleanTitleText(commandMessage.body), 72);
    return suffix ? `${commandMessage.command} · ${suffix}` : `Command ${commandMessage.command}`;
  }
  return textPreview(cleanTitleText(userText), 96) || "未识别用户输入";
}

function isInternalRequest(request) {
  return request.source_hint?.type === "metadata";
}

function isTimelineInternalRequest(request) {
  return isInternalRequest(request) || request.source_hint?.type === "subagent" || request.summary?.entry?.kind === "harness_injection";
}

function messageDeltaPreview(message) {
  const commandMessage = parseCommandMessage(message);
  return {
    role: message?.role || "unknown",
    kind: messageDeltaKind(message),
    text: textPreview(commandMessage ? commandPreviewText(commandMessage) : displayMessageText(message), 220),
    command_message: commandMessage,
  };
}

function messageDeltaKind(message) {
  if (isTaskNotificationMessage(message)) return taskNotificationSummary(message).subagent ? "subagent_result" : "task_notification";
  if (isFrameworkReminderMessage(message)) return "framework_reminder";
  if (isSuggestionModeMessage(message)) return "agent_internal";
  if (isCompactInjectionMessage(message)) return "compact";
  if (isSkillInjectionMessage(message)) return "harness_injection";
  if (message?.role === "user" && realUserVisibleText(message)) return "message";
  if (parseCommandMessage(message)) return "command_message";
  if (isToolResultMessage(message)) return "tool_result";
  const parts = Array.isArray(message?.content) ? message.content : [];
  if (parts.some((part) => part?.type === "tool_use")) return "tool_use";
  return "message";
}

function summarizeHistoryStack(messages, currentUser) {
  const currentUserKey = currentUser ? stableJson(currentUser) : "";
  return (messages || []).map((message, index) => {
    const kind = messageDeltaKind(message);
    const toolCalls = extractToolCalls([message]);
    const toolResults = extractToolResults([message]);
    const fullText = extractContentText(message?.content);
    const commandMessage = parseCommandMessage(message);
    const realText = kind === "compact" ? "" : realUserVisibleText(message);
    const displayText = displayMessageText(message);
    return {
      index: index + 1,
      role: message?.role || "unknown",
      kind,
      label: historyMessageLabel(message, kind),
      is_current_user: Boolean(currentUserKey && stableJson(message) === currentUserKey),
      text: textPreview(realText || (commandMessage ? commandMessage.body || commandPreviewText(commandMessage) : displayText), kind === "framework_reminder" ? 180 : 420),
      command_message: commandMessage,
      full_text: kind === "framework_reminder" ? textPreview(fullText, 4000) : "",
      char_count: charLength(fullText),
      tool_calls: toolCalls.map((call) => ({ name: call.name, id: call.id || null, arguments_preview: textPreview(stableJson(call.arguments), 260) })),
      tool_results: toolResults.map((result) => ({ id: result.id || null, content: textPreview(result.content, 260) })),
    };
  });
}

function historyMessageLabel(message, kind) {
  if (kind === "message" && message?.role === "user") return "User 输入";
  const commandMessage = parseCommandMessage(message);
  if (commandMessage) return `Command ${commandMessage.command}`;
  if (kind === "compact") return "上下文压缩 (/compact)";
  if (kind === "harness_injection") return "Skill / Harness 注入";
  if (kind === "task_notification") return "任务通知";
  if (kind === "framework_reminder") return "框架提醒";
  if (kind === "agent_internal") return "Agent 内部请求";
  if (kind === "tool_result") return "Tool result";
  if (kind === "tool_use") return "Tool use";
  if (message?.role === "user") return "User 输入";
  if (message?.role === "assistant") return "Assistant 回复";
  if (message?.role === "system") return "System";
  if (message?.role === "tool") return "Tool result";
  return message?.role || "Message";
}

function isToolResultMessage(message) {
  if (message?.role === "tool") return true;
  const content = message?.content;
  if (Array.isArray(content) && content.length) {
    // A tool-result continuation may carry a trailing harness text block —
    // e.g. ToolSearch returns a tool_result + "Tool loaded.", and tool turns
    // sometimes bundle a compact/reminder block. Any tool_result block makes
    // this a continuation, not a new user turn. (compact / task_notification /
    // command / suggestion are classified ahead of tool_result, so the special
    // cases still get their own label.)
    return content.some((part) => part?.type === "tool_result");
  }
  return content?.type === "tool_result";
}

function buildWorkbenchSummary(source, requests, command) {
  const first = requests[0] || {};
  const watchIds = uniqueValues([...requests.map((request) => request.watch_id), source.live_watch_id]);
  const conversationIds = uniqueValues([...requests.map((request) => request.conversation_id), source.conversation_id]);
  const workspaces = uniqueValues([...requests.map((request) => request.raw?.workspace || request.raw?.body?.workspace), command?.cwd]);
  const agentProfiles = uniqueValues(requests.map((request) => request.agent_profile || source.agent));
  const sourceKinds = uniqueValues([...requests.map((request) => request.source_kind), source.kind]);
  return {
    agent: agentProfiles[0] || source.agent || "Unknown Agent",
    project: displayProjectName(workspaces[0]),
    workspace: workspaces[0] || null,
    mode: inferWatchMode(source, requests),
    watch_ids: watchIds,
    conversation_ids: conversationIds,
    conversation_label: conversationIds.length ? shortenId(conversationIds[0]) : "按监听任务归档",
    capture_label: captureLabel(source),
    source_kinds: sourceKinds,
    status: liveStatusLabel(source.live_status),
    request_count: requests.length,
    subagent_count: requests.filter((request) => request.is_subagent).length,
    parent_spawn_count: requests.filter((request) => request.source_hint.type === "parent_spawn").length,
    redaction_count: requests.reduce((sum, request) => sum + request.redaction_count, 0),
    first_seen: first.captured_at || null,
    last_seen: requests.at(-1)?.captured_at || null,
  };
}

function inferRequestSource(capture, body, currentUser, debugSource, lastUser = currentUser) {
  if (isContextTokenCountingRequest(capture)) {
    return { type: "metadata", label: "上下文统计 (/context)", confidence: "high" };
  }
  if (isSuggestionModeMessage(lastUser)) {
    return { type: "metadata", label: "Agent 输入建议请求", confidence: "high" };
  }
  if (isFrameworkReminderMessage(lastUser)) {
    return { type: "metadata", label: "Claude Code 框架提醒", confidence: "high" };
  }
  if (isTitleGenerationRequest(body)) {
    return { type: "metadata", label: "生成会话标题", confidence: "high" };
  }
  if (isWebSearchInternalRequest(body)) {
    return { type: "metadata", label: "WebSearch 内部请求", confidence: "high" };
  }
  const userText = userVisibleText(currentUser);
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  if (claudeAgentId) {
    return { type: "subagent", label: debugSource?.source || "Claude Code 子 Agent", confidence: "high" };
  }
  if (debugSource?.source?.startsWith("agent:")) {
    return { type: "subagent", label: debugSource.source, confidence: "high" };
  }
  if (debugSource?.source === "generate_session_title") {
    return { type: "metadata", label: "生成会话标题", confidence: "high" };
  }
  if (/\[Subagent Context\]|\[Subagent Task\]/i.test(userText)) {
    return { type: "subagent", label: "子代理请求", confidence: "high" };
  }
  const apiSource = capture.api_source || body.api_source || body.metadata?.api_source;
  if (typeof apiSource === "string" && apiSource.startsWith("agent:")) {
    return { type: "subagent", label: apiSource, confidence: "high" };
  }
  const calls = extractToolCalls(Array.isArray(body.messages) ? body.messages : []);
  if (calls.some((call) => /^(Agent|sessions_spawn|subagents)$/.test(call.name))) {
    return { type: "parent_spawn", label: "启动子代理", confidence: "high" };
  }
  return { type: "main", label: "主代理请求", confidence: "medium" };
}

function isContextTokenCountingRequest(capture) {
  const requestPath = String(capture?.path || capture?.original_url || "");
  return /\/v1\/messages\/count_tokens(?:$|[?#/])/.test(requestPath);
}

function isTitleGenerationRequest(body) {
  const systemText = extractSystemParts(body, Array.isArray(body?.messages) ? body.messages : [])
    .map((part) => part.text)
    .join("\n");
  const format = body?.output_config?.format;
  return (
    /Generate a concise, sentence-case title/i.test(systemText) ||
    (format?.type === "json_schema" && format?.schema?.properties?.title && Array.isArray(body?.tools) && body.tools.length === 0)
  );
}

function isWebSearchInternalRequest(body) {
  const systemText = extractSystemParts(body, Array.isArray(body?.messages) ? body.messages : [])
    .map((part) => part.text)
    .join("\n");
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return (
    body?.tool_choice?.name === "web_search" ||
    tools.some((tool) => tool?.name === "web_search" || tool?.type === "web_search_20250305") ||
    /assistant for performing a web search tool use/i.test(systemText)
  );
}

function inferProtocolProfile(capture, body) {
  const path = String(capture?.path || "");
  const model = String(body?.model || "");
  const protocol = inferProtocol(path, body);
  const provider = inferProvider(model, capture);
  const extensions = [];
  if (hasReasoningContent(body)) extensions.push("reasoning_content");
  if (body?.thinking != null) extensions.push("thinking");
  return {
    protocol,
    protocol_label: protocolLabel(protocol),
    provider,
    provider_label: providerLabel(provider),
    model: model || null,
    extensions,
  };
}

function inferProtocol(path, body) {
  if (/\/v1\/messages(?:$|[?#/])/.test(path) && Array.isArray(body?.messages)) return "anthropic_messages";
  if (/\/v1\/chat\/completions(?:$|[?#/])/.test(path)) return "openai_chat_completions";
  if (/\/v1\/responses(?:$|[?#/])/.test(path)) return "openai_responses";
  if (/(generateContent|streamGenerateContent)/.test(path) || Array.isArray(body?.contents)) return "gemini_generate_content";
  if (Array.isArray(body?.input)) return "openai_responses";
  if (Array.isArray(body?.messages) && Array.isArray(body?.tools) && body?.stream != null && body?.system == null) return "openai_chat_completions";
  return "unknown";
}

function inferProvider(model, capture) {
  const lowerModel = String(model || "").toLowerCase();
  const hostHint = String(capture?.headers?.host || capture?.target_base_url || "").toLowerCase();
  if (/^mimo(?:-|_)/.test(lowerModel) || /xiaomimimo|mimo/.test(hostHint)) return "xiaomi_mimo";
  if (/^gpt-|^o[134]|openai/.test(lowerModel)) return "openai";
  if (/claude/.test(lowerModel)) return "anthropic";
  if (/gemini/.test(lowerModel)) return "google_gemini";
  if (/deepseek/.test(lowerModel)) return "deepseek";
  if (/qwen|qwq/.test(lowerModel)) return "qwen";
  if (/kimi|moonshot/.test(lowerModel)) return "moonshot";
  return "unknown";
}

function protocolLabel(protocol) {
  const labels = {
    openai_chat_completions: "OpenAI Chat",
    openai_responses: "OpenAI Responses",
    anthropic_messages: "Anthropic",
    gemini_generate_content: "Gemini",
    unknown: "未知协议",
  };
  return labels[protocol] || protocol;
}

function providerLabel(provider) {
  const labels = {
    xiaomi_mimo: "MiMo",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google_gemini: "Google Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    moonshot: "Moonshot",
    unknown: "未知厂商",
  };
  return labels[provider] || provider;
}

function hasReasoningContent(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasReasoningContent);
  if (typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "reasoning_content")) return true;
  return Object.values(value).some(hasReasoningContent);
}

function extractSystemParts(body, messages) {
  const output = [];
  if (typeof body.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body.system)) {
    for (const part of body.system) output.push({ source: "body.system", text: extractContentText(part) });
  }
  for (const message of messages) {
    if (message.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => part.text);
}

function extractToolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        calls.push({
          name: call.function?.name || call.name || "unknown",
          id: call.id || null,
          arguments: parseMaybeJson(call.function?.arguments || call.arguments),
        });
      }
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    calls.push(...extractToolCallsFromContent(parts));
  }
  return calls;
}

function extractToolCallsFromContent(content) {
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  return parts.map(toolCallFromPart).filter(Boolean);
}

function toolCallFromPart(part) {
  if (!part || typeof part !== "object" || part.type !== "tool_use") return null;
  return { name: part.name || "unknown", id: part.id || null, arguments: part.input ?? null };
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const output = [];
  for (const call of calls.filter(Boolean)) {
    const key = `${call.id || ""}:${call.name || ""}:${stableJson(call.arguments ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function extractToolResults(messages) {
  const results = [];
  for (const message of messages) {
    if (message.role === "tool") {
      results.push({ id: message.tool_call_id || null, content: extractContentText(message.content) });
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part?.type === "tool_result") {
        results.push({ id: part.tool_use_id || null, content: extractContentText(part.content) });
      }
    }
  }
  return results;
}

function analyzeRequestComposition(body, messages, systemParts, tools, currentUser, responseSummary, rawBodyLength = 0) {
  const params = Object.fromEntries(Object.entries(body || {}).filter(([key]) => !["messages", "system", "tools"].includes(key)));
  const messageParts = analyzeMessageComposition(messages || [], currentUser);
  const totalPayloadChars = Number(rawBodyLength) || jsonCharLength(body || {});
  const messagesChars = messageParts.total_chars;
  const systemChars = (systemParts || []).reduce((sum, part) => sum + charLength(part.text), 0);
  const toolsChars = jsonCharLength(tools || []);
  const paramsChars = jsonCharLength(params);
  const currentUserChars = messageParts.current_user_chars || charLength(userVisibleText(currentUser));
  const responseTextChars = charLength(responseSummary?.text || "");
  const responseThinkingChars = charLength(responseSummary?.thinking || "");
  const fixedContextChars = systemChars + toolsChars + paramsChars;
  const historyContextChars = Math.max(0, messageParts.total_chars - currentUserChars);
  return {
    unit: "chars",
    total_payload_chars: totalPayloadChars,
    input_chars: totalPayloadChars,
    fixed_context_chars: fixedContextChars,
    history_context_chars: historyContextChars,
    current_user_chars: currentUserChars,
    human_user_chars: messageParts.human_user_chars,
    assistant_history_chars: messageParts.assistant_chars,
    tool_use_chars: messageParts.tool_use_chars,
    tool_result_chars: messageParts.tool_result_chars,
    agent_internal_chars: messageParts.agent_internal_chars,
    response_text_chars: responseTextChars,
    response_thinking_chars: responseThinkingChars,
    sections: {
      system: compositionItem(systemChars, totalPayloadChars),
      tools: compositionItem(toolsChars, totalPayloadChars),
      params: compositionItem(paramsChars, totalPayloadChars),
      messages: compositionItem(messagesChars, totalPayloadChars),
      current_user: compositionItem(currentUserChars, totalPayloadChars),
      history_context: compositionItem(historyContextChars, totalPayloadChars),
      assistant_history: compositionItem(messageParts.assistant_chars, totalPayloadChars),
      tool_use: compositionItem(messageParts.tool_use_chars, totalPayloadChars),
      tool_result: compositionItem(messageParts.tool_result_chars, totalPayloadChars),
      agent_internal: compositionItem(messageParts.agent_internal_chars, totalPayloadChars),
      response_text: compositionItem(responseTextChars, totalPayloadChars),
      response_thinking: compositionItem(responseThinkingChars, totalPayloadChars),
    },
    ratios: {
      current_user_to_input: ratio(currentUserChars, totalPayloadChars),
      human_user_to_input: ratio(messageParts.human_user_chars, totalPayloadChars),
      fixed_context_to_input: ratio(fixedContextChars, totalPayloadChars),
      history_context_to_input: ratio(historyContextChars, totalPayloadChars),
      tools_to_input: ratio(toolsChars, totalPayloadChars),
      system_to_input: ratio(systemChars, totalPayloadChars),
      tool_result_to_input: ratio(messageParts.tool_result_chars, totalPayloadChars),
      output_to_input: ratio(responseTextChars, totalPayloadChars),
    },
    note: "本统计使用字符数近似，后续可升级为 tokenizer 估算。",
  };
}

function analyzeMessageComposition(messages, currentUser) {
  const stats = {
    total_chars: 0,
    human_user_chars: 0,
    assistant_chars: 0,
    tool_use_chars: 0,
    tool_result_chars: 0,
    agent_internal_chars: 0,
    other_chars: 0,
  };
  for (const message of messages) {
    const chars = messageCompositionChars(message);
    stats.total_chars += chars;
    if (isFrameworkReminderMessage(message)) stats.agent_internal_chars += chars;
    else if (isSuggestionModeMessage(message)) stats.agent_internal_chars += chars;
    else if (isToolResultMessage(message)) stats.tool_result_chars += chars;
    else if (messageDeltaKind(message) === "tool_use") stats.tool_use_chars += chars;
    else if (message?.role === "user") stats.human_user_chars += chars;
    else if (message?.role === "assistant") stats.assistant_chars += chars;
    else stats.other_chars += chars;
  }
  stats.current_user_chars = charLength(userVisibleText(currentUser));
  return stats;
}

function messageCompositionChars(message) {
  if (!message || typeof message !== "object") return 0;
  if (messageDeltaKind(message) === "tool_use") return charLength(stableJson(extractToolCalls([message])));
  if (isToolResultMessage(message)) return charLength(extractContentText(message.content));
  return charLength(extractContentText(message.content));
}

function compositionItem(chars, total) {
  return {
    chars,
    ratio: ratio(chars, total),
  };
}

function ratio(value, total) {
  if (!total) return 0;
  return Number((Number(value || 0) / Number(total)).toFixed(4));
}

function charLength(value) {
  return String(value || "").length;
}

function jsonCharLength(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return charLength(stableJson(value ?? null));
  }
}

function buildStats(requests, agentTrace = null) {
  const subagentCount = requests.filter((request) => request.is_subagent).length;
  return {
    request_count: requests.length,
    response_count: requests.filter((request) => request.summary.response?.captured).length,
    subagent_count: subagentCount,
    subagent_instance_count: agentTrace?.branch_count || new Set(requests.map((request) => request.trace?.claude_agent_id).filter(Boolean)).size || subagentCount,
    main_count: requests.length - subagentCount,
    tool_call_count: requests.reduce((sum, request) => sum + request.counts.tool_calls, 0),
    tool_result_count: requests.reduce((sum, request) => sum + request.counts.tool_results, 0),
    raw_body_bytes: requests.reduce((sum, request) => sum + request.counts.raw_body_bytes, 0),
  };
}

function lastMessage(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return messages[index];
  }
  return null;
}

function lastRealUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (isSuggestionModeMessage(message) || isFrameworkReminderMessage(message) || isTaskNotificationMessage(message)) continue;
    if (realUserVisibleText(message) || parseCommandMessage(message)) return message;
  }
  return null;
}

function isFrameworkReminderMessage(message) {
  if (!message || message.role !== "user") return false;
  const text = extractContentText(message.content);
  return (hasFrameworkReminderBlock(text) && !stripFrameworkReminderBlocks(text)) || isKnownFrameworkReminderText(text);
}

function isSuggestionModeMessage(message) {
  if (!message) return false;
  return /^\[SUGGESTION MODE:/i.test(extractContentText(message.content).trim());
}

// Background-task completion notices the harness injects as a role:"user"
// message wrapped in <task-notification>. They are not real user input — the
// model treats them as a system event — so they must not be mistaken for the
// turn's user prompt.
function isTaskNotificationMessage(message) {
  if (!message || message.role !== "user") return false;
  return /^\s*<task-notification[\s>]/i.test(extractContentText(message.content));
}

function taskNotificationSummary(message) {
  const text = extractContentText(message?.content);
  const tag = (name) => (text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i")) || [])[1]?.trim() || "";
  const taskId = tag("task-id");
  const status = tag("status");
  const summary = tag("summary");
  const result = tag("result").replace(/\s+/g, " ").trim();
  const subagent = subagentResultFromTaskNotification({ summary, status, result });
  const headline = [summary, status && `(${status})`].filter(Boolean).join(" ");
  const preview = textPreview([headline, result].filter(Boolean).join(" — "), 420)
    || textPreview(
      text.replace(/<\/?[a-z-]+>/gi, " ").replace(/\s+/g, " ").trim(),
      420,
    );
  return { taskId, status, summary, result, preview, subagent };
}

function subagentResultFromTaskNotification({ summary, status, result }) {
  const match = String(summary || "").match(/^Agent\s+"([^"]+)"\s+finished/i);
  if (!match) return null;
  return {
    name: match[1],
    status: status || null,
    result: result || "",
    preview: textPreview(`子 Agent「${match[1]}」${status ? ` ${status}` : "完成"} — ${result || summary}`, 420),
  };
}

// Context-compaction (/compact) prompt the harness injects as bare text — no
// XML markers — asking the model to summarize the conversation. It frequently
// rides in the SAME role:"user" message as the prior turn's tool_results (a
// separate text block), so detection must look per-block, not at the flattened
// message, and must run before the tool_result check.
function isCompactInjectionText(text) {
  const t = String(text || "");
  return (
    /create a detailed summary of the conversation so far/i.test(t) ||
    (/Respond with TEXT ONLY/i.test(t) && /<analysis>[\s\S]*<summary>/i.test(t))
  );
}

function compactInjectionText(message) {
  if (!message) return "";
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: extractContentText(message?.content) }];
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "";
    if (isCompactInjectionText(text)) return text;
  }
  return "";
}

function isCompactInjectionMessage(message) {
  return Boolean(compactInjectionText(message));
}

function isSkillInjectionText(text) {
  const value = String(text || "").trim();
  return /^Base directory for this skill:\s*\S+/i.test(value) || /^Skill base directory:\s*\S+/i.test(value);
}

function skillInjectionText(message) {
  if (!message) return "";
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: extractContentText(message?.content) }];
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "";
    if (isSkillInjectionText(text)) return text;
  }
  return "";
}

function isSkillInjectionMessage(message) {
  return Boolean(skillInjectionText(message));
}

// Classify the most recent salient message of a request so the card header can
// say what this upstream turn actually is — real user input, a task
// notification, a tool-result return, etc. — instead of always "User input".
// Skips appended framework/system reminders and scans back to the message that
// defines the turn.
function classifyCurrentEntry(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message) continue;
    if (isFrameworkReminderMessage(message)) continue;
    if (message.role === "system") continue;
    if (isTaskNotificationMessage(message)) {
      const { taskId, preview, subagent } = taskNotificationSummary(message);
      if (subagent) {
        return {
          kind: "subagent_result",
          label: "子 Agent 结果回流",
          text: subagent.preview || preview,
          task_id: taskId,
          subagent,
        };
      }
      return { kind: "task_notification", label: "任务通知", text: preview, task_id: taskId };
    }
    if (isCompactInjectionMessage(message)) {
      return { kind: "compact", label: "上下文压缩 (/compact)", text: "请求模型把前文压缩成 <analysis> + <summary> 结构化总结（注入提示词，非用户真话）" };
    }
    if (isSkillInjectionMessage(message)) {
      return { kind: "harness_injection", label: "Skill / Harness 注入", text: textPreview(skillInjectionText(message), 1200) };
    }
    if (message.role === "user") {
      const real = realUserVisibleText(message);
      if (real) return { kind: "user_input", label: "User input", text: textPreview(real, 1200) };
    }
    if (isToolResultMessage(message)) return { kind: "tool_result", label: "Tool result 回传", text: "" };
    const parts = Array.isArray(message.content) ? message.content : [];
    if (parts.some((part) => part?.type === "tool_use")) return { kind: "tool_use", label: "Tool use 上行", text: "" };
    if (isSuggestionModeMessage(message)) return { kind: "agent_internal", label: "Agent 内部建议", text: "" };
    const commandMessage = parseCommandMessage(message);
    if (commandMessage) return { kind: "command", label: `Command ${commandMessage.command}`, text: commandMessage.preview || "" };
    if (message.role === "user") continue;
    // assistant / other roles: keep scanning back for the user-side entry.
  }
  return { kind: "unknown", label: "未识别输入", text: "" };
}

function extractContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "thinking" || part?.type === "reasoning") return "";
        if (part?.type === "text") return part.text || "";
        if (part?.text) return part.text;
        if (part?.content) return extractContentText(part.content);
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content.type === "thinking" || content.type === "reasoning") return "";
  if (content.text) return content.text;
  if (content.content) return extractContentText(content.content);
  return JSON.stringify(content);
}

function extractThinkingText(content) {
  if (content == null) return "";
  if (typeof content === "string") return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if (part.type === "thinking") return part.thinking || part.text || "";
        if (part.type === "reasoning") return part.reasoning || part.text || "";
        if (part.thinking) return part.thinking;
        if (part.reasoning) return part.reasoning;
        if (part.content) return extractThinkingText(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (content.type === "thinking") return content.thinking || content.text || "";
    if (content.type === "reasoning") return content.reasoning || content.text || "";
    if (content.thinking) return content.thinking;
    if (content.reasoning) return content.reasoning;
    if (content.content) return extractThinkingText(content.content);
  }
  return "";
}

function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function displayMessageText(message) {
  const text = extractContentText(message?.content);
  if (isCompactInjectionMessage(message)) return "上下文压缩指令：请求模型把前文压缩成 <analysis> + <summary> 总结（harness 注入）";
  if (isSkillInjectionMessage(message)) return `Skill / Harness 注入\n${skillInjectionText(message)}`;
  if (isFrameworkReminderMessage(message)) return "Claude Code 框架自动补充提醒";
  if (isTaskNotificationMessage(message)) {
    const { taskId, preview, subagent } = taskNotificationSummary(message);
    if (subagent) return taskId ? `子 Agent 结果回流 · ${taskId}\n${subagent.preview || preview}` : `子 Agent 结果回流\n${subagent.preview || preview}`;
    return taskId ? `后台任务通知 · ${taskId}\n${preview}` : `后台任务通知\n${preview}`;
  }
  return text;
}

function userVisibleText(message) {
  const realText = realUserVisibleText(message);
  if (realText) return realText;
  const commandMessage = parseCommandMessage(message);
  if (commandMessage) return commandUserVisibleText(commandMessage);
  return "";
}

function realUserVisibleText(message) {
  if (!message) return "";
  const rawText = extractContentText(message.content);
  const textAfterLocalCommands = userTextAfterLocalCommandBlocks(rawText);
  if (textAfterLocalCommands) return textAfterLocalCommands;
  const text = realUserVisibleTextFromContent(message.content);
  if (parseCommandMessage(message)) return "";
  return stripDisplayWrapperTags(stripFrameworkReminderBlocks(text));
}

function realUserVisibleTextFromContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: extractContentText(content) }];
  return parts
    .map((part) => realUserVisibleTextPart(part))
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function realUserVisibleTextPart(part) {
  if (part == null) return "";
  if (typeof part === "string") return cleanRealUserTextPart(part);
  if (part.type === "tool_result" || part.type === "tool_use" || part.type === "thinking" || part.type === "reasoning") return "";
  const text = part.type === "text" ? part.text || "" : part.text || extractContentText(part.content);
  return cleanRealUserTextPart(text);
}

function cleanRealUserTextPart(text) {
  let value = stripFrameworkReminderBlocks(String(text || ""));
  if (/<local-command-|<command-(?:name|message|args)\b/i.test(value)) value = userTextAfterLocalCommandBlocks(value);
  else value = stripDisplayWrapperTags(value);
  if (!value) return "";
  if (isCompactInjectionText(value)) return "";
  if (isSkillInjectionText(value)) return "";
  if (isLocalCommandOnlyText(value)) return "";
  if (/^Tool loaded\.\s*$/i.test(value)) return "";
  return value;
}

function inferCaptureTitle(capture) {
  const body = capture?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((message) => message?.role === "user" && !isToolResultMessage(message) && !isSuggestionModeMessage(message) && !isFrameworkReminderMessage(message) && !isTaskNotificationMessage(message) && !isCompactInjectionMessage(message) && !isSkillInjectionMessage(message));
  const title = textPreview(cleanTitleText(userVisibleText(user)), 48);
  return title || null;
}

function cleanTitleText(text) {
  return String(text || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(commandMessageRegex(), "$1")
    .replace(commandNameRegex(), "$1")
    .replace(frameworkReminderRegex(), "")
    .replace(/\s*Write the title in [\s\S]*?Keep technical terms and code identifiers in their original form\.?\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function stripFrameworkReminderBlocks(text) {
  return String(text || "").replace(frameworkReminderRegex(), "").trim();
}

function stripDisplayWrapperTags(text) {
  return String(text || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(commandMessageRegex(), "$1")
    .replace(commandNameRegex(), "$1")
    .trim();
}

function userTextAfterLocalCommandBlocks(text) {
  const value = String(text || "");
  if (!/<local-command-|<command-(?:name|message|args)\b/i.test(value)) return "";
  const cleaned = stripFrameworkReminderBlocks(stripLocalCommandGeneratedMarkdown(value))
    .replace(localCommandCaveatRegex(), "")
    .replace(localCommandStdoutRegex(), "")
    .replace(localCommandStderrRegex(), "")
    .replace(commandArgsRegex(), "")
    .replace(commandMessageRegex(), "")
    .replace(commandNameRegex(), "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(stripAnsiRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

function stripLocalCommandGeneratedMarkdown(text) {
  let value = String(text || "");
  if (/<command-name\b[^>]*>\s*\/?context\s*<\/command-name>/i.test(value)) {
    value = value.replace(/(^|\n)## Context Usage[\s\S]*?(?=\n\s*<local-command-caveat\b|\n\s*<command-name\b|$)/gi, "\n");
  }
  return value;
}

function isLocalCommandOnlyText(text) {
  const value = String(text || "");
  if (!/<local-command-|<command-(?:name|message|args)\b/i.test(value)) return false;
  return !userTextAfterLocalCommandBlocks(value);
}

function hasFrameworkReminderBlock(text) {
  return frameworkReminderRegex().test(String(text || ""));
}

function frameworkReminderRegex() {
  return /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
}

function parseCommandMessage(messageOrText) {
  const text =
    typeof messageOrText === "string"
      ? messageOrText
      : messageOrText?.role === "user"
        ? extractContentText(messageOrText.content)
        : "";
  if (!text || !/<command-(?:message|name)\b/i.test(text)) return null;
  const commandName = firstTagValue(text, commandNameRegex());
  const commandMessage = firstTagValue(text, commandMessageRegex());
  const command = normalizeSlashCommand(commandName || commandMessage);
  if (!command) return null;
  const body = text
    .replace(commandMessageRegex(), "")
    .replace(commandNameRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    type: "claude_command",
    command,
    name: commandName ? normalizeSlashCommand(commandName) : command,
    message: commandMessage || command.replace(/^\//, ""),
    body,
    preview: textPreview(body || `Claude Code command ${command}`, 1200),
  };
}

function firstTagValue(text, regex) {
  const match = regex.exec(String(text || ""));
  return match?.[1]?.trim() || "";
}

function commandMessageRegex() {
  return /<command-message\b[^>]*>([\s\S]*?)<\/command-message>/gi;
}

function commandNameRegex() {
  return /<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi;
}

function commandArgsRegex() {
  return /<command-args\b[^>]*>[\s\S]*?<\/command-args>/gi;
}

function localCommandCaveatRegex() {
  return /<local-command-caveat\b[^>]*>[\s\S]*?<\/local-command-caveat>/gi;
}

function localCommandStdoutRegex() {
  return /<local-command-stdout\b[^>]*>[\s\S]*?<\/local-command-stdout>/gi;
}

function localCommandStderrRegex() {
  return /<local-command-stderr\b[^>]*>[\s\S]*?<\/local-command-stderr>/gi;
}

function stripAnsiRegex() {
  return /\x1B\[[0-?]*[ -/]*[@-~]/g;
}

function normalizeSlashCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+/)[0].replace(/^\/+/, "");
  if (!first) return "";
  return `/${first}`;
}

function commandUserVisibleText(commandMessage) {
  const prefix = `Command ${commandMessage.command}`;
  return commandMessage.body ? `${prefix}\n${commandMessage.body}` : prefix;
}

function commandPreviewText(commandMessage) {
  return commandMessage.body ? `${commandMessage.command} · ${commandMessage.body}` : commandMessage.command;
}

function isKnownFrameworkReminderText(text) {
  const value = String(text || "").trimStart();
  if (!/^The user stepped away and is coming back\./i.test(value.slice(0, 80))) return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  return /^The user stepped away and is coming back\. Recap in under 40 words,\s*1-2 plain sentences,\s*no markdown\./i.test(normalized);
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
    const requests = captures.map((capture, index) => summarizeCapture(capture, { agent: "", confidence: "unknown", kind: "proxy_capture" }, index, debugSources[index]));
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
      const inferredTitle = captures.map(inferCaptureTitle).find(Boolean);
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

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function displayProjectName(workspace) {
  if (!workspace) return "未归属项目";
  const normalized = String(workspace).replace(/\/$/, "");
  return path.basename(normalized) || normalized;
}

function shortenId(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
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
