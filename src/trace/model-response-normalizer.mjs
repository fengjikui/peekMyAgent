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
const OPAQUE_REASONING_PREVIEW = "<encrypted reasoning retained only in the original captured response>";

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
    opaque_reasoning: parsed.opaque_reasoning || [],
    tool_calls: parsed.tool_calls || [],
    usage: parsed.usage,
    finish_reason: parsed.finish_reason || null,
    response_status: parsed.response_status || null,
    response_protocol: parsed.response_protocol || null,
    complete_response_source: parsed.complete_response_source || null,
    complete_response: parsed.complete_response || null,
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
  const opaqueReasoning = [];
  const toolCalls = [];
  const finishReasons = [];
  if (Array.isArray(body.content)) textParts.push(extractProviderText(body.content));
  if (Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (Array.isArray(body.content)) toolCalls.push(...extractToolCallsFromContent(body.content));
  if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (typeof body.content === "string") textParts.push(body.content);
  if (Array.isArray(body.choices)) collectChoiceResponse(body.choices, { textParts, thinkingParts, toolCalls, finishReasons });
  if (Array.isArray(body.output)) {
    collectOutputResponse(body.output, { textParts, thinkingParts, opaqueReasoning, toolCalls });
  }
  if (body.stop_reason) finishReasons.push(body.stop_reason);
  if (body.finish_reason) finishReasons.push(body.finish_reason);
  return {
    complete_response: body,
    complete_response_source: "captured_body_json",
    response_protocol: detectResponseProtocol(body),
    message_id: body.id || null,
    role: body.role || null,
    model: body.model || null,
    text: textParts.filter(Boolean).join("\n"),
    thinking: thinkingParts.filter(Boolean).join("\n"),
    opaque_reasoning: opaqueReasoning,
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
  const anthropicContentBlocks = new Map();
  const openAiToolCallBlocks = new Map();
  const openAiChoiceBlocks = new Map();
  const responsesToolCallBlocks = new Map();
  const responsesOutputItems = new Map();
  const opaqueReasoningBlocks = new Map();
  const finishReasons = [];
  let usage = null;
  let messageId = null;
  let role = null;
  let model = null;
  let responseStatus = null;
  let terminalResponse = null;
  let protocol = null;
  let anthropicMessage = null;
  let chatCompletionMetadata = null;

  for (const event of events) {
    if (!event.data || event.data === "[DONE]") continue;
    const data = parseJson(event.data);
    if (!data || typeof data !== "object") continue;
    if (/^response\.(?:completed|failed|incomplete)$/.test(data.type || "") && data.response && typeof data.response === "object") {
      protocol = "openai_responses";
      terminalResponse = data.response;
      responseStatus = data.response.status || data.type.replace(/^response\./, "");
      continue;
    }
    if (data.type === "response.created" && data.response) {
      protocol = "openai_responses";
      messageId = data.response.id || messageId;
      model = data.response.model || model;
      responseStatus = data.response.status || responseStatus;
    }
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") textParts.push(data.delta);
    if (/^response\.reasoning_(?:summary_)?text\.delta$/.test(data.type || "") && typeof data.delta === "string") {
      thinkingParts.push(data.delta);
    }
    collectResponsesToolCallEvent(data, responsesToolCallBlocks);
    collectResponsesOutputItem(data, responsesOutputItems);
    collectResponsesReasoningEvent(data, opaqueReasoningBlocks);
    if (data.model) model = data.model;
    if (Array.isArray(data.choices)) {
      protocol = "openai_chat_completions";
      chatCompletionMetadata = mergeChatCompletionMetadata(chatCompletionMetadata, data);
      collectStreamingChoices(data.choices, {
        textParts,
        thinkingParts,
        fallbackTextParts,
        fallbackThinkingParts,
        toolCalls,
        openAiToolCallBlocks,
        openAiChoiceBlocks,
        finishReasons,
        setRole(value) {
          role = value;
        },
      });
    }
    if (/^(?:message_start|message_delta|message_stop|content_block_)/.test(data.type || "")) {
      protocol = "anthropic_messages";
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
    if (data.type === "content_block_start" && data.index != null && data.content_block) {
      anthropicContentBlocks.set(data.index, createAnthropicContentBlock(data.content_block));
    }
    if (data.type === "content_block_delta" && data.index != null) {
      mergeAnthropicContentBlockDelta(anthropicContentBlocks, data.index, data.delta);
    }
    if (data.delta?.type === "input_json_delta" && data.index != null) {
      const block = toolCallBlocks.get(data.index);
      if (block) block.partialJson += data.delta.partial_json || "";
    }
    if (data.message?.content) fallbackTextParts.push(extractContentText(data.message.content));
    if (data.message?.content) fallbackThinkingParts.push(extractThinkingText(data.message.content));
    if (data.message?.content) toolCalls.push(...extractToolCallsFromContent(data.message.content));
    if (data.type === "message_start" && data.message?.id) {
      anthropicMessage = {
        ...data.message,
        content: [],
        usage: data.message.usage ? { ...data.message.usage } : null,
      };
      messageId = data.message.id;
      if (data.message.role) role = data.message.role;
      if (data.message.model) model = data.message.model;
    }
    if (data.type === "message_delta") {
      anthropicMessage ||= {
        id: messageId,
        type: "message",
        role: role || "assistant",
        model,
        content: [],
        usage: null,
      };
      if (data.delta && typeof data.delta === "object") {
        if (data.delta.stop_reason !== undefined) anthropicMessage.stop_reason = data.delta.stop_reason;
        if (data.delta.stop_sequence !== undefined) anthropicMessage.stop_sequence = data.delta.stop_sequence;
      }
      if (data.usage && typeof data.usage === "object") {
        anthropicMessage.usage = { ...(anthropicMessage.usage || {}), ...data.usage };
      }
    }
    if (data.id && data.type === "message") messageId = data.id;
    if (data.delta?.stop_reason) finishReasons.push(data.delta.stop_reason);
    if (data.stop_reason) finishReasons.push(data.stop_reason);
    if (data.finish_reason) finishReasons.push(data.finish_reason);
    if (data.usage) usage = data.usage;
    if (data.message?.usage) usage = data.message.usage;
  }

  if (terminalResponse) {
    const completeResponse = completeResponsesTerminalResponse(terminalResponse, responsesOutputItems);
    const terminal = summarizeJsonResponse(completeResponse);
    const reconstructed = completeResponse !== terminalResponse;
    return {
      ...terminal,
      complete_response: redactOpaqueReasoningPayload(completeResponse),
      complete_response_source: reconstructed ? "stream_reconstruction" : "protocol_terminal_event",
      response_protocol: "openai_responses",
      text: terminal.text || textParts.filter(Boolean).join("") || fallbackTextParts.filter(Boolean).join("\n"),
      thinking: terminal.thinking || thinkingParts.filter(Boolean).join("") || fallbackThinkingParts.filter(Boolean).join("\n"),
      opaque_reasoning: terminal.opaque_reasoning?.length
        ? terminal.opaque_reasoning
        : [...opaqueReasoningBlocks.values()],
      tool_calls: terminal.tool_calls.length
        ? terminal.tool_calls
        : dedupeToolCalls(finalizeResponsesStreamToolCalls(responsesToolCallBlocks)),
      response_status: terminal.response_status || responseStatus,
      finish_reason: terminal.finish_reason || terminal.response_status || responseStatus || null,
      event_count: events.length,
    };
  }

  const reconstructedResponse =
    protocol === "anthropic_messages"
      ? reconstructAnthropicMessage({
          message: anthropicMessage,
          contentBlocks: anthropicContentBlocks,
          messageId,
          role,
          model,
          usage,
          finishReason: uniqueValues(finishReasons).join(", ") || null,
        })
      : protocol === "openai_chat_completions"
        ? reconstructChatCompletion({
            metadata: chatCompletionMetadata,
            choiceBlocks: openAiChoiceBlocks,
            model,
            usage,
          })
        : null;

  return {
    complete_response: reconstructedResponse,
    complete_response_source: reconstructedResponse ? "stream_reconstruction" : null,
    response_protocol: protocol,
    message_id: messageId,
    role,
    model,
    text: textParts.filter(Boolean).join("") || fallbackTextParts.filter(Boolean).join("\n"),
    thinking: thinkingParts.filter(Boolean).join("") || fallbackThinkingParts.filter(Boolean).join("\n"),
    opaque_reasoning: [...opaqueReasoningBlocks.values()],
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

function collectResponsesOutputItem(data, items) {
  if (!["response.output_item.added", "response.output_item.done"].includes(String(data?.type || ""))) return;
  if (!data?.item || typeof data.item !== "object") return;
  const key = data.output_index ?? data.item.id ?? items.size;
  const current = items.get(key);
  if (data.type === "response.output_item.done" || !current) {
    items.set(key, structuredCloneSafe(data.item));
  }
}

function completeResponsesTerminalResponse(terminalResponse, streamedItems) {
  if (!streamedItems.size) return terminalResponse;
  const terminalItems = Array.isArray(terminalResponse?.output) ? terminalResponse.output : [];
  if (terminalItems.length >= streamedItems.size) return terminalResponse;
  return {
    ...terminalResponse,
    output: [...streamedItems.entries()]
      .sort(compareOutputItemEntries)
      .map(([, item]) => item),
  };
}

function compareOutputItemEntries([left], [right]) {
  const leftIndex = Number(left);
  const rightIndex = Number(right);
  if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) return leftIndex - rightIndex;
  if (Number.isFinite(leftIndex)) return -1;
  if (Number.isFinite(rightIndex)) return 1;
  return String(left).localeCompare(String(right));
}

function emptyResponseSummary() {
  return {
    captured: false,
    message_id: null,
    preview: "",
    text: "",
    thinking: "",
    thinking_preview: "",
    opaque_reasoning: [],
    usage: null,
    finish_reason: null,
    response_status: null,
    response_protocol: null,
    complete_response_source: null,
    complete_response: null,
    latency_ms: null,
    status: null,
    stream: false,
    event_count: 0,
    truncated: false,
  };
}

function emptyParsedResponse() {
  return {
    complete_response: null,
    complete_response_source: null,
    response_protocol: null,
    message_id: null,
    role: null,
    model: null,
    text: "",
    thinking: "",
    opaque_reasoning: [],
    tool_calls: [],
    usage: null,
    finish_reason: null,
    response_status: null,
    event_count: 0,
  };
}

function redactOpaqueReasoningPayload(value) {
  if (Array.isArray(value)) return value.map(redactOpaqueReasoningPayload);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "encrypted_content" && typeof child === "string" && child) {
      output.encrypted_content_omitted = {
        reason: "opaque_encrypted_reasoning",
        chars: child.length,
        preview: OPAQUE_REASONING_PREVIEW,
      };
      continue;
    }
    output[key] = redactOpaqueReasoningPayload(child);
  }
  return output;
}

function collectChoiceResponse(choices, output) {
  for (const choice of choices) {
    if (choice?.message?.content) output.textParts.push(extractProviderText(choice.message.content));
    if (choice?.message?.content) output.thinkingParts.push(extractThinkingText(choice.message.content));
    if (choice?.message?.reasoning_content) output.thinkingParts.push(choice.message.reasoning_content);
    if (choice?.message?.content) output.toolCalls.push(...extractToolCallsFromContent(choice.message.content));
    if (Array.isArray(choice?.message?.tool_calls)) output.toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
    if (choice?.delta?.content) output.textParts.push(extractProviderText(choice.delta.content));
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
      else {
        const opaqueReasoning = opaqueReasoningMarker(item);
        if (opaqueReasoning) output.opaqueReasoning.push(opaqueReasoning);
      }
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
      output.textParts.push(extractProviderText(item.content));
      output.thinkingParts.push(extractThinkingText(item.content));
      output.toolCalls.push(...extractToolCallsFromContent(item.content));
    } else if (item.content && typeof item.content === "object") {
      output.thinkingParts.push(extractThinkingText(item.content));
      output.textParts.push(extractProviderText(item.content));
    } else if (item.content) {
      output.textParts.push(extractProviderText(item.content));
    }
    if (typeof item.output_text === "string") output.textParts.push(item.output_text);
  }
}

function collectResponsesReasoningEvent(data, blocks) {
  const type = String(data?.type || "");
  if (!["response.output_item.added", "response.output_item.done"].includes(type)) return;
  const marker = opaqueReasoningMarker(data?.item);
  if (!marker) return;
  const key = data.item?.id || (data.output_index != null ? `output:${data.output_index}` : `reasoning:${blocks.size}`);
  blocks.set(key, marker);
}

function opaqueReasoningMarker(item) {
  if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string" || !item.encrypted_content) {
    return null;
  }
  if (extractResponsesReasoningText(item)) return null;
  return {
    type: "reasoning",
    id: item.id || null,
    summary: [],
    encrypted_content_omitted: {
      reason: "opaque_encrypted_reasoning",
      chars: item.encrypted_content.length,
      preview: OPAQUE_REASONING_PREVIEW,
    },
  };
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
    mergeChatCompletionChoice(output.openAiChoiceBlocks, choice);
    if (choice?.delta?.role) output.setRole(choice.delta.role);
    if (choice?.delta?.content) output.textParts.push(extractProviderText(choice.delta.content));
    if (choice?.delta?.reasoning_content) output.thinkingParts.push(choice.delta.reasoning_content);
    if (choice?.message?.content) output.fallbackTextParts.push(extractProviderText(choice.message.content));
    if (choice?.message?.content) output.fallbackThinkingParts.push(extractThinkingText(choice.message.content));
    if (choice?.message?.reasoning_content) output.fallbackThinkingParts.push(choice.message.reasoning_content);
    if (choice?.message?.role) output.setRole(choice.message.role);
    if (choice?.message?.content) output.toolCalls.push(...extractToolCallsFromContent(choice.message.content));
    if (Array.isArray(choice?.message?.tool_calls)) output.toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
    if (Array.isArray(choice?.delta?.tool_calls)) mergeOpenAiStreamToolCalls(output.openAiToolCallBlocks, choice.delta.tool_calls);
    if (choice?.finish_reason) output.finishReasons.push(choice.finish_reason);
  }
}

function detectResponseProtocol(body) {
  if (Array.isArray(body?.output) || /^response\./.test(String(body?.object || ""))) {
    return "openai_responses";
  }
  if (Array.isArray(body?.choices)) return "openai_chat_completions";
  if (Array.isArray(body?.content) && (body?.type === "message" || body?.role === "assistant")) {
    return "anthropic_messages";
  }
  return "unknown";
}

function extractProviderText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (!content || typeof content !== "object") return "";
    if (["text", "output_text", "input_text"].includes(content.type) && typeof content.text === "string") {
      return content.text;
    }
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (["text", "output_text", "input_text"].includes(part.type) && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function createAnthropicContentBlock(contentBlock) {
  const block = structuredCloneSafe(contentBlock);
  if (block.type === "text") block.text = String(block.text || "");
  if (block.type === "thinking") {
    block.thinking = String(block.thinking || "");
    if (block.signature !== undefined) block.signature = String(block.signature || "");
  }
  if (block.type === "tool_use") {
    block.input = block.input && typeof block.input === "object" ? block.input : {};
    block.__partial_json = "";
  }
  return block;
}

function mergeAnthropicContentBlockDelta(blocks, index, delta) {
  if (!delta || typeof delta !== "object") return;
  const block = blocks.get(index) || createAnthropicContentBlock({ type: inferredAnthropicBlockType(delta) });
  if (delta.type === "text_delta") block.text = `${block.text || ""}${delta.text || ""}`;
  else if (delta.type === "thinking_delta") block.thinking = `${block.thinking || ""}${delta.thinking || ""}`;
  else if (delta.type === "signature_delta") block.signature = `${block.signature || ""}${delta.signature || ""}`;
  else if (delta.type === "input_json_delta") block.__partial_json = `${block.__partial_json || ""}${delta.partial_json || ""}`;
  blocks.set(index, block);
}

function inferredAnthropicBlockType(delta) {
  if (delta?.type === "thinking_delta" || delta?.type === "signature_delta") return "thinking";
  if (delta?.type === "input_json_delta") return "tool_use";
  return "text";
}

function reconstructAnthropicMessage({ message, contentBlocks, messageId, role, model, usage, finishReason }) {
  const content = [...contentBlocks.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, source]) => {
      const block = { ...source };
      if (block.type === "tool_use" && block.__partial_json) {
        block.input = parseMaybeJson(block.__partial_json);
      }
      delete block.__partial_json;
      return block;
    });
  if (!message && !content.length) return null;
  return {
    ...(message || {}),
    id: message?.id || messageId || null,
    type: message?.type || "message",
    role: message?.role || role || "assistant",
    model: message?.model || model || null,
    content,
    stop_reason: message?.stop_reason ?? finishReason ?? null,
    stop_sequence: message?.stop_sequence ?? null,
    usage: message?.usage || usage || null,
  };
}

function mergeChatCompletionMetadata(current, data) {
  const next = { ...(current || {}) };
  for (const key of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
    if (data[key] !== undefined) next[key] = data[key];
  }
  if (data.usage !== undefined) next.usage = data.usage;
  return next;
}

function mergeChatCompletionChoice(blocks, choice) {
  const index = choice?.index ?? 0;
  const current = blocks.get(index) || {
    index,
    role: null,
    content: "",
    reasoningContent: "",
    toolCalls: new Map(),
    finishReason: null,
    logprobs: undefined,
  };
  const message = choice?.message || {};
  const delta = choice?.delta || {};
  if (message.role || delta.role) current.role = message.role || delta.role;
  current.content += extractProviderText(message.content) || extractProviderText(delta.content);
  current.reasoningContent += String(message.reasoning_content || delta.reasoning_content || "");
  mergeNativeChatToolCalls(current.toolCalls, message.tool_calls);
  mergeNativeChatToolCalls(current.toolCalls, delta.tool_calls);
  if (choice?.finish_reason !== undefined && choice.finish_reason !== null) current.finishReason = choice.finish_reason;
  if (choice?.logprobs !== undefined) current.logprobs = choice.logprobs;
  blocks.set(index, current);
}

function mergeNativeChatToolCalls(blocks, chunks) {
  for (const chunk of chunks || []) {
    const index = chunk.index ?? blocks.size;
    const current = blocks.get(index) || {
      index,
      id: null,
      type: "function",
      function: { name: "", arguments: "" },
    };
    if (chunk.id) current.id = chunk.id;
    if (chunk.type) current.type = chunk.type;
    if (chunk.function?.name) current.function.name += chunk.function.name;
    if (chunk.function?.arguments) current.function.arguments += chunk.function.arguments;
    blocks.set(index, current);
  }
}

function reconstructChatCompletion({ metadata, choiceBlocks, model, usage }) {
  if (!choiceBlocks.size) return null;
  const object = metadata?.object === "chat.completion.chunk" ? "chat.completion" : metadata?.object || "chat.completion";
  return {
    ...(metadata || {}),
    object,
    model: metadata?.model || model || null,
    choices: [...choiceBlocks.values()]
      .sort((left, right) => left.index - right.index)
      .map((choice) => {
        const message = {
          role: choice.role || "assistant",
          content: choice.content || null,
        };
        if (choice.reasoningContent) message.reasoning_content = choice.reasoningContent;
        if (choice.toolCalls.size) {
          message.tool_calls = [...choice.toolCalls.values()]
            .sort((left, right) => left.index - right.index)
            .map(({ index: _index, ...toolCall }) => toolCall);
        }
        return {
          index: choice.index,
          message,
          finish_reason: choice.finishReason,
          ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
        };
      }),
    usage: metadata?.usage || usage || null,
  };
}

function structuredCloneSafe(value) {
  return value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
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
