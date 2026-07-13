export const TIMELINE_VIEW_LIMITS = Object.freeze({
  responseTextChars: 700,
  responseThinkingChars: 360,
  toolArgumentChars: 360,
  currentUserChars: 520,
  systemPreviewChars: 320,
  assistantPreviewChars: 320,
  internalPreviewChars: 320,
  entryTextChars: 320,
  subagentResultChars: 700,
  thinkingPreviewChars: 160,
  roleCount: 48,
  toolNameCount: 24,
  contextPreviewCount: 4,
  contextPreviewChars: 140,
});

const COMPOSITION_SECTION_KEYS = ["current_user", "history_context", "system", "tools", "tool_result", "params"];

export function projectTimelineViewerData(data) {
  return {
    ...data,
    requests: (data?.requests || []).map(projectTimelineRequest),
  };
}

export function projectTimelineRequest(request) {
  const summary = request?.summary || {};
  const historyStack = Array.isArray(summary.history_stack) ? summary.history_stack : [];
  const { history_stack, tool_calls, tool_results, roles, tool_names, ...summaryWithoutHeavyFields } = summary;
  return {
    ...request,
    context_delta: projectContextDelta(request?.context_delta),
    summary: {
      ...summaryWithoutHeavyFields,
      history_stack: [],
      history_stack_omitted: {
        count: historyStack.length,
      },
      roles: compactArray(roles, TIMELINE_VIEW_LIMITS.roleCount),
      roles_omitted: omittedArrayCount(roles, TIMELINE_VIEW_LIMITS.roleCount),
      tool_names: compactArray(tool_names, TIMELINE_VIEW_LIMITS.toolNameCount),
      tool_names_omitted: omittedArrayCount(tool_names, TIMELINE_VIEW_LIMITS.toolNameCount),
      current_user: textPreview(summary.current_user || "", TIMELINE_VIEW_LIMITS.currentUserChars),
      system_preview: textPreview(summary.system_preview || "", TIMELINE_VIEW_LIMITS.systemPreviewChars),
      assistant_preview: textPreview(summary.assistant_preview || "", TIMELINE_VIEW_LIMITS.assistantPreviewChars),
      internal_request_preview: textPreview(summary.internal_request_preview || "", TIMELINE_VIEW_LIMITS.internalPreviewChars),
      entry: projectEntry(summary.entry),
      composition: projectComposition(summary.composition),
      tool_calls_omitted: Array.isArray(tool_calls) ? { count: tool_calls.length } : undefined,
      tool_results_omitted: Array.isArray(tool_results) ? { count: tool_results.length } : undefined,
      current_tool_calls: (summary.current_tool_calls || []).map(projectToolCall),
      current_tool_results: (summary.current_tool_results || []).map(projectToolResult),
      response: projectResponseSummary(summary.response),
    },
    raw: projectRawCapture(request?.raw),
    detail_omitted: true,
  };
}

function compactArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function omittedArrayCount(value, limit) {
  return Array.isArray(value) && value.length > limit ? { count: value.length - limit, total: value.length } : undefined;
}

function projectContextDelta(delta) {
  if (!delta || typeof delta !== "object") return delta || null;
  const previews = Array.isArray(delta.previews) ? delta.previews : [];
  return {
    ...delta,
    previews: previews.slice(0, TIMELINE_VIEW_LIMITS.contextPreviewCount).map((preview) => ({
      role: preview?.role || "unknown",
      kind: preview?.kind || "message",
      text: textPreview(preview?.text || "", TIMELINE_VIEW_LIMITS.contextPreviewChars),
    })),
    previews_omitted: omittedArrayCount(previews, TIMELINE_VIEW_LIMITS.contextPreviewCount),
  };
}

function projectComposition(composition) {
  if (!composition || typeof composition !== "object") return composition || null;
  const sections = {};
  for (const key of COMPOSITION_SECTION_KEYS) {
    if (composition.sections?.[key]) sections[key] = composition.sections[key];
  }
  return {
    unit: composition.unit,
    total_payload_chars: composition.total_payload_chars,
    input_chars: composition.input_chars,
    sections,
  };
}

function projectEntry(entry) {
  if (!entry || typeof entry !== "object") return entry || null;
  const output = { ...entry };
  if (typeof output.text === "string") output.text = textPreview(output.text, TIMELINE_VIEW_LIMITS.entryTextChars);
  if (typeof output.value === "string") output.value = textPreview(output.value, TIMELINE_VIEW_LIMITS.entryTextChars);
  if (output.subagent && typeof output.subagent === "object") output.subagent = projectSubagentEntry(output.subagent);
  return output;
}

function projectSubagentEntry(subagent) {
  return {
    ...subagent,
    preview: textPreview(subagent.preview || "", TIMELINE_VIEW_LIMITS.entryTextChars),
    result: textPreview(subagent.result || "", TIMELINE_VIEW_LIMITS.subagentResultChars),
  };
}

function projectResponseSummary(response) {
  if (!response || typeof response !== "object") return response || null;
  const { complete_response, preview: _preview, ...rest } = response;
  return {
    ...rest,
    text: textPreview(response.text || "", TIMELINE_VIEW_LIMITS.responseTextChars),
    thinking: textPreview(response.thinking || "", TIMELINE_VIEW_LIMITS.responseThinkingChars),
    thinking_preview: textPreview(response.thinking_preview || "", TIMELINE_VIEW_LIMITS.thinkingPreviewChars),
    tool_calls: (response.tool_calls || []).map(projectToolCall),
    ...(complete_response ? { complete_response_omitted: true } : {}),
  };
}

function projectToolCall(call) {
  if (!call || typeof call !== "object") return call;
  return {
    ...call,
    arguments: compactPreviewValue(call.arguments),
  };
}

function projectToolResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    content: textPreview(result.content || "", TIMELINE_VIEW_LIMITS.toolArgumentChars),
  };
}

function compactPreviewValue(value) {
  const serialized = stableJson(value ?? null);
  if (serialized.length <= TIMELINE_VIEW_LIMITS.toolArgumentChars) return value;
  return {
    preview: textPreview(serialized, TIMELINE_VIEW_LIMITS.toolArgumentChars),
    omitted: {
      reason: "compact_view",
      chars: serialized.length,
    },
  };
}

function projectRawCapture(raw) {
  if (!raw || typeof raw !== "object") return raw || null;
  const body = raw.body && typeof raw.body === "object" ? raw.body : null;
  const response = raw.response && typeof raw.response === "object" ? raw.response : null;
  return {
    body_source: raw.body_source || "original",
    body: projectRawBodyMetadata(body),
    body_omitted: body
      ? {
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
          system: Array.isArray(body.system) ? body.system.length : body.system ? 1 : 0,
          raw_body_length: raw.raw_body_length || jsonByteLength(body),
        }
      : null,
    response: projectRawResponseMetadata(response),
    detail_omitted: true,
  };
}

function projectRawBodyMetadata(body) {
  if (!body || typeof body !== "object") return null;
  const output = {};
  for (const key of ["model", "stream", "max_tokens", "temperature", "top_p"]) {
    if (body[key] !== undefined) output[key] = body[key];
  }
  return output;
}

function projectRawResponseMetadata(response) {
  if (!response || typeof response !== "object") return response || null;
  const output = {};
  for (const key of ["status", "received_at", "duration_ms", "raw_body_length", "captured_body_length", "truncated", "body_text_omitted"]) {
    if (response[key] !== undefined) output[key] = response[key];
  }
  if (response.body_json !== undefined && response.body_json !== null) output.body_json_omitted = true;
  if (typeof response.body_text === "string") {
    const byteSize = Buffer.byteLength(response.body_text, "utf8");
    output.body_text_omitted =
      response.body_text_omitted || {
        reason: "compact_view",
        byte_size: byteSize,
        raw_body_length: response.raw_body_length || byteSize,
        captured_body_length: response.captured_body_length || byteSize,
      };
  }
  return output;
}

function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
