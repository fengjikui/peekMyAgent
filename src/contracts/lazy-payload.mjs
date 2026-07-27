export const LAZY_PAYLOAD_CONTRACT_VERSION = 1;
export const LAZY_PAYLOAD_MARKER = "peekmyagent.lazy_payload.v1";

export function isLazyPayload(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.__peekmyagent_lazy_payload__ === LAZY_PAYLOAD_MARKER &&
      typeof value.ref === "string" &&
      value.ref.length > 0,
  );
}

export function containsLazyPayload(value) {
  if (isLazyPayload(value)) return true;
  if (Array.isArray(value)) return value.some(containsLazyPayload);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsLazyPayload);
}

export function hydrateLazyPayload(value, ref, payload) {
  if (!ref || !payload || typeof payload !== "object") return value;
  return replaceLazyPayload(value, ref, payload).value;
}

export function validateLazyPayloadResponse(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["response must be an object"] };
  if (!nonEmptyText(value.request_id)) errors.push("request_id is required");
  if (!nonEmptyText(value.ref)) errors.push("ref is required");
  if (!isRecord(value.payload)) {
    errors.push("payload must be an object");
  } else {
    if (!nonEmptyText(value.payload.kind)) errors.push("payload.kind is required");
    if (!nonEmptyText(value.payload.encoding)) errors.push("payload.encoding is required");
    if (typeof value.payload.value !== "string") errors.push("payload.value must be a string");
    if (!nonNegativeInteger(value.payload.byte_size)) errors.push("payload.byte_size must be a non-negative integer");
    if (!nonEmptyText(value.payload.sha256)) errors.push("payload.sha256 is required");
  }
  return { ok: errors.length === 0, errors };
}

export function assertLazyPayloadResponse(value, name = "Viewer API lazy payload") {
  const validation = validateLazyPayloadResponse(value);
  if (!validation.ok) throw new Error(`Invalid ${name}: ${validation.errors.join("; ")}`);
  return value;
}

function replaceLazyPayload(value, ref, payload) {
  if (isLazyPayload(value)) {
    if (value.ref !== ref) return { value, changed: false };
    return {
      value: {
        ...value,
        load_state: "loaded",
        loaded_value: payload.value,
        encoding: payload.encoding || value.encoding,
        mime_type: payload.mime_type || value.mime_type || null,
      },
      changed: true,
    };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = replaceLazyPayload(item, ref, payload);
      changed ||= next.changed;
      return next.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const next = replaceLazyPayload(item, ref, payload);
    changed ||= next.changed;
    return [key, next.value];
  });
  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0;
}
