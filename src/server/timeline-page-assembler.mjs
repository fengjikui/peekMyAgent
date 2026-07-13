import { annotateRequestContextChanges, createContextDeltaState } from "../trace/context-delta.mjs";
import {
  annotateSubagentLineage,
  attachSubagentGraphToTurns,
  buildSubagentGraph,
  createSubagentLineageState,
} from "../trace/subagent-graph.mjs";
import { projectTimelineRequest } from "./timeline-view-projector.mjs";

export class TimelinePageAssembler {
  constructor({ summarizeCapture, contextSemantics, lineageSemantics, buildTurns, buildStats, buildWorkbench } = {}) {
    this.summarizeCapture = requiredFunction(summarizeCapture, "summarizeCapture");
    this.contextSemantics = requiredValue(contextSemantics, "contextSemantics");
    this.lineageSemantics = requiredValue(lineageSemantics, "lineageSemantics");
    this.buildTurns = requiredFunction(buildTurns, "buildTurns");
    this.buildStats = requiredFunction(buildStats, "buildStats");
    this.buildWorkbench = requiredFunction(buildWorkbench, "buildWorkbench");
  }

  createState({ source, command = null } = {}) {
    if (!source?.id) throw new TypeError("timeline page source.id is required");
    return {
      source,
      command,
      requests: [],
      context: createContextDeltaState(),
      lineage: createSubagentLineageState(),
      annotationSnapshots: new Map(),
      turnSnapshots: new Map(),
      graphSnapshots: createGraphSnapshots(),
    };
  }

  append(state, { captures = [], debugSources = [], startIndex = 0, command = null, page = null } = {}) {
    assertState(state);
    if (command && !state.command) state.command = command;
    const priorRequestIds = new Set(state.requests.map((request) => request.id));
    const pageRequests = captures.map((capture, index) =>
      this.summarizeCapture(capture, state.source, startIndex + index, debugSources[index] || null),
    );

    annotateSubagentLineage(pageRequests, this.lineageSemantics, { state: state.lineage });
    annotateRequestContextChanges(pageRequests, this.contextSemantics, { state: state.context });
    state.requests.push(...pageRequests.map(projectTimelineRequest));

    clearDerivedTimelineAnnotations(state.requests);
    const turns = this.buildTurns(state.requests);
    const agentTrace = buildSubagentGraph(state.requests, this.lineageSemantics);
    attachSubagentGraphToTurns(turns, agentTrace);

    const requestPatches = changedPriorAnnotations(state, priorRequestIds);
    const initialPage = priorRequestIds.size === 0;
    const turnDelta = entityDelta(state.turnSnapshots, turns, (turn) => turn.id);
    const graphDelta = subagentGraphDelta(state.graphSnapshots, agentTrace);
    const outputPageRequests = pageRequests
      .map((request) => state.requests.find((item) => item.id === request.id))
      .filter(Boolean)
      .map(projectTimelineRequest);
    const stats = this.buildStats(state.requests, agentTrace, {
      source: state.source,
      page: page || null,
      loadedCount: state.requests.length,
    });
    const source = {
      ...state.source,
      command: state.command,
      workbench: this.buildWorkbench(state.source, state.requests, state.command),
    };

    return {
      generated_at: new Date().toISOString(),
      source,
      stats,
      requests: outputPageRequests,
      request_patches: requestPatches,
      ...(initialPage ? { turns, agent_trace: agentTrace } : {}),
      turn_updates: initialPage ? [] : turnDelta.updates,
      removed_turn_ids: initialPage ? [] : turnDelta.removedIds,
      agent_trace_delta: initialPage ? null : graphDelta,
      page_scope: "timeline_cursor_delta",
      page,
    };
  }
}

function clearDerivedTimelineAnnotations(requests) {
  for (const request of requests) {
    delete request.turn_id;
    if (!request.trace || typeof request.trace !== "object") continue;
    delete request.trace.branch_id;
    delete request.trace.agent_branch;
    delete request.trace.spawn_branch_ids;
    delete request.trace.returned_branch_ids;
  }
}

function changedPriorAnnotations(state, priorRequestIds) {
  const patches = [];
  const nextSnapshots = new Map();
  for (const request of state.requests) {
    const annotation = requestAnnotation(request);
    const serialized = stableJson(annotation);
    nextSnapshots.set(request.id, serialized);
    if (!priorRequestIds.has(request.id)) continue;
    if (state.annotationSnapshots.get(request.id) === serialized) continue;
    patches.push({ id: request.id, ...annotation });
  }
  state.annotationSnapshots = nextSnapshots;
  return patches;
}

function requestAnnotation(request) {
  return {
    turn_id: request.turn_id || null,
    trace: request.trace || {},
    is_subagent: Boolean(request.is_subagent),
    subagent_type: request.subagent_type || null,
    source_hint: request.source_hint || null,
  };
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function createGraphSnapshots() {
  return {
    branches: new Map(),
    spawns: new Map(),
    returns: new Map(),
  };
}

function subagentGraphDelta(snapshots, graph) {
  const branchDelta = entityDelta(snapshots.branches, graph?.branches || [], (branch) => branch.id);
  const spawnDelta = entityDelta(snapshots.spawns, graph?.spawns || [], (spawn) => spawn.id);
  const returnDelta = entityDelta(snapshots.returns, graph?.returns || [], (item) => item.spawn_id);
  return {
    version: graph?.version || 1,
    branch_count: graph?.branch_count || 0,
    spawn_count: graph?.spawn_count || 0,
    return_count: graph?.return_count || 0,
    confidence: graph?.confidence || "none",
    signals: graph?.signals || {},
    branch_updates: branchDelta.updates,
    removed_branch_ids: branchDelta.removedIds,
    spawn_updates: spawnDelta.updates,
    removed_spawn_ids: spawnDelta.removedIds,
    return_updates: returnDelta.updates,
    removed_return_spawn_ids: returnDelta.removedIds,
  };
}

function entityDelta(previousSnapshots, entities, keyOf) {
  const nextSnapshots = new Map();
  const updates = [];
  for (const entity of entities || []) {
    const key = String(keyOf(entity) || "");
    if (!key) continue;
    const serialized = stableJson(entity);
    nextSnapshots.set(key, serialized);
    if (previousSnapshots.get(key) !== serialized) updates.push(entity);
  }
  const removedIds = [...previousSnapshots.keys()].filter((key) => !nextSnapshots.has(key));
  previousSnapshots.clear();
  for (const [key, serialized] of nextSnapshots) previousSnapshots.set(key, serialized);
  return { updates, removedIds };
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`timeline page ${name} is required`);
  return value;
}

function requiredValue(value, name) {
  if (!value || typeof value !== "object") throw new TypeError(`timeline page ${name} is required`);
  return value;
}

function assertState(state) {
  if (
    !state?.source?.id ||
    !Array.isArray(state.requests) ||
    !(state.annotationSnapshots instanceof Map) ||
    !(state.turnSnapshots instanceof Map) ||
    !(state.graphSnapshots?.branches instanceof Map)
  ) {
    throw new TypeError("invalid timeline page assembler state");
  }
}
