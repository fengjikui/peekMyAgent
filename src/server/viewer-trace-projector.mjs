import crypto from "node:crypto";
import { annotateRequestContextChanges } from "../trace/context-delta.mjs";
import { extractContentText, extractToolCalls, extractToolResults } from "../trace/content-parts.mjs";
import {
  classifyCurrentEntry,
  classifyMessageKind,
  cleanTitleText,
  commandPreviewText,
  commandUserVisibleText,
  displayMessageText,
  isCompactInjectionMessage,
  isFrameworkReminderMessage,
  isSkillInjectionMessage,
  isSuggestionModeMessage,
  isTaskNotificationMessage,
  isToolResultMessage,
  lastMessage,
  lastRealUserMessage,
  parseCommandMessage,
  realUserVisibleText,
  userVisibleText,
} from "../trace/message-semantics.mjs";
import { summarizeModelResponse } from "../trace/model-response-normalizer.mjs";
import { analyzeRequestComposition } from "../trace/request-composition.mjs";
import {
  extractSystemParts,
  extractRequestMessages,
  extractRequestTools,
  inferProtocolProfile,
  inferRequestSource,
  isContextTokenCountingRequest,
} from "../trace/request-profile.mjs";
import {
  annotateSubagentLineage,
  attachSubagentGraphToTurns,
  buildSubagentGraph,
} from "../trace/subagent-graph.mjs";
import { buildTurnTimeline } from "../trace/turn-timeline.mjs";
import { normalizeTranslationSourceText } from "../translation/blocks.mjs";

export const DEFAULT_VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES = 16 * 1024;

export function createViewerTraceProjector({
  responseBodyTextInlineBytes = DEFAULT_VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES,
  sourceDisplay = {},
  now = () => new Date().toISOString(),
} = {}) {
  const displayProjectName = requiredFunction(sourceDisplay.displayProjectName, "sourceDisplay.displayProjectName");
  const inferWatchMode = requiredFunction(sourceDisplay.inferWatchMode, "sourceDisplay.inferWatchMode");
  const captureLabel = requiredFunction(sourceDisplay.captureLabel, "sourceDisplay.captureLabel");
  const liveStatusLabel = requiredFunction(sourceDisplay.liveStatusLabel, "sourceDisplay.liveStatusLabel");
  const inlineResponseBytes = positiveInteger(responseBodyTextInlineBytes, DEFAULT_VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES);
  const currentTimestamp = requiredFunction(now, "now");

  function buildData({ source, captures, debugSources = [], command = null, partial = null }) {
    const requests = captures.map((capture, index) => summarizeCapture(capture, source, index, debugSources[index] || null));
    const graphSemantics = lineageSemantics();
    annotateSubagentLineage(requests, graphSemantics);
    annotateRequestChanges(requests);
    const turns = buildTurns(requests);
    const agentTrace = buildSubagentGraph(requests, graphSemantics);
    attachSubagentGraphToTurns(turns, agentTrace);
    const stats = statsWithSourceTotals(buildStats(requests, agentTrace), source, partial);
    return {
      generated_at: currentTimestamp(),
      source: { ...source, command, workbench: buildWorkbench(source, requests, command) },
      stats,
      requests,
      turns,
      agent_trace: agentTrace,
      ...(partial?.has_more ? { partial } : {}),
    };
  }

  function initialPartialInfo({ requestedLimit, loadedCount, totalCount }) {
    const limit = Number(requestedLimit) || 0;
    if (!limit) return null;
    const loaded = Number(loadedCount) || 0;
    const total = Math.max(Number(totalCount) || 0, loaded);
    return {
      mode: "initial",
      request_limit: limit,
      loaded_request_count: loaded,
      total_request_count: total,
      has_more: total > loaded,
    };
  }

  function statsWithSourceTotals(stats, source, partial) {
    if (!partial?.has_more) return stats;
    return {
      ...stats,
      request_count: Number(source.request_count) || partial.total_request_count || stats.request_count,
      response_count: Number(source.response_count) || stats.response_count,
      raw_body_bytes: Number(source.raw_body_bytes) || stats.raw_body_bytes,
      partial_loaded_request_count: partial.loaded_request_count,
    };
  }

  function summarizeCapture(capture, source, index, debugSource) {
    const body = capture.body || {};
    const responseSummary = summarizeModelResponse(capture.response);
    const messages = extractRequestMessages(body);
    const systemParts = extractSystemParts(body, messages);
    const tools = extractRequestTools(body);
    const lastUser = lastMessage(messages, "user");
    const currentUser = lastRealUserMessage(messages);
    const currentUserRealText = realUserVisibleText(currentUser);
    const commandMessage = currentUserRealText ? null : parseCommandMessage(currentUser);
    const entry = isContextTokenCountingRequest(capture)
      ? {
          kind: "context_count",
          label: "上下文统计 (/context)",
          text: "Claude Code 为 /context 统计上下文 token 用量发出的内部请求",
        }
      : classifyCurrentEntry(messages);
    const currentUserText =
      entry.kind === "compact" || entry.kind === "context_count"
        ? ""
        : currentUserRealText || (commandMessage ? commandUserVisibleText(commandMessage) : "");
    const internalRequestText = isSuggestionModeMessage(lastUser) ? extractContentText(lastUser.content) : "";
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    const toolMessages = messages.filter((message) => message.role === "tool");
    const toolCalls = extractToolCalls(messages);
    const toolResults = extractToolResults(messages);
    const sourceHint = inferRequestSource({ capture, body, currentUser, debugSource, lastUser });
    const protocolProfile = inferProtocolProfile(capture, body);
    const historyCount = Math.max(0, messages.length - (currentUser ? 1 : 0) - systemParts.length);
    const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
    const claudeSessionId = headerValue(capture.headers, "x-claude-code-session-id");

    return {
      id: capture.capture_id || `request-${index + 1}`,
      request_index: capture.request_index || index + 1,
      captured_at: capture.received_at || capture.captured_at || null,
      method: capture.method || "POST",
      path: capture.path || null,
      model: body.model || null,
      protocol: protocolProfile.protocol,
      provider: protocolProfile.provider,
      upstream_status: capture.upstream_status || null,
      watch_id: capture.watch_id || null,
      conversation_id: capture.conversation_id || null,
      agent_profile: capture.agent_profile || source.agent,
      confidence: source.confidence,
      source_kind: source.kind,
      source_hint: sourceHint,
      debug_source: debugSource?.source || null,
      is_subagent: sourceHint.type === "subagent",
      trace: {
        actor_type: sourceHint.type === "subagent" ? "child" : sourceHint.type === "metadata" ? "side" : "main",
        claude_agent_id: claudeAgentId || null,
        claude_session_id_prefix: claudeSessionId ? claudeSessionId.slice(0, 12) : null,
        debug_source: debugSource?.source || null,
      },
      redaction_count: Array.isArray(capture.header_redactions) ? capture.header_redactions.length : 0,
      fingerprints: {
        system: hashJson(systemParts.map((part) => part.text)),
        tools: hashJson(tools.map((tool) => tool.function?.name || tool.name || tool.type || "unknown")),
        params: hashJson(Object.fromEntries(
          Object.entries(body).filter(([key]) => !["messages", "input", "system", "instructions", "tools", "additional_tools"].includes(key)),
        )),
      },
      counts: {
        messages: messages.length,
        system: systemParts.length,
        tools: tools.length,
        tool_calls: toolCalls.length,
        tool_results: toolResults.length,
        assistant_messages: assistantMessages.length,
        tool_messages: toolMessages.length,
        history: historyCount,
        raw_body_bytes: capture.raw_body_length || byteLength(body),
        response_body_bytes: capture.response?.raw_body_length || 0,
      },
      summary: {
        current_user: textPreview(currentUserText, 1200),
        entry,
        command_message: commandMessage,
        internal_request_preview: textPreview(internalRequestText, 1200),
        system_preview: textPreview(systemParts.map((part) => part.text).join("\n\n"), 1000),
        assistant_preview: textPreview(
          assistantMessages.map((message) => extractContentText(message.content)).filter(Boolean).join("\n\n"),
          1000,
        ),
        tool_calls: toolCalls,
        current_tool_calls: toolCalls,
        tool_results: toolResults.map((result) => ({ ...result, content: textPreview(result.content, 800) })),
        current_tool_results: toolResults.map((result) => ({ ...result, content: textPreview(result.content, 800) })),
        tool_names: tools.map((tool) => tool.function?.name || tool.name || tool.type).filter(Boolean),
        roles: messages.map((message) => message.role || "unknown"),
        history_stack: summarizeHistoryStack(messages, currentUser),
        response: responseSummary,
        protocol: protocolProfile,
        composition: analyzeRequestComposition({
          body,
          messages,
          systemParts,
          tools,
          currentUser,
          responseSummary,
          rawBodyLength: capture.raw_body_length,
        }),
      },
      raw: compactCaptureForViewer(capture, responseSummary),
    };
  }

  function projectRequestDetailWindow(captures, source, requestId, { startIndex = 0, debugSources = [] } = {}) {
    const requests = captures.map((capture, index) => {
      const requestIndex = Number(capture.request_index);
      const sourceIndex = Number.isFinite(requestIndex) && requestIndex > 0 ? requestIndex - 1 : startIndex + index;
      return summarizeCapture(capture, source, sourceIndex, debugSources[index] || null);
    });
    annotateRequestChanges(requests);
    const request = requests.find((item) => item.id === requestId || String(item.request_index) === String(requestId)) || requests.at(-1) || null;
    if (request) request.detail_scope = "request_window";
    return request;
  }

  function compactCaptureForViewer(capture, responseSummary) {
    if (!capture || typeof capture !== "object") return capture;
    const response = compactResponseForViewer(capture.response, responseSummary);
    return response === capture.response ? capture : { ...capture, response };
  }

  function compactResponseForViewer(response, responseSummary) {
    if (!response || typeof response !== "object") return response || null;
    if (typeof response.body_text !== "string") return response;
    const bodyText = response.body_text;
    const byteSize = Buffer.byteLength(bodyText, "utf8");
    const contentType = headerValue(response.headers, "content-type");
    const stream = Boolean(responseSummary?.stream) || /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(bodyText);
    const hasBodyJson = response.body_json !== undefined && response.body_json !== null;
    const tooLarge = byteSize > inlineResponseBytes;
    if (!stream && !hasBodyJson && !tooLarge) return response;
    const { body_text, ...rest } = response;
    return {
      ...rest,
      body_text_omitted: {
        reason: stream ? "stream" : hasBodyJson ? "duplicated_body_json" : "large",
        byte_size: byteSize,
        raw_body_length: response.raw_body_length || byteSize,
        captured_body_length: response.captured_body_length || byteSize,
        body_json_available: hasBodyJson,
        stream,
      },
    };
  }

  function annotateRequestChanges(requests) {
    return annotateRequestContextChanges(requests, contextSemantics());
  }

  function contextSemantics() {
    return {
      extractToolCalls,
      extractToolResults,
      classifyMessage: classifyMessageKind,
      previewMessage: messageDeltaPreview,
      previewText: textPreview,
      isInternalRequest,
      responseToolCalls(request) {
        if (request?.raw?.provenance?.transport !== "codex_rollout_local" && request?.protocol !== "openai_responses") return [];
        return request.summary?.response?.tool_calls || [];
      },
      isRealUserMessage(message) {
        return (
          message?.role === "user" &&
          !isToolResultMessage(message) &&
          !isSuggestionModeMessage(message) &&
          !isFrameworkReminderMessage(message)
        );
      },
    };
  }

  function buildTurns(requests) {
    return buildTurnTimeline(requests, {
      normalizeUserKey: normalizeTurnUserKey,
      isInternalRequest: isTimelineInternalRequest,
      titleFor: turnTitle,
      cleanUserText: cleanTitleText,
      previewText: textPreview,
    });
  }

  function lineageSemantics() {
    return {
      extractHistoryToolCalls(request) {
        return extractToolCalls(extractRequestMessages(request.raw?.body || {}));
      },
      firstUserPromptText,
      normalizePrompt: normalizeTranslationSourceText,
      previewText: textPreview,
      stableJson,
      childAgentType(request, spawn) {
        if (spawn?.subagent_type) return spawn.subagent_type;
        const debug = request?.debug_source || request?.trace?.debug_source || "";
        if (debug.startsWith("agent:")) return debug.replace(/^agent:/, "");
        return "Subagent";
      },
    };
  }

  function firstUserPromptText(request) {
    const messages = extractRequestMessages(request.raw?.body || {});
    for (const message of messages) {
      if (message?.role !== "user") continue;
      if (isToolResultMessage(message)) continue;
      const text = realUserVisibleText(message);
      if (text) return text;
      return "";
    }
    return "";
  }

  function normalizeTurnUserKey(text) {
    return cleanTitleText(text).replace(/\s+/g, " ").trim();
  }

  function turnTitle(userText, commandMessage = null) {
    if (commandMessage) {
      const suffix = textPreview(cleanTitleText(commandMessage.body), 72);
      return suffix ? `${commandMessage.command} · ${suffix}` : `Command ${commandMessage.command}`;
    }
    return textPreview(cleanTitleText(userText), 96) || "未识别用户输入";
  }

  function isInternalRequest(request) {
    return request.source_hint?.type === "metadata";
  }

  function isTimelineInternalRequest(request) {
    return isInternalRequest(request) || request.source_hint?.type === "subagent" || request.summary?.entry?.kind === "harness_injection";
  }

  function messageDeltaPreview(message) {
    const commandMessage = parseCommandMessage(message);
    return {
      role: message?.role || "unknown",
      kind: classifyMessageKind(message),
      text: textPreview(commandMessage ? commandPreviewText(commandMessage) : displayMessageText(message), 220),
      command_message: commandMessage,
    };
  }

  function summarizeHistoryStack(messages, currentUser) {
    const currentUserKey = currentUser ? stableJson(currentUser) : "";
    return (messages || []).map((message, index) => {
      const kind = classifyMessageKind(message);
      const toolCalls = extractToolCalls([message]);
      const toolResults = extractToolResults([message]);
      const fullText = extractContentText(message?.content);
      const commandMessage = parseCommandMessage(message);
      const realText = kind === "compact" ? "" : realUserVisibleText(message);
      const displayText = displayMessageText(message);
      return {
        index: index + 1,
        role: message?.role || "unknown",
        kind,
        label: historyMessageLabel(message, kind),
        is_current_user: Boolean(currentUserKey && stableJson(message) === currentUserKey),
        text: textPreview(
          realText || (commandMessage ? commandMessage.body || commandPreviewText(commandMessage) : displayText),
          kind === "framework_reminder" ? 180 : 420,
        ),
        command_message: commandMessage,
        full_text: kind === "framework_reminder" ? textPreview(fullText, 4000) : "",
        char_count: String(fullText || "").length,
        tool_calls: toolCalls.map((call) => ({
          name: call.name,
          id: call.id || null,
          arguments_preview: textPreview(stableJson(call.arguments), 260),
        })),
        tool_results: toolResults.map((result) => ({ id: result.id || null, content: textPreview(result.content, 260) })),
      };
    });
  }

  function historyMessageLabel(message, kind) {
    if (kind === "message" && message?.role === "user") return "User 输入";
    const commandMessage = parseCommandMessage(message);
    if (commandMessage) return `Command ${commandMessage.command}`;
    if (kind === "compact") return "上下文压缩 (/compact)";
    if (kind === "harness_injection") return "Skill / Harness 注入";
    if (kind === "task_notification") return "任务通知";
    if (kind === "framework_reminder") return "框架提醒";
    if (kind === "agent_internal") return "Agent 内部请求";
    if (kind === "tool_result") return "Tool result";
    if (kind === "tool_use") return "Tool use";
    if (message?.role === "user") return "User 输入";
    if (message?.role === "assistant") return "Assistant 回复";
    if (message?.role === "system") return "System";
    if (message?.role === "tool") return "Tool result";
    return message?.role || "Message";
  }

  function buildWorkbench(source, requests, command) {
    const first = requests[0] || {};
    const watchIds = uniqueValues([...requests.map((request) => request.watch_id), source.live_watch_id]);
    const conversationIds = uniqueValues([...requests.map((request) => request.conversation_id), source.conversation_id]);
    const workspaces = uniqueValues([
      source.workspace,
      ...requests.map((request) => request.raw?.workspace || request.raw?.body?.workspace),
      command?.cwd,
    ]);
    const agentProfiles = uniqueValues(requests.map((request) => request.agent_profile || source.agent));
    const sourceKinds = uniqueValues([...requests.map((request) => request.source_kind), source.kind]);
    return {
      agent: agentProfiles[0] || source.agent || "Unknown Agent",
      project: displayProjectName(workspaces[0]),
      workspace: workspaces[0] || null,
      mode: inferWatchMode(source, requests),
      watch_ids: watchIds,
      conversation_ids: conversationIds,
      conversation_label: conversationIds.length ? shortenId(conversationIds[0]) : "按监听任务归档",
      capture_label: captureLabel(source),
      source_kinds: sourceKinds,
      status: liveStatusLabel(source.live_status),
      request_count: requests.length,
      subagent_count: requests.filter((request) => request.is_subagent).length,
      parent_spawn_count: requests.filter((request) => request.source_hint.type === "parent_spawn").length,
      redaction_count: requests.reduce((sum, request) => sum + request.redaction_count, 0),
      first_seen: first.captured_at || null,
      last_seen: requests.at(-1)?.captured_at || null,
    };
  }

  function buildStats(requests, agentTrace = null) {
    const subagentCount = requests.filter((request) => request.is_subagent).length;
    return {
      request_count: requests.length,
      response_count: requests.filter((request) => request.summary.response?.captured).length,
      subagent_count: subagentCount,
      subagent_instance_count:
        agentTrace?.branch_count ||
        new Set(requests.map((request) => request.trace?.claude_agent_id).filter(Boolean)).size ||
        subagentCount,
      main_count: requests.length - subagentCount,
      tool_call_count: distinctToolEventCount(requests, (request) => request.summary?.current_tool_calls),
      tool_result_count: distinctToolEventCount(requests, (request) => request.summary?.current_tool_results),
      raw_body_bytes: requests.reduce((sum, request) => sum + request.counts.raw_body_bytes, 0),
    };
  }

  function inferCaptureTitle(capture) {
    const body = capture?.body || {};
    const messages = extractRequestMessages(body);
    const user = messages.find(
      (message) =>
        message?.role === "user" &&
        !isToolResultMessage(message) &&
        !isSuggestionModeMessage(message) &&
        !isFrameworkReminderMessage(message) &&
        !isTaskNotificationMessage(message) &&
        !isCompactInjectionMessage(message) &&
        !isSkillInjectionMessage(message),
    );
    const title = textPreview(cleanTitleText(userVisibleText(user)), 48);
    return title || null;
  }

  function timelineAssemblerDependencies() {
    return {
      summarizeCapture,
      contextSemantics: contextSemantics(),
      lineageSemantics: lineageSemantics(),
      buildTurns,
      buildStats(requests, agentTrace, { source, page, loadedCount } = {}) {
        return statsWithSourceTotals(buildStats(requests, agentTrace), source, {
          has_more: Boolean(page?.has_more),
          loaded_request_count: loadedCount,
          total_request_count: page?.total_count,
        });
      },
      buildWorkbench,
    };
  }

  return Object.freeze({
    buildData,
    buildStats,
    buildWorkbench,
    buildTurns,
    contextSemantics,
    inferCaptureTitle,
    initialPartialInfo,
    lineageSemantics,
    projectRequestDetailWindow,
    statsWithSourceTotals,
    summarizeCapture,
    timelineAssemblerDependencies,
  });
}

export function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

export function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

export function uniqueValues(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
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

function distinctToolEventCount(requests, selectEvents) {
  const ids = new Set();
  let anonymous = 0;
  for (const request of requests || []) {
    for (const event of selectEvents(request) || []) {
      const id = String(event?.id || event?.tool_call_id || event?.tool_use_id || "").trim();
      if (id) ids.add(id);
      else anonymous += 1;
    }
  }
  return ids.size + anonymous;
}

function shortenId(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}
