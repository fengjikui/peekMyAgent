import { rawUpstreamComposition, rawUpstreamRequestMetadata } from "./raw-view-model.js";
import { providerUsageForRequest } from "./upstream-detail-model.js";

const COMPOSITION_KEYS = [
  "system",
  "tools",
  "history_context",
  "current_user",
  "tool_result",
  "params",
];

export function buildMetadataView(request = {}) {
  const metadata = rawUpstreamRequestMetadata(request);
  const usage = providerUsageForRequest(request);
  const composition = rawUpstreamComposition(request) || {};
  const responseUsage = request?.summary?.response?.usage || request?.response?.usage || null;
  const attribution = metadata.request_attribution;

  return {
    identity: compactFacts({
      request_index: metadata.request_index,
      capture_id: metadata.capture_id,
      conversation_id: metadata.conversation_id,
      watch_id: metadata.watch_id,
      agent_profile: metadata.agent_profile,
      workspace: metadata.workspace,
    }),
    transport: compactFacts({
      received_at: metadata.received_at,
      method: metadata.method,
      path: metadata.path,
      original_url: metadata.original_url,
      raw_body_length: metadata.raw_body_length,
      body_source: metadata.body_source,
    }),
    providerUsage: responseUsage
      ? {
          input: usage.input,
          cache: usage.cache,
          actualInput: usage.actualInput,
          output: usage.output,
          totalInput: usage.total,
          cacheRatio: usage.total ? usage.cache / usage.total : 0,
          actualRatio: usage.total ? usage.actualInput / usage.total : 0,
        }
      : null,
    composition: {
      unit: composition.unit || "chars",
      total: Number(composition.total_payload_chars || composition.input_chars || 0),
      sections: COMPOSITION_KEYS.map((key) => ({
        key,
        chars: Number(composition.sections?.[key]?.chars || 0),
        ratio: Number(composition.sections?.[key]?.ratio || 0),
      })).filter((item) => item.chars > 0),
    },
    attribution: attribution
      ? {
          facts: compactFacts({
            actor: attribution.actor,
            relation: attribution.relation,
            operation: attribution.operation,
            request_kind: attribution.request_kind,
            confidence: attribution.confidence,
          }),
          evidence: Array.isArray(attribution.evidence) ? attribution.evidence : [],
        }
      : null,
    evidence: {
      transport: metadata.upstream_evidence?.transport || null,
      request: metadata.upstream_evidence?.request || null,
      sections: metadata.upstream_evidence?.sections || null,
      headerRedactions: metadata.header_redactions || null,
      contextDelta: metadata.context_delta || null,
    },
  };
}

function compactFacts(value) {
  return Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .map(([key, item]) => ({ key, value: item }));
}
