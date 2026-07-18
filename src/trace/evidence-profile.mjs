export function captureEvidenceProfile(capture = {}) {
  const provenance = capture.provenance && typeof capture.provenance === "object" ? capture.provenance : {};
  const request = artifactProfile(provenance.request);
  const response = artifactProfile(provenance.response);
  const codex = capture.body?.codex && typeof capture.body.codex === "object" ? capture.body.codex : {};
  const semanticEvent = capture.semantic_event || codex.semantic_event || null;
  if (semanticEvent) {
    return {
      schema_version: 1,
      kind: "semantic_event",
      transport: provenance.transport || capture.body_source || "unknown",
      request,
      response,
      association: {
        method: provenance.association?.method || "none",
        confidence: provenance.association?.confidence || "none",
      },
      semantic_event: {
        category: semanticEvent.category || null,
        type: semanticEvent.type || null,
        origin: semanticEvent.evidence?.origin || null,
        fidelity: semanticEvent.evidence?.fidelity || "partial",
        exact_wire_event: Boolean(semanticEvent.evidence?.exact_wire_event),
      },
      limitations: semanticEvent.evidence?.exact_wire_event ? [] : ["exact_wire_unavailable"],
    };
  }
  const limitations = [];
  if (request.fidelity === "partial") limitations.push("request_partial");
  if (response.fidelity === "partial") limitations.push("response_partial");
  if (codex.input_scope === "observed_upstream_delta") limitations.push("observed_upstream_delta");
  if (codex.full_request_history_available === false) limitations.push("full_history_unavailable");
  if (codex.tool_schema_scope === "dynamic_tools_only") limitations.push("dynamic_tools_only");
  if (codex.tool_schema_scope === "not_present_in_rollout") limitations.push("tool_schema_unavailable");
  if (codex.exact_wire_request === false) limitations.push("exact_wire_unavailable");
  return {
    schema_version: 1,
    kind: "request_response",
    transport: provenance.transport || capture.body_source || "unknown",
    request,
    response,
    sections: sectionEvidenceProfiles(request, codex),
    association: {
      method: provenance.association?.method || "none",
      confidence: provenance.association?.confidence || "none",
    },
    limitations: [...new Set(limitations)],
  };
}

function sectionEvidenceProfiles(request, codex) {
  const requestScope = request.exact ? "complete_request" : "partial_request";
  const inputScope = codex.input_scope || requestScope;
  const toolScope = codex.tool_schema_scope || requestScope;
  const observedInput = inputScope === "observed_upstream_delta";
  const toolUnavailable = toolScope === "not_present_in_rollout";

  return {
    system: {
      source: "request",
      origin: request.origin,
      fidelity: request.fidelity,
      scope: observedInput ? "observed_upstream_delta" : requestScope,
      available: request.available,
    },
    tools: {
      source: toolScope === "dynamic_tools_only" ? "session_metadata" : "request",
      origin: codex.tool_schema_origin || request.origin,
      fidelity: toolUnavailable ? "missing" : request.fidelity,
      scope: toolScope,
      available: request.available && !toolUnavailable,
      count: optionalNonNegativeInteger(codex.tool_schema_count),
    },
    messages: {
      source: "request",
      origin: request.origin,
      fidelity: request.fidelity,
      scope: inputScope,
      available: request.available,
      history_complete:
        typeof codex.full_request_history_available === "boolean"
          ? codex.full_request_history_available
          : request.exact
            ? true
            : null,
    },
    harness: {
      source: "pma_semantic_projection",
      origin: request.origin,
      fidelity: request.fidelity,
      scope: observedInput ? "observed_upstream_delta" : requestScope,
      available: request.available,
      derived: true,
    },
  };
}

function artifactProfile(value) {
  const artifact = value && typeof value === "object" ? value : {};
  const fidelity = artifact.fidelity || "missing";
  return {
    origin: artifact.origin || null,
    fidelity,
    artifact: artifact.artifact || null,
    exact: fidelity === "exact",
    available: fidelity !== "missing",
  };
}

function optionalNonNegativeInteger(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
