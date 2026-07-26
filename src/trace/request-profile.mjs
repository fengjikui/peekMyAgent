import { extractContentText, extractToolCalls } from "./content-parts.mjs";
import { extractRequestMessages, extractRequestTools } from "../shared/request-payload.mjs";
import {
  isFrameworkReminderMessage,
  isSuggestionModeMessage,
  userVisibleText,
} from "./message-semantics.mjs";
import { createRequestAttribution, requestAttributionEvidence } from "./request-attribution.mjs";

export { extractRequestMessages, extractRequestTools } from "../shared/request-payload.mjs";

export function extractSystemParts(body = {}, messages = extractRequestMessages(body)) {
  const output = [];
  if (typeof body?.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body?.system)) {
    for (const part of body.system) output.push({ source: "body.system", text: extractContentText(part) });
  }
  if (typeof body?.instructions === "string") output.push({ source: "body.instructions", text: body.instructions });
  if (Array.isArray(body?.instructions)) {
    for (const part of body.instructions) output.push({ source: "body.instructions", text: extractContentText(part) });
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => part.text);
}

export function inferRequestSource({ capture = {}, body = {}, currentUser = null, debugSource = null, lastUser = currentUser } = {}) {
  const transportOperation = classifyTransportOperation(capture);
  if (transportOperation) {
    return createRequestAttribution({
      type: "metadata",
      label: transportOperation.label,
      label_key: transportOperation.label_key,
      operation: transportOperation.operation,
      confidence: "high",
      evidence: transportOperation.evidence,
    });
  }
  const codexOperation = classifyCodexRequestOperation(capture, body);
  if (codexOperation) return codexOperation;
  if (isContextTokenCountingRequest(capture)) {
    return createRequestAttribution({
      type: "metadata",
      label: "上下文统计 (/context)",
      operation: "context_token_count",
      confidence: "high",
      evidence: [requestAttributionEvidence("transport", "path", "/v1/messages/count_tokens")],
    });
  }
  if (isSuggestionModeMessage(lastUser)) {
    return createRequestAttribution({
      type: "metadata",
      label: "Agent 输入建议请求",
      operation: "input_suggestion",
      confidence: "high",
      evidence: [requestAttributionEvidence("message", "semantic_marker", "suggestion_mode")],
    });
  }
  if (isFrameworkReminderMessage(lastUser)) {
    return createRequestAttribution({
      type: "metadata",
      label: "Claude Code 框架提醒",
      operation: "framework_reminder",
      confidence: "high",
      evidence: [requestAttributionEvidence("message", "semantic_marker", "system_reminder")],
    });
  }
  if (isTitleGenerationRequest(body, capture)) {
    return createRequestAttribution({
      type: "metadata",
      label: "生成会话标题",
      label_key: "sessionTitleGenerationRequest",
      note_key: "sessionTitleGenerationNote",
      operation: "session_title_generation",
      turn_placement: titleGenerationTurnPlacement(capture),
      confidence: "high",
      evidence: [requestAttributionEvidence("request_body", "semantic_shape", "title_generation")],
    });
  }
  if (isWebSearchInternalRequest(body)) {
    return createRequestAttribution({
      type: "metadata",
      label: "WebSearch 内部请求",
      operation: "internal_web_search",
      confidence: "high",
      evidence: [requestAttributionEvidence("request_body", "semantic_shape", "web_search")],
    });
  }

  const userText = userVisibleText(currentUser);
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  if (claudeAgentId) {
    return createRequestAttribution({
      type: "subagent",
      label: debugSource?.source || "Claude Code 子 Agent",
      confidence: "high",
      evidence: [requestAttributionEvidence("request_header", "x-claude-code-agent-id", "present")],
    });
  }
  if (isCodexSubagentRequest(capture, body)) {
    return createRequestAttribution({
      type: "subagent",
      label: "Codex 子 Agent",
      confidence: "high",
      evidence: codexSubagentEvidence(capture, body),
    });
  }
  if (debugSource?.source?.startsWith("agent:")) {
    return createRequestAttribution({
      type: "subagent",
      label: debugSource.source,
      confidence: "high",
      evidence: [requestAttributionEvidence("debug", "source_prefix", "agent")],
    });
  }
  if (debugSource?.source === "generate_session_title") {
    return createRequestAttribution({
      type: "metadata",
      label: "生成会话标题",
      label_key: "sessionTitleGenerationRequest",
      note_key: "sessionTitleGenerationNote",
      operation: "session_title_generation",
      turn_placement: titleGenerationTurnPlacement(capture),
      confidence: "high",
      evidence: [requestAttributionEvidence("debug", "source", "generate_session_title")],
    });
  }
  if (/\[Subagent Context\]|\[Subagent Task\]/i.test(userText)) {
    return createRequestAttribution({
      type: "subagent",
      label: "子代理请求",
      confidence: "high",
      evidence: [requestAttributionEvidence("message", "semantic_marker", "subagent_context")],
    });
  }
  const apiSource = capture.api_source || body.api_source || body.metadata?.api_source;
  if (typeof apiSource === "string" && apiSource.startsWith("agent:")) {
    return createRequestAttribution({
      type: "subagent",
      label: apiSource,
      confidence: "high",
      evidence: [requestAttributionEvidence("request_body", "api_source_prefix", "agent")],
    });
  }
  const calls = extractToolCalls(extractRequestMessages(body));
  const spawnCall = calls.find((call) => /^(Agent|sessions_spawn|subagents)$/.test(call.name));
  if (spawnCall) {
    return createRequestAttribution({
      type: "parent_spawn",
      label: "启动子代理",
      confidence: "high",
      evidence: [requestAttributionEvidence("message", "tool_call.name", spawnCall.name)],
    });
  }
  return createRequestAttribution({
    type: "main",
    label: "主代理请求",
    confidence: "medium",
    evidence: [requestAttributionEvidence("fallback", "classification", "main_agent")],
  });
}

function titleGenerationTurnPlacement(capture = {}) {
  const agentProfile = String(capture?.agent_profile || capture?.agentProfile || "").trim();
  return /^claude\s*code$/i.test(agentProfile) ? "next_turn" : "trigger_turn";
}

export function classifyCodexRequestOperation(capture = {}, body = capture.body || {}) {
  const observation = codexTurnMetadataObservation(body, capture);
  const metadata = observation?.metadata;
  const requestKind = cleanIdentity(metadata?.request_kind)?.toLowerCase();
  if (!requestKind || requestKind === "turn") return null;
  const evidence = [codexMetadataEvidence(observation, "request_kind")].filter(Boolean);
  if (requestKind === "prewarm") {
    return createRequestAttribution({
      type: "metadata",
      label: "Codex 对话预热请求",
      label_key: "codexPrewarmRequest",
      note_key: "codexPrewarmNote",
      operation: "responses_prewarm",
      request_kind: requestKind,
      turn_placement: "next_turn",
      relation: "current_dialogue",
      confidence: "high",
      evidence,
    });
  }
  if (requestKind === "compaction") {
    return createRequestAttribution({
      type: "metadata",
      label: "Harness 上下文压缩请求",
      label_key: "contextCompactionRequest",
      operation: "context_compaction",
      request_kind: requestKind,
      relation: "current_dialogue",
      confidence: "high",
      evidence,
    });
  }
  if (requestKind === "memory") {
    return createRequestAttribution({
      type: "background",
      label: "Codex 后台任务 · 记忆提取",
      label_key: "codexMemoryBackgroundTask",
      note_key: "codexMemoryBackgroundNote",
      operation: "codex_memory_extraction",
      request_kind: requestKind,
      relation: "independent",
      confidence: "high",
      evidence,
    });
  }
  const operationKind = safeOperationToken(requestKind);
  return createRequestAttribution({
    type: "background",
    label: "Codex 后台任务",
    label_key: "codexBackgroundTask",
    note_key: "codexBackgroundTaskNote",
    operation: `codex_${operationKind}`,
    request_kind: requestKind,
    relation: "independent",
    confidence: "high",
    evidence,
  });
}

export function codexTurnMetadata(body = {}, capture = {}) {
  return codexTurnMetadataObservation(body, capture)?.metadata || null;
}

export function codexTurnMetadataObservation(body = {}, capture = {}) {
  const clientMetadata = body?.client_metadata;
  const direct = clientMetadata && typeof clientMetadata === "object" && !Array.isArray(clientMetadata)
    ? pickCodexTurnMetadata(clientMetadata)
    : {};
  const sources = Object.fromEntries(Object.keys(direct).map((key) => [key, `client_metadata.${key}`]));
  const candidates = [
    {
      value: clientMetadata?.["x-codex-turn-metadata"],
      source: "client_metadata.x-codex-turn-metadata",
    },
    { value: clientMetadata?.turn_metadata, source: "client_metadata.turn_metadata" },
    { value: capture.header_semantics?.codex_turn_metadata, source: "header_semantics.codex_turn_metadata" },
    { value: headerValue(capture.headers, "x-codex-turn-metadata"), source: "headers.x-codex-turn-metadata" },
  ];
  for (const candidate of candidates) {
    const parsed = parseMetadataObject(candidate.value);
    if (parsed) {
      for (const key of Object.keys(parsed)) sources[key] = `${candidate.source}.${key}`;
      return { metadata: { ...direct, ...parsed }, sources };
    }
  }
  return Object.keys(direct).length ? { metadata: direct, sources } : null;
}

export function classifyTransportOperation(capture = {}) {
  if (isCodexContextCompactionRequest(capture)) {
    return {
      operation: "context_compaction",
      kind: "compact",
      label: "Harness 上下文压缩请求",
      label_key: "contextCompactionRequest",
      evidence: [requestAttributionEvidence("transport", "path", "/v1/responses/compact")],
    };
  }
  if (isCodexSearchServiceRequest(capture)) {
    return {
      operation: "codex_search",
      kind: "agent_internal",
      label: "Codex 内置搜索请求",
      label_key: "codexSearchServiceRequest",
      evidence: [requestAttributionEvidence("transport", "path", "/v1/alpha/search")],
    };
  }
  return null;
}

export function isCodexContextCompactionRequest(capture = {}) {
  return capturePaths(capture).some((value) =>
    /\/(?:v1\/responses|backend-api\/codex\/responses)\/compact(?:$|[?#/])/.test(value),
  );
}

export function isCodexSearchServiceRequest(capture = {}) {
  return capturePaths(capture).some((value) =>
    /\/(?:v1|backend-api\/codex)\/alpha\/search(?:$|[?#/])/.test(value),
  );
}

function codexMetadataEvidence(observation, key, { presenceOnly = false } = {}) {
  const value = observation?.metadata?.[key];
  const field = observation?.sources?.[key];
  if (value == null || !field) return null;
  const origin = field.startsWith("headers.") || field.startsWith("header_semantics.")
    ? "request_header"
    : "request_body";
  return requestAttributionEvidence(origin, field, presenceOnly ? "present" : safeEvidenceValue(value));
}

function codexSubagentEvidence(capture = {}, body = capture.body || {}) {
  const observation = codexTurnMetadataObservation(body, capture);
  const metadata = observation?.metadata || {};
  const evidence = [];
  if (String(metadata.thread_source || "").trim().toLowerCase() === "subagent") {
    evidence.push(codexMetadataEvidence(observation, "thread_source"));
  }
  for (const key of ["parent_thread_id", "x-codex-parent-thread-id"]) {
    if (cleanIdentity(metadata[key])) evidence.push(codexMetadataEvidence(observation, key, { presenceOnly: true }));
  }
  const marker = headerValue(capture.headers, "x-openai-subagent").trim().toLowerCase();
  if (marker && !["0", "false", "no", "off"].includes(marker)) {
    evidence.push(requestAttributionEvidence("request_header", "x-openai-subagent", "present"));
  }
  if (capture.header_semantics?.codex_parent_thread) {
    evidence.push(requestAttributionEvidence("request_header", "x-codex-parent-thread-id", "present"));
  }
  if (capture.header_semantics?.codex_subagent) {
    evidence.push(requestAttributionEvidence("request_header", "x-openai-subagent", "present"));
  }
  for (const entry of capture.header_redactions || []) {
    const field = String(entry?.field_path || "").toLowerCase();
    if (["headers.x-codex-parent-thread-id", "headers.x-openai-subagent"].includes(field)) {
      evidence.push(requestAttributionEvidence("redaction_manifest", field, "present"));
    }
  }
  return dedupeEvidence(evidence.filter(Boolean));
}

export function isCodexSubagentRequest(capture = {}, body = capture.body || {}) {
  return codexSubagentEvidence(capture, body).length > 0;
}

export function codexSubagentIdentity(capture = {}, body = capture.body || {}) {
  if (!isCodexSubagentRequest(capture, body)) return null;
  const clientMetadata = body?.client_metadata;
  const turnMetadata = codexTurnMetadata(body, capture) || {};
  const metadata = clientMetadata && typeof clientMetadata === "object" && !Array.isArray(clientMetadata) ? clientMetadata : {};
  const windowId = cleanIdentity(turnMetadata.window_id || metadata["x-codex-window-id"]) || "";
  const agentId = cleanIdentity(turnMetadata.thread_id || metadata.thread_id || windowId.split(":")[0]);
  const parentAgentId = cleanIdentity(
    turnMetadata.parent_thread_id ||
      turnMetadata["x-codex-parent-thread-id"] ||
      metadata["x-codex-parent-thread-id"] ||
      metadata.parent_thread_id ||
      turnMetadata.session_id ||
      metadata.session_id,
  );
  if (!agentId && !parentAgentId) return null;
  return {
    agent_id: agentId,
    parent_agent_id: parentAgentId,
    source: "client_metadata",
  };
}

export function isContextTokenCountingRequest(capture) {
  const requestPath = String(capture?.path || capture?.original_url || "");
  return /\/v1\/messages\/count_tokens(?:$|[?#/])/.test(requestPath);
}

export function isTitleGenerationRequest(body, capture = {}) {
  const systemText = extractSystemParts(body)
    .map((part) => part.text)
    .join("\n");
  const format = body?.output_config?.format;
  return (
    /Generate a concise, sentence-case title/i.test(systemText) ||
    isOpenCodeTitleGenerationRequest(body, systemText, capture) ||
    (format?.type === "json_schema" && format?.schema?.properties?.title && Array.isArray(body?.tools) && body.tools.length === 0)
  );
}

function isOpenCodeTitleGenerationRequest(body, systemText, capture = {}) {
  const agentProfile = String(capture?.agent_profile || capture?.agentProfile || "").trim();
  if (agentProfile && !/^open\s*code$/i.test(agentProfile)) return false;
  const messages = extractRequestMessages(body);
  const promptText = messages
    .filter((message) => message?.role === "user")
    .map((message) => extractContentText(message.content))
    .join("\n");
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return (
    /^You are a title generator\. You output ONLY a thread title\. Nothing else\./i.test(systemText.trim()) &&
    /<task>\s*Generate a brief title that would help the user find this conversation later\./i.test(systemText) &&
    /Generate a title for this conversation:/i.test(promptText) &&
    tools.length === 0
  );
}

export function isWebSearchInternalRequest(body) {
  const systemText = extractSystemParts(body)
    .map((part) => part.text)
    .join("\n");
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return (
    body?.tool_choice?.name === "web_search" ||
    tools.some((tool) => tool?.name === "web_search" || tool?.type === "web_search_20250305") ||
    /assistant for performing a web search tool use/i.test(systemText)
  );
}

export function inferProtocolProfile(capture = {}, body = {}) {
  const path = String(capture?.path || "");
  const model = String(body?.model || "");
  const protocol = inferProtocol(path, body);
  const provider = inferProvider(model, capture);
  const extensions = [];
  if (hasReasoningContent(body)) extensions.push("reasoning_content");
  if (body?.thinking != null) extensions.push("thinking");
  return {
    protocol,
    protocol_label: protocolLabel(protocol),
    provider,
    provider_label: providerLabel(provider),
    model: model || null,
    extensions,
  };
}

export function inferProtocol(path, body = {}) {
  if (/\/v1\/messages(?:$|[?#/])/.test(path) && Array.isArray(body?.messages)) return "anthropic_messages";
  if (/\/v1\/chat\/completions(?:$|[?#/])/.test(path)) return "openai_chat_completions";
  if (/\/v1\/responses(?:$|[?#/])/.test(path)) return "openai_responses";
  if (/(generateContent|streamGenerateContent)/.test(path) || Array.isArray(body?.contents)) return "gemini_generate_content";
  if (Array.isArray(body?.input)) return "openai_responses";
  if (Array.isArray(body?.messages) && Array.isArray(body?.tools) && body?.stream != null && body?.system == null) return "openai_chat_completions";
  return "unknown";
}

export function inferProvider(model, capture = {}) {
  const lowerModel = String(model || "").toLowerCase();
  const hostHint = String(capture?.headers?.host || capture?.target_base_url || "").toLowerCase();
  if (/^mimo(?:-|_)/.test(lowerModel) || /xiaomimimo|mimo/.test(hostHint)) return "xiaomi_mimo";
  if (/^gpt-|^o[134]|openai/.test(lowerModel)) return "openai";
  if (/claude/.test(lowerModel)) return "anthropic";
  if (/gemini/.test(lowerModel)) return "google_gemini";
  if (/deepseek/.test(lowerModel)) return "deepseek";
  if (/qwen|qwq/.test(lowerModel)) return "qwen";
  if (/kimi|moonshot/.test(lowerModel)) return "moonshot";
  return "unknown";
}

function protocolLabel(protocol) {
  const labels = {
    openai_chat_completions: "OpenAI Chat",
    openai_responses: "OpenAI Responses",
    anthropic_messages: "Anthropic",
    gemini_generate_content: "Gemini",
    unknown: "未知协议",
  };
  return labels[protocol] || protocol;
}

function providerLabel(provider) {
  const labels = {
    xiaomi_mimo: "MiMo",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google_gemini: "Google Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    moonshot: "Moonshot",
    unknown: "未知厂商",
  };
  return labels[provider] || provider;
}

function hasReasoningContent(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasReasoningContent);
  if (typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "reasoning_content")) return true;
  return Object.values(value).some(hasReasoningContent);
}

function capturePaths(capture = {}) {
  return [capture.path, capture.original_url, capture.upstream_path]
    .map((value) => String(value || ""))
    .filter(Boolean);
}

function pickCodexTurnMetadata(value) {
  const keys = [
    "request_kind",
    "thread_source",
    "parent_thread_id",
    "subagent_kind",
    "thread_id",
    "session_id",
    "turn_id",
    "window_id",
  ];
  return Object.fromEntries(keys.filter((key) => value[key] != null).map((key) => [key, value[key]]));
}

function parseMetadataObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text || /^\[REDACTED(?::[^\]]+)?\]$/i.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function cleanIdentity(value) {
  const text = String(value || "").trim();
  return text || null;
}

function safeEvidenceValue(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(text) ? text : "present";
}

function safeOperationToken(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return text.slice(0, 48) || "background";
}

function dedupeEvidence(items) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}
