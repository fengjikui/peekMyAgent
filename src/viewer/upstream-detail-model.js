export const UPSTREAM_TOOL_PREVIEW_LIMIT = 18;

export function buildUpstreamDetailView(request = {}, { cleanText = defaultCleanText } = {}) {
  const summary = request.summary || {};
  const counts = request.counts || {};
  const toolNames = Array.isArray(summary.tool_names) ? summary.tool_names : [];
  const historyItems = Array.isArray(summary.history_stack) ? summary.history_stack : [];

  return {
    requestId: request.id || "",
    requestIndex: request.request_index || "",
    system: {
      count: counts.system || 0,
      preview: summary.system_preview || "",
      composition: compositionSection(summary, "system"),
    },
    tools: {
      count: counts.tools || 0,
      names: toolNames.slice(0, UPSTREAM_TOOL_PREVIEW_LIMIT),
      hiddenCount: Math.max(0, toolNames.length - UPSTREAM_TOOL_PREVIEW_LIMIT),
      composition: compositionSection(summary, "tools"),
    },
    history: {
      count: historyItems.length || counts.messages || 0,
      roles: Array.isArray(summary.roles) ? summary.roles : [],
      historyCount: counts.history || 0,
      rawBodyBytes: counts.raw_body_bytes || 0,
      composition: compositionSection(summary, "history_context"),
      items: historyItems.map(normalizeHistoryItem),
    },
    internalRequest:
      request.source_hint?.type === "metadata" && summary.internal_request_preview
        ? summary.internal_request_preview
        : "",
    currentMessage: buildCurrentMessage(request, summary, cleanText),
    providerStats: buildProviderStats(summary),
  };
}

export function providerUsageForRequest(request = {}) {
  const usage = request.summary?.response?.usage || request.response?.usage || {};
  const hasPromptTokens = usage.prompt_tokens != null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cache = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  const actualInput = Math.max(0, hasPromptTokens ? input - cache : input);
  const total = hasPromptTokens ? input : input + cache;
  return { input, output, cache, actualInput, total };
}

function buildCurrentMessage(request, summary, cleanText) {
  const entry = summary.entry || {};
  const contextDelta = request.context_delta || summary.context_delta || {};
  const previews = Array.isArray(contextDelta.previews) ? contextDelta.previews : [];
  if (entry.kind === "subagent_result") {
    const subagent = entry.subagent || {};
    const fallbackText = cleanText(subagent.preview || entry.text || summary.current_user || "");
    const markdownText = cleanText(subagent.result || fallbackText);
    if (!markdownText) return null;
    return {
      kind: "subagent_result",
      name: cleanText(subagent.name || ""),
      status: cleanText(subagent.status || ""),
      fallbackText,
      markdownText,
    };
  }
  if (!previews.length) return null;
  return {
    kind: "messages",
    count: contextDelta.new_messages || previews.length,
    composition: compositionSection(summary, "current_user"),
    items: previews.map((item) => ({
      kind: item?.kind || "",
      role: item?.role || "",
      text: item?.text || "",
    })),
  };
}

function buildProviderStats(summary) {
  const composition = summary.composition;
  if (!composition?.total_payload_chars) return null;
  const usage = providerUsageForRequest({ summary });
  return {
    totalPayloadChars: composition.total_payload_chars,
    input: usage.input,
    cache: usage.cache,
    output: usage.output,
    actualRatio: usage.total ? usage.actualInput / usage.total : 0,
    cacheRatio: usage.total ? usage.cache / usage.total : 0,
  };
}

function compositionSection(summary, key) {
  const item = summary.composition?.sections?.[key];
  if (!item?.chars) return null;
  return {
    key,
    ratio: Number(item.ratio || 0),
    chars: Number(item.chars || 0),
  };
}

function normalizeHistoryItem(item = {}) {
  return {
    index: item.index || "",
    kind: item.kind || "message",
    role: item.role || "unknown",
    label: item.label || "",
    text: item.text || "",
    fullText: item.full_text || "",
    charCount: item.char_count || 0,
    contextStatus: item.context_status || "",
    currentUser: Boolean(item.is_current_user),
    commandMessage: item.command_message || null,
    toolCalls: (Array.isArray(item.tool_calls) ? item.tool_calls : []).map((call) => ({
      id: call?.id || "",
      name: call?.name || "unknown",
      argumentsPreview: call?.arguments_preview || "",
    })),
    toolResults: (Array.isArray(item.tool_results) ? item.tool_results : []).map((result) => ({
      id: result?.id || "",
      content: result?.content || "",
    })),
  };
}

function defaultCleanText(value) {
  return String(value || "").trim();
}
