export const EVIDENCE_MODES = Object.freeze({
  EXACT: "exact",
  RECONSTRUCTED: "reconstructed",
  PARTIAL: "partial",
  MISSING: "missing",
  UNKNOWN: "unknown",
  SEMANTIC_EVENT: "semantic_event",
});

export function buildSourceEvidenceView(source = {}, { translate = identityTranslate } = {}) {
  const mode = sourceEvidenceMode(source);
  return {
    mode,
    navigatorSuffix: mode === EVIDENCE_MODES.RECONSTRUCTED ? translate("semanticReconstruction") : "",
  };
}

export function buildRequestEvidenceView(request = {}, { translate = identityTranslate } = {}) {
  const semanticEvent = requestHasSemanticEvent(request);
  const upstreamMode = semanticEvent
    ? EVIDENCE_MODES.SEMANTIC_EVENT
    : artifactEvidenceMode(request?.summary?.evidence?.request, {
        reconstructed: requestUsesReconstructedUpstream(request),
      });
  const downstreamMode = semanticEvent
    ? EVIDENCE_MODES.MISSING
    : artifactEvidenceMode(request?.summary?.evidence?.response, {
        reconstructed: responseUsesReconstructedDownstream(request),
      });
  const reconstructedUpstream = upstreamMode === EVIDENCE_MODES.RECONSTRUCTED;
  const reconstructedDownstream = downstreamMode === EVIDENCE_MODES.RECONSTRUCTED;
  return {
    kind: semanticEvent ? EVIDENCE_MODES.SEMANTIC_EVENT : "request_response",
    upstream: {
      mode: upstreamMode,
      reconstructed: reconstructedUpstream,
      expandLabel: translate(reconstructedUpstream ? "expandReconstructedUpstream" : "expandUpstream"),
      collapseLabel: translate(reconstructedUpstream ? "collapseReconstructedUpstream" : "collapseUpstream"),
      detailsLabel: translate(reconstructedUpstream ? "reconstructedUpstreamDetails" : "upstreamDetails", {
        index: request?.request_index ?? "",
      }),
      rawTitle: translate(reconstructedUpstream ? "reconstructedUpstreamActionHelp" : "fullCaptureTitle"),
    },
    downstream: {
      mode: downstreamMode,
      reconstructed: reconstructedDownstream,
    },
  };
}

export function buildRawSectionEvidenceView(
  request = {},
  section,
  { mode = "request", translate = identityTranslate } = {},
) {
  if (requestHasSemanticEvent(request)) return null;
  const evidenceSection = ["history", "message"].includes(section) ? "messages" : section;
  const profile = request?.summary?.evidence?.sections?.[evidenceSection] || null;

  if (mode === "response" && section === "tools") {
    if (profile?.scope === "dynamic_tools_only") {
      return sectionEvidence(
        "reference",
        translate("rawSectionEvidenceUpstreamReferenceBadge"),
        translate("rawSectionEvidenceDynamicToolsReference"),
      );
    }
    if (profile?.scope === "not_present_in_rollout") {
      return sectionEvidence(
        "partial",
        translate("rawSectionEvidenceRolloutBadge"),
        translate("rawSectionEvidenceToolsUnavailable"),
      );
    }
    return sectionEvidence(
      "reference",
      translate("rawSectionEvidenceUpstreamReferenceBadge"),
      translate("responseOnlyToolsNotice"),
    );
  }

  if (section === "harness") {
    const exactSource = profile?.scope === "complete_request" || (!profile && !requestUsesReconstructedUpstream(request));
    return sectionEvidence(
      "derived",
      translate("rawSectionEvidenceDerivedBadge"),
      translate(
        exactSource
          ? "rawSectionEvidenceHarnessExact"
          : "rawSectionEvidenceHarnessObserved",
      ),
    );
  }

  if (profile?.scope === "dynamic_tools_only") {
    return sectionEvidence(
      "partial",
      translate("rawSectionEvidenceRolloutBadge"),
      translate("rawSectionEvidenceDynamicTools"),
    );
  }
  if (profile?.scope === "not_present_in_rollout") {
    return sectionEvidence(
      "partial",
      translate("rawSectionEvidenceRolloutBadge"),
      translate("rawSectionEvidenceToolsUnavailable"),
    );
  }
  if (profile?.scope === "observed_upstream_delta") {
    const messageKey = ["history", "message", "messages"].includes(section)
      ? "rawSectionEvidenceMessagesObserved"
      : "rawSectionEvidenceSystemObserved";
    return sectionEvidence(
      "partial",
      translate("rawSectionEvidenceRolloutBadge"),
      translate(messageKey),
    );
  }
  if (profile?.scope === "partial_request" || requestUsesReconstructedUpstream(request)) {
    return sectionEvidence(
      "partial",
      translate("rawSectionEvidencePartialBadge"),
      translate("rawSectionEvidencePartial"),
    );
  }
  return null;
}

export function sourceEvidenceMode(source = {}) {
  const kind = String(source?.capture_kind || source?.kind || "").toLowerCase();
  const confidence = String(source?.confidence || "").toLowerCase();
  const evidenceMode = String(source?.evidence_mode || source?.workbench?.evidence_mode || "").toLowerCase();
  const captureLabel = String(source?.capture_label || source?.workbench?.capture_label || "").toLowerCase();

  if (
    kind === "codex_proxy_exact" ||
    confidence === "exact" ||
    captureLabel === "exact proxy capture" ||
    captureLabel === "codex exact responses capture"
  ) {
    return EVIDENCE_MODES.EXACT;
  }
  if (
    kind === "codex_rollout_local" ||
    kind === "codex_rollout_pending" ||
    confidence === "semantic" ||
    evidenceMode === "local_rollout" ||
    captureLabel === "codex local semantic trace"
  ) {
    return EVIDENCE_MODES.RECONSTRUCTED;
  }
  if (confidence === "partial") return EVIDENCE_MODES.PARTIAL;
  return EVIDENCE_MODES.UNKNOWN;
}

export function requestHasSemanticEvent(request = {}) {
  return Boolean(
    request?.summary?.evidence?.kind === "semantic_event" ||
      request?.raw?.semantic_event ||
      request?.raw?.body?.semantic_event ||
      request?.raw?.body?.codex?.semantic_event,
  );
}

export function requestUsesReconstructedUpstream(request = {}) {
  if (requestHasSemanticEvent(request)) return false;
  const requestEvidence = request?.summary?.evidence?.request;
  if (requestEvidence?.available) return requestEvidence.exact === false;
  if (request?.raw?.body_source === "reconstructed") return true;
  return request?.raw?.body?.codex?.exact_wire_request === false;
}

export function responseUsesReconstructedDownstream(request = {}) {
  if (requestHasSemanticEvent(request)) return false;
  const responseEvidence = request?.summary?.evidence?.response;
  if (responseEvidence?.available) return responseEvidence.exact === false;
  return request?.raw?.body?.codex?.fidelity === "semantic_reconstruction";
}

function artifactEvidenceMode(artifact, { reconstructed = false } = {}) {
  if (reconstructed) return EVIDENCE_MODES.RECONSTRUCTED;
  if (artifact?.exact === true || artifact?.fidelity === "exact") return EVIDENCE_MODES.EXACT;
  if (artifact?.available === false || artifact?.fidelity === "missing") return EVIDENCE_MODES.MISSING;
  if (artifact?.available || artifact?.fidelity === "partial") return EVIDENCE_MODES.PARTIAL;
  return EVIDENCE_MODES.UNKNOWN;
}

function sectionEvidence(tone, badge, text) {
  return { tone, badge, text };
}

function identityTranslate(key, values = {}) {
  return String(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}
