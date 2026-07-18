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
  if (["function_call", "custom_tool_call", "local_shell_call", "computer_call"].includes(item.type)) {
    return {
      role: "assistant",
      source_type: item.type,
      content: [{
        type: "tool_use",
        id: item.call_id || item.id || null,
        name: item.name || item.function?.name || responsesToolName(item.type),
        input: parseMaybeJson(item.arguments ?? item.input ?? item.action ?? item.function?.arguments),
      }],
    };
  }
  if (["function_call_output", "custom_tool_call_output", "local_shell_call_output", "computer_call_output"].includes(item.type)) {
    return {
      role: "tool",
      source_type: item.type,
      codex_item_type: item.type,
      tool_call_id: item.call_id || item.id || null,
      name: item.name || null,
      content: item.output ?? item.content ?? "",
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

function responsesToolName(type) {
  if (type === "local_shell_call") return "local_shell";
  if (type === "computer_call") return "computer";
  return "unknown";
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
