import { commonMessagePrefixLength } from "./message-equivalence.mjs";
import { extractRequestMessages } from "./request-profile.mjs";

export function createContextDeltaState() {
  return { previousByContextKey: new Map() };
}

export function annotateRequestContextChanges(requests, semantics = {}, { state = createContextDeltaState() } = {}) {
  assertSemantics(semantics);
  const previousByContextKey = contextPreviousRequests(state);
  for (const request of requests || []) {
    const contextKey = requestContextChainKey(request);
    const previous = previousByContextKey.get(contextKey) || null;
    const currentToolMessages = semantics.isInternalRequest(request) ? [] : currentToolEventMessages(request, previous, semantics);
    const currentToolCalls = currentToolMessages ? semantics.extractToolCalls(currentToolMessages) : request.summary.tool_calls;
    request.summary.current_tool_calls = currentToolMessages
      ? removePreviouslyObservedResponseCalls(currentToolCalls, previous)
      : currentToolCalls || [];
    request.summary.current_tool_results = currentToolMessages
      ? semantics.extractToolResults(currentToolMessages).map((result) => ({ ...result, content: semantics.previewText(result.content, 800) }))
      : request.summary.tool_results;
    request.trace.context_chain_key = contextKey;
    request.trace.previous_context_request_index = previous?.request_index || null;
    annotateHistoryStackDelta(request, previous);
    request.changes = requestChanges(request, previous);
    request.context_delta = analyzeContextDelta(request, previous, contextKey, semantics);
    previousByContextKey.set(contextKey, request);
  }
  return requests;
}

function removePreviouslyObservedResponseCalls(calls, previous) {
  const observed = new Set((previous?.summary?.response?.tool_calls || []).map(toolEventKey).filter(Boolean));
  if (!observed.size) return calls || [];
  return (calls || []).filter((call) => !observed.has(toolEventKey(call)));
}

function toolEventKey(event) {
  const id = String(event?.id || event?.tool_call_id || event?.tool_use_id || "").trim();
  if (id) return `id:${id}`;
  const name = String(event?.name || "").trim();
  if (!name) return "";
  return `shape:${name}:${stableJson(event?.arguments ?? event?.input ?? null)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contextPreviousRequests(state) {
  if (!state || !(state.previousByContextKey instanceof Map)) {
    throw new TypeError("context delta state.previousByContextKey must be a Map");
  }
  return state.previousByContextKey;
}

export function requestContextChainKey(request) {
  const sessionKey = request.conversation_id || request.watch_id || request.trace?.claude_session_id_prefix || request.agent_profile || "session";
  const agentId = request.trace?.agent_instance_id || request.trace?.claude_agent_id || "";
  if (agentId) return `agent:${sessionKey}:${agentId}`;
  const actorType = request.trace?.actor_type || request.source_hint?.type || "main";
  if (actorType === "main") return `main:${sessionKey}`;
  const sideKey = request.trace?.debug_source || request.source_hint?.type || "side";
  return `${actorType}:${sessionKey}:${sideKey}`;
}

export function analyzeContextDelta(request, previous, contextKey, semantics) {
  const messages = requestMessages(request);
  const previousMessages = requestMessages(previous);
  const commonPrefixMessages = previous ? commonMessagePrefixLength(previousMessages, messages) : 0;
  const newMessages = messages.slice(commonPrefixMessages);
  const fixedContext = {
    system: previous ? (request.changes.system_changed ? "changed" : "reused") : "baseline",
    tools: previous ? (request.changes.tools_changed ? "changed" : "reused") : "baseline",
    params: previous ? (request.changes.params_changed ? "changed" : "reused") : "baseline",
  };
  return {
    baseline: !previous,
    comparison_key: contextKey || null,
    previous_request_index: previous?.request_index || null,
    previous_messages: previousMessages.length,
    total_messages: messages.length,
    reused_messages: commonPrefixMessages,
    reused_ratio: messages.length ? Number((commonPrefixMessages / messages.length).toFixed(3)) : 0,
    new_messages: newMessages.length,
    new_roles: countMessageRoles(newMessages, semantics),
    new_tool_calls: semantics.extractToolCalls(newMessages).length,
    new_tool_results: semantics.extractToolResults(newMessages).length,
    fixed_context: fixedContext,
    previews: newMessages.slice(0, 8).map(semantics.previewMessage),
  };
}

function requestChanges(request, previous) {
  return {
    system_changed: previous ? request.fingerprints.system !== previous.fingerprints.system : false,
    tools_changed: previous ? request.fingerprints.tools !== previous.fingerprints.tools : false,
    params_changed: previous ? request.fingerprints.params !== previous.fingerprints.params : false,
    messages_delta: previous ? request.counts.messages - previous.counts.messages : request.counts.messages,
    tools_delta: previous ? request.counts.tools - previous.counts.tools : request.counts.tools,
    raw_bytes_delta: previous ? request.counts.raw_body_bytes - previous.counts.raw_body_bytes : request.counts.raw_body_bytes,
  };
}

function annotateHistoryStackDelta(request, previous) {
  const stack = request.summary?.history_stack || [];
  const messages = requestMessages(request);
  const previousMessages = requestMessages(previous);
  const reusedCount = previous ? commonMessagePrefixLength(previousMessages, messages) : 0;
  for (const item of stack) {
    const index = Math.max(0, Number(item.index || 0) - 1);
    item.context_status = previous ? (index < reusedCount ? "reused" : "new") : "baseline";
  }
}

function countMessageRoles(messages, semantics) {
  const counts = {};
  for (const message of messages) {
    const role = message?.role || "unknown";
    const kind = semantics.classifyMessage(message);
    const key = kind === "message" ? role : kind;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function currentToolEventMessages(request, previous, semantics) {
  const messages = extractRequestMessages(request?.raw?.body || {});
  if (!messages.length) return null;
  const latestTurnMessages = messagesAfterLatestRealUserInput(messages, semantics);
  const previousMessages = extractRequestMessages(previous?.raw?.body || {});
  if (!previousMessages.length) return latestTurnMessages;
  const prefixLength = commonMessagePrefixLength(previousMessages, messages);
  const suffix = messages.slice(prefixLength);
  return suffix.length ? suffix : latestTurnMessages;
}

function messagesAfterLatestRealUserInput(messages, semantics) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (semantics.isRealUserMessage(messages[index])) return messages.slice(index + 1);
  }
  return messages;
}

function requestMessages(request) {
  return extractRequestMessages(request?.raw?.body || {});
}

function assertSemantics(semantics) {
  for (const name of ["extractToolCalls", "extractToolResults", "classifyMessage", "previewMessage", "previewText", "isInternalRequest", "isRealUserMessage"]) {
    if (typeof semantics[name] !== "function") throw new Error(`context delta semantics.${name} is required`);
  }
}
