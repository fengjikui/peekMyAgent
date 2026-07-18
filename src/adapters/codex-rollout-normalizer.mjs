import { codexRolloutProvenance } from "../core/provenance.mjs";

const OPAQUE_REASONING_PREVIEW = "<encrypted reasoning retained only in the original Codex rollout>";

export function normalizeCodexRolloutTask({ source = {}, sessionMeta = {}, turn = {}, requestIndex = 1 } = {}) {
  const exchanges = segmentCodexRolloutTask(turn);
  return exchanges.map((exchange, offset) =>
    normalizeCodexRolloutTurn({ source, sessionMeta, turn, exchange, requestIndex: requestIndex + offset }),
  );
}

export function normalizeCodexRolloutTurn({ source = {}, sessionMeta = {}, turn = {}, exchange = null, requestIndex = 1 } = {}) {
  const threadId = String(source.conversation_id || sessionMeta.id || sessionMeta.session_id || "").trim();
  const turnId = String(turn.turnId || turn.turnContext?.turn_id || `turn-${requestIndex}`).trim();
  const roundIndex = positiveRoundIndex(exchange?.roundIndex);
  const exchangeId = `${turnId}-exchange-${roundIndex}`;
  const entries = exchange?.entries || turn.entries || [];
  const responseItems = entries.filter((entry) => entry?.type === "response_item").map((entry) => entry.payload).filter(Boolean);
  const requestInput = (exchange?.requestItems || responseItems.filter(isUpstreamResponseItem)).map(cloneWithoutOpaqueReasoning);
  const responseOutput = exchange?.responseItems
    ? downstreamItemsFromEntries(entries, exchange.responseItems)
    : downstreamItemsFromEntries(entries);
  const messages = requestInput.map(responseItemToMessage).filter(Boolean);
  const system = normalizeBaseInstructions(sessionMeta.base_instructions);
  const tools = normalizeDynamicTools(sessionMeta.dynamic_tools);
  const tokenInfo = exchange?.tokenInfo || latestTokenInfo(entries);
  const status = exchangeStatus(turn, exchange);
  const finishReason = exchangeFinishReason({ turn, exchange, responseOutput });
  const body = {
    model: turn.turnContext?.model || source.model || null,
    stream: true,
    input: requestInput,
    system,
    tools,
    messages,
    reasoning: normalizeReasoningConfig(turn.turnContext),
    codex: {
      evidence_mode: "local_rollout",
      fidelity: "semantic_reconstruction",
      exact_wire_request: false,
      thread_id: threadId || null,
      turn_id: turnId,
      exchange_id: exchangeId,
      exchange_index: roundIndex,
      input_scope: "observed_upstream_delta",
      full_request_history_available: false,
      turn_context: turn.turnContext || null,
      tool_schema_scope: tools.length ? "dynamic_tools_only" : "not_present_in_rollout",
      lifecycle: exchangeLifecycle(turn, exchange),
      event_types: eventTypeCounts(entries),
      rollout_events: entries.map(cloneWithoutOpaqueReasoning),
    },
  };
  const responseBody = {
    id: exchangeId,
    object: "response",
    status,
    model: body.model,
    output: responseOutput,
    usage: tokenInfo?.last_token_usage || null,
    finish_reason: finishReason,
    codex: {
      evidence_mode: "local_rollout",
      thread_id: threadId || null,
      turn_id: turnId,
      exchange_id: exchangeId,
      context_window: tokenInfo?.model_context_window || turn.startedEvent?.model_context_window || null,
      total_token_usage: tokenInfo?.total_token_usage || null,
    },
  };
  const receivedAt = exchange?.startedAt || turn.startedAt || firstTimestamp(entries) || source.created_at || new Date(0).toISOString();
  const responseReceivedAt = exchange?.completedAt || lastTimestamp(entries) || receivedAt;
  const captureId = `codex-${threadId || "thread"}-${exchangeId}`;
  const responsePresent = responseOutput.length > 0 || Boolean(exchange?.complete || turn.completedEvent);

  return {
    capture_id: captureId,
    request_index: requestIndex,
    watch_id: `codex-${threadId || "thread"}`,
    conversation_id: threadId || null,
    agent_profile: "Codex",
    workspace: turn.turnContext?.cwd || source.workspace || sessionMeta.cwd || null,
    received_at: receivedAt,
    method: "POST",
    path: "/v1/responses",
    headers: {
      "content-type": "application/json",
      "x-peekmyagent-evidence": "codex_rollout_local",
      ...(threadId ? { "x-codex-thread-id": threadId } : {}),
      ...(turnId ? { "x-codex-turn-id": turnId } : {}),
    },
    body_source: "reconstructed",
    body,
    raw_body_length: byteLength(body),
    provenance: codexRolloutProvenance({ threadId, turnId: exchangeId, hasResponse: responsePresent }),
    ...(responsePresent
      ? {
          upstream_status: turn.aborted ? 499 : 200,
          response: {
            status: turn.aborted ? 499 : 200,
            headers: { "content-type": "application/json" },
            body_json: responseBody,
            raw_body_length: byteLength(responseBody),
            captured_body_length: byteLength(responseBody),
            received_at: responseReceivedAt,
            duration_ms: finiteNumber(exchange?.durationMs),
          },
        }
      : {}),
  };
}

export function segmentCodexRolloutTask(turn = {}) {
  const entries = Array.isArray(turn.entries) ? turn.entries : [];
  const exchanges = [];
  let pendingItems = [];
  let pendingEntries = [];
  let current = null;
  let lastCompleted = null;

  const startExchange = (timestamp = null) => {
    if (current) return current;
    current = {
      roundIndex: exchanges.length + 1,
      requestItems: pendingItems,
      responseItems: [],
      entries: pendingEntries,
      tokenInfo: null,
      startedAt: firstTimestamp(pendingEntries) || timestamp || turn.startedAt || null,
      completedAt: null,
      complete: false,
      finalInTask: false,
      aborted: false,
    };
    pendingItems = [];
    pendingEntries = [];
    return current;
  };

  const completeExchange = ({ timestamp = null, finalInTask = false, aborted = false } = {}) => {
    if (!current) {
      if (!pendingItems.length && !pendingEntries.length) return null;
      startExchange(timestamp);
    }
    current.complete = true;
    current.finalInTask = Boolean(finalInTask);
    current.aborted = Boolean(aborted);
    current.completedAt = timestamp || lastTimestamp(current.entries) || current.startedAt;
    exchanges.push(current);
    lastCompleted = current;
    current = null;
    return lastCompleted;
  };

  for (const entry of entries) {
    const payload = entry?.payload;
    const payloadType = payload?.type;
    if (entry?.type === "response_item" && isUpstreamResponseItem(payload)) {
      if (current?.responseItems.length) completeExchange({ timestamp: entry.timestamp });
      pendingItems.push(payload);
      pendingEntries.push(entry);
      continue;
    }
    if (entry?.type === "response_item" && isDownstreamResponseItem(payload)) {
      const exchange = startExchange(entry.timestamp);
      exchange.responseItems.push(payload);
      exchange.entries.push(entry);
      continue;
    }
    if (entry?.type === "event_msg" && (payloadType === "agent_reasoning" || payloadType === "agent_message")) {
      startExchange(entry.timestamp).entries.push(entry);
      continue;
    }
    if (entry?.type === "event_msg" && payloadType === "token_count") {
      const target = current || lastCompleted;
      if (target) {
        target.entries.push(entry);
        if (payload?.info) target.tokenInfo = payload.info;
      } else {
        pendingEntries.push(entry);
      }
      continue;
    }
    if (entry?.type === "event_msg" && (payloadType === "task_complete" || payloadType === "turn_aborted")) {
      const target = current || (pendingItems.length || pendingEntries.length ? startExchange(entry.timestamp) : lastCompleted);
      if (target) target.entries.push(entry);
      if (current) {
        completeExchange({
          timestamp: payload?.completed_at || entry.timestamp,
          finalInTask: true,
          aborted: payloadType === "turn_aborted",
        });
      } else if (lastCompleted) {
        lastCompleted.finalInTask = true;
        lastCompleted.aborted = payloadType === "turn_aborted";
        lastCompleted.completedAt = payload?.completed_at || entry.timestamp || lastCompleted.completedAt;
      }
      continue;
    }
    if (current) current.entries.push(entry);
    else pendingEntries.push(entry);
  }

  if (current) exchanges.push(current);
  else if (pendingItems.length) {
    current = startExchange(lastTimestamp(pendingEntries));
    exchanges.push(current);
  }
  return exchanges;
}

export function normalizeCodexRolloutRecord(record) {
  if (!record || typeof record !== "object" || !record.type) return null;
  return {
    timestamp: record.timestamp || null,
    type: String(record.type),
    payload: cloneWithoutOpaqueReasoning(record.payload),
  };
}

export function normalizeBaseInstructions(value) {
  if (typeof value === "string" && value.trim()) {
    return [{ type: "text", text: value, source: "codex.session_meta.base_instructions" }];
  }
  if (value && typeof value === "object" && typeof value.text === "string" && value.text.trim()) {
    return [{ type: "text", text: value.text, source: "codex.session_meta.base_instructions" }];
  }
  return [];
}

export function normalizeDynamicTools(dynamicTools) {
  const output = [];
  for (const item of Array.isArray(dynamicTools) ? dynamicTools : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "namespace" && Array.isArray(item.tools)) {
      for (const tool of item.tools) {
        const normalized = normalizeTool(tool, { namespace: item.name, namespaceDescription: item.description });
        if (normalized) output.push(normalized);
      }
      continue;
    }
    const normalized = normalizeTool(item);
    if (normalized) output.push(normalized);
  }
  return output;
}

export function responseItemToMessage(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "message" && ["developer", "system", "user"].includes(item.role)) {
    return {
      role: item.role,
      content: normalizeMessageContent(item.content),
      ...(item.id ? { id: item.id } : {}),
    };
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return {
      role: "tool",
      tool_call_id: item.call_id || null,
      name: item.name || null,
      content: normalizeToolOutput(item.output),
      codex_item_type: item.type,
    };
  }
  return null;
}

export function isUpstreamResponseItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "message") return ["developer", "system", "user"].includes(item.role);
  return item.type === "function_call_output" || item.type === "custom_tool_call_output";
}

export function isDownstreamResponseItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "message") return item.role === "assistant";
  return ["reasoning", "function_call", "custom_tool_call", "web_search_call", "computer_call"].includes(item.type);
}

function downstreamItemsFromEntries(entries, selectedItems = null) {
  const output = [];
  let reasoningIndex = 0;
  let messageIndex = 0;
  const selected = selectedItems ? new Set(selectedItems) : null;
  const responseItems = (entries || [])
    .filter((entry) => entry?.type === "response_item" && isDownstreamResponseItem(entry.payload) && (!selected || selected.has(entry.payload)))
    .map((entry) => entry.payload);
  const reasoningTexts = new Set(responseItems.flatMap(responsesReasoningTexts).filter(Boolean));
  const assistantTexts = new Set(responseItems.map(responseItemText).filter(Boolean));
  for (const entry of entries || []) {
    if (entry?.type === "response_item" && isDownstreamResponseItem(entry.payload) && (!selected || selected.has(entry.payload))) {
      output.push(cloneWithoutOpaqueReasoning(entry.payload));
      continue;
    }
    if (entry?.type === "event_msg" && entry.payload?.type === "agent_reasoning" && entry.payload.text) {
      const text = String(entry.payload.text).trim();
      if (!text || reasoningTexts.has(text)) continue;
      reasoningTexts.add(text);
      reasoningIndex += 1;
      output.push({
        type: "reasoning",
        id: `rollout-reasoning-${reasoningIndex}`,
        summary: [{ type: "summary_text", text }],
        codex_rollout_event: true,
      });
      continue;
    }
    if (entry?.type === "event_msg" && entry.payload?.type === "agent_message" && entry.payload.message) {
      const text = String(entry.payload.message).trim();
      if (!text || assistantTexts.has(text)) continue;
      assistantTexts.add(text);
      messageIndex += 1;
      output.push({
        type: "message",
        id: `rollout-message-${messageIndex}`,
        role: "assistant",
        content: [{ type: "output_text", text }],
        phase: entry.payload.phase || null,
        codex_rollout_event: true,
      });
    }
  }
  return output;
}

function normalizeTool(tool, { namespace = null, namespaceDescription = null } = {}) {
  if (!tool || typeof tool !== "object") return null;
  const localName = String(tool.name || "").trim();
  if (!localName) return null;
  const qualifiedName = namespace && !localName.startsWith(`${namespace}__`) ? `${namespace}__${localName}` : localName;
  const inputSchema = tool.inputSchema || tool.input_schema || tool.parameters || { type: "object", properties: {} };
  return {
    type: "function",
    name: qualifiedName,
    display_name: localName,
    description: String(tool.description || "").trim(),
    input_schema: inputSchema,
    ...(namespace ? { namespace, namespace_description: namespaceDescription || null } : {}),
    ...(tool.deferLoading != null ? { defer_loading: Boolean(tool.deferLoading) } : {}),
  };
}

function normalizeMessageContent(content) {
  const parts = Array.isArray(content) ? content : content == null ? [] : [content];
  return parts.map((part) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (!part || typeof part !== "object") return { type: "text", text: String(part ?? "") };
    if (part.type === "input_text" || part.type === "output_text") return { ...part, type: "text" };
    return part;
  });
}

function normalizeToolOutput(output) {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function normalizeReasoningConfig(context) {
  const effort = context?.effort || null;
  return effort ? { effort } : null;
}

function latestTokenInfo(entries) {
  for (let index = (entries || []).length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload.info) return entry.payload.info;
  }
  return null;
}

function eventTypeCounts(entries) {
  const counts = {};
  for (const entry of entries || []) {
    const key = entry?.payload?.type ? `${entry.type}:${entry.payload.type}` : String(entry?.type || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function exchangeLifecycle(turn, exchange) {
  return {
    status: exchangeStatus(turn, exchange),
    started_at: exchange?.startedAt || turn.startedAt || null,
    completed_at: exchange?.completedAt || (exchange?.finalInTask ? turn.completedAt : null) || null,
    duration_ms: finiteNumber(exchange?.durationMs),
    time_to_first_token_ms: null,
    task_started_at: turn.startedAt || null,
    task_completed_at: turn.completedAt || null,
    final_in_task: Boolean(exchange?.finalInTask),
  };
}

function exchangeStatus(turn, exchange) {
  if (exchange?.aborted || turn.aborted) return "cancelled";
  if (exchange?.complete || (!exchange && turn.completedEvent)) return "completed";
  return "in_progress";
}

function exchangeFinishReason({ turn, exchange, responseOutput }) {
  if (exchange?.aborted || turn.aborted) return "cancelled";
  if ((responseOutput || []).some((item) => ["function_call", "custom_tool_call"].includes(item?.type))) return "tool_use";
  if (exchange?.finalInTask || (!exchange && turn.completedEvent)) return "end_turn";
  return null;
}

function responsesReasoningTexts(item) {
  if (item?.type !== "reasoning") return [];
  return [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
    .map((part) => (typeof part === "string" ? part : part?.text))
    .map((text) => String(text || "").trim())
    .filter(Boolean);
}

function responseItemText(item) {
  if (item?.type !== "message" || item.role !== "assistant") return "";
  return normalizeMessageContent(item.content)
    .map((part) => part?.text || part?.output_text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function positiveRoundIndex(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

function cloneWithoutOpaqueReasoning(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneWithoutOpaqueReasoning);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "encrypted_content" && typeof item === "string" && item) {
      output.encrypted_content_omitted = {
        reason: "opaque_encrypted_reasoning",
        chars: item.length,
        preview: OPAQUE_REASONING_PREVIEW,
      };
      continue;
    }
    output[key] = cloneWithoutOpaqueReasoning(item);
  }
  return output;
}

function firstTimestamp(entries) {
  return (entries || []).find((entry) => entry?.timestamp)?.timestamp || null;
}

function lastTimestamp(entries) {
  for (let index = (entries || []).length - 1; index >= 0; index -= 1) {
    if (entries[index]?.timestamp) return entries[index].timestamp;
  }
  return null;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
