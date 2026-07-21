export function extractRequestMessages(body = {}) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (!Array.isArray(body?.input)) return [];
  return body.input.map(responseInputItemToMessage).filter(Boolean);
}

export function extractRequestTools(body = {}) {
  const tools = [
    ...(Array.isArray(body?.tools) ? body.tools : []),
    ...(Array.isArray(body?.additional_tools) ? body.additional_tools : []),
  ];
  const seen = new Set();
  return tools.filter((tool) => {
    const key = tool?.name || tool?.function?.name || null;
    if (!key || !seen.has(key)) {
      if (key) seen.add(key);
      return true;
    }
    return false;
  });
}

export function responseInputItemToMessage(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agent_message") {
    return {
      role: "user",
      content: item.content ?? item.text ?? "",
      codex_item_type: "agent_message",
      author: item.author || null,
      recipient: item.recipient || null,
    };
  }
  if (item.role || item.type === "message") {
    return {
      ...item,
      role: item.role || "unknown",
      content: item.content ?? item.text ?? "",
    };
  }
  if (isResponsesToolCallItem(item)) {
    return {
      role: "assistant",
      source_type: item.type,
      content: [{
        type: "tool_use",
        id: item.call_id || item.id || null,
        name: item.name || item.function?.name || responsesToolProtocolName(item.type) || "unknown",
        input: parseMaybeJson(item.arguments ?? item.input ?? item.action ?? item.function?.arguments),
      }],
    };
  }
  if (isResponsesToolOutputItem(item)) {
    return {
      role: "tool",
      source_type: item.type,
      codex_item_type: item.type,
      tool_call_id: item.call_id || item.id || null,
      name: item.name || responsesToolProtocolName(item.type) || null,
      content: item.output ?? item.content ?? item.result ?? item.tools ?? "",
    };
  }
  if (item.type === "reasoning") {
    return {
      role: "assistant",
      source_type: item.type,
      content: [{ type: "reasoning", reasoning: responsesReasoningText(item) }],
    };
  }
  return null;
}

export function isResponsesToolCallItem(item) {
  const type = String(item?.type || "").toLowerCase();
  return Boolean(type && type.endsWith("_call") && !type.endsWith("_output"));
}

export function isResponsesToolOutputItem(item) {
  const type = String(item?.type || "").toLowerCase();
  return Boolean(type && (type.endsWith("_call_output") || type === "tool_search_output"));
}

export function responsesToolProtocolName(value) {
  const type = String(typeof value === "string" ? value : value?.type || "").toLowerCase();
  const base = type.replace(/_output$/, "").replace(/_call$/, "");
  if (!base || ["function", "custom_tool"].includes(base)) return null;
  return base;
}

function responsesReasoningText(item) {
  const parts = Array.isArray(item?.summary) ? item.summary : [];
  return parts.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
