import {
  extractRequestMessages,
  extractRequestTools,
  isResponsesToolCallItem,
  isResponsesToolOutputItem,
  responsesToolProtocolName,
} from "../shared/request-payload.mjs";

export const PROTOCOL_EXCHANGE_SCHEMA_VERSION = 1;

const PROTOCOL_LABELS = Object.freeze({
  openai_responses: "OpenAI Responses",
  openai_chat_completions: "OpenAI Chat Completions",
  anthropic_messages: "Anthropic Messages",
  gemini_generate_content: "Google GenerateContent",
  unknown: "Unknown protocol",
});

const ADAPTERS = Object.freeze({
  openai_responses: projectOpenAiResponsesExchange,
  openai_chat_completions: projectChatCompletionsExchange,
  anthropic_messages: projectAnthropicMessagesExchange,
  gemini_generate_content: projectGeminiExchange,
});

export function projectProtocolExchange({ protocol = "unknown", request = {}, response = null } = {}) {
  const normalizedProtocol = normalizeProtocol(protocol, request, response);
  const adapter = ADAPTERS[normalizedProtocol] || projectUnknownExchange;
  const projected = adapter(request || {}, response);
  return {
    schema_version: PROTOCOL_EXCHANGE_SCHEMA_VERSION,
    protocol: normalizedProtocol,
    protocol_label: PROTOCOL_LABELS[normalizedProtocol] || normalizedProtocol,
    request: projected.request,
    response: projected.response,
  };
}

export function compactProtocolExchange(exchange) {
  if (!exchange || typeof exchange !== "object") return null;
  return {
    schema_version: exchange.schema_version || PROTOCOL_EXCHANGE_SCHEMA_VERSION,
    protocol: exchange.protocol || "unknown",
    protocol_label: exchange.protocol_label || PROTOCOL_LABELS[exchange.protocol] || exchange.protocol || "Unknown protocol",
    request: {
      counts: compactProtocolCounts(exchange.request?.counts, [
        "instruction_blocks",
        "input_items",
        "tool_stages",
        "tools",
      ]),
    },
    response: {
      counts: compactProtocolCounts(exchange.response?.counts, ["output_items", "tool_calls"]),
      status: exchange.response?.status || null,
    },
  };
}

function compactProtocolCounts(counts, keys) {
  const output = {};
  for (const key of keys) {
    if (counts?.[key] != null) output[key] = Number(counts[key] || 0);
  }
  return output;
}

function projectOpenAiResponsesExchange(request, response) {
  const input = Array.isArray(request?.input) ? request.input : [];
  const instructions = [];
  appendTopLevelInstructions(instructions, request.instructions, "$.instructions", "instructions");
  appendTopLevelInstructions(instructions, request.system, "$.system", "system");

  const toolStages = [];
  const effectiveTools = new Map();
  appendToolStage(toolStages, effectiveTools, request.tools, {
    kind: "declared",
    sourcePath: "$.tools",
    inputIndex: null,
  });
  appendToolStage(toolStages, effectiveTools, request.additional_tools, {
    kind: "added",
    sourcePath: "$.additional_tools",
    inputIndex: null,
  });

  const inputItems = input.map((item, index) => {
    const summary = summarizeResponsesItem(item, index, "$.input");
    if (summary.semantic === "instruction") {
      instructions.push(instructionSummary(item, summary.source_path, summary.role));
    }
    if (item?.type === "additional_tools") {
      appendToolStage(toolStages, effectiveTools, item.tools, {
        kind: "added",
        sourcePath: `${summary.source_path}.tools`,
        inputIndex: index,
      });
    }
    if (item?.type === "tool_search_output") {
      appendToolStage(toolStages, effectiveTools, item.tools, {
        kind: "loaded",
        sourcePath: `${summary.source_path}.tools`,
        inputIndex: index,
      });
    }
    return summary;
  });

  const responseItems = Array.isArray(response?.output)
    ? response.output.map((item, index) => summarizeResponsesItem(item, index, "$.output", { downstream: true }))
    : [];
  return exchangeProjection({
    requestInstructions: instructions,
    requestItems: inputItems,
    requestToolStages: toolStages,
    requestTools: extractRequestTools(request),
    responseItems,
    response,
  });
}

function projectAnthropicMessagesExchange(request, response) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const instructions = [];
  appendTopLevelInstructions(instructions, request.system, "$.system", "system");
  const effectiveTools = new Map();
  const toolStages = [];
  appendToolStage(toolStages, effectiveTools, request.tools, {
    kind: "declared",
    sourcePath: "$.tools",
    inputIndex: null,
  });
  const inputItems = flattenAnthropicMessages(messages);
  const responseItems = Array.isArray(response?.content)
    ? response.content.map((item, index) => summarizeContentBlock(item, index, "$.content", "assistant"))
    : [];
  return exchangeProjection({
    requestInstructions: instructions,
    requestItems: inputItems,
    requestToolStages: toolStages,
    requestTools: extractRequestTools(request),
    responseItems,
    response,
  });
}

function projectChatCompletionsExchange(request, response) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const instructions = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => ["system", "developer"].includes(normalizedRole(message?.role)))
    .map(({ message, index }) => instructionSummary(message, `$.messages[${index}]`, normalizedRole(message.role)));
  const effectiveTools = new Map();
  const toolStages = [];
  appendToolStage(toolStages, effectiveTools, request.tools, {
    kind: "declared",
    sourcePath: "$.tools",
    inputIndex: null,
  });
  const inputItems = messages.map((message, index) => summarizeMessage(message, index, "$.messages"));
  const responseItems = flattenChatCompletionChoices(response?.choices);
  return exchangeProjection({
    requestInstructions: instructions,
    requestItems: inputItems,
    requestToolStages: toolStages,
    requestTools: extractRequestTools(request),
    responseItems,
    response,
  });
}

function projectGeminiExchange(request, response) {
  const contents = Array.isArray(request?.contents) ? request.contents : [];
  const instructions = [];
  appendTopLevelInstructions(instructions, request.systemInstruction, "$.systemInstruction", "system");
  appendTopLevelInstructions(instructions, request.system_instruction, "$.system_instruction", "system");
  const effectiveTools = new Map();
  const toolStages = [];
  appendToolStage(toolStages, effectiveTools, request.tools, {
    kind: "declared",
    sourcePath: "$.tools",
    inputIndex: null,
  });
  const inputItems = flattenGeminiContents(contents, "$.contents");
  const responseItems = [];
  for (const [candidateIndex, candidate] of (Array.isArray(response?.candidates) ? response.candidates : []).entries()) {
    responseItems.push(
      ...flattenGeminiContents(
        [candidate?.content || candidate],
        `$.candidates[${candidateIndex}].content`,
        { downstream: true, omitContentIndex: true },
      ),
    );
  }
  return exchangeProjection({
    requestInstructions: instructions,
    requestItems: inputItems,
    requestToolStages: toolStages,
    requestTools: Array.isArray(request?.tools) ? request.tools : [],
    responseItems,
    response,
  });
}

function projectUnknownExchange(request, response) {
  const messages = extractRequestMessages(request);
  const instructions = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => ["system", "developer"].includes(normalizedRole(message?.role)))
    .map(({ message, index }) => instructionSummary(message, `$.messages[${index}]`, normalizedRole(message.role)));
  const items = messages.map((message, index) => summarizeMessage(message, index, "$.messages"));
  return exchangeProjection({
    requestInstructions: instructions,
    requestItems: items,
    requestToolStages: [],
    requestTools: extractRequestTools(request),
    responseItems: [],
    response,
  });
}

function exchangeProjection({
  requestInstructions,
  requestItems,
  requestToolStages,
  requestTools,
  responseItems,
  response,
}) {
  return {
    request: {
      instruction_blocks: requestInstructions.filter((item) => item.chars || item.item_type),
      input_items: requestItems,
      tool_stages: requestToolStages,
      counts: countRequestProjection(requestInstructions, requestItems, requestToolStages, requestTools),
    },
    response: {
      output_items: responseItems,
      counts: countResponseProjection(responseItems),
      status: responseStatus(response),
    },
  };
}

function flattenAnthropicMessages(messages) {
  const output = [];
  for (const [messageIndex, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const role = normalizedRole(message?.role) || "unknown";
    if (!Array.isArray(message?.content)) {
      output.push({
        ...summarizeMessage(message, messageIndex, "$.messages"),
        index: output.length,
      });
      continue;
    }
    for (const [contentIndex, block] of message.content.entries()) {
      output.push({
        ...summarizeContentBlock(block, contentIndex, `$.messages[${messageIndex}].content`, role),
        index: output.length,
      });
    }
  }
  return output;
}

function flattenChatCompletionChoices(choices) {
  const output = [];
  for (const [choiceIndex, choice] of (Array.isArray(choices) ? choices : []).entries()) {
    const message = choice?.message || choice?.delta;
    if (!message) continue;
    const messagePath = `$.choices[${choiceIndex}].${choice?.message ? "message" : "delta"}`;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const legacyFunctionCall = message.function_call && typeof message.function_call === "object"
      ? [message.function_call]
      : [];
    if (itemTextChars(message) || (!toolCalls.length && !legacyFunctionCall.length)) {
      output.push({
        ...summarizeMessage(message, choiceIndex, "$.choices", { downstream: true }),
        index: output.length,
        source_path: messagePath,
        finish_reason: choice.finish_reason || null,
      });
    }
    for (const [toolIndex, call] of toolCalls.entries()) {
      output.push(summarizeChatToolCall(call, {
        index: output.length,
        sourcePath: `${messagePath}.tool_calls[${toolIndex}]`,
        finishReason: choice.finish_reason,
      }));
    }
    for (const [toolIndex, call] of legacyFunctionCall.entries()) {
      output.push(summarizeChatToolCall({ type: "function", function: call }, {
        index: output.length,
        sourcePath: `${messagePath}.function_call${toolIndex ? `[${toolIndex}]` : ""}`,
        finishReason: choice.finish_reason,
      }));
    }
  }
  return output;
}

function summarizeChatToolCall(call, { index, sourcePath, finishReason }) {
  const name = call?.function?.name || call?.name || "unknown";
  return {
    index,
    source_path: sourcePath,
    item_type: normalizedType(call?.type) || "function",
    role: "assistant",
    semantic: "tool_call",
    chars: itemTextChars(call?.function?.arguments ?? call?.arguments),
    call_id: call?.id || null,
    name,
    tool_count: 1,
    tool_names: [name],
    finish_reason: finishReason || null,
  };
}

function flattenGeminiContents(contents, rootPath, { downstream = false, omitContentIndex = false } = {}) {
  const output = [];
  for (const [contentIndex, content] of (Array.isArray(contents) ? contents : []).entries()) {
    const contentPath = omitContentIndex ? rootPath : `${rootPath}[${contentIndex}]`;
    const role = normalizeGeminiRole(content?.role, { downstream });
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    if (!parts.length) {
      output.push(summarizeGeminiPart(content, {
        index: output.length,
        sourcePath: contentPath,
        role,
        downstream,
      }));
      continue;
    }
    for (const [partIndex, part] of parts.entries()) {
      output.push(summarizeGeminiPart(part, {
        index: output.length,
        sourcePath: `${contentPath}.parts[${partIndex}]`,
        role,
        downstream,
      }));
    }
  }
  return output;
}

function summarizeGeminiPart(part, { index, sourcePath, role, downstream }) {
  const functionCall = part?.functionCall || part?.function_call || part?.toolCall || part?.tool_call || null;
  const functionResponse = part?.functionResponse || part?.function_response || part?.toolResponse || part?.tool_response || null;
  const codeResult = part?.codeExecutionResult || part?.code_execution_result || null;
  let semantic = downstream ? "response_item" : "input_item";
  let itemType = "part";
  let callId = null;
  let name = null;
  if (functionCall) {
    semantic = "tool_call";
    itemType = part?.functionCall || part?.function_call ? "function_call" : "tool_call";
    callId = functionCall.id || null;
    name = functionCall.name || null;
  } else if (functionResponse || codeResult) {
    semantic = "tool_result";
    itemType = functionResponse ? "function_response" : "code_execution_result";
    callId = functionResponse?.id || null;
    name = functionResponse?.name || (codeResult ? "code_execution" : null);
  } else if (part?.thought === true || part?.thoughtSignature || part?.thought_signature) {
    semantic = "reasoning";
    itemType = "thought";
  } else if (role === "assistant") {
    semantic = "assistant_message";
    itemType = "text" in (part || {}) ? "text" : "part";
  } else if (role === "user") {
    semantic = "user_message";
    itemType = "text" in (part || {}) ? "text" : "part";
  }
  return {
    index,
    source_path: sourcePath,
    item_type: itemType,
    role,
    semantic,
    chars: itemTextChars(part),
    call_id: callId,
    name,
    tool_count: semantic === "tool_call" ? 1 : 0,
    tool_names: semantic === "tool_call" ? [name || "unknown"] : [],
  };
}

function summarizeResponsesItem(item, index, rootPath, { downstream = false } = {}) {
  const type = normalizedType(item?.type) || (item?.role ? "message" : "unknown");
  const role = normalizedRole(item?.role) || inferredResponsesRole(item);
  const sourcePath = `${rootPath}[${index}]`;
  const toolList = item?.type === "additional_tools" || item?.type === "tool_search_output"
    ? collectToolCatalog(item.tools, { sourcePath: `${sourcePath}.tools` }).tools
    : [];
  const semantic = responsesItemSemantic(item, role, { downstream });
  return {
    index,
    source_path: sourcePath,
    item_type: type,
    role,
    semantic,
    chars: itemTextChars(item),
    call_id: item?.call_id || item?.id || null,
    name: item?.name || item?.function?.name || (semantic.startsWith("tool_") ? responsesToolProtocolName(type) : null),
    tool_count: toolList.length,
    tool_names: toolList.map((tool) => tool.qualified_name),
  };
}

function summarizeMessage(message, index, rootPath, { downstream = false } = {}) {
  const role = normalizedRole(message?.role) || (downstream ? "assistant" : "unknown");
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    index,
    source_path: `${rootPath}[${index}]`,
    item_type: normalizedType(message?.type) || "message",
    role,
    semantic: ["system", "developer"].includes(role)
      ? "instruction"
      : role === "tool"
        ? "tool_result"
        : role === "assistant"
          ? "assistant_message"
          : role === "user"
            ? "user_message"
            : "message",
    chars: itemTextChars(message),
    call_id: message?.tool_call_id || null,
    name: message?.name || null,
    tool_count: toolCalls.length,
    tool_names: toolCalls.map((call) => call?.function?.name || call?.name || "unknown"),
  };
}

function summarizeContentBlock(item, index, rootPath, role) {
  const type = normalizedType(item?.type) || "content";
  const semantic = type === "tool_use"
    ? "tool_call"
    : type === "tool_result"
      ? "tool_result"
      : ["thinking", "reasoning"].includes(type)
        ? "reasoning"
        : role === "assistant"
          ? "assistant_message"
          : role === "user"
            ? "user_message"
            : "message";
  return {
    index,
    source_path: `${rootPath}[${index}]`,
    item_type: type,
    role,
    semantic,
    chars: itemTextChars(item),
    call_id: item?.id || item?.tool_use_id || null,
    name: item?.name || null,
    tool_count: type === "tool_use" ? 1 : 0,
    tool_names: type === "tool_use" ? [item?.name || "unknown"] : [],
  };
}

function responsesItemSemantic(item, role, { downstream }) {
  const type = normalizedType(item?.type);
  if (type === "additional_tools") return "tools_added";
  if (type === "tool_search_output") return "tools_loaded";
  if (isResponsesToolOutputItem(item)) return "tool_result";
  if (isResponsesToolCallItem(item)) return type === "tool_search_call" ? "tool_search" : "tool_call";
  if (type === "reasoning") return "reasoning";
  if (["system", "developer"].includes(role)) return "instruction";
  if (role === "assistant") return "assistant_message";
  if (role === "tool") return "tool_result";
  if (role === "user") return "user_message";
  return downstream ? "response_item" : "input_item";
}

function appendTopLevelInstructions(output, value, sourcePath, role) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => output.push(instructionSummary(item, `${sourcePath}[${index}]`, role)));
    return;
  }
  output.push(instructionSummary(value, sourcePath, role));
}

function instructionSummary(value, sourcePath, role) {
  return {
    source_path: sourcePath,
    role: normalizedRole(role) || "instructions",
    item_type: normalizedType(value?.type) || (typeof value === "string" ? "text" : "message"),
    chars: itemTextChars(value),
  };
}

function appendToolStage(stages, effectiveTools, tools, { kind, sourcePath, inputIndex }) {
  if (!Array.isArray(tools) || !tools.length) return;
  const catalog = collectToolCatalog(tools, { sourcePath });
  const flattened = catalog.tools;
  for (const tool of flattened) effectiveTools.set(toolIdentity(tool), tool);
  stages.push({
    kind,
    source_path: sourcePath,
    input_index: inputIndex,
    tool_count: flattened.length,
    effective_tool_count: effectiveTools.size,
    namespace_count: catalog.namespaces.length,
    namespaces: catalog.namespaces,
    tools: flattened,
  });
}

function collectToolCatalog(tools, {
  sourcePath = "$",
  namespacePath = [],
  inheritedDeferred = false,
} = {}) {
  const catalog = { tools: [], namespaces: [] };
  for (const [toolIndex, tool] of (Array.isArray(tools) ? tools : []).entries()) {
    if (!tool || typeof tool !== "object") continue;
    const toolPath = `${sourcePath}[${toolIndex}]`;
    let expanded = false;
    const functionDeclarations = Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool.function_declarations)
        ? tool.function_declarations
        : [];
    if (functionDeclarations.length) {
      for (const [declarationIndex, declaration] of functionDeclarations.entries()) {
        if (!declaration || typeof declaration !== "object") continue;
        catalog.tools.push(toolCatalogLeaf(declaration, {
          type: "function",
          sourcePath: `${toolPath}.${Array.isArray(tool.functionDeclarations) ? "functionDeclarations" : "function_declarations"}[${declarationIndex}]`,
          namespacePath,
          deferred: inheritedDeferred,
        }));
      }
      expanded = true;
    }
    for (const key of ["googleSearch", "google_search", "codeExecution", "code_execution", "computerUse", "computer_use", "urlContext", "url_context"]) {
      if (tool[key] == null) continue;
      catalog.tools.push(toolCatalogLeaf({ name: key }, {
        type: "built_in",
        sourcePath: `${toolPath}.${key}`,
        namespacePath,
        deferred: inheritedDeferred,
      }));
      expanded = true;
    }
    if (expanded) continue;
    const type = normalizedType(tool.type) || (tool.function ? "function" : "tool");
    const name = String(tool.name || tool.function?.name || tool.server_label || type || "unknown");
    if (type === "namespace" && Array.isArray(tool.tools)) {
      const nestedNamespacePath = [...namespacePath, name];
      const nestedCatalog = collectToolCatalog(tool.tools, {
        sourcePath: `${toolPath}.tools`,
        namespacePath: nestedNamespacePath,
        inheritedDeferred: inheritedDeferred || Boolean(tool.defer_loading),
      });
      catalog.namespaces.push({
        name,
        qualified_name: nestedNamespacePath.join("."),
        namespace: namespacePath.join(".") || null,
        namespace_path: nestedNamespacePath,
        source_path: toolPath,
        description_chars: itemTextChars(tool.description),
        tool_count: nestedCatalog.tools.length,
      });
      catalog.namespaces.push(...nestedCatalog.namespaces);
      catalog.tools.push(...nestedCatalog.tools);
      continue;
    }
    catalog.tools.push(toolCatalogLeaf(tool, {
      name,
      type,
      sourcePath: toolPath,
      namespacePath,
      deferred: inheritedDeferred || Boolean(tool.defer_loading),
    }));
  }
  return catalog;
}

function toolCatalogLeaf(tool, {
  name = null,
  type = null,
  sourcePath,
  namespacePath,
  deferred,
}) {
  const leafName = String(name || tool?.name || tool?.function?.name || "unknown");
  const namespace = namespacePath.join(".") || null;
  return {
    name: leafName,
    qualified_name: namespace ? `${namespace}.${leafName}` : leafName,
    type: type || normalizedType(tool?.type) || (tool?.function ? "function" : "tool"),
    namespace,
    namespace_path: [...namespacePath],
    source_path: sourcePath,
    deferred: Boolean(deferred),
  };
}

function countRequestProjection(instructions, items, toolStages, requestTools) {
  return {
    instruction_blocks: instructions.length,
    input_items: items.length,
    developer_items: items.filter((item) => item.role === "developer" && item.semantic === "instruction").length,
    user_items: items.filter((item) => item.role === "user").length,
    assistant_items: items.filter((item) => item.role === "assistant").length,
    tool_result_items: items.filter((item) => item.semantic === "tool_result").length,
    tool_stages: toolStages.length,
    tools: uniqueToolCount(requestTools, toolStages),
  };
}

function countResponseProjection(items) {
  return {
    output_items: items.length,
    messages: items.filter((item) => item.semantic === "assistant_message").length,
    reasoning_items: items.filter((item) => item.semantic === "reasoning").length,
    tool_calls: items.filter((item) => ["tool_call", "tool_search"].includes(item.semantic)).length,
    tool_results: items.filter((item) => item.semantic === "tool_result").length,
  };
}

function uniqueToolCount(requestTools, stages) {
  const seen = new Set();
  for (const tool of collectToolCatalog(requestTools).tools) seen.add(toolIdentity(tool));
  for (const stage of stages) for (const tool of stage.tools || []) seen.add(toolIdentity(tool));
  return seen.size;
}

function toolIdentity(tool) {
  return tool?.qualified_name || `${tool?.namespace || ""}:${tool?.name || tool?.type || "unknown"}`;
}

function inferredResponsesRole(item) {
  if (isResponsesToolCallItem(item) || normalizedType(item?.type) === "reasoning") return "assistant";
  if (isResponsesToolOutputItem(item)) return "tool";
  return "unknown";
}

function itemTextChars(value) {
  if (value == null) return 0;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + itemTextChars(item), 0);
  if (typeof value !== "object") return 0;
  let total = 0;
  for (const key of ["text", "thinking", "reasoning", "output", "content", "summary", "parts"]) {
    if (value[key] !== undefined) total += itemTextChars(value[key]);
  }
  return total;
}

function responseStatus(response) {
  return response?.status ||
    response?.stop_reason ||
    response?.choices?.[0]?.finish_reason ||
    response?.candidates?.[0]?.finishReason ||
    response?.candidates?.[0]?.finish_reason ||
    response?.promptFeedback?.blockReason ||
    response?.prompt_feedback?.block_reason ||
    null;
}

function normalizeGeminiRole(value, { downstream = false } = {}) {
  const role = normalizedRole(value);
  if (role === "model") return "assistant";
  if (role === "function") return "tool";
  return role || (downstream ? "assistant" : "unknown");
}

function normalizeProtocol(protocol, request, response) {
  const value = String(protocol || "").trim().toLowerCase();
  if (ADAPTERS[value]) return value;
  if (Array.isArray(request?.input) || Array.isArray(response?.output)) return "openai_responses";
  if (Array.isArray(request?.contents) || Array.isArray(response?.candidates)) return "gemini_generate_content";
  if (Array.isArray(request?.messages) && (request?.system != null || response?.type === "message")) return "anthropic_messages";
  if (Array.isArray(request?.messages) || Array.isArray(response?.choices)) return "openai_chat_completions";
  return "unknown";
}

function normalizedRole(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedType(value) {
  return String(value || "").trim().toLowerCase();
}
