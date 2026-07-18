import { extractRequestMessages, extractRequestTools } from "../shared/request-payload.mjs";

export function rawSectionData(request, section, { translate = (key) => key, harnessMaterials = [] } = {}) {
  if (requestHasSemanticEvent(request)) {
    if (section === "metadata") {
      return { title: translate("rawEventMetadata"), value: rawSemanticEventMetadata(request) };
    }
    return { title: translate("rawEventSource"), value: rawUpstreamRequestValue(request) };
  }
  const body = request?.raw?.body || {};
  const messages = extractRequestMessages(body);
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
  if (section === "messages") {
    return {
      title: Array.isArray(body.input) ? "input / history" : "messages / history",
      value: Array.isArray(body.input) ? body.input : messages,
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
      title: "tool_use",
      value: { [translate("currentResponseToolUse")]: request?.summary?.response?.tool_calls || [] },
    };
  }
  if (section === "tool_results") {
    return {
      title: "tool_result",
      value: { [translate("currentUpstreamToolResult")]: request?.summary?.current_tool_results || [] },
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

export function requestHasSemanticEvent(request) {
  return Boolean(
    request?.summary?.evidence?.kind === "semantic_event" ||
      request?.raw?.semantic_event ||
      request?.raw?.body?.semantic_event ||
      request?.raw?.body?.codex?.semantic_event,
  );
}

export function requestUsesReconstructedUpstream(request) {
  if (requestHasSemanticEvent(request)) return false;
  const requestEvidence = request?.summary?.evidence?.request;
  if (requestEvidence?.available) return requestEvidence.exact === false;
  if (request?.raw?.body_source === "reconstructed") return true;
  return request?.raw?.body?.codex?.exact_wire_request === false;
}

export function responseUsesReconstructedDownstream(request) {
  if (requestHasSemanticEvent(request)) return false;
  const responseEvidence = request?.summary?.evidence?.response;
  if (responseEvidence?.available) return responseEvidence.exact === false;
  return request?.raw?.body?.codex?.fidelity === "semantic_reconstruction";
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
    context_delta: request?.context_delta,
    composition: rawUpstreamComposition(request),
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
  return {
    complete_response: response.captured
      ? response.complete_response || {
          id: response.message_id || null,
          role: "assistant",
          content: [
            ...(response.thinking ? [{ type: "thinking", thinking: response.thinking }] : []),
            ...(response.text ? [{ type: "text", text: response.text }] : []),
            ...(response.tool_calls || []).map((call) => ({
              type: "tool_use",
              id: call.id || null,
              name: call.name || "unknown",
              input: call.arguments ?? null,
            })),
          ],
          text: response.text || "",
          thinking: response.thinking || "",
          tool_use: response.tool_calls || [],
          stop_reason: response.finish_reason || null,
          finish_reason: response.finish_reason || null,
          status: response.response_status || null,
          usage: response.usage || null,
          stream: Boolean(response.stream),
          event_count: response.event_count || 0,
          truncated: Boolean(response.truncated),
        }
      : null,
    parsed_from_response: response.captured
      ? {
          message_id: response.message_id || null,
          text: response.text || "",
          thinking: response.thinking || "",
          tool_use: response.tool_calls || [],
          usage: response.usage || null,
          finish_reason: response.finish_reason || null,
          response_status: response.response_status || null,
          stream: Boolean(response.stream),
          event_count: response.event_count || 0,
          truncated: Boolean(response.truncated),
        }
      : null,
    response_capture: rawResponse
      ? {
          status: rawResponse.status ?? response.status ?? null,
          content_type: rawResponse.headers?.["content-type"] || rawResponse.headers?.["Content-Type"] || null,
          raw_body_bytes: rawResponse.raw_body_length ?? response.raw_body_bytes ?? null,
          captured_body_bytes: rawResponse.captured_body_length ?? response.captured_body_bytes ?? null,
          received_at: rawResponse.received_at || response.received_at || null,
          body_json_available: rawResponse.body_json !== undefined && rawResponse.body_json !== null,
          body_text_omitted: rawResponse.body_text_omitted || null,
          stream: Boolean(response.stream),
          event_count: response.event_count || 0,
        }
      : null,
  };
}
