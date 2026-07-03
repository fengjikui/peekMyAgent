import { redactText, safeJsonShape } from "./redaction.mjs";

export const SCHEMA_VERSION = "0.1";

export function normalizeMessage(message, index, sourcePath = "body.messages") {
  const role = typeof message?.role === "string" ? message.role : "unknown";
  const content = extractContent(message?.content);
  const { value: contentText, redactions } = redactText(content.text, `${sourcePath}.${index}.content`);
  return {
    id: message?.id || `${sourcePath}.${index}`,
    role,
    content_type: content.type,
    content_text: contentText,
    content_json_shape: safeJsonShape(message?.content),
    tool_calls: extractToolCalls(message),
    redaction_state: redactions.length ? "redacted" : "none",
    redactions,
    source_path: `${sourcePath}.${index}`,
  };
}

export function extractContent(content) {
  if (typeof content === "string") return { type: "text", text: content };
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.text) return part.text;
      if (part?.content && typeof part.content === "string") return part.content;
      return `[${part?.type || "object"}]`;
    });
    return { type: "array", text: parts.join("\n") };
  }
  if (content == null) return { type: "empty", text: "" };
  if (typeof content === "object" && typeof content.text === "string") return { type: content.type || "object_text", text: content.text };
  return { type: "json", text: JSON.stringify(safeJsonShape(content)) };
}

export function extractToolCalls(message) {
  if (Array.isArray(message?.tool_calls)) return message.tool_calls.map((tool) => safeJsonShape(tool));
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "tool_use" || part?.type === "tool_result")
    .map((part) => safeJsonShape(part));
}

export function requestParams(body, omit = []) {
  const omitted = new Set(["messages", "input", "tools", "system", "instructions", ...omit]);
  const params = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!omitted.has(key)) params[key] = safeJsonShape(value);
  }
  return params;
}

export function collectMessageRedactions(...messageGroups) {
  return messageGroups.flat().flatMap((message) => message.redactions || []);
}

export function baseNormalizedRequest({
  captureId,
  watchId,
  capturedAt,
  requestIndex,
  agentProfile,
  workspace,
  conversationId,
  sourceAgent,
  adapterName,
  captureMethod,
  captureConfidence,
  isFinalRemoteRequest,
  providerProtocol,
  endpoint,
  method,
  model,
  messages,
  system,
  tools,
  requestParams: params,
  redactions,
  source,
  rawBodyShape,
}) {
  return {
    schema_version: SCHEMA_VERSION,
    capture_id: captureId || source?.capture_id || null,
    watch_id: watchId || source?.watch_id || null,
    captured_at: capturedAt || source?.received_at || null,
    request_index: Number.isInteger(requestIndex) ? requestIndex : source?.request_index || null,
    agent_profile: agentProfile || source?.agent_profile || null,
    workspace: workspace || source?.workspace || null,
    conversation_id: conversationId || source?.conversation_id || null,
    source_agent: sourceAgent,
    adapter_name: adapterName,
    capture_method: captureMethod,
    capture_confidence: captureConfidence,
    is_final_remote_request: Boolean(isFinalRemoteRequest),
    provider_protocol: providerProtocol,
    endpoint,
    method,
    model: model || "unknown",
    system: system || [],
    messages,
    tools: Array.isArray(tools) ? tools.map((tool) => safeJsonShape(tool)) : [],
    request_params: params || {},
    redactions: redactions || [],
    source,
    raw_body_shape: rawBodyShape,
  };
}
