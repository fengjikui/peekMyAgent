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
import { resolveViewerStaticAsset } from "../server/viewer-static-assets.mjs";
import {
  normalizeTranslationSourceText,
} from "../translation/blocks.mjs";
import { TranslationMaterialCollector } from "../translation/materials.mjs";
import { TranslationService } from "../translation/service.mjs";
import { annotateRequestContextChanges } from "../trace/context-delta.mjs";
import {
  extractContentText,
  extractToolCalls,
  extractToolResults,
} from "../trace/content-parts.mjs";
import {
  classifyMessageKind,
  classifyCurrentEntry,
  cleanTitleText,
  compactInjectionText,
  commandPreviewText,
  commandUserVisibleText,
  displayMessageText,
  isCompactInjectionMessage,
  isFrameworkReminderMessage,
  isKnownFrameworkReminderText,
  isSkillInjectionMessage,
  isSuggestionModeMessage,
  isTaskNotificationMessage,
  isToolResultMessage,
  lastMessage,
  lastRealUserMessage,
  parseCommandMessage,
  realUserVisibleText,
  userVisibleText,
} from "../trace/message-semantics.mjs";
import { summarizeModelResponse } from "../trace/model-response-normalizer.mjs";
import { analyzeRequestComposition } from "../trace/request-composition.mjs";
import {
  extractSystemParts,
  inferProtocolProfile,
  inferRequestSource,
  isContextTokenCountingRequest,
} from "../trace/request-profile.mjs";
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
  const sourceHint = inferRequestSource({ capture, body, currentUser, debugSource, lastUser });
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
      composition: analyzeRequestComposition({
        body,
        messages,
        systemParts,
        tools,
        currentUser,
        responseSummary,
        rawBodyLength: capture.raw_body_length,
      }),
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
    classifyMessage: classifyMessageKind,
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
    kind: classifyMessageKind(message),
    text: textPreview(commandMessage ? commandPreviewText(commandMessage) : displayMessageText(message), 220),
    command_message: commandMessage,
  };
}

function summarizeHistoryStack(messages, currentUser) {
  const currentUserKey = currentUser ? stableJson(currentUser) : "";
  return (messages || []).map((message, index) => {
    const kind = classifyMessageKind(message);
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

function charLength(value) {
  return String(value || "").length;
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

function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function inferCaptureTitle(capture) {
  const body = capture?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((message) => message?.role === "user" && !isToolResultMessage(message) && !isSuggestionModeMessage(message) && !isFrameworkReminderMessage(message) && !isTaskNotificationMessage(message) && !isCompactInjectionMessage(message) && !isSkillInjectionMessage(message));
  const title = textPreview(cleanTitleText(userVisibleText(user)), 48);
  return title || null;
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
