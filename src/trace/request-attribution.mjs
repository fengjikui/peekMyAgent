const DEFAULTS_BY_TYPE = {
  main: {
    actor: "main_agent",
    relation: "current_dialogue",
    operation: "model_turn",
  },
  subagent: {
    actor: "subagent",
    relation: "child_dialogue",
    operation: "subagent_turn",
  },
  parent_spawn: {
    actor: "main_agent",
    relation: "current_dialogue",
    operation: "subagent_spawn",
  },
  metadata: {
    actor: "harness",
    relation: "current_dialogue",
    operation: "harness_operation",
  },
  background: {
    actor: "background_service",
    relation: "independent",
    operation: "background_operation",
  },
};

export function createRequestAttribution({
  type,
  label,
  label_key,
  note_key,
  actor,
  relation,
  operation,
  request_kind,
  confidence = "medium",
  evidence = [],
} = {}) {
  const defaults = DEFAULTS_BY_TYPE[type];
  if (!defaults) throw new TypeError(`Unsupported request attribution type: ${type}`);
  return compactObject({
    type,
    label,
    label_key,
    note_key,
    actor: actor || defaults.actor,
    relation: relation || defaults.relation,
    operation: operation || defaults.operation,
    request_kind,
    confidence,
    evidence: normalizeEvidence(evidence),
  });
}

export function requestAttributionEvidence(origin, field, value = "present") {
  const safeOrigin = normalizeToken(origin, "unknown");
  const safeField = normalizeField(field);
  const safeValue = normalizeValue(value);
  return compactObject({ origin: safeOrigin, field: safeField, value: safeValue });
}

function normalizeEvidence(items) {
  const output = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const normalized = requestAttributionEvidence(item.origin, item.field, item.value);
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeToken(value, fallback) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,47}$/.test(text) ? text : fallback;
}

function normalizeField(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z0-9_.\-[\]]{1,160}$/.test(text)) return text;
  return "unknown";
}

function normalizeValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (/^[A-Za-z0-9_./:-]{1,80}$/.test(text)) return text;
  return "present";
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
