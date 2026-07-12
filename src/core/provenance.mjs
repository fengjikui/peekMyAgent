export const PROVENANCE_SCHEMA_VERSION = 1;

const FIDELITY_VALUES = new Set(["exact", "partial", "missing"]);
const ASSOCIATION_CONFIDENCE_VALUES = new Set(["exact", "high", "heuristic", "none"]);

export function createCaptureProvenance({ transport, request, response, association }) {
  const value = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    transport: requiredText(transport, "transport"),
    request: normalizeArtifact(request, "request"),
    response: normalizeArtifact(response, "response"),
    association: normalizeAssociation(association),
  };
  return value;
}

export function validateCaptureProvenance(value) {
  const errors = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["provenance must be an object"] };
  if (value.schema_version !== PROVENANCE_SCHEMA_VERSION) errors.push(`schema_version must be ${PROVENANCE_SCHEMA_VERSION}`);
  if (!nonEmptyText(value.transport)) errors.push("transport is required");
  validateArtifact(value.request, "request", errors);
  validateArtifact(value.response, "response", errors);
  const association = value.association;
  if (!association || typeof association !== "object") {
    errors.push("association is required");
  } else {
    if (!nonEmptyText(association.method)) errors.push("association.method is required");
    if (!ASSOCIATION_CONFIDENCE_VALUES.has(association.confidence)) errors.push("association.confidence is invalid");
  }
  return { ok: errors.length === 0, errors };
}

export function captureProvenanceOr(value, fallbackFactory) {
  if (value == null) return fallbackFactory();
  const validation = validateCaptureProvenance(value);
  if (!validation.ok) throw new Error(`Invalid capture provenance: ${validation.errors.join("; ")}`);
  return createCaptureProvenance(value);
}

export function proxyCaptureProvenance(capture = {}) {
  const hasResponse = Boolean(capture.response);
  const responseIsPartial = hasResponse && Boolean(capture.response?.truncated);
  const responseIsError = hasResponse && Boolean(capture.response?.error || capture.upstream_error);
  return createCaptureProvenance({
    transport: "capture_proxy",
    request: { origin: "network_proxy", fidelity: "exact", artifact: "http_request" },
    response: hasResponse
      ? {
          origin: responseIsError ? "capture_proxy" : "network_proxy",
          fidelity: responseIsPartial ? "partial" : "exact",
          artifact: responseIsError ? "proxy_error_response" : "http_response",
        }
      : { origin: null, fidelity: "missing", artifact: null },
    association: hasResponse
      ? {
          method: "capture_lifecycle",
          confidence: "exact",
          evidence: {
            capture_id: capture.capture_id || capture.captureId || null,
            response_status: capture.response?.status ?? capture.upstream_status ?? null,
          },
        }
      : { method: "none", confidence: "none" },
  });
}

export function importedTraceProvenance(capture = {}) {
  const hasRequest = Object.hasOwn(capture, "body") && capture.body != null;
  const hasResponse = Boolean(capture.response);
  return createCaptureProvenance({
    transport: "trace_import",
    request: hasRequest
      ? { origin: "imported_trace", fidelity: "exact", artifact: "capture_request" }
      : { origin: "imported_trace", fidelity: "missing", artifact: null },
    response: hasResponse
      ? {
          origin: "imported_trace",
          fidelity: capture.response?.truncated ? "partial" : "exact",
          artifact: "capture_response",
        }
      : { origin: "imported_trace", fidelity: "missing", artifact: null },
    association: hasResponse
      ? {
          method: "imported_capture_record",
          confidence: "high",
          evidence: { capture_id: capture.capture_id || capture.captureId || null },
        }
      : { method: "none", confidence: "none" },
  });
}

function normalizeArtifact(value, name) {
  const artifact = value && typeof value === "object" ? value : {};
  const fidelity = artifact.fidelity || "missing";
  if (!FIDELITY_VALUES.has(fidelity)) throw new Error(`${name}.fidelity is invalid`);
  return {
    origin: artifact.origin ? String(artifact.origin) : null,
    fidelity,
    artifact: artifact.artifact ? String(artifact.artifact) : null,
  };
}

function normalizeAssociation(value) {
  const association = value && typeof value === "object" ? value : {};
  const confidence = association.confidence || "none";
  if (!ASSOCIATION_CONFIDENCE_VALUES.has(confidence)) throw new Error("association.confidence is invalid");
  return {
    method: association.method ? String(association.method) : "none",
    confidence,
    evidence: sanitizeEvidence(association.evidence),
  };
}

function sanitizeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null || ["string", "number", "boolean"].includes(typeof item)) output[key] = item;
  }
  return output;
}

function validateArtifact(value, name, errors) {
  if (!value || typeof value !== "object") {
    errors.push(`${name} is required`);
    return;
  }
  if (!FIDELITY_VALUES.has(value.fidelity)) errors.push(`${name}.fidelity is invalid`);
}

function requiredText(value, name) {
  if (!nonEmptyText(value)) throw new Error(`${name} is required`);
  return String(value);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
