export function extractContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "thinking" || part?.type === "reasoning") return "";
        if (part?.type === "text") return part.text || "";
        if (part?.text) return part.text;
        if (part?.content) return extractContentText(part.content);
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content.type === "thinking" || content.type === "reasoning") return "";
  if (content.text) return content.text;
  if (content.content) return extractContentText(content.content);
  return JSON.stringify(content);
}

export function extractThinkingText(content) {
  if (content == null || typeof content === "string") return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if (part.type === "thinking") return part.thinking || part.text || "";
        if (part.type === "reasoning") return part.reasoning || part.text || "";
        if (part.thinking) return part.thinking;
        if (part.reasoning) return part.reasoning;
        if (part.content) return extractThinkingText(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (content.type === "thinking") return content.thinking || content.text || "";
    if (content.type === "reasoning") return content.reasoning || content.text || "";
    if (content.thinking) return content.thinking;
    if (content.reasoning) return content.reasoning;
    if (content.content) return extractThinkingText(content.content);
  }
  return "";
}

export function extractToolCalls(messages) {
  const calls = [];
  for (const message of messages || []) {
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        calls.push({
          name: call.function?.name || call.name || "unknown",
          id: call.id || null,
          arguments: parseMaybeJson(call.function?.arguments || call.arguments),
        });
      }
    }
    const parts = Array.isArray(message?.content) ? message.content : [];
    calls.push(...extractToolCallsFromContent(parts));
  }
  return calls;
}

export function extractToolCallsFromContent(content) {
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  return parts.map(toolCallFromPart).filter(Boolean);
}

export function extractToolResults(messages) {
  const results = [];
  for (const message of messages || []) {
    if (message?.role === "tool") {
      results.push({ id: message.tool_call_id || null, content: extractContentText(message.content) });
    }
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const part of parts) {
      if (part?.type === "tool_result") {
        results.push({ id: part.tool_use_id || null, content: extractContentText(part.content) });
      }
    }
  }
  return results;
}

export function toolCallFromPart(part) {
  if (!part || typeof part !== "object" || part.type !== "tool_use") return null;
  return { name: part.name || "unknown", id: part.id || null, arguments: part.input ?? null };
}

export function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
