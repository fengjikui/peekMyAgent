import { OTEL_WATCH_KIND, otelDirToCaptures } from "../core/otel-capture.mjs";
import { extractOtelBodyEvents, mergeOtelBodyEvents } from "../core/otel-events.mjs";
import { sourceIdForWatch } from "../core/source-identifiers.mjs";

export const OTEL_INGEST_LIMITS = Object.freeze({
  eventWatches: 32,
  eventsPerWatch: 2400,
});

export class OtelIngestService {
  constructor({
    store,
    cwd = "",
    bodyEvents,
    limits,
    toCaptures,
    extractEvents,
    mergeEvents,
    sourceId,
    sanitizeTitle,
    conversationTitle,
    badRequest,
  } = {}) {
    this.store = requiredObject(store, "store");
    this.cwd = String(cwd || "");
    this.bodyEvents = bodyEvents instanceof Map ? bodyEvents : new Map();
    this.limits = { ...OTEL_INGEST_LIMITS, ...(limits || {}) };
    this.toCaptures = typeof toCaptures === "function" ? toCaptures : otelDirToCaptures;
    this.extractEvents = typeof extractEvents === "function" ? extractEvents : extractOtelBodyEvents;
    this.mergeEvents = typeof mergeEvents === "function" ? mergeEvents : mergeOtelBodyEvents;
    this.sourceId = typeof sourceId === "function" ? sourceId : sourceIdForWatch;
    this.sanitizeTitle = typeof sanitizeTitle === "function" ? sanitizeTitle : (value) => String(value || "").trim();
    this.conversationTitle = typeof conversationTitle === "function" ? conversationTitle : () => "";
    this.badRequest = typeof badRequest === "function" ? badRequest : defaultBadRequest;
  }

  async ingestCaptures(input = {}) {
    const dir = String(input.dir || "").trim();
    if (!dir) throw new Error("ingestOtelCaptures requires a dump dir");
    const watchId = String(input.watch_id || "").trim();
    if (!watchId) throw new Error("ingestOtelCaptures requires watch_id");

    const agent = input.agent || "Claude Code";
    const workspace = input.workspace || this.cwd;
    const conversationId = input.conversation_id || null;
    const events = this.bodyEvents.get(watchId) || [];
    const eventCorrelationEnabled = input.event_correlation_enabled === true;
    const finalIngest = input.final === true;
    const captures = this.toCaptures(
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
      title: this.sanitizeTitle(input.title || this.conversationTitle({ agent, conversation_id: conversationId })) || null,
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
    let nextRequestIndex = this.store.nextRequestIndex(watchId) || 1;
    for (const capture of captures) {
      if (!this.store.hasRequest(capture.capture_id)) {
        capture.request_index = nextRequestIndex;
        nextRequestIndex += 1;
      }
      const result = this.store.upsertCapture({ watch, capture });
      if (result?.inserted) ingested += 1;
      // A later refresh can attach a response to an already-persisted request.
      if (capture.response && this.store.updateCaptureResponse(capture)?.updated) responses += 1;
    }

    if (finalIngest) this.bodyEvents.delete(watchId);
    return {
      ok: true,
      watch_id: watchId,
      source_id: this.sourceId(watchId),
      total: captures.length,
      ingested,
      responses,
      event_correlations: events.length,
    };
  }

  async ingestEvents({ watchId, payload } = {}) {
    if (!watchId) throw this.badRequest("OTel event ingest requires watch_id");
    const incoming = this.extractEvents(payload, { maxEvents: this.limits.eventsPerWatch });
    const merged = this.mergeEvents(this.bodyEvents.get(watchId) || [], incoming, { maxEvents: this.limits.eventsPerWatch });
    this.bodyEvents.delete(watchId);
    while (this.bodyEvents.size >= this.limits.eventWatches) {
      const oldestWatchId = this.bodyEvents.keys().next().value;
      if (!oldestWatchId) break;
      this.bodyEvents.delete(oldestWatchId);
    }
    this.bodyEvents.set(watchId, merged);
    return { accepted: incoming.length, indexed: merged.length };
  }
}

function defaultBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} is required`);
  return value;
}
