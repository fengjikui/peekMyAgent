import {
  extractRequestMessages,
  extractRequestTools,
  isResponsesToolCallItem,
} from "../shared/request-payload.mjs";
import {
  requestHasSemanticEvent,
  requestUsesReconstructedUpstream,
  responseUsesReconstructedDownstream,
} from "./evidence-view-model.js";
import { upstreamConversationMessageSections, upstreamToolResultMessages } from "./message-view-model.js";
import { projectProtocolExchange } from "../trace/protocol-exchange.mjs";

export {
  requestHasSemanticEvent,
  requestUsesReconstructedUpstream,
  responseUsesReconstructedDownstream,
} from "./evidence-view-model.js";

export function rawSectionData(request, section, { translate = (key) => key, harnessMaterials = [] } = {}) {
  if (requestHasSemanticEvent(request)) {
    if (section === "metadata") {
      return { title: translate("rawEventMetadata"), value: rawSemanticEventMetadata(request) };
    }
    return { title: translate("rawEventSource"), value: rawUpstreamRequestValue(request) };
  }
  const body = request?.raw?.body || {};
  const messages = extractRequestMessages(body);
  if (section === "protocol") {
    return {
      title: translate("rawProtocol"),
      value:
        request?.summary?.protocol_exchange ||
        projectProtocolExchange({
          protocol: request?.protocol,
          request: body,
          response: rawProviderResponse(request),
        }),
    };
  }
  if (section === "system") {
    return {
      title: "system",
      value: {
        body_system: body.system ?? null,
        ...(body.instructions !== undefined ? { body_instructions: body.instructions } : {}),
        message_system: messages.filter((message) => message.role === "system"),
      },
    };
  }
  if (section === "developer") {
    return {
      title: translate("rawDeveloper"),
      value: messages.filter((message) => message.role === "developer"),
    };
  }
  if (section === "tools") return { title: "tools", value: extractRequestTools(body) };
  if (section === "harness") {
    return {
      title: translate("rawHarnessTitle"),
      value: harnessMaterials.map((item) => ({
        kind: item.kind,
        label: item.metadata?.label,
        category: item.metadata?.category || null,
        source_tag: item.metadata?.tag || null,
        path: item.metadata?.path,
        text: item.source_text,
      })),
    };
  }
  if (["history", "message", "messages"].includes(section)) {
    const conversation = upstreamConversationMessageSections(request);
    const historySection = section === "history" || section === "messages";
    return {
      title: historySection ? "history" : "message",
      value: historySection ? conversation.history : conversation.current,
    };
  }
  if (section === "upstream_tool_calls") {
    return {
      title: "upstream tool_use",
      value: { [translate("currentUpstreamToolUse")]: request?.summary?.current_tool_calls || [] },
    };
  }
  if (section === "tool_calls") {
    return {
      title: responseToolCallSectionLabel(request, { translate }),
      value: rawResponseToolCalls(request),
    };
  }
  if (section === "tool_results") {
    const fullToolResults = upstreamToolResultMessages(request);
    return {
      title: "tool_result",
      value: fullToolResults.length ? fullToolResults : request?.summary?.current_tool_results || [],
    };
  }
  if (section === "response") return { title: "response", value: rawResponseSectionValue(request) };
  if (section === "metadata") {
    return { title: translate("rawRequestMetadata"), value: rawUpstreamRequestMetadata(request) };
  }
  return {
    title: translate(requestUsesReconstructedUpstream(request) ? "rawReconstructedRequest" : "rawFullCapture"),
    value: rawUpstreamRequestValue(request),
  };
}

export function rawSemanticEventMetadata(request) {
  const raw = rawUpstreamRequestValue(request);
  const event = raw.semantic_event || raw.body?.semantic_event || raw.body?.codex?.semantic_event || null;
  return {
    capture_id: raw.capture_id,
    watch_id: raw.watch_id,
    request_index: raw.request_index,
    agent_profile: raw.agent_profile,
    workspace: raw.workspace,
    conversation_id: raw.conversation_id,
    received_at: raw.received_at,
    method: raw.method,
    path: raw.path,
    body_source: raw.body_source,
    evidence: request?.summary?.evidence || null,
    semantic_event: event
      ? {
          schema_version: event.schema_version || null,
          category: event.category || null,
          type: event.type || null,
          actor: event.actor || null,
          source: event.source || null,
          evidence: event.evidence || null,
        }
      : null,
  };
}

export function rawUpstreamRequestValue(request) {
  const raw = request?.raw && typeof request.raw === "object" ? request.raw : {};
  const upstreamRequest = { ...raw };
  delete upstreamRequest.response;
  delete upstreamRequest.upstream_status;
  delete upstreamRequest.upstream_error;
  return upstreamRequest;
}

export function rawUpstreamRequestMetadata(request) {
  const raw = rawUpstreamRequestValue(request);
  return {
    capture_id: raw.capture_id,
    watch_id: raw.watch_id,
    request_index: raw.request_index,
    agent_profile: raw.agent_profile,
    workspace: raw.workspace,
    conversation_id: raw.conversation_id,
    received_at: raw.received_at,
    method: raw.method,
    path: raw.path,
    original_url: raw.original_url,
    raw_body_length: raw.raw_body_length,
    body_source: raw.body_source,
    headers: raw.headers,
    header_redactions: raw.header_redactions,
    request_attribution: request?.source_hint || null,
    upstream_evidence: rawUpstreamEvidenceMetadata(request),
    context_delta: request?.context_delta,
    composition: rawUpstreamComposition(request),
  };
}

export function rawUpstreamEvidenceMetadata(request) {
  const evidence = request?.summary?.evidence;
  if (!evidence || typeof evidence !== "object") return null;
  return {
    schema_version: evidence.schema_version ?? null,
    transport: evidence.transport ?? null,
    request: evidence.request || null,
    sections: evidence.sections || null,
  };
}

export function rawUpstreamComposition(request) {
  const composition = request?.summary?.composition;
  if (!composition || typeof composition !== "object") return composition;
  const upstream = {
    ...composition,
    sections: composition.sections ? { ...composition.sections } : composition.sections,
    ratios: composition.ratios ? { ...composition.ratios } : composition.ratios,
  };
  delete upstream.response_text_chars;
  delete upstream.response_thinking_chars;
  if (upstream.sections) {
    delete upstream.sections.response_text;
    delete upstream.sections.response_thinking;
  }
  if (upstream.ratios) delete upstream.ratios.output_to_input;
  return upstream;
}

export function rawResponseSectionValue(request) {
  const response = request?.summary?.response || {};
  const rawResponse = request?.raw?.response || null;
  const originalResponse = rawProviderResponse(request);
  return {
    response: response.captured ? originalResponse : null,
    response_capture: rawResponse
      ? {
          status: rawResponse.status ?? response.status ?? null,
          content_type: rawResponse.headers?.["content-type"] || rawResponse.headers?.["Content-Type"] || null,
          raw_body_bytes: rawResponse.raw_body_length ?? response.raw_body_bytes ?? null,
          captured_body_bytes: rawResponse.captured_body_length ?? response.captured_body_bytes ?? null,
          decoded_body_bytes: rawResponse.decoded_body_length ?? response.decoded_body_bytes ?? null,
          content_encoding: rawResponse.response_content_encoding || response.response_content_encoding || "identity",
          content_decoding: rawResponse.content_decoding || response.content_decoding || null,
          body_text_source: rawResponse.body_text_source || null,
          received_at: rawResponse.received_at || response.received_at || null,
          body_json_available: rawResponse.body_json !== undefined && rawResponse.body_json !== null,
          transport: response.stream ? "stream" : "json",
          response_protocol: response.response_protocol || null,
          displayed_response: displayedResponseSource(rawResponse, response),
          reconstructed: response.complete_response_source === "stream_reconstruction",
        }
      : null,
  };
}

export function rawResponseToolCalls(request) {
  const response = rawProviderResponse(request);
  const calls = [];
  if (Array.isArray(response?.content)) {
    calls.push(...response.content.filter((item) => ["tool_use", "server_tool_use"].includes(item?.type)));
  }
  if (Array.isArray(response?.output)) {
    calls.push(...response.output.filter(isResponsesToolCallItem));
  }
  for (const choice of Array.isArray(response?.choices) ? response.choices : []) {
    if (Array.isArray(choice?.message?.tool_calls)) calls.push(...choice.message.tool_calls);
  }
  return calls;
}

export function responseToolCallSectionLabel(request, { translate = (key) => key } = {}) {
  const response = rawProviderResponse(request);
  const protocolTypes = [];
  if (Array.isArray(response?.content)) {
    protocolTypes.push(...response.content
      .filter((item) => ["tool_use", "server_tool_use"].includes(item?.type))
      .map((item) => item.type));
  }
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (isResponsesToolCallItem(item)) protocolTypes.push(item.type);
  }
  if (
    Array.isArray(response?.choices) &&
    response.choices.some(
      (choice) => Array.isArray(choice?.message?.tool_calls) || Array.isArray(choice?.delta?.tool_calls),
    )
  ) {
    protocolTypes.push("tool_calls");
  }
  const uniqueTypes = [...new Set(protocolTypes.filter(Boolean))];
  return uniqueTypes.length ? uniqueTypes.join(" / ") : translate("currentResponseToolCalls");
}

function rawProviderResponse(request) {
  const rawResponse = request?.raw?.response || null;
  if (rawResponse?.body_json !== undefined && rawResponse?.body_json !== null) {
    return rawResponse.body_json;
  }
  const response = request?.summary?.response || {};
  if (!isProtocolResponse(response.complete_response, response.complete_response_source)) return null;
  return response.complete_response;
}

function displayedResponseSource(rawResponse, response) {
  if (rawResponse?.body_json !== undefined && rawResponse?.body_json !== null) return "captured_body_json";
  if (isProtocolResponse(response?.complete_response, response?.complete_response_source)) {
    return response.complete_response_source || "protocol_complete_response";
  }
  return "unavailable";
}

function isProtocolResponse(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.stream_assembly) return false;
  if (["captured_body_json", "protocol_terminal_event", "stream_reconstruction"].includes(source)) return true;
  if (Array.isArray(value.output) || Array.isArray(value.choices)) return true;
  return value.type === "message" && Array.isArray(value.content);
}
