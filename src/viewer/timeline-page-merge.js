export function mergeTimelinePage(current, page) {
  if (!current?.source?.id || !page?.source?.id) throw new TypeError("timeline page source is required");
  if (current.source.id !== page.source.id) throw new TypeError("timeline page source mismatch");

  const requests = new Map((current.requests || []).map((request) => [request.id, request]));
  for (const patch of page.request_patches || []) {
    const request = requests.get(patch.id);
    if (!request) continue;
    requests.set(patch.id, applyRequestPatch(request, patch));
  }
  for (const request of page.requests || []) requests.set(request.id, request);

  const turns = Array.isArray(page.turns)
    ? page.turns
    : mergeEntities(current.turns || [], page.turn_updates || [], page.removed_turn_ids || [], (turn) => turn.id);
  const agentTrace = page.agent_trace || mergeAgentTrace(current.agent_trace, page.agent_trace_delta);
  const {
    turn_updates: _turnUpdates,
    removed_turn_ids: _removedTurnIds,
    agent_trace_delta: _agentTraceDelta,
    ...pageFields
  } = page;

  return {
    ...current,
    ...pageFields,
    source: { ...current.source, ...page.source },
    requests: [...requests.values()].sort(compareRequests),
    request_patches: [],
    turns,
    agent_trace: agentTrace,
  };
}

function applyRequestPatch(request, patch) {
  const { id: _id, ...fields } = patch;
  return {
    ...request,
    ...fields,
    trace: fields.trace ? { ...fields.trace } : request.trace,
  };
}

function compareRequests(left, right) {
  const indexDelta = Number(left?.request_index || 0) - Number(right?.request_index || 0);
  if (indexDelta) return indexDelta;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function mergeAgentTrace(current, delta) {
  if (!delta) return current || emptyAgentTrace();
  const base = current || emptyAgentTrace();
  return {
    ...base,
    version: delta.version || base.version || 1,
    branch_count: Number(delta.branch_count) || 0,
    spawn_count: Number(delta.spawn_count) || 0,
    return_count: Number(delta.return_count) || 0,
    confidence: delta.confidence || "none",
    signals: delta.signals || base.signals || {},
    branches: mergeEntities(base.branches || [], delta.branch_updates || [], delta.removed_branch_ids || [], (item) => item.id),
    spawns: mergeEntities(base.spawns || [], delta.spawn_updates || [], delta.removed_spawn_ids || [], (item) => item.id),
    returns: mergeEntities(
      base.returns || [],
      delta.return_updates || [],
      delta.removed_return_spawn_ids || [],
      (item) => item.spawn_id,
    ),
  };
}

function mergeEntities(current, updates, removedIds, keyOf) {
  const removed = new Set((removedIds || []).map(String));
  const entities = new Map();
  for (const entity of current || []) {
    const key = String(keyOf(entity) || "");
    if (key && !removed.has(key)) entities.set(key, entity);
  }
  for (const entity of updates || []) {
    const key = String(keyOf(entity) || "");
    if (key) entities.set(key, entity);
  }
  return [...entities.values()];
}

function emptyAgentTrace() {
  return { version: 1, branch_count: 0, spawn_count: 0, return_count: 0, confidence: "none", branches: [], spawns: [], returns: [] };
}
