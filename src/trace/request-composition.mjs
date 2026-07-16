import { extractContentText, extractToolCalls } from "./content-parts.mjs";
import {
  classifyMessageKind,
  isFrameworkReminderMessage,
  isSuggestionModeMessage,
  isToolResultMessage,
  userVisibleText,
} from "./message-semantics.mjs";

export function analyzeRequestComposition({
  body = {},
  messages = [],
  systemParts = [],
  tools = [],
  currentUser = null,
  responseSummary = null,
  rawBodyLength = 0,
} = {}) {
  const params = Object.fromEntries(Object.entries(body || {}).filter(([key]) => !["messages", "system", "tools"].includes(key)));
  const messageParts = analyzeMessageComposition(messages || [], currentUser);
  const totalPayloadChars = Number(rawBodyLength) || jsonCharLength(body || {});
  const messagesChars = messageParts.total_chars;
  const systemChars = (systemParts || []).reduce((sum, part) => sum + charLength(part.text), 0);
  const toolsChars = jsonCharLength(tools || []);
  const paramsChars = jsonCharLength(params);
  const currentUserChars = messageParts.current_user_chars || charLength(userVisibleText(currentUser));
  const responseTextChars = charLength(responseSummary?.text || "");
  const responseThinkingChars = charLength(responseSummary?.thinking || "");
  const fixedContextChars = systemChars + toolsChars + paramsChars;
  const historyContextChars = Math.max(0, messageParts.total_chars - currentUserChars);

  return {
    unit: "chars",
    total_payload_chars: totalPayloadChars,
    input_chars: totalPayloadChars,
    fixed_context_chars: fixedContextChars,
    history_context_chars: historyContextChars,
    current_user_chars: currentUserChars,
    human_user_chars: messageParts.human_user_chars,
    assistant_history_chars: messageParts.assistant_chars,
    tool_use_chars: messageParts.tool_use_chars,
    tool_result_chars: messageParts.tool_result_chars,
    agent_internal_chars: messageParts.agent_internal_chars,
    response_text_chars: responseTextChars,
    response_thinking_chars: responseThinkingChars,
    sections: {
      system: compositionItem(systemChars, totalPayloadChars),
      tools: compositionItem(toolsChars, totalPayloadChars),
      params: compositionItem(paramsChars, totalPayloadChars),
      messages: compositionItem(messagesChars, totalPayloadChars),
      current_user: compositionItem(currentUserChars, totalPayloadChars),
      history_context: compositionItem(historyContextChars, totalPayloadChars),
      assistant_history: compositionItem(messageParts.assistant_chars, totalPayloadChars),
      tool_use: compositionItem(messageParts.tool_use_chars, totalPayloadChars),
      tool_result: compositionItem(messageParts.tool_result_chars, totalPayloadChars),
      agent_internal: compositionItem(messageParts.agent_internal_chars, totalPayloadChars),
      response_text: compositionItem(responseTextChars, totalPayloadChars),
      response_thinking: compositionItem(responseThinkingChars, totalPayloadChars),
    },
    ratios: {
      current_user_to_input: ratio(currentUserChars, totalPayloadChars),
      human_user_to_input: ratio(messageParts.human_user_chars, totalPayloadChars),
      fixed_context_to_input: ratio(fixedContextChars, totalPayloadChars),
      history_context_to_input: ratio(historyContextChars, totalPayloadChars),
      tools_to_input: ratio(toolsChars, totalPayloadChars),
      system_to_input: ratio(systemChars, totalPayloadChars),
      tool_result_to_input: ratio(messageParts.tool_result_chars, totalPayloadChars),
      output_to_input: ratio(responseTextChars, totalPayloadChars),
    },
    note: "本统计使用字符数近似，后续可升级为 tokenizer 估算。",
  };
}

export function analyzeMessageComposition(messages, currentUser) {
  const stats = {
    total_chars: 0,
    human_user_chars: 0,
    assistant_chars: 0,
    tool_use_chars: 0,
    tool_result_chars: 0,
    agent_internal_chars: 0,
    other_chars: 0,
  };

  for (const message of messages || []) {
    const chars = messageCompositionChars(message);
    stats.total_chars += chars;
    if (isFrameworkReminderMessage(message)) stats.agent_internal_chars += chars;
    else if (isSuggestionModeMessage(message)) stats.agent_internal_chars += chars;
    else if (isToolResultMessage(message)) stats.tool_result_chars += chars;
    else if (classifyMessageKind(message) === "tool_use") stats.tool_use_chars += chars;
    else if (message?.role === "user") stats.human_user_chars += chars;
    else if (message?.role === "assistant") stats.assistant_chars += chars;
    else stats.other_chars += chars;
  }

  stats.current_user_chars = charLength(userVisibleText(currentUser));
  return stats;
}

function messageCompositionChars(message) {
  if (!message || typeof message !== "object") return 0;
  if (classifyMessageKind(message) === "tool_use") return charLength(stableJson(extractToolCalls([message])));
  return charLength(extractContentText(message.content));
}

function compositionItem(chars, total) {
  return {
    chars,
    ratio: ratio(chars, total),
  };
}

function ratio(value, total) {
  if (!total) return 0;
  return Number((Number(value || 0) / Number(total)).toFixed(4));
}

function charLength(value) {
  return String(value || "").length;
}

function jsonCharLength(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return charLength(stableJson(value ?? null));
  }
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
