import {
  extractRequestMessages,
  responseInputItemToMessage,
  responsesToolProtocolName,
} from "../shared/request-payload.mjs";
import { messageTextWithoutHarnessInjections } from "../trace/message-semantics.mjs";

export const DEFAULT_MESSAGE_TEXT_LIMIT = 5000;

export function organizedMessagesViewModel(
  messages,
  { textLimit = DEFAULT_MESSAGE_TEXT_LIMIT, timelineRequestIndexes = [] } = {},
) {
  const records = (Array.isArray(messages) ? messages : [])
    .map((message, index) => organizedMessageRecord(message, index, textLimit))
    .filter(Boolean);
  let segmentIndex = 0;
  let previousDirection = null;
  for (const record of records) {
    const direction = record.role === "assistant" ? "response" : "request";
    if (direction === "request" && previousDirection === "response") segmentIndex += 1;
    record.segmentIndex = segmentIndex;
    previousDirection = direction;
  }
  const timelineOffset = timelineRequestIndexes.length - segmentIndex - (records.length ? 1 : 0);
  const groups = [];

  for (const record of records) {
    const timelinePosition = timelineOffset + record.segmentIndex;
    const timelineRequestIndex = timelinePosition >= 0 ? timelineRequestIndexes[timelinePosition] ?? null : null;
    const previous = groups[groups.length - 1];
    if (previous && previous.segmentIndex === record.segmentIndex && previous.role === record.role) {
      previous.blocks.push(...record.blocks);
      continue;
    }
    groups.push({
      segmentIndex: record.segmentIndex,
      timelineRequestIndex,
      kind: messageGroupKind(record.role),
      role: record.role,
      roleClass: safeMessageClassName(record.role),
      blocks: [...record.blocks],
    });
  }

  return groups.map((group) => ({ ...group, blockCount: group.blocks.length }));
}

export function messageTimelineRequestIndexes(request, requests = []) {
  if (!request || request.request_index == null) return [];
  const byIndex = new Map(
    (Array.isArray(requests) ? requests : [])
      .filter((item) => item?.request_index != null)
      .map((item) => [String(item.request_index), item]),
  );
  byIndex.set(String(request.request_index), request);
  const chain = [];
  const visited = new Set();
  let current = request;
  while (current?.request_index != null && !visited.has(String(current.request_index))) {
    const key = String(current.request_index);
    visited.add(key);
    chain.unshift(current.request_index);
    const previousIndex = current.context_delta?.previous_request_index ?? current.trace?.previous_context_request_index;
    if (previousIndex == null) break;
    current = byIndex.get(String(previousIndex)) || null;
  }
  return chain;
}

export function upstreamConversationMessageSections(request) {
  const body = request?.raw?.body || {};
  const messages = Array.isArray(body.input) ? body.input : extractRequestMessages(body);
  const splitIndex = upstreamMessageSplitIndex(request, messages.length);
  return {
    history: conversationMessageItems(messages.slice(0, splitIndex)),
    current: conversationMessageItems(messages.slice(splitIndex)),
  };
}

export function responseConversationMessages(request) {
  const response = request?.summary?.response || {};
  if (!response.captured) return [];
  const complete = response.complete_response || {};
  if (Array.isArray(complete.content) && complete.content.length) {
    return [
      {
        type: "message",
        role: complete.role || "assistant",
        content: complete.content,
      },
    ];
  }
  const content = [];
  if (response.thinking) content.push({ type: "thinking", thinking: response.thinking });
  if (response.text) content.push({ type: "output_text", text: response.text });
  for (const call of response.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || null,
      name: call.name || "unknown",
      input: call.arguments ?? null,
    });
  }
  return content.length ? [{ type: "message", role: "assistant", content }] : [];
}

function conversationMessageItems(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message, index) => {
    const role = inferMessageRole(message);
    if (role === "system") return false;
    return Boolean(organizedMessageRecord(message, index, DEFAULT_MESSAGE_TEXT_LIMIT));
  });
}

function organizedMessageRecord(message, index, textLimit) {
  const role = inferMessageRole(message);
  const roleInferred = !hasExplicitMessageRole(message);
  const blocks = normalizeMessageBlocks(message)
    .map((block) =>
      organizedMessageBlock({ ...(message || {}), role }, block, {
        role,
        roleInferred,
        sourceIndex: index,
        textLimit,
      }),
    )
    .filter(Boolean);
  return blocks.length ? { role, blocks, segmentIndex: 0 } : null;
}

function upstreamMessageSplitIndex(request, totalMessages) {
  const delta = request?.context_delta || request?.summary?.context_delta || {};
  const previousMessages = nonNegativeInteger(delta.previous_messages);
  if (previousMessages != null) return Math.min(previousMessages, totalMessages);
  const newMessages = nonNegativeInteger(delta.new_messages);
  if (newMessages != null) return Math.max(0, totalMessages - Math.min(newMessages, totalMessages));
  return delta.baseline ? 0 : totalMessages;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function normalizeMessageBlocks(message) {
  if (message == null) return [{ type: "empty", text: "", raw: message }];
  if (typeof message !== "object") return [{ type: "text", text: String(message), raw: message }];
  const content = message.content;
  if (Array.isArray(content)) {
    return content.length ? content.map((block) => normalizeMessageBlock(block)) : [{ type: "empty", text: "", raw: content }];
  }
  if (typeof content === "string") return [{ type: "text", text: content, raw: content }];
  if (content != null) return [normalizeMessageBlock(content)];
  return [normalizeMessageBlock(message)];
}

function normalizeMessageBlock(block) {
  if (block == null) return { type: "empty", text: "", raw: block };
  if (typeof block !== "object") return { type: "text", text: String(block), raw: block };
  return {
    type: String(block.type || "object"),
    text: messageBlockText(block),
    raw: block,
  };
}

export function truncateMessageText(text, limit = DEFAULT_MESSAGE_TEXT_LIMIT) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, originalLength: value.length, truncated: false };
  return {
    text: `${value.slice(0, limit).trimEnd()}\n\n...`,
    originalLength: value.length,
    truncated: true,
  };
}

export function safeMessageClassName(value) {
  return (
    String(value || "context")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "context"
  );
}

export function inferMessageRole(message) {
  const explicitRole = explicitMessageRole(message);
  if (explicitRole) return explicitRole;
  const converted = message && typeof message === "object" ? responseInputItemToMessage(message) : null;
  if (converted?.role && converted.role !== "unknown") return converted.role;
  const type = String(message?.type || "").toLowerCase();
  const kind = messageBlockKind(type);
  if (kind === "tool_result") return "tool";
  if (kind === "tool_call" || kind === "reasoning" || type === "output_text") return "assistant";
  const contentTypes = Array.isArray(message?.content)
    ? message.content.map((part) => String(part?.type || "").toLowerCase())
    : [];
  if (contentTypes.some((item) => messageBlockKind(item) === "tool_result")) return "tool";
  if (contentTypes.some((item) => ["tool_call", "reasoning"].includes(messageBlockKind(item)) || item === "output_text")) {
    return "assistant";
  }
  return "user";
}

function explicitMessageRole(message) {
  const role = typeof message === "object" && message ? String(message.role || "").trim().toLowerCase() : "";
  return role && role !== "unknown" ? role : "";
}

function hasExplicitMessageRole(message) {
  return Boolean(explicitMessageRole(message));
}

function blockViewModel(block, { role, roleInferred, sourceIndex, textLimit }) {
  const type = block.type || "object";
  const text = block.text || "";
  const kind = messageBlockKind(type);
  return {
    sourceIndex,
    type,
    role,
    roleInferred,
    kind,
    text,
    textPreview: truncateMessageText(text, textLimit),
    raw: block.raw,
    toolCall: kind === "tool_call" ? toolCallView(block.raw) : null,
    toolResult: kind === "tool_result" ? toolResultView(block.raw, text) : null,
  };
}

function organizedMessageBlock(message, block, metadata) {
  if (block.text && ["text", "input_text", "output_text"].includes(block.type)) {
    const text = messageTextWithoutHarnessInjections(message, block.text);
    if (!text) return null;
    block = { ...block, text };
  }
  return blockViewModel(block, metadata);
}

function messageBlockKind(type) {
  if (type === "tool_result" || type.endsWith("_output")) return "tool_result";
  if (type === "tool_use" || type.endsWith("_call")) return "tool_call";
  if (type === "reasoning" || type === "thinking") return "reasoning";
  if (["text", "input_text", "output_text", "empty"].includes(type)) return "text";
  return "structured";
}

function messageGroupKind(role) {
  if (role === "assistant") return "model_response";
  if (role === "tool") return "tool_results";
  if (role === "user") return "user_input";
  return "context_input";
}

function toolCallView(raw = {}) {
  return {
    name: raw.name || raw.function?.name || raw.tool_name || responsesToolProtocolName(raw.type) || "unknown",
    callId: raw.call_id || raw.id || raw.tool_use_id || null,
    parameters: parseMaybeJson(raw.arguments ?? raw.input ?? raw.action ?? raw.function?.arguments ?? null),
  };
}

function toolResultView(raw = {}, text = "") {
  return {
    callId: raw.call_id || raw.tool_use_id || raw.id || null,
    name: raw.name || raw.tool_name || responsesToolProtocolName(raw.type) || null,
    output: text || stringValue(raw.output ?? raw.content ?? raw.result ?? raw.tools ?? ""),
    toolSearch: toolSearchResultView(raw),
  };
}

function toolSearchResultView(raw = {}) {
  if (raw.type !== "tool_search_output" || !Array.isArray(raw.tools)) return null;
  const groups = raw.tools.map((item) => toolSearchGroupView(item)).filter(Boolean);
  return {
    groups,
    namespaceCount: groups.filter((group) => group.type === "namespace").length,
    toolCount: groups.reduce((sum, group) => sum + group.toolCount, 0),
  };
}

function toolSearchGroupView(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type || "tool");
  const nestedTools = (Array.isArray(item.tools) ? item.tools : [])
    .map((tool) => ({
      type: String(tool?.type || "tool"),
      name: String(tool?.name || "").trim(),
    }))
    .filter((tool) => tool.name);
  return {
    type,
    name: String(item.name || "").trim() || type,
    description: typeof item.description === "string" ? item.description.trim() : "",
    tools: nestedTools,
    toolCount: nestedTools.length || (type === "function" ? 1 : 0),
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function messageBlockText(block) {
  if (!block || typeof block !== "object") return String(block ?? "");
  if (typeof block.text === "string") return block.text;
  if (typeof block.reasoning === "string") return block.reasoning;
  const reasoningSummary = Array.isArray(block.summary)
    ? block.summary
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .filter(Boolean)
        .join("\n")
    : "";
  if (reasoningSummary) return reasoningSummary;
  if (typeof block.output === "string") return block.output;
  if (typeof block.content === "string") return block.content;
  if (typeof block.input === "string") return block.input;
  if (typeof block.name === "string" && block.type === "tool_use") return `${block.name}${block.id ? ` (${block.id})` : ""}`;
  return "";
}

function stringValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
