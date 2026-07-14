const WIRE_ENTITY_KEYS = new Set([
  "requests",
  "request_patches",
  "turns",
  "turn_updates",
  "removed_turn_ids",
  "agent_trace",
  "agent_trace_delta",
]);
const TIMELINE_TRACE_KEYS = [
  "context_chain_key",
  "previous_context_request_index",
  "branch_id",
  "agent_branch",
  "spawn_branch_ids",
  "returned_branch_ids",
];

export class TimelineEntityStore {
  constructor(initial = null) {
    this.clear();
    if (initial) this.reset(initial);
  }

  clear() {
    this.sourceId = null;
    this.root = {};
    this.requests = new Map();
    this.requestOrder = [];
    this.requestOrderDirty = false;
    this.turns = new Map();
    this.turnOrder = [];
    this.agentMeta = agentTraceMeta(emptyAgentTrace());
    this.agentBranches = new Map();
    this.agentBranchOrder = [];
    this.agentSpawns = new Map();
    this.agentSpawnOrder = [];
    this.agentReturns = new Map();
    this.agentReturnOrder = [];
    this.cachedSnapshot = null;
  }

  reset(data) {
    assertTimelineSource(data);
    this.clear();
    this.sourceId = data.source.id;
    this.mergeRoot(data);
    this.replaceRequests(data.requests || []);
    this.replaceTurns(data.turns || []);
    this.replaceAgentTrace(data.agent_trace || emptyAgentTrace());
    return this.snapshot();
  }

  applyPage(page) {
    assertTimelineSource(page);
    if (!this.sourceId) return this.reset(page);
    if (this.sourceId !== page.source.id) throw new TypeError("timeline page source mismatch");

    this.mergeRoot(page);
    for (const patch of page.request_patches || []) this.applyRequestPatch(patch);
    for (const request of page.requests || []) this.upsertRequest(request);

    if (Array.isArray(page.turns)) this.replaceTurns(page.turns);
    else mergeEntities(this.turns, this.turnOrder, page.turn_updates, page.removed_turn_ids, (turn) => turn.id);

    if (page.agent_trace) this.replaceAgentTrace(page.agent_trace);
    else if (page.agent_trace_delta) this.applyAgentTraceDelta(page.agent_trace_delta);

    this.invalidate();
    return this.snapshot();
  }

  mergeRequestDetail(fullRequest) {
    if (!fullRequest?.id) return fullRequest;
    const previous = this.requests.get(fullRequest.id);
    if (!previous) return fullRequest;
    const merged = mergeTimelineRequestDetail(previous, fullRequest);
    this.requests.set(fullRequest.id, merged);
    this.invalidate();
    return merged;
  }

  request(requestId) {
    return this.requests.get(requestId) || null;
  }

  hasRequest(requestId) {
    return this.requests.has(requestId);
  }

  snapshot() {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    if (this.requestOrderDirty) {
      this.requestOrder.sort((leftId, rightId) => compareRequests(this.requests.get(leftId), this.requests.get(rightId)));
      this.requestOrderDirty = false;
    }
    this.cachedSnapshot = {
      ...this.root,
      requests: materialize(this.requests, this.requestOrder),
      request_patches: [],
      turns: materialize(this.turns, this.turnOrder),
      agent_trace: {
        ...this.agentMeta,
        branches: materialize(this.agentBranches, this.agentBranchOrder),
        spawns: materialize(this.agentSpawns, this.agentSpawnOrder),
        returns: materialize(this.agentReturns, this.agentReturnOrder),
      },
    };
    return this.cachedSnapshot;
  }

  mergeRoot(page) {
    const rootFields = {};
    for (const [key, value] of Object.entries(page || {})) {
      if (!WIRE_ENTITY_KEYS.has(key) && value !== undefined) rootFields[key] = value;
    }
    this.root = {
      ...this.root,
      ...rootFields,
      source: { ...(this.root.source || {}), ...(page.source || {}) },
    };
  }

  replaceRequests(requests) {
    this.requests.clear();
    this.requestOrder = [];
    for (const request of requests || []) this.upsertRequest(request);
    this.requestOrder.sort((leftId, rightId) => compareRequests(this.requests.get(leftId), this.requests.get(rightId)));
    this.requestOrderDirty = false;
  }

  upsertRequest(request) {
    if (!request?.id) return;
    const isNew = !this.requests.has(request.id);
    if (isNew) {
      const previousId = this.requestOrder.at(-1);
      if (previousId && compareRequests(this.requests.get(previousId), request) > 0) this.requestOrderDirty = true;
      this.requestOrder.push(request.id);
    }
    this.requests.set(request.id, request);
  }

  applyRequestPatch(patch) {
    const request = this.requests.get(patch?.id);
    if (!request) return;
    this.requests.set(patch.id, applyRequestPatch(request, patch));
  }

  replaceTurns(turns) {
    replaceEntities(this.turns, this.turnOrder, turns, (turn) => turn.id);
  }

  replaceAgentTrace(trace) {
    this.agentMeta = agentTraceMeta(trace);
    replaceEntities(this.agentBranches, this.agentBranchOrder, trace?.branches, (item) => item.id);
    replaceEntities(this.agentSpawns, this.agentSpawnOrder, trace?.spawns, (item) => item.id);
    replaceEntities(this.agentReturns, this.agentReturnOrder, trace?.returns, (item) => item.spawn_id);
  }

  applyAgentTraceDelta(delta) {
    this.agentMeta = agentTraceDeltaMeta(this.agentMeta, delta);
    mergeEntities(
      this.agentBranches,
      this.agentBranchOrder,
      delta.branch_updates,
      delta.removed_branch_ids,
      (item) => item.id,
    );
    mergeEntities(
      this.agentSpawns,
      this.agentSpawnOrder,
      delta.spawn_updates,
      delta.removed_spawn_ids,
      (item) => item.id,
    );
    mergeEntities(
      this.agentReturns,
      this.agentReturnOrder,
      delta.return_updates,
      delta.removed_return_spawn_ids,
      (item) => item.spawn_id,
    );
  }

  invalidate() {
    this.cachedSnapshot = null;
  }
}

export function mergeTimelinePage(current, page) {
  return new TimelineEntityStore(current).applyPage(page);
}

export function mergeTimelineRequestDetail(previous, fullRequest) {
  if (!previous || !fullRequest) return fullRequest || previous;
  const trace = { ...(fullRequest.trace || {}) };
  for (const key of TIMELINE_TRACE_KEYS) {
    if (previous.trace?.[key] !== undefined) trace[key] = previous.trace[key];
  }
  return {
    ...previous,
    ...fullRequest,
    turn_id: preferOwn(previous, fullRequest, "turn_id", null),
    is_subagent: preferOwn(previous, fullRequest, "is_subagent", undefined),
    subagent_type: preferOwn(previous, fullRequest, "subagent_type", null),
    source_hint: preferOwn(previous, fullRequest, "source_hint", null),
    changes: previous.changes || fullRequest.changes,
    context_delta: previous.context_delta || fullRequest.context_delta,
    trace,
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

function agentTraceMeta(trace) {
  return {
    version: trace?.version || 1,
    branch_count: Number(trace?.branch_count) || 0,
    spawn_count: Number(trace?.spawn_count) || 0,
    return_count: Number(trace?.return_count) || 0,
    confidence: trace?.confidence || "none",
    signals: trace?.signals || {},
  };
}

function agentTraceDeltaMeta(current, delta) {
  return {
    version: delta?.version || current.version || 1,
    branch_count: delta?.branch_count === undefined ? current.branch_count : Number(delta.branch_count) || 0,
    spawn_count: delta?.spawn_count === undefined ? current.spawn_count : Number(delta.spawn_count) || 0,
    return_count: delta?.return_count === undefined ? current.return_count : Number(delta.return_count) || 0,
    confidence: delta?.confidence || current.confidence || "none",
    signals: delta?.signals || current.signals || {},
  };
}

function replaceEntities(target, order, entities, keyOf) {
  target.clear();
  order.length = 0;
  for (const entity of entities || []) {
    const key = String(keyOf(entity) || "");
    if (!key || target.has(key)) continue;
    target.set(key, entity);
    order.push(key);
  }
}

function mergeEntities(target, order, updates = [], removedIds = [], keyOf) {
  const removed = new Set((removedIds || []).map(String));
  if (removed.size) {
    for (const key of removed) target.delete(key);
    const remaining = order.filter((key) => !removed.has(key));
    order.splice(0, order.length, ...remaining);
  }
  for (const entity of updates || []) {
    const key = String(keyOf(entity) || "");
    if (!key) continue;
    if (!target.has(key)) order.push(key);
    target.set(key, entity);
  }
}

function materialize(entities, order) {
  return order.map((id) => entities.get(id)).filter(Boolean);
}

function preferOwn(primary, fallback, key, defaultValue) {
  if (Object.prototype.hasOwnProperty.call(primary || {}, key)) return primary[key];
  if (Object.prototype.hasOwnProperty.call(fallback || {}, key)) return fallback[key];
  return defaultValue;
}

function assertTimelineSource(value) {
  if (!value?.source?.id) throw new TypeError("timeline page source is required");
}

function emptyAgentTrace() {
  return {
    version: 1,
    branch_count: 0,
    spawn_count: 0,
    return_count: 0,
    confidence: "none",
    signals: {},
    branches: [],
    spawns: [],
    returns: [],
  };
}
