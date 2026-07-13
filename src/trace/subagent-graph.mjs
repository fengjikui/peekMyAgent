import crypto from "node:crypto";

const AGENT_SPAWN_TOOL = /^(Agent|Task|sessions_spawn|subagents)$/i;

export function createSubagentLineageState() {
  return { spawnByPromptKey: new Map() };
}

export function annotateSubagentLineage(requests, semantics = {}, { state = createSubagentLineageState() } = {}) {
  assertSemantics(semantics);
  const spawnByPromptKey = lineageSpawnPrompts(state);
  for (const [key, spawn] of collectSpawnPrompts(requests, semantics)) {
    if (!spawnByPromptKey.has(key)) spawnByPromptKey.set(key, spawn);
  }
  if (!spawnByPromptKey.size) return requests;

  for (const request of requests || []) {
    if (request.is_subagent || request.source_hint?.type === "metadata") continue;
    const key = promptKey(semantics.firstUserPromptText(request), semantics.normalizePrompt);
    const spawn = key ? spawnByPromptKey.get(key) : null;
    if (!spawn) continue;
    const instanceId = `body:${key.slice(0, 12)}`;
    const typeLabel = spawn.subagent_type || "子 Agent";
    request.is_subagent = true;
    request.subagent_type = spawn.subagent_type || null;
    request.source_hint = { type: "subagent", label: `${typeLabel} 子 Agent`, confidence: "medium" };
    request.trace = {
      ...request.trace,
      actor_type: "child",
      claude_agent_id: request.trace?.claude_agent_id || instanceId,
      subagent_prompt_key: key,
    };
  }
  return requests;
}

function lineageSpawnPrompts(state) {
  if (!state || !(state.spawnByPromptKey instanceof Map)) {
    throw new TypeError("subagent lineage state.spawnByPromptKey must be a Map");
  }
  return state.spawnByPromptKey;
}

export function buildSubagentGraph(requests, semantics = {}) {
  assertSemantics(semantics);
  const requestById = new Map((requests || []).map((request) => [request.id, request]));
  const spawnCalls = [];
  const childGroups = new Map();
  const spawnByPromptKey = new Map();

  for (const request of requests || []) {
    const agentId = request.trace?.claude_agent_id || null;
    if (agentId) {
      if (!childGroups.has(agentId)) childGroups.set(agentId, []);
      childGroups.get(agentId).push(request);
    }
    for (const call of responseToolCalls(request)) {
      if (!isAgentSpawnTool(call.name)) continue;
      const key = spawnPromptKey(call, semantics.normalizePrompt);
      const spawn = spawnRecord(call, request, spawnCalls.length, semantics);
      spawnCalls.push(spawn);
      if (key && !spawnByPromptKey.has(key)) spawnByPromptKey.set(key, spawn);
    }
  }

  const returns = collectParentReturns(requests, spawnCalls, semantics);
  const returnBySpawnId = new Map(returns.map((item) => [item.spawn_id, item]));
  const sortedChildGroups = [...childGroups.entries()]
    .map(([agentId, group]) => [agentId, [...group].sort(compareRequestsByIndex)])
    .sort((left, right) => compareRequestsByIndex(left[1][0], right[1][0]));

  const branches = sortedChildGroups.map(([agentId, group], index) => {
    const key = group[0]?.trace?.subagent_prompt_key || null;
    const spawn = (key && spawnByPromptKey.get(key)) || spawnCalls[index] || null;
    return buildBranch({
      agentId,
      group,
      index,
      spawn,
      returned: spawn ? returnBySpawnId.get(spawn.id) || null : null,
      semantics,
    });
  });

  annotateRequestsWithBranches(branches, requestById);
  return {
    version: 1,
    branch_count: branches.length,
    spawn_count: spawnCalls.length,
    return_count: returns.length,
    confidence: branches.length ? (spawnCalls.length >= branches.length && returns.length ? "high" : "medium") : "none",
    signals: {
      child_instance: "x-claude-code-agent-id",
      child_type: "debug source agent:*",
      request_response_pair: "capture_id/request_index",
      parent_spawn: "response Agent tool_use",
      parent_return: "request Agent tool_result",
    },
    branches,
    spawns: spawnCalls,
    returns,
  };
}

export function attachSubagentGraphToTurns(turns, graph) {
  if (!graph?.branches?.length) return turns;
  const turnByRequestId = new Map();
  const turnByRequestIndex = new Map();
  for (const turn of turns || []) {
    turn.agent_branches = [];
    turn.agent_branch_count = 0;
    for (const requestId of turn.request_ids || []) turnByRequestId.set(requestId, turn);
    for (const requestIndex of turn.request_indexes || []) turnByRequestIndex.set(requestIndex, turn);
  }
  for (const branch of graph.branches) {
    const owner =
      turnByRequestId.get(branch.spawn?.parent_request_id) ||
      turnByRequestIndex.get(branch.spawn?.parent_request_index) ||
      turnByRequestId.get(branch.request_ids?.[0]) ||
      turnByRequestIndex.get(branch.request_indexes?.[0]) ||
      turnByRequestId.get(branch.return?.parent_request_id) ||
      turnByRequestIndex.get(branch.return?.parent_request_index);
    if (!owner) continue;
    owner.agent_branches.push(branch.id);
    owner.agent_branch_count = owner.agent_branches.length;
  }
  return turns;
}

function collectSpawnPrompts(requests, semantics) {
  const spawnByPromptKey = new Map();
  for (const request of requests || []) {
    const calls = [...responseToolCalls(request), ...semantics.extractHistoryToolCalls(request)];
    for (const call of calls) {
      if (!isAgentSpawnTool(call.name)) continue;
      const key = promptKey(spawnPrompt(call), semantics.normalizePrompt);
      if (!key || spawnByPromptKey.has(key)) continue;
      call.trace ||= {};
      call.trace.agent_spawn = {
        prompt_key: key,
        description: call.arguments?.description || call.arguments?.taskName || "",
        subagent_type: spawnType(call),
        prompt_preview: semantics.previewText(spawnPrompt(call), 220),
      };
      spawnByPromptKey.set(key, {
        subagent_type: spawnType(call),
        description: call.arguments?.description || call.arguments?.taskName || "",
      });
    }
  }
  return spawnByPromptKey;
}

function collectParentReturns(requests, spawnCalls, semantics) {
  const returns = [];
  const spawnById = new Map(spawnCalls.map((call) => [call.id, call]));
  for (const request of requests || []) {
    for (const result of request.summary?.current_tool_results || []) {
      const spawn = result.id ? spawnById.get(result.id) : null;
      if (!spawn) continue;
      returns.push({
        spawn_id: spawn.id,
        parent_request_id: request.id,
        parent_request_index: request.request_index,
        result_preview: semantics.previewText(result.content, 260),
      });
    }
  }
  return returns;
}

function spawnRecord(call, request, order, semantics) {
  const traceSpawn = call.trace?.agent_spawn || null;
  return {
    id: call.id || `spawn-${request.request_index}-${order + 1}`,
    name: call.name || "Agent",
    parent_request_id: request.id,
    parent_request_index: request.request_index,
    order,
    label: spawnLabel(call),
    description: semantics.previewText(
      traceSpawn?.description || call.arguments?.description || call.arguments?.taskName || call.arguments?.subagent_type || "",
      120,
    ),
    prompt_preview: traceSpawn?.prompt_preview || semantics.previewText(spawnPrompt(call), 220),
    subagent_type: spawnType(call),
    raw_arguments: call.arguments ?? null,
  };
}

function buildBranch({ agentId, group, index, spawn, returned, semantics }) {
  return {
    id: `branch-${index + 1}-${agentId}`,
    label: spawn?.description || spawn?.subagent_type || `子 Agent ${index + 1}`,
    agent_id: agentId,
    agent_type: semantics.childAgentType(group[0], spawn),
    confidence: spawn ? "high_ordered" : "high_agent_id",
    linkage_note: spawn
      ? "通过子 Agent 实例顺序与父级 Agent tool_use 顺序关联；子分支内部由 x-claude-code-agent-id 强关联。"
      : "通过 x-claude-code-agent-id 强关联；未找到可配对的父级 Agent tool_use。",
    spawn: spawn ? publicSpawn(spawn) : null,
    return: returned,
    request_ids: group.map((request) => request.id),
    request_indexes: group.map((request) => request.request_index),
    first_request_index: group[0]?.request_index || null,
    last_request_index: group.at(-1)?.request_index || null,
    response_tool_call_count: group.reduce((sum, request) => sum + responseToolCalls(request).length, 0),
    request_tool_result_count: group.reduce((sum, request) => sum + (request.summary?.current_tool_results?.length || 0), 0),
    status: returned ? "returned" : group.some((request) => request.summary?.response?.finish_reason === "end_turn") ? "completed" : "running",
    steps: group.map((request, stepIndex) => branchStep(request, stepIndex, semantics)),
  };
}

function branchStep(request, stepIndex, semantics) {
  return {
    request_id: request.id,
    request_index: request.request_index,
    response_id: request.summary?.response?.message_id || null,
    response_captured: Boolean(request.summary?.response?.captured),
    finish_reason: request.summary?.response?.finish_reason || null,
    response_tool_calls: responseToolCalls(request).map((call) => ({
      id: call.id || null,
      name: call.name || "unknown",
      arguments_preview: semantics.previewText(semantics.stableJson(call.arguments ?? null), 180),
    })),
    request_tool_results: (request.summary?.current_tool_results || []).map((result) => ({
      id: result.id || null,
      content_preview: semantics.previewText(result.content, 160),
    })),
    response_preview: semantics.previewText(request.summary?.response?.preview || request.summary?.response?.text || "", stepIndex ? 220 : 120),
  };
}

function annotateRequestsWithBranches(branches, requestById) {
  for (const [branchIndex, branch] of branches.entries()) {
    for (const requestId of branch.request_ids) {
      const request = requestById.get(requestId);
      if (!request) continue;
      request.trace ||= {};
      request.trace.branch_id = branch.id;
      request.trace.agent_branch = {
        id: branch.id,
        index: branchIndex + 1,
        label: branch.label,
        agent_id: branch.agent_id,
        agent_type: branch.agent_type,
        status: branch.status,
      };
    }
    annotateParentBranch(requestById.get(branch.spawn?.parent_request_id), "spawn_branch_ids", branch.id);
    annotateParentBranch(requestById.get(branch.return?.parent_request_id), "returned_branch_ids", branch.id);
  }
}

function annotateParentBranch(request, field, branchId) {
  if (!request) return;
  request.trace ||= {};
  request.trace[field] ||= [];
  request.trace[field].push(branchId);
}

function publicSpawn(spawn) {
  return {
    id: spawn.id,
    name: spawn.name,
    parent_request_id: spawn.parent_request_id,
    parent_request_index: spawn.parent_request_index,
    label: spawn.label,
    description: spawn.description,
    prompt_preview: spawn.prompt_preview,
    subagent_type: spawn.subagent_type,
  };
}

function promptKey(text, normalizePrompt) {
  const normalized = normalizePrompt(text || "");
  if (!normalized || normalized.length < 8) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function responseToolCalls(request) {
  return request.summary?.response?.tool_calls || [];
}

function spawnPrompt(call) {
  return call.arguments?.prompt || call.arguments?.task || "";
}

function spawnType(call) {
  return call.trace?.agent_spawn?.subagent_type || call.arguments?.subagent_type || call.arguments?.agentType || call.arguments?.type || null;
}

function spawnLabel(call) {
  const traceSpawn = call.trace?.agent_spawn || null;
  const args = call.arguments || {};
  return traceSpawn?.description || args.description || args.taskName || traceSpawn?.subagent_type || args.subagent_type || call.name || "Agent";
}

function spawnPromptKey(call, normalizePrompt) {
  return call.trace?.agent_spawn?.prompt_key || promptKey(spawnPrompt(call), normalizePrompt);
}

function isAgentSpawnTool(name) {
  return AGENT_SPAWN_TOOL.test(String(name || ""));
}

function compareRequestsByIndex(left, right) {
  return Number(left?.request_index || 0) - Number(right?.request_index || 0);
}

function assertSemantics(semantics) {
  for (const name of ["extractHistoryToolCalls", "firstUserPromptText", "normalizePrompt", "previewText", "stableJson", "childAgentType"]) {
    if (typeof semantics[name] !== "function") throw new Error(`subagent graph semantics.${name} is required`);
  }
}
