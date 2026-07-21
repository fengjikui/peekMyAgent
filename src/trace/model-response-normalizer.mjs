import {
  extractContentText,
  extractThinkingText,
  extractToolCalls,
  extractToolCallsFromContent,
  parseMaybeJson,
  toolCallFromPart,
} from "./content-parts.mjs";
import {
  isResponsesToolCallItem,
  responsesToolProtocolName,
} from "../shared/request-payload.mjs";

const DEFAULT_TEXT_PREVIEW_CHARS = 1200;
const DEFAULT_TEXT_CHARS = 8000;
const DEFAULT_THINKING_CHARS = 8000;
const DEFAULT_THINKING_PREVIEW_CHARS = 240;

export function summarizeModelResponse(response) {
  if (!response) return emptyResponseSummary();

  const contentType = headerValue(response.headers, "content-type");
  const stream = /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(response.body_text || "");
  const parsed = stream ? summarizeSseResponse(response.body_text || "") : summarizeJsonResponse(response.body_json);
  return {
    captured: true,
    message_id: parsed.message_id || null,
    preview: textPreview(parsed.text, DEFAULT_TEXT_PREVIEW_CHARS),
    text: textPreview(parsed.text, DEFAULT_TEXT_CHARS),
    thinking: textPreview(parsed.thinking, DEFAULT_THINKING_CHARS),
    thinking_preview: textPreview(parsed.thinking, DEFAULT_THINKING_PREVIEW_CHARS),
    tool_calls: parsed.tool_calls || [],
    usage: parsed.usage,
    finish_reason: parsed.finish_reason || null,
    response_status: parsed.response_status || null,
    complete_response: assembleCompleteResponse(parsed, { stream, truncated: Boolean(response.truncated) }),
    latency_ms: response.duration_ms ?? null,
    status: response.status ?? null,
    stream,
    event_count: parsed.event_count || 0,
    truncated: Boolean(response.truncated),
    raw_body_bytes: response.raw_body_length || 0,
    captured_body_bytes: response.captured_body_length || 0,
    received_at: response.received_at || null,
  };
}

export function summarizeJsonResponse(body) {
  if (!body || typeof body !== "object") return emptyParsedResponse();

  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];
  const finishReasons = [];
  if (Array.isArray(body.content)) textParts.push(extractContentText(body.content));
  if (Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (Array.isArray(body.content)) toolCalls.push(...extractToolCallsFromContent(body.content));
  if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (typeof body.content === "string") textParts.push(body.content);
  if (Array.isArray(body.choices)) collectChoiceResponse(body.choices, { textParts, thinkingParts, toolCalls, finishReasons });
  if (Array.isArray(body.output)) collectOutputResponse(body.output, { textParts, thinkingParts, toolCalls });
  if (body.stop_reason) finishReasons.push(body.stop_reason);
  if (body.finish_reason) finishReasons.push(body.finish_reason);
  return {
    message_id: body.id || null,
    role: body.role || null,
    model: body.model || null,
    text: textParts.filter(Boolean).join("\n"),
    thinking: thinkingParts.filter(Boolean).join("\n"),
    tool_calls: dedupeToolCalls(toolCalls),
    usage: body.usage || null,
    finish_reason: uniqueValues(finishReasons).join(", ") || null,
    response_status: body.status || null,
    event_count: 0,
  };
}

export function summarizeSseResponse(text) {
  const events = parseSseEvents(text);
  const textParts = [];
  const thinkingParts = [];
  const fallbackTextParts = [];
  const fallbackThinkingParts = [];
  const toolCalls = [];
  const toolCallBlocks = new Map();
  const openAiToolCallBlocks = new Map();
  const responsesToolCallBlocks = new Map();
  const finishReasons = [];
  let usage = null;
  let messageId = null;
  let role = null;
  let model = null;
  let responseStatus = null;
  let terminalResponse = null;

  for (const event of events) {
    if (!event.data || event.data === "[DONE]") continue;
    const data = parseJson(event.data);
    if (!data || typeof data !== "object") continue;
    if (/^response\.(?:completed|failed|incomplete)$/.test(data.type || "") && data.response && typeof data.response === "object") {
      terminalResponse = data.response;
      responseStatus = data.response.status || data.type.replace(/^response\./, "");
      continue;
    }
    if (data.type === "response.created" && data.response) {
      messageId = data.response.id || messageId;
      model = data.response.model || model;
      responseStatus = data.response.status || responseStatus;
    }
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") textParts.push(data.delta);
    if (/^response\.reasoning_(?:summary_)?text\.delta$/.test(data.type || "") && typeof data.delta === "string") {
      thinkingParts.push(data.delta);
    }
    collectResponsesToolCallEvent(data, responsesToolCallBlocks);
    if (data.model) model = data.model;
    if (Array.isArray(data.choices)) {
      collectStreamingChoices(data.choices, {
        textParts,
        thinkingParts,
        fallbackTextParts,
        fallbackThinkingParts,
        toolCalls,
        openAiToolCallBlocks,
        finishReasons,
        setRole(value) {
          role = value;
        },
      });
    }
    if (data.delta?.type === "text_delta" && data.delta.text) textParts.push(data.delta.text);
    if (data.delta?.type === "thinking_delta" && data.delta.thinking) thinkingParts.push(data.delta.thinking);
    else if (!data.delta?.type && data.delta?.text) textParts.push(data.delta.text);
    if (data.content_block?.type === "text" && data.content_block.text) fallbackTextParts.push(data.content_block.text);
    if (data.content_block?.type === "thinking" && data.content_block.thinking) fallbackThinkingParts.push(data.content_block.thinking);
    if (data.content_block?.type === "tool_use") {
      const call = toolCallFromPart(data.content_block);
      if (call) {
        toolCalls.push(call);
        toolCallBlocks.set(data.index, { call, partialJson: "" });
      }
    }
    if (data.delta?.type === "input_json_delta" && data.index != null) {
      const block = toolCallBlocks.get(data.index);
      if (block) block.partialJson += data.delta.partial_json || "";
    }
    if (data.message?.content) fallbackTextParts.push(extractContentText(data.message.content));
    if (data.message?.content) fallbackThinkingParts.push(extractThinkingText(data.message.content));
    if (data.message?.content) toolCalls.push(...extractToolCallsFromContent(data.message.content));
    if (data.type === "message_start" && data.message?.id) {
      messageId = data.message.id;
      if (data.message.role) role = data.message.role;
      if (data.message.model) model = data.message.model;
    }
    if (data.id && data.type === "message") messageId = data.id;
    if (data.delta?.stop_reason) finishReasons.push(data.delta.stop_reason);
    if (data.stop_reason) finishReasons.push(data.stop_reason);
    if (data.finish_reason) finishReasons.push(data.finish_reason);
    if (data.usage) usage = data.usage;
    if (data.message?.usage) usage = data.message.usage;
  }

  if (terminalResponse) {
    const terminal = summarizeJsonResponse(terminalResponse);
    return {
      ...terminal,
      text: terminal.text || textParts.filter(Boolean).join("") || fallbackTextParts.filter(Boolean).join("\n"),
      thinking: terminal.thinking || thinkingParts.filter(Boolean).join("") || fallbackThinkingParts.filter(Boolean).join("\n"),
      tool_calls: terminal.tool_calls.length
        ? terminal.tool_calls
        : dedupeToolCalls(finalizeResponsesStreamToolCalls(responsesToolCallBlocks)),
      response_status: terminal.response_status || responseStatus,
      finish_reason: terminal.finish_reason || terminal.response_status || responseStatus || null,
      event_count: events.length,
    };
  }

  return {
    message_id: messageId,
    role,
    model,
    text: textParts.filter(Boolean).join("") || fallbackTextParts.filter(Boolean).join("\n"),
    thinking: thinkingParts.filter(Boolean).join("") || fallbackThinkingParts.filter(Boolean).join("\n"),
    tool_calls: dedupeToolCalls([
      ...mergeStreamToolCallInputs(toolCalls, toolCallBlocks),
      ...finalizeOpenAiStreamToolCalls(openAiToolCallBlocks),
      ...finalizeResponsesStreamToolCalls(responsesToolCallBlocks),
    ]),
    usage,
    finish_reason: uniqueValues(finishReasons).join(", ") || null,
    response_status: responseStatus,
    event_count: events.length,
  };
}

export function assembleCompleteResponse(parsed, { stream = false, truncated = false } = {}) {
  const content = [];
  if (parsed?.thinking) content.push({ type: "thinking", thinking: parsed.thinking });
  if (parsed?.text) content.push({ type: "text", text: parsed.text });
  for (const call of parsed?.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || null,
      name: call.name || "unknown",
      input: call.arguments ?? null,
    });
  }
  return {
    id: parsed?.message_id || null,
    role: parsed?.role || "assistant",
    model: parsed?.model || null,
    content,
    text: parsed?.text || "",
    thinking: parsed?.thinking || "",
    tool_use: parsed?.tool_calls || [],
    stop_reason: parsed?.finish_reason || null,
    finish_reason: parsed?.finish_reason || null,
    status: parsed?.response_status || null,
    usage: parsed?.usage || null,
    stream: Boolean(stream),
    event_count: parsed?.event_count || 0,
    truncated: Boolean(truncated),
  };
}

function emptyResponseSummary() {
  return {
    captured: false,
    message_id: null,
    preview: "",
    text: "",
    thinking: "",
    thinking_preview: "",
    usage: null,
    finish_reason: null,
    response_status: null,
    latency_ms: null,
    status: null,
    stream: false,
    event_count: 0,
    truncated: false,
  };
}

function emptyParsedResponse() {
  return {
    message_id: null,
    role: null,
    model: null,
    text: "",
    thinking: "",
    tool_calls: [],
    usage: null,
    finish_reason: null,
    response_status: null,
    event_count: 0,
  };
}

function collectChoiceResponse(choices, output) {
  for (const choice of choices) {
    if (choice?.message?.content) output.textParts.push(extractContentText(choice.message.content));
    if (choice?.message?.content) output.thinkingParts.push(extractThinkingText(choice.message.content));
    if (choice?.message?.reasoning_content) output.thinkingParts.push(choice.message.reasoning_content);
    if (choice?.message?.content) output.toolCalls.push(...extractToolCallsFromContent(choice.message.content));
    if (Array.isArray(choice?.message?.tool_calls)) output.toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
    if (choice?.delta?.content) output.textParts.push(extractContentText(choice.delta.content));
    if (choice?.delta?.reasoning_content) output.thinkingParts.push(choice.delta.reasoning_content);
    if (Array.isArray(choice?.delta?.tool_calls)) output.toolCalls.push(...extractToolCalls([{ tool_calls: choice.delta.tool_calls }]));
    if (choice?.finish_reason) output.finishReasons.push(choice.finish_reason);
  }
}

function collectOutputResponse(items, output) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      const reasoningText = extractResponsesReasoningText(item);
      if (reasoningText) output.thinkingParts.push(reasoningText);
      continue;
    }
    if (isResponsesToolCallItem(item)) {
      output.toolCalls.push({
        name: item.name || item.function?.name || responsesToolProtocolName(item.type) || "unknown",
        id: item.call_id || item.id || null,
        arguments: parseMaybeJson(item.arguments ?? item.input ?? item.function?.arguments),
      });
      continue;
    }
    if (Array.isArray(item.content)) {
      output.textParts.push(extractContentText(item.content));
      output.thinkingParts.push(extractThinkingText(item.content));
      output.toolCalls.push(...extractToolCallsFromContent(item.content));
    } else if (item.content && typeof item.content === "object") {
      output.thinkingParts.push(extractThinkingText(item.content));
      output.textParts.push(extractContentText(item.content));
    } else if (item.content) {
      output.textParts.push(extractContentText(item.content));
    }
    if (typeof item.output_text === "string") output.textParts.push(item.output_text);
  }
}

function extractResponsesReasoningText(item) {
  const values = [];
  for (const part of Array.isArray(item?.summary) ? item.summary : []) {
    if (typeof part === "string") values.push(part);
    else if (part?.text) values.push(part.text);
  }
  for (const part of Array.isArray(item?.content) ? item.content : []) {
    if (typeof part === "string") values.push(part);
    else if (part?.text) values.push(part.text);
  }
  if (typeof item?.text === "string") values.push(item.text);
  return values.filter(Boolean).join("\n");
}

function collectResponsesToolCallEvent(data, blocks) {
  const type = String(data?.type || "");
  const item = data?.item;
  if (["response.output_item.added", "response.output_item.done"].includes(type) && isResponsesToolCall(item)) {
    const key = responsesToolCallKey(data, item, blocks.size);
    const current = blocks.get(key) || { id: null, name: null, argumentsText: "", finalArguments: undefined };
    current.id = item.call_id || item.id || current.id;
    current.name = item.name || item.function?.name || responsesToolProtocolName(item.type) || current.name;
    if (type === "response.output_item.done") {
      current.finalArguments = item.arguments ?? item.input ?? item.action ?? item.function?.arguments;
    }
    blocks.set(key, current);
    return;
  }
  if (!/(?:function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(type)) return;
  const key = responsesToolCallKey(data, null, blocks.size);
  const current = blocks.get(key) || { id: data.call_id || data.item_id || null, name: data.name || null, argumentsText: "", finalArguments: undefined };
  if (type.endsWith(".delta")) current.argumentsText += data.delta || "";
  else current.finalArguments = data.arguments ?? data.input ?? data.text ?? data.delta ?? current.argumentsText;
  blocks.set(key, current);
}

function responsesToolCallKey(data, item, fallback) {
  if (data?.output_index != null) return `output:${data.output_index}`;
  return item?.call_id || data?.call_id || item?.id || data?.item_id || fallback;
}

function isResponsesToolCall(item) {
  return isResponsesToolCallItem(item);
}

function finalizeResponsesStreamToolCalls(blocks) {
  return [...blocks.values()]
    .filter((block) => block.id || block.name || block.argumentsText || block.finalArguments !== undefined)
    .map((block) => ({
      name: block.name || "unknown",
      id: block.id || null,
      arguments: parseMaybeJson(block.finalArguments !== undefined ? block.finalArguments : block.argumentsText),
    }));
}

function collectStreamingChoices(choices, output) {
  for (const choice of choices) {
    if (choice?.delta?.role) output.setRole(choice.delta.role);
    if (choice?.delta?.content) output.textParts.push(extractContentText(choice.delta.content));
    if (choice?.delta?.reasoning_content) output.thinkingParts.push(choice.delta.reasoning_content);
    if (choice?.message?.content) output.fallbackTextParts.push(extractContentText(choice.message.content));
    if (choice?.message?.content) output.fallbackThinkingParts.push(extractThinkingText(choice.message.content));
    if (choice?.message?.reasoning_content) output.fallbackThinkingParts.push(choice.message.reasoning_content);
    if (choice?.message?.role) output.setRole(choice.message.role);
    if (choice?.message?.content) output.toolCalls.push(...extractToolCallsFromContent(choice.message.content));
    if (Array.isArray(choice?.message?.tool_calls)) output.toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
    if (Array.isArray(choice?.delta?.tool_calls)) mergeOpenAiStreamToolCalls(output.openAiToolCallBlocks, choice.delta.tool_calls);
    if (choice?.finish_reason) output.finishReasons.push(choice.finish_reason);
  }
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const output = [];
  for (const call of calls.filter(Boolean)) {
    const key = `${call.id || ""}:${call.name || ""}:${stableJson(call.arguments ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function mergeOpenAiStreamToolCalls(blocks, chunks) {
  for (const chunk of chunks || []) {
    const key = chunk.index ?? chunk.id ?? blocks.size;
    const current = blocks.get(key) || { id: null, name: null, argumentsText: "", type: null };
    if (chunk.id) current.id = chunk.id;
    if (chunk.type) current.type = chunk.type;
    if (chunk.function?.name) current.name = chunk.function.name;
    if (chunk.name) current.name = chunk.name;
    if (chunk.function?.arguments) current.argumentsText += chunk.function.arguments;
    else if (chunk.arguments) current.argumentsText += chunk.arguments;
    blocks.set(key, current);
  }
}

function finalizeOpenAiStreamToolCalls(blocks) {
  return [...blocks.values()]
    .filter((block) => block.id || block.name || block.argumentsText)
    .map((block) => ({
      name: block.name || "unknown",
      id: block.id || null,
      arguments: parseMaybeJson(block.argumentsText),
    }));
}

function mergeStreamToolCallInputs(toolCalls, blocks) {
  if (!blocks.size) return toolCalls;
  return toolCalls.map((call) => {
    const block = [...blocks.values()].find((item) => item.call === call || (item.call.id && item.call.id === call.id));
    if (!block?.partialJson) return call;
    return { ...call, arguments: parseMaybeJson(block.partialJson) };
  });
}

function parseSseEvents(text) {
  const events = [];
  let current = { event: null, data: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
      current = { event: null, data: [] };
      continue;
    }
    if (line.startsWith("event:")) current.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) current.data.push(line.slice("data:".length).trim());
  }
  if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
  return events;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
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
