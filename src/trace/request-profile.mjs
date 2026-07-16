import { extractContentText, extractToolCalls } from "./content-parts.mjs";
import {
  isFrameworkReminderMessage,
  isSuggestionModeMessage,
  userVisibleText,
} from "./message-semantics.mjs";

export function extractSystemParts(body = {}, messages = body?.messages) {
  const output = [];
  if (typeof body?.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body?.system)) {
    for (const part of body.system) output.push({ source: "body.system", text: extractContentText(part) });
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => part.text);
}

export function inferRequestSource({ capture = {}, body = {}, currentUser = null, debugSource = null, lastUser = currentUser } = {}) {
  if (isContextTokenCountingRequest(capture)) {
    return { type: "metadata", label: "上下文统计 (/context)", confidence: "high" };
  }
  if (isSuggestionModeMessage(lastUser)) {
    return { type: "metadata", label: "Agent 输入建议请求", confidence: "high" };
  }
  if (isFrameworkReminderMessage(lastUser)) {
    return { type: "metadata", label: "Claude Code 框架提醒", confidence: "high" };
  }
  if (isTitleGenerationRequest(body)) {
    return { type: "metadata", label: "生成会话标题", confidence: "high" };
  }
  if (isWebSearchInternalRequest(body)) {
    return { type: "metadata", label: "WebSearch 内部请求", confidence: "high" };
  }

  const userText = userVisibleText(currentUser);
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  if (claudeAgentId) {
    return { type: "subagent", label: debugSource?.source || "Claude Code 子 Agent", confidence: "high" };
  }
  if (debugSource?.source?.startsWith("agent:")) {
    return { type: "subagent", label: debugSource.source, confidence: "high" };
  }
  if (debugSource?.source === "generate_session_title") {
    return { type: "metadata", label: "生成会话标题", confidence: "high" };
  }
  if (/\[Subagent Context\]|\[Subagent Task\]/i.test(userText)) {
    return { type: "subagent", label: "子代理请求", confidence: "high" };
  }
  const apiSource = capture.api_source || body.api_source || body.metadata?.api_source;
  if (typeof apiSource === "string" && apiSource.startsWith("agent:")) {
    return { type: "subagent", label: apiSource, confidence: "high" };
  }
  const calls = extractToolCalls(Array.isArray(body.messages) ? body.messages : []);
  if (calls.some((call) => /^(Agent|sessions_spawn|subagents)$/.test(call.name))) {
    return { type: "parent_spawn", label: "启动子代理", confidence: "high" };
  }
  return { type: "main", label: "主代理请求", confidence: "medium" };
}

export function isContextTokenCountingRequest(capture) {
  const requestPath = String(capture?.path || capture?.original_url || "");
  return /\/v1\/messages\/count_tokens(?:$|[?#/])/.test(requestPath);
}

export function isTitleGenerationRequest(body) {
  const systemText = extractSystemParts(body)
    .map((part) => part.text)
    .join("\n");
  const format = body?.output_config?.format;
  return (
    /Generate a concise, sentence-case title/i.test(systemText) ||
    (format?.type === "json_schema" && format?.schema?.properties?.title && Array.isArray(body?.tools) && body.tools.length === 0)
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

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}
