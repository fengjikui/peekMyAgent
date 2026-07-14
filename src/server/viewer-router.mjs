import {
  readJsonBody,
  readRawBody,
  rejectWrongMethod,
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
} from "./http.mjs";
import {
  VIEWER_API_LIMITS,
  VIEWER_API_ROUTES,
  expectedViewerApiMethod,
  sanitizeApiLookupId,
} from "./viewer-api-contract.mjs";
import { TRACE_BUNDLE_LIMITS } from "./trace-bundle-service.mjs";
import { projectTimelineViewerData } from "./timeline-view-projector.mjs";

const OTEL_WATCH_ID_HEADER = "x-peekmyagent-watch-id";

const REQUIRED_OPERATIONS = Object.freeze([
  "listSources",
  "loadTranslations",
  "generateTranslations",
  "startWatch",
  "stopWatch",
  "pauseWatch",
  "sendAgentMessage",
  "updateSource",
  "importTrace",
  "exportTrace",
  "ingestOtelCaptures",
  "ingestOtelEvents",
  "listWatchStatus",
  "daemonPing",
  "daemonStatus",
  "requestShutdown",
  "loadViewerData",
  "startTimeline",
  "nextTimeline",
  "loadRequestDetail",
]);

const INTENT_VALIDATORS = new Map([
  ["/api/translations/generate", validateTranslationGenerateIntent],
  ["/api/watch/start", validateWatchStartIntent],
  ["/api/watch/stop", validateWatchStopIntent],
  ["/api/watch/pause", validateWatchPauseIntent],
  ["/api/agent/send", validateAgentSendIntent],
  ["/api/source/update", validateSourceUpdateIntent],
  ["/api/trace/import", validateTraceImportIntent],
  ["/api/trace/export", validateTraceExportIntent],
  ["/api/capture/otel", validateOtelIngestIntent],
  ["/api/capture/otel/events", validateOtelEventIngestIntent],
  ["/api/capture/otel/traces", validateOtelEventIngestIntent],
  ["/api/daemon/shutdown", validateDaemonShutdownIntent],
]);

export function createViewerRouter({
  unsafeAllowRemote = false,
  defaultSourceId = null,
  operations,
  staticAssets = null,
  pid = process.pid,
} = {}) {
  assertOperations(operations);
  assertStaticAssets(staticAssets);
  const routeHandlers = createRouteHandlers({ defaultSourceId, operations, pid });
  assertRouteContract(routeHandlers);

  return async function routeViewerRequest(req, res) {
    const url = new URL(req.url || "/", "http://peek.local");
    const guard = validateLocalHttpRequest(req, url, { unsafeAllowRemote });
    if (guard) return writeJson(res, guard.status, { error: guard.message });

    const staticAsset = staticAssets?.resolve?.(url.pathname);
    if (staticAsset) return staticAssets.serve(res, staticAsset);

    const handler = routeHandlers.get(url.pathname);
    if (!handler) return writeJson(res, 404, { error: "Not found" });

    const expectedMethod = expectedViewerApiMethod(url.pathname);
    if (rejectWrongMethod(req, res, expectedMethod)) return;

    const validateIntent = INTENT_VALIDATORS.get(url.pathname);
    const intentGuard = validateIntent?.(req);
    if (intentGuard) return writeJson(res, intentGuard.status, { error: intentGuard.message });

    return handler({ req, res, url });
  };
}

function createRouteHandlers({ defaultSourceId, operations, pid }) {
  return new Map([
    ["/api/sources", async ({ res }) => writeJson(res, 200, await operations.listSources())],
    [
      "/api/translations",
      async ({ res, url }) =>
        writeJson(
          res,
          200,
          await operations.loadTranslations({
            agent: url.searchParams.get("agent") || "Claude Code",
            targetLanguage: url.searchParams.get("target_language") || "zh-CN",
          }),
        ),
    ],
    ["/api/translations/generate", jsonOperation(operations.generateTranslations)],
    ["/api/watch/start", jsonOperation(operations.startWatch)],
    ["/api/watch/stop", jsonOperation(operations.stopWatch)],
    ["/api/watch/pause", jsonOperation(operations.pauseWatch)],
    ["/api/agent/send", jsonOperation(operations.sendAgentMessage)],
    ["/api/source/update", jsonOperation(operations.updateSource)],
    [
      "/api/trace/import",
      async ({ req, res }) => {
        const buffer = await readRawBody(req, { maxBytes: TRACE_BUNDLE_LIMITS.importBytes });
        return writeJson(res, 200, await operations.importTrace(buffer));
      },
    ],
    [
      "/api/trace/export",
      async ({ res, url }) => writeTraceBundle(res, await operations.exportTrace(url.searchParams.get("source") || "")),
    ],
    ["/api/capture/otel", jsonOperation(operations.ingestOtelCaptures)],
    [
      "/api/capture/otel/events",
      async ({ req, res, url }) => {
        const watchId = sanitizeApiLookupId(requestHeader(req, OTEL_WATCH_ID_HEADER) || url.searchParams.get("watch_id"), {
          limit: VIEWER_API_LIMITS.requestIdChars,
        });
        const payload = await readJsonBody(req);
        return writeJson(res, 200, await operations.ingestOtelEvents({ watchId, payload }));
      },
    ],
    [
      "/api/capture/otel/traces",
      async ({ req, res }) => {
        await readJsonBody(req);
        return writeJson(res, 200, {});
      },
    ],
    ["/api/watch/status", async ({ res }) => writeJson(res, 200, await operations.listWatchStatus())],
    ["/api/daemon/ping", async ({ res }) => writeJson(res, 200, await operations.daemonPing())],
    ["/api/daemon/status", async ({ res }) => writeJson(res, 200, await operations.daemonStatus())],
    [
      "/api/daemon/shutdown",
      async ({ res }) => {
        res.once("finish", operations.requestShutdown);
        return writeJson(res, 200, { ok: true, action: "shutdown", pid });
      },
    ],
    ["/api/view", createViewHandler({ defaultSourceId, operations })],
    ["/api/request", createRequestHandler({ defaultSourceId, operations })],
  ]);
}

function jsonOperation(operation) {
  return async ({ req, res }) => writeJson(res, 200, await operation(await readJsonBody(req)));
}

function createViewHandler({ defaultSourceId, operations }) {
  return async ({ res, url }) => {
    const requestedSource = sanitizeApiLookupId(url.searchParams.get("source"), { limit: VIEWER_API_LIMITS.sourceIdChars });
    const sourceId = requestedSource || defaultSourceId || null;
    const compact = url.searchParams.get("compact") === "1";
    const cursor = sanitizeApiLookupId(url.searchParams.get("cursor"), { limit: VIEWER_API_LIMITS.cursorChars });

    if (compact && (url.searchParams.get("initial") === "1" || cursor)) {
      const limit = boundedPositiveInt(url.searchParams.get("limit"), VIEWER_API_LIMITS.initialRequests, VIEWER_API_LIMITS.maxInitialRequests);
      const data = cursor
        ? await operations.nextTimeline({ sourceId, cursor, limit })
        : await operations.startTimeline({ sourceId, limit });
      return writeJson(res, 200, data);
    }

    const data = await operations.loadViewerData({
      sourceId,
      requireSource: Boolean(requestedSource),
      initialLimit: initialViewLimit(url.searchParams),
    });
    return writeJson(res, 200, compact ? projectTimelineViewerData(data) : data);
  };
}

function createRequestHandler({ defaultSourceId, operations }) {
  return async ({ res, url }) => {
    const requestedSource = sanitizeApiLookupId(url.searchParams.get("source"), { limit: VIEWER_API_LIMITS.sourceIdChars });
    const sourceId = requestedSource || defaultSourceId || null;
    const requestId = sanitizeApiLookupId(url.searchParams.get("request") || "", { limit: VIEWER_API_LIMITS.requestIdChars });
    return writeJson(
      res,
      200,
      await operations.loadRequestDetail({ sourceId, requestId, requireSource: Boolean(requestedSource) }),
    );
  };
}

function initialViewLimit(searchParams) {
  if (searchParams.get("initial") !== "1" && !searchParams.has("limit")) return 0;
  return boundedPositiveInt(searchParams.get("limit"), VIEWER_API_LIMITS.initialRequests, VIEWER_API_LIMITS.maxInitialRequests);
}

function boundedPositiveInt(value, fallback, max) {
  const number = Number(value);
  const positive = Number.isInteger(number) && number > 0 ? number : fallback;
  return Math.min(positive, max);
}

function writeTraceBundle(res, exported) {
  res.writeHead(200, {
    ...viewerSecurityHeaders(),
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${exported.filename}"`,
    "cache-control": "no-store",
    "x-peekmyagent-trace-id": exported.bundle.manifest.trace_id,
  });
  res.end(exported.buffer);
}

function requestHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function assertOperations(operations) {
  if (!operations || typeof operations !== "object") throw new TypeError("ViewerRouter requires an operations object.");
  const missing = REQUIRED_OPERATIONS.filter((name) => typeof operations[name] !== "function");
  if (missing.length) throw new TypeError(`ViewerRouter is missing operations: ${missing.join(", ")}`);
}

function assertStaticAssets(staticAssets) {
  if (staticAssets == null) return;
  if (typeof staticAssets.resolve !== "function" || typeof staticAssets.serve !== "function") {
    throw new TypeError("ViewerRouter staticAssets requires resolve and serve functions.");
  }
}

function assertRouteContract(routeHandlers) {
  const expectedPaths = VIEWER_API_ROUTES.map(({ pathname }) => pathname).sort();
  const actualPaths = [...routeHandlers.keys()].sort();
  if (expectedPaths.length !== actualPaths.length || expectedPaths.some((pathname, index) => pathname !== actualPaths[index])) {
    throw new Error("ViewerRouter handlers do not match the shared Viewer API route contract.");
  }
}
