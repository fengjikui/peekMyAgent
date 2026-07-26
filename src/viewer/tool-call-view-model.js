const COMMAND_PARAMETER_KEYS = new Set(["command", "cmd", "script", "code"]);

export function buildToolCallDetailView(calls) {
  return (Array.isArray(calls) ? calls : [])
    .map((call, index) => toolCallDetail(call, index))
    .filter(Boolean);
}

function toolCallDetail(call, index) {
  if (!call || typeof call !== "object") return null;
  const parameterSource = toolCallParameterSource(call);
  const parameters = parseMaybeJson(parameterSource.value);
  return {
    index,
    protocolType: String(call.type || (call.function ? "function" : "tool_call")),
    name: String(call.name || call.function?.name || call.tool_name || "unknown"),
    callId: call.call_id || call.id || call.tool_use_id || null,
    status: call.status || null,
    parameterSource: parameterSource.key,
    parameters,
    parameterEntries: parameterEntries(parameters),
  };
}

function toolCallParameterSource(call) {
  if (Object.hasOwn(call, "arguments")) return { key: "arguments", value: call.arguments };
  if (Object.hasOwn(call, "input")) return { key: "input", value: call.input };
  if (Object.hasOwn(call, "action")) return { key: "action", value: call.action };
  if (call.function && Object.hasOwn(call.function, "arguments")) {
    return { key: "function.arguments", value: call.function.arguments };
  }
  return { key: null, value: null };
}

function parameterEntries(parameters) {
  if (!isPlainObject(parameters)) return [];
  return Object.entries(parameters).map(([key, value]) => ({
    key,
    value,
    presentation: parameterPresentation(key, value),
  }));
}

function parameterPresentation(key, value) {
  if (COMMAND_PARAMETER_KEYS.has(String(key).toLowerCase()) && typeof value === "string") return "command";
  if (value && typeof value === "object") return "structured";
  if (typeof value === "string" && value.includes("\n")) return "multiline";
  return "scalar";
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
