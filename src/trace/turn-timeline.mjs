export function buildTurnTimeline(requests, semantics = {}) {
  assertSemantics(semantics);
  const turns = [];
  let nextTurnIndex = 1;
  let currentTurn = null;
  let currentUserKey = "";
  let pendingInternalRequests = [];
  for (const request of requests || []) {
    if (semantics.isIndependentRequest?.(request)) {
      const backgroundGroup = createIndependentGroup(request, semantics);
      addRequestToTurn(backgroundGroup, request, semantics);
      turns.push(backgroundGroup);
      continue;
    }
    const internalRequest = semantics.isInternalRequest(request);
    const turnPlacement = request.source_hint?.turn_placement;
    if (internalRequest && turnPlacement === "trigger_turn" && currentTurn) {
      addRequestToTurn(currentTurn, request, semantics);
      continue;
    }
    if (internalRequest && (!currentTurn || turnPlacement === "next_turn")) {
      pendingInternalRequests.push(request);
      continue;
    }
    const userText = request.summary?.current_user || "";
    const commandMessage = request.summary?.command_message || null;
    const userKey = semantics.normalizeUserKey(userText);
    if (internalRequest && currentTurn && currentUserKey && userKey && userKey !== currentUserKey) {
      pendingInternalRequests.push(request);
      continue;
    }
    const shouldStartTurn =
      !currentTurn ||
      (!internalRequest && userKey && userKey !== currentUserKey) ||
      (!currentUserKey && userKey && currentTurn.request_count > 0 && !internalRequest);
    if (shouldStartTurn) {
      currentTurn = createTurn(nextTurnIndex++, userText, commandMessage, semantics);
      turns.push(currentTurn);
      currentUserKey = userKey;
    } else if (currentTurn && !currentUserKey && userKey) {
      currentTurn.title = semantics.titleFor(userText, commandMessage);
      currentTurn.user_input = semantics.previewText(semantics.cleanUserText(userText), 1200);
      if (commandMessage && !currentTurn.command_message) currentTurn.command_message = commandMessage;
      currentUserKey = userKey;
    }
    if (!currentTurn) {
      currentTurn = createTurn(nextTurnIndex++, userText, commandMessage, semantics);
      turns.push(currentTurn);
      currentUserKey = userKey;
    }
    if (pendingInternalRequests.length) {
      for (const pending of pendingInternalRequests) addRequestToTurn(currentTurn, pending, semantics);
      pendingInternalRequests = [];
    }
    addRequestToTurn(currentTurn, request, semantics);
  }
  if (pendingInternalRequests.length) {
    if (!currentTurn) {
      currentTurn = createTurn(nextTurnIndex++, "", null, semantics);
      turns.push(currentTurn);
    }
    for (const pending of pendingInternalRequests) addRequestToTurn(currentTurn, pending, semantics);
  }
  return turns.map(finalizeTurn);
}

function createTurn(index, userText, commandMessage, semantics) {
  return {
    id: `turn-${index}`,
    kind: "conversation_turn",
    index,
    title: semantics.titleFor(userText, commandMessage),
    user_input: semantics.previewText(semantics.cleanUserText(userText), 1200),
    command_message: commandMessage,
    request_ids: [],
    request_indexes: [],
    first_request_index: null,
    last_request_index: null,
    started_at: null,
    ended_at: null,
    request_count: 0,
    main_request_count: 0,
    internal_request_count: 0,
    subagent_count: 0,
    parent_spawn_count: 0,
    tool_call_count: 0,
    tool_result_count: 0,
    tool_call_keys: new Set(),
    tool_result_keys: new Set(),
    raw_body_bytes: 0,
    context_delta: { new_messages: 0, new_tool_calls: 0, new_tool_results: 0, new_roles: {} },
  };
}

function createIndependentGroup(request, semantics) {
  const attribution = request.source_hint || {};
  return {
    ...createTurn(null, "", null, semantics),
    id: `background-request-${request.request_index || request.id}`,
    kind: "independent_background",
    index: null,
    title: attribution.label || "Background task",
    source_hint: attribution,
  };
}

function addRequestToTurn(turn, request, semantics) {
  request.turn_id = turn.id;
  turn.request_ids.push(request.id);
  turn.request_indexes.push(request.request_index);
  turn.first_request_index ??= request.request_index;
  turn.last_request_index = request.request_index;
  turn.started_at ??= request.captured_at || null;
  turn.ended_at = request.captured_at || turn.ended_at;
  turn.request_count += 1;
  turn.raw_body_bytes += request.counts?.raw_body_bytes || 0;
  if (semantics.isInternalRequest(request)) turn.internal_request_count += 1;
  else turn.main_request_count += 1;
  if (request.is_subagent) turn.subagent_count += 1;
  if (request.source_hint?.type === "parent_spawn") turn.parent_spawn_count += 1;
  addDistinctToolEvents(turn.tool_call_keys, [
    ...(request.summary?.current_tool_calls || []),
    ...(typeof semantics.responseToolCalls === "function" ? semantics.responseToolCalls(request) : []),
  ]);
  addDistinctToolEvents(turn.tool_result_keys, request.summary?.current_tool_results || []);
  turn.tool_call_count = turn.tool_call_keys.size;
  turn.tool_result_count = turn.tool_result_keys.size;
  mergeContextDelta(turn.context_delta, request.context_delta);
}

function mergeContextDelta(target, delta) {
  if (!delta) return;
  target.new_messages += delta.new_messages || 0;
  target.new_tool_calls += delta.new_tool_calls || 0;
  target.new_tool_results += delta.new_tool_results || 0;
  for (const [role, count] of Object.entries(delta.new_roles || {})) {
    target.new_roles[role] = (target.new_roles[role] || 0) + count;
  }
}

function finalizeTurn(turn) {
  const { tool_call_keys, tool_result_keys, ...publicTurn } = turn;
  return {
    ...publicTurn,
    request_count: turn.request_ids.length,
    has_internal_requests: turn.internal_request_count > 0,
    has_tool_exchange: turn.tool_call_count > 0 || turn.tool_result_count > 0,
  };
}

function addDistinctToolEvents(keys, events) {
  for (const event of events || []) {
    const id = String(event?.id || event?.tool_call_id || event?.tool_use_id || "").trim();
    keys.add(id ? `id:${id}` : Symbol("anonymous-tool-event"));
  }
}

function assertSemantics(semantics) {
  for (const name of ["normalizeUserKey", "isInternalRequest", "titleFor", "cleanUserText", "previewText"]) {
    if (typeof semantics[name] !== "function") throw new Error(`turn timeline semantics.${name} is required`);
  }
}
