export const CAPTURE_SEMANTIC_EVENT_SCHEMA_VERSION = 1;

const EVENT_CATEGORIES = new Set(["context_lifecycle", "agent_lifecycle", "harness_lifecycle"]);
const EVENT_ACTORS = new Set(["harness", "agent", "user"]);

export function createCaptureSemanticEvent({ category, type, actor = "harness", source, evidence = {}, data = {} } = {}) {
  const value = {
    schema_version: CAPTURE_SEMANTIC_EVENT_SCHEMA_VERSION,
    category: requiredEnum(category, EVENT_CATEGORIES, "category"),
    type: requiredText(type, "type"),
    actor: requiredEnum(actor, EVENT_ACTORS, "actor"),
    source: requiredText(source, "source"),
    evidence: normalizeEvidence(evidence),
    data: normalizeData(data),
  };
  return Object.freeze(value);
}

export function captureSemanticEntry(event) {
  if (!event || event.schema_version !== CAPTURE_SEMANTIC_EVENT_SCHEMA_VERSION) return null;
  if (event.type === "context_compacted") {
    const data = event.data || {};
    return {
      kind: "compact",
      label: "Context compacted",
      text: contextCompactionText(data),
      semantic_event: event,
      codex_compaction: {
        previous_window_id: data.previous_window_id || null,
        window_id: data.window_id || null,
        window_number: finiteNumber(data.window_number),
        replacement_item_count: nonNegativeInteger(data.replacement_item_count),
        retained_message_count: nonNegativeInteger(data.retained_message_count),
        retained_message_roles: normalizeCountMap(data.retained_message_roles),
        opaque_compaction_count: nonNegativeInteger(data.opaque_compaction_count),
        history_effect: data.history_effect ? String(data.history_effect) : null,
        post_compaction_estimated_context_tokens: finiteNumber(data.post_compaction_estimated_context_tokens),
        token_estimate_kind: data.token_estimate_kind ? String(data.token_estimate_kind) : null,
        model_context_window: finiteNumber(data.model_context_window),
      },
    };
  }
  return {
    kind: "harness_event",
    label: event.type,
    text: event.type,
    semantic_event: event,
  };
}

function contextCompactionText(data) {
  const window = data.window_number != null ? `Window ${data.window_number}` : "Context window";
  const items = nonNegativeInteger(data.replacement_item_count);
  return `${window} compacted${items ? ` · ${items} replacement items` : ""}`;
}

function normalizeEvidence(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    origin: input.origin ? String(input.origin) : null,
    fidelity: input.fidelity ? String(input.fidelity) : "partial",
    exact_wire_event: Boolean(input.exact_wire_event),
  };
}

function normalizeData(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`semantic event ${name} is required`);
  return text;
}

function requiredEnum(value, allowed, name) {
  const text = requiredText(value, name);
  if (!allowed.has(text)) throw new TypeError(`semantic event ${name} is invalid`);
  return text;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizeCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [String(key), nonNegativeInteger(count)])
      .filter(([, count]) => count > 0),
  );
}
