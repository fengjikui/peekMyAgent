import path from "node:path";

const BODY_EVENT_NAMES = new Set(["api_request_body", "api_response_body"]);
const DEFAULT_MAX_EVENTS = 10000;

export function extractOtelBodyEvents(payload, { maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  const output = [];
  for (const resource of payload?.resourceLogs || []) {
    for (const scope of resource?.scopeLogs || []) {
      for (const record of scope?.logRecords || []) {
        if (output.length >= maxEvents) return output;
        const attributes = otelAttributes(record.attributes);
        const eventName = attributes["event.name"] || otelValue(record.body);
        if (!BODY_EVENT_NAMES.has(eventName) || !attributes.body_ref) continue;
        output.push({
          event_name: eventName,
          event_sequence: finiteNumber(attributes["event.sequence"]),
          prompt_id: textOrNull(attributes["prompt.id"]),
          query_source: textOrNull(attributes.query_source),
          request_id: textOrNull(attributes.request_id),
          body_ref: path.basename(String(attributes.body_ref)),
          trace_id: textOrNull(record.traceId || record.trace_id),
          span_id: textOrNull(record.spanId || record.span_id),
        });
      }
    }
  }
  return output;
}

export function mergeOtelBodyEvents(existing, incoming, { maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  const byArtifact = new Map();
  for (const event of [...(existing || []), ...(incoming || [])]) {
    if (!event?.body_ref || !BODY_EVENT_NAMES.has(event.event_name)) continue;
    byArtifact.set(`${event.event_name}:${event.body_ref}`, event);
  }
  return [...byArtifact.values()]
    .sort((a, b) => eventOrder(a) - eventOrder(b) || a.body_ref.localeCompare(b.body_ref))
    .slice(-maxEvents);
}

export function correlationKey(event) {
  if (!event?.trace_id || !event?.span_id) return null;
  return `${event.trace_id}:${event.span_id}`;
}

function eventOrder(event) {
  return Number.isFinite(event?.event_sequence) ? event.event_sequence : Number.MAX_SAFE_INTEGER;
}

function otelAttributes(items) {
  return Object.fromEntries((items || []).map((item) => [item.key, otelValue(item.value)]));
}

function otelValue(value) {
  if (!value || typeof value !== "object") return value ?? null;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"]) {
    if (key in value) return value[key];
  }
  if (value.arrayValue) return (value.arrayValue.values || []).map(otelValue);
  return null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  return value == null || value === "" ? null : String(value);
}
