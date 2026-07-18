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
    association: {
      method: provenance.association?.method || "none",
      confidence: provenance.association?.confidence || "none",
    },
    limitations: [...new Set(limitations)],
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
