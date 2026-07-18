export function buildTimelineRequestIdentity(
  request = {},
  { translate = identityTranslate, cleanText = defaultCleanText, preview = defaultPreview } = {},
) {
  const commandMessage = request.summary?.command_message;
  const title =
    request.source_hint?.type === "metadata"
      ? request.source_hint.label || translate("metadataRequest")
      : commandMessage
        ? commandMessageLabel(commandMessage)
        : request.is_subagent
          ? translate("subagentRequest")
          : request.source_hint?.type === "parent_spawn"
            ? translate("parentSpawnRequest")
            : translate("mainAgentRequest");

  if (commandMessage) {
    return { title, excerpt: commandMessagePreview(commandMessage, { cleanText, preview }) };
  }
  const summary = request.summary || {};
  const excerpt =
    request.source_hint?.type === "metadata"
      ? summary.internal_request_preview || summary.current_user || summary.assistant_preview || translate("noTextSummary")
      : summary.current_user || summary.assistant_preview || translate("noTextSummary");
  return { title, excerpt };
}

export function buildTimelineUpstreamView(
  request = {},
  {
    translate = identityTranslate,
    cleanText = defaultCleanText,
    preview = defaultPreview,
    serialize = stableSerialize,
  } = {},
) {
  const showInlineContent = shouldShowTimelineRequestContent(request, { cleanText });
  const entryPreview = cleanText(request.summary?.entry?.text || "");
  return {
    requestIndex: request.request_index,
    kindClass: timelineUpstreamKindClass(request),
    userTurn: isTimelineUserTurnEntry(request),
    compact: !showInlineContent,
    label: timelineUpstreamEntryLabel(request, { translate, cleanText, preview }),
    preview:
      showInlineContent || entryPreview
        ? timelineUpstreamEntryPreview(request, { translate, cleanText, preview, serialize })
        : "",
    showInlineContent,
    sections: timelineUpstreamQuickSections(request),
  };
}

export function buildTimelineTurnInputView(
  request = {},
  turn = {},
  { translate = identityTranslate, cleanText = defaultCleanText, preview = defaultPreview } = {},
) {
  const entry = request.summary?.entry;
  const knownEntryLabel = localizedTimelineEntryLabel(entry, translate);
  let label = "User input";
  if (turn.command_message) label = commandMessageLabel(turn.command_message);
  else if (knownEntryLabel) label = knownEntryLabel;
  else if (entry?.kind && entry.kind !== "user_input" && entry.kind !== "unknown" && entry.label) label = entry.label;
  return {
    requestIndex: request.request_index,
    kindClass: timelineUpstreamKindClass(request),
    userTurn: isTimelineUserTurnEntry(request),
    label,
    preview: cleanText(
      turn.command_message
        ? commandMessagePreview(turn.command_message, { cleanText, preview })
        : turn.user_input || entry?.text || turn.title || "",
    ),
  };
}

export function buildTimelineToolExchangeView(request = {}) {
  const calls = request.summary?.current_tool_calls || [];
  const results = request.summary?.current_tool_results || [];
  if (!calls.length && !results.length) return null;
  return {
    pairs: pairTimelineToolEvents(calls, results),
    counts: { calls: calls.length, results: results.length },
  };
}

export function buildTimelineAssistantResponseView(
  request = {},
  {
    expanded = false,
    translate = identityTranslate,
    cleanText = defaultCleanText,
    preview = defaultPreview,
    markdownPreview = defaultMarkdownPreview,
    formatCompactNumber = defaultNumberFormat,
    formatCharCount = defaultCharCount,
  } = {},
) {
  if (!shouldShowTimelineAssistantResponse(request)) return null;
  const response = request.summary.response;
  const responseText = response.text || response.preview || "";
  const longResponse = cleanText(responseText).length > 200;
  const thinking = response.thinking
    ? {
        text: response.thinking,
        charCount: formatCharCount(response.thinking.length),
        preview: response.thinking_preview || preview(response.thinking, 120),
      }
    : null;
  return {
    requestId: request.id,
    expanded,
    longResponse,
    visibleText: longResponse && !expanded ? markdownPreview(responseText, 200) : responseText,
    meta: [
      response.latency_ms != null ? `${response.latency_ms}ms` : "",
      response.finish_reason ? `finish: ${response.finish_reason}` : "",
      response.truncated ? translate("truncated") : "",
      ...formatTimelineResponseUsageMeta(response.usage, { formatCompactNumber }),
    ].filter(Boolean),
    toolCalls: buildTimelineResponseToolCalls(request, response.tool_calls || [], translate),
    thinking,
  };
}

export function buildTimelineResponseToolCalls(request = {}, toolCalls = [], translate = identityTranslate) {
  const spawnEvents = Array.isArray(request.trace?.agent_spawn_events) ? request.trace.agent_spawn_events : [];
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => {
    const spawn = spawnEvents.find((item) => item?.spawn_id && item.spawn_id === call?.id);
    if (!spawn) return describeObservedToolSemantics(call, translate);
    const label = spawn.label || spawn.description || spawn.subagent_type || call.name || "Agent";
    const displayLines = [];
    if (spawn.context_mode === "all") displayLines.push(translate("agentContextInherited"));
    else if (spawn.context_mode) displayLines.push(translate("agentContextIsolated"));
    if (spawn.task_message_visibility === "encrypted_in_rollout") {
      displayLines.push(translate("agentTaskEncrypted"));
    } else if (spawn.prompt_preview) {
      displayLines.push(spawn.prompt_preview);
    } else if (spawn.task_message_visibility === "missing") {
      displayLines.push(translate("agentTaskUnavailable"));
    }
    return {
      ...call,
      displayName: `${call.name || "Agent"} · ${label}`,
      displayLines,
      suppressArguments: true,
    };
  });
}

function describeObservedToolSemantics(call = {}, translate = identityTranslate) {
  const semantic = call.semantic;
  if (!semantic || typeof semantic !== "object") return call;
  const nested = Array.isArray(semantic.nested_tool_names) ? semantic.nested_tool_names.filter(Boolean) : [];
  const displayLines = [];
  if (nested.length) {
    displayLines.push(translate("nestedToolDispatchObserved", { tools: nested.join(", ") }));
  }
  if (semantic.kind === "skill_load") {
    displayLines.push(translate("skillLoadObserved", { skill: semantic.skill_name || "unknown" }));
  } else if (semantic.kind === "skill_instruction_read") {
    displayLines.push(translate("skillInstructionReadObserved", { skill: semantic.skill_name || "unknown" }));
  }
  return {
    ...call,
    displayName: call.name || "unknown",
    displayLines,
  };
}

export function shouldShowTimelineRequestContent(request = {}, { cleanText = defaultCleanText } = {}) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.summary?.command_message) return false;
  if (request.is_subagent) return false;
  if (request.source_hint?.type === "parent_spawn") return false;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return false;
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return false;
  return Boolean(cleanText(request.summary?.current_user || ""));
}

export function shouldShowTimelineAssistantResponse(request = {}) {
  if (request.source_hint?.type === "metadata") return false;
  const response = request.summary?.response;
  if (!response?.captured) return false;
  return Boolean(response.text || response.preview || response.thinking || (response.tool_calls || []).length);
}

export function isPrimaryTimelineRequest(request = {}, options = {}) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.summary?.entry?.semantic_event) return true;
  if (request.is_subagent) return false;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return false;
  return shouldShowTimelineRequestContent(request, options) || Boolean(request.summary?.command_message);
}

export function isTimelineResponseRequest(request = {}) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.is_subagent) return false;
  return shouldShowTimelineAssistantResponse(request);
}

export function isTimelineUserTurnEntry(request = {}) {
  if (request.summary?.command_message) return true;
  return request.summary?.entry?.kind === "user_input";
}

export function timelineUpstreamKindClass(request = {}) {
  if (isTimelineSemanticEvent(request)) return "semantic-event";
  if (request.source_hint?.type === "metadata") return "metadata";
  if (request.summary?.command_message) return "command-message";
  if (request.summary?.entry?.kind === "subagent_result") return "subagent-result";
  if ((request.summary?.current_tool_results?.length || 0) > 0) return "tool-result";
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return "tool-use";
  return "user";
}

export function timelineUpstreamQuickSections(request = {}) {
  if (isTimelineSemanticEvent(request)) return [];
  const sections = [
    { section: "system", label: "System" },
    { section: "tools", label: "Tools" },
  ];
  if ((request.summary?.current_tool_calls || []).length) sections.push({ section: "upstream_tool_calls", label: "tool_use" });
  if ((request.summary?.current_tool_results || []).length) sections.push({ section: "tool_results", label: "tool_result" });
  return sections;
}

export function isTimelineSemanticEvent(request = {}) {
  return Boolean(
    request.summary?.evidence?.kind === "semantic_event" ||
      request.summary?.entry?.semantic_event ||
      request.raw?.semantic_event ||
      request.raw?.body?.semantic_event ||
      request.raw?.body?.codex?.semantic_event,
  );
}

export function timelineUpstreamEntryLabel(
  request = {},
  { translate = identityTranslate, cleanText = defaultCleanText, preview = defaultPreview } = {},
) {
  if (request.source_hint?.type === "metadata") {
    return buildTimelineRequestIdentity(request, { translate, cleanText, preview }).title;
  }
  if (request.summary?.command_message) return commandMessageLabel(request.summary.command_message);
  const entry = request.summary?.entry;
  const knownEntryLabel = localizedTimelineEntryLabel(entry, translate);
  if (knownEntryLabel) return knownEntryLabel;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return translate("toolResultUpstream");
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return translate("toolUseUpstream");
  if (request.is_subagent) return "Subagent input";
  if (entry?.kind && entry.kind !== "user_input" && entry.kind !== "unknown" && entry.label) return entry.label;
  return "User input";
}

export function timelineUpstreamEntryPreview(
  request = {},
  {
    translate = identityTranslate,
    cleanText = defaultCleanText,
    preview = defaultPreview,
    serialize = stableSerialize,
  } = {},
) {
  const identity = () => buildTimelineRequestIdentity(request, { translate, cleanText, preview });
  if (request.source_hint?.type === "metadata") {
    const frameworkReminder = [...(request.summary?.history_stack || [])]
      .reverse()
      .find((item) => item.kind === "framework_reminder");
    return preview(request.summary?.internal_request_preview || frameworkReminder?.text || identity().title, 260);
  }
  if (request.summary?.command_message) {
    return commandMessagePreview(request.summary.command_message, { cleanText, preview });
  }
  const entry = request.summary?.entry;
  if (entry?.kind === "compact" && entry.codex_compaction) {
    const compact = entry.codex_compaction;
    return translate("codexCompactionPreview", {
      sequence: compact.window_number ?? "?",
      items: compact.replacement_item_count || 0,
      messages: compact.retained_message_count || 0,
      opaque: compact.opaque_compaction_count || 0,
    });
  }
  if ((entry?.kind === "compact" || entry?.kind === "task_notification" || entry?.kind === "subagent_result") && entry.text) {
    return preview(cleanText(entry.text), 420);
  }
  const toolResults = request.summary?.current_tool_results || [];
  if (toolResults.length) return translate("resultReturnPreview", { count: toolResults.length });
  const toolCalls = request.summary?.current_tool_calls || [];
  if (toolCalls.length) {
    const text = toolCalls.map((call) => `${call.name || "unknown"} ${serialize(call.arguments ?? null)}`).join("\n");
    if (text) return preview(text, 320);
  }
  if (entry?.text) return preview(cleanText(entry.text), 420);
  return preview(cleanText(request.summary?.current_user || identity().excerpt), 420);
}

export function commandMessageLabel(commandMessage = {}) {
  return `Command ${commandMessage.command || ""}`.trim();
}

export function commandMessagePreview(
  commandMessage = {},
  { cleanText = defaultCleanText, preview = defaultPreview } = {},
) {
  const command = commandMessage.command || "/command";
  const body = cleanText(commandMessage.body || commandMessage.preview || "");
  return body ? `${command} · ${preview(body, 180)}` : `Command ${command}`;
}

export function timelineMessageKindLabel(kind, role, translate = identityTranslate) {
  if (kind === "compact") return translate("compactMessage");
  if (kind === "context_count") return translate("contextCountMessage");
  if (kind === "subagent_result") return translate("subagentResult");
  if (kind === "task_notification") return translate("taskNotification");
  if (kind === "framework_reminder") return translate("frameworkReminder");
  if (kind === "agent_internal") return translate("agentInternal");
  if (kind === "tool_result") return "Tool result";
  if (kind === "tool_use") return "Tool use";
  if (kind === "assistant") return "Assistant";
  if (kind === "user") return "User";
  if (kind === "system") return "System";
  return role || kind || "Message";
}

export function formatTimelineResponseUsageMeta(usage, { formatCompactNumber = defaultNumberFormat } = {}) {
  if (!usage || typeof usage !== "object") return [];
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const cache = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const total = usage.total_tokens;
  const items = [
    input != null ? `input ${formatCompactNumber(Number(input))}` : "",
    cache != null ? `cache ${formatCompactNumber(Number(cache))}` : "",
    output != null ? `output ${formatCompactNumber(Number(output))}` : "",
    total != null ? `total ${formatCompactNumber(Number(total))}` : "",
  ].filter(Boolean);
  if (items.length) return items;
  return Object.entries(usage)
    .filter(([, value]) => value != null && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key} ${String(value)}`);
}

export function pairTimelineToolEvents(calls = [], results = []) {
  const remainingResults = [...results];
  const pairs = calls.map((call) => {
    const matchIndex = remainingResults.findIndex((result) => result.id && call.id && result.id === call.id);
    const result = matchIndex >= 0 ? remainingResults.splice(matchIndex, 1)[0] : null;
    return { call, result, confidence: result ? "id" : "call_only" };
  });
  for (const result of remainingResults) pairs.push({ call: null, result, confidence: "result_only" });
  return pairs;
}

function localizedTimelineEntryLabel(entry, translate) {
  if (!entry?.kind) return "";
  if (["compact", "task_notification", "subagent_result", "framework_reminder", "agent_internal"].includes(entry.kind)) {
    return timelineMessageKindLabel(entry.kind, entry.role, translate);
  }
  return "";
}

function identityTranslate(key) {
  return key;
}

function defaultCleanText(value) {
  return String(value || "").trim();
}

function defaultPreview(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function defaultMarkdownPreview(value, limit) {
  const text = defaultCleanText(value);
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}...`;
}

function defaultNumberFormat(value) {
  return String(value);
}

function defaultCharCount(value) {
  return `${value} chars`;
}

function stableSerialize(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
