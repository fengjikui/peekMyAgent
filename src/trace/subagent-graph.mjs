import crypto from "node:crypto";

const AGENT_SPAWN_TOOL = /^(Agent|Task|sessions_spawn|subagents|spawn_agent)$/i;

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
      agent_instance_id: request.trace?.agent_instance_id || request.trace?.claude_agent_id || instanceId,
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
    const agentId = request.trace?.agent_instance_id || request.trace?.claude_agent_id || null;
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

  const { returns, launches, failedSpawnIds } = collectParentReturnEvidence(requests, spawnCalls, semantics);
  const spawnCallById = new Map(spawnCalls.map((spawn) => [spawn.id, spawn]));
  const returnBySpawnId = new Map(returns.map((item) => [item.spawn_id, item]));
  const launchBySpawnId = new Map(launches.map((item) => [item.spawn_id, item]));
  const spawnByLaunchAgentId = new Map(
    launches
      .map((launch) => [launch.agent_id, spawnCallById.get(launch.spawn_id) || null])
      .filter(([, spawn]) => spawn),
  );
  const viableSpawnCalls = spawnCalls.filter((spawn) => !failedSpawnIds.has(spawn.id));
  const agentMessages = collectAgentMessages(requests, semantics);
  const sortedChildGroups = [...childGroups.entries()]
    .map(([agentId, group]) => [agentId, [...group].sort(compareRequestsByIndex)])
    .sort((left, right) => compareRequestsByIndex(left[1][0], right[1][0]));

  const branches = sortedChildGroups.map(([agentId, group], index) => {
    const key = group[0]?.trace?.subagent_prompt_key || null;
    const promptSpawn = key && spawnByPromptKey.get(key);
    const spawn =
      spawnByLaunchAgentId.get(agentId) ||
      (promptSpawn && !failedSpawnIds.has(promptSpawn.id) ? promptSpawn : null) ||
      viableSpawnCalls[index] ||
      null;
    return buildBranch({
      agentId,
      group,
      index,
      spawn,
      launch: spawn ? launchBySpawnId.get(spawn.id) || null : null,
      returned: spawn ? returnBySpawnId.get(spawn.id) || null : null,
      semantics,
    });
  });
  const usedSpawnIds = new Set(branches.map((branch) => branch.spawn?.id).filter(Boolean));
  const usedAgentIds = new Set(branches.map((branch) => branch.agent_id).filter(Boolean));
  for (const spawn of spawnCalls) {
    if (usedSpawnIds.has(spawn.id) || failedSpawnIds.has(spawn.id) || !isCodexAgentSpawn(spawn)) continue;
    const launch = launchBySpawnId.get(spawn.id) || null;
    const matchingMessages = agentMessages.filter((item) => messageMatchesSpawn(item, spawn, launch));
    const agentId = matchingMessages[0]?.summary?.author || launch?.agent_id || codexAgentIdFromSpawn(spawn);
    branches.push(
      buildAgentMessageBranch({
        agentId,
        messages: matchingMessages,
        index: branches.length,
        spawn,
        launch,
        returned: returnBySpawnId.get(spawn.id) || null,
        semantics,
      }),
    );
    usedSpawnIds.add(spawn.id);
    if (agentId) usedAgentIds.add(agentId);
  }
  for (const item of agentMessages) {
    const agentId = item.summary?.author || item.summary?.name;
    if (!agentId || usedAgentIds.has(agentId)) continue;
    const matchingMessages = agentMessages.filter((candidate) => candidate.summary?.author === agentId);
    branches.push(
      buildAgentMessageBranch({
        agentId,
        messages: matchingMessages,
        index: branches.length,
        spawn: null,
        launch: null,
        semantics,
      }),
    );
    usedAgentIds.add(agentId);
  }

  const graphReturns = branches.map((branch) => branch.return).filter(Boolean);
  const hasCodexSpawns = spawnCalls.some(isCodexAgentSpawn);

  annotateRequestsWithBranches(branches, requestById);
  return {
    version: 2,
    branch_count: branches.length,
    spawn_count: spawnCalls.length,
    failed_spawn_count: failedSpawnIds.size,
    return_count: graphReturns.length,
    confidence: branches.length
      ? branches.every((branch) => ["high_ordered", "high_agent_id", "high_agent_message"].includes(branch.confidence))
        ? "high"
        : "medium"
      : "none",
    signals: {
      child_instance: requests.some((request) => request.trace?.agent_instance_id)
        ? "agent instance id"
        : agentMessages.length
          ? "agent_message author"
          : "x-claude-code-agent-id",
      child_type: hasCodexSpawns
        ? "spawn_agent arguments.agent_type"
        : agentMessages.length
          ? "spawn_agent task_name"
          : "debug source agent:*",
      request_response_pair: "capture_id/request_index",
      parent_spawn: hasCodexSpawns
        ? "response spawn_agent function call"
        : agentMessages.length
          ? "response spawn_agent tool call"
          : "response Agent tool_use",
      parent_return: returns.some((item) => item.evidence === "wait_agent")
        ? "wait_agent function_call_output"
        : agentMessages.length
          ? "upstream agent_message author/recipient"
          : "request Agent tool_result",
    },
    branches,
    spawns: spawnCalls.map(publicSpawn),
    returns: graphReturns,
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

function collectParentReturnEvidence(requests, spawnCalls, semantics) {
  const returns = [];
  const launches = [];
  const failedSpawnIds = new Set();
  const spawnById = new Map(spawnCalls.map((call) => [call.id, call]));
  const toolCallById = new Map();
  for (const request of requests || []) {
    for (const call of responseToolCalls(request)) {
      if (call?.id) toolCallById.set(call.id, call);
    }
  }
  for (const request of requests || []) {
    for (const result of request.summary?.current_tool_results || []) {
      const spawn = result.id ? spawnById.get(result.id) : null;
      if (!spawn) continue;
      if (isCodexAgentSpawn(spawn)) {
        const payload = parseToolResultPayload(result.content);
        const agentId = payload?.agent_id || payload?.task_name || null;
        if (!agentId) {
          failedSpawnIds.add(spawn.id);
          continue;
        }
        launches.push({
          spawn_id: spawn.id,
          parent_request_id: request.id,
          parent_request_index: request.request_index,
          agent_id: agentId,
          nickname: payload?.nickname || null,
          result_preview: semantics.previewText(result.content, 260),
        });
        continue;
      }
      returns.push({
        spawn_id: spawn.id,
        parent_request_id: request.id,
        parent_request_index: request.request_index,
        result_preview: semantics.previewText(result.content, 260),
      });
    }
  }

  const launchByAgentId = new Map(launches.map((launch) => [launch.agent_id, launch]));
  for (const request of requests || []) {
    for (const result of request.summary?.current_tool_results || []) {
      const call = result.id ? toolCallById.get(result.id) : null;
      if (String(call?.name || "").toLowerCase() !== "wait_agent") continue;
      for (const completed of parseCodexWaitResults(result.content)) {
        const launch = launchByAgentId.get(completed.agent_id);
        if (!launch) continue;
        returns.push({
          spawn_id: launch.spawn_id,
          parent_request_id: request.id,
          parent_request_index: request.request_index,
          agent_id: completed.agent_id,
          result_status: completed.status,
          result_preview: semantics.previewText(completed.result || result.content, 260),
          evidence: "wait_agent",
        });
      }
    }

    for (const block of request.summary?.entry?.harness_blocks || []) {
      if (block?.tag !== "subagent_notification") continue;
      const payload = parseToolResultPayload(block.text);
      const agentId = payload?.agent_path || payload?.agent_id || null;
      const completed = terminalAgentStatus(agentId, payload?.status);
      const launch = completed ? launchByAgentId.get(completed.agent_id) : null;
      if (!launch || returns.some((item) => item.spawn_id === launch.spawn_id)) continue;
      returns.push({
        spawn_id: launch.spawn_id,
        parent_request_id: request.id,
        parent_request_index: request.request_index,
        agent_id: completed.agent_id,
        result_status: completed.status,
        result_preview: semantics.previewText(completed.result || block.text, 260),
        evidence: "subagent_notification",
      });
    }
  }

  return {
    returns: [...new Map(returns.map((item) => [item.spawn_id, item])).values()],
    launches,
    failedSpawnIds,
  };
}

function spawnRecord(call, request, order, semantics) {
  const traceSpawn = call.trace?.agent_spawn || null;
  const semanticSpawn = call.semantic?.kind === "subagent_spawn" ? call.semantic : null;
  const argumentsValue = call.arguments || {};
  return {
    id: call.id || `spawn-${request.request_index}-${order + 1}`,
    name: call.name || "Agent",
    parent_request_id: request.id,
    parent_request_index: request.request_index,
    order,
    label: spawnLabel(call),
    description: semantics.previewText(
      traceSpawn?.description ||
        semanticSpawn?.agent_label ||
        call.arguments?.description ||
        call.arguments?.taskName ||
        call.arguments?.task_name ||
        call.arguments?.subagent_type ||
        "",
      120,
    ),
    prompt_preview:
      traceSpawn?.prompt_preview ||
      semanticSpawn?.prompt_preview ||
      semantics.previewText(spawnPrompt(call), 220),
    subagent_type: spawnType(call),
    context_mode: argumentsValue.fork_turns || semanticSpawn?.context_mode || null,
    task_message_visibility:
      semanticSpawn?.task_message_visibility || taskMessageVisibility(argumentsValue.message),
    raw_arguments: call.arguments ?? null,
  };
}

function buildBranch({ agentId, group, index, spawn, launch, returned, semantics }) {
  const identitySource = group[0]?.trace?.agent_identity_source || null;
  const exactCodexIdentity = identitySource === "client_metadata" && launch?.agent_id === agentId;
  return {
    id: `branch-${index + 1}-${agentId}`,
    label: launch?.nickname || spawn?.description || spawn?.subagent_type || `子 Agent ${index + 1}`,
    agent_id: agentId,
    agent_type: semantics.childAgentType(group[0], spawn),
    confidence: exactCodexIdentity ? "high_agent_id" : spawn ? "high_ordered" : "high_agent_id",
    linkage_note: exactCodexIdentity
      ? "通过父级 spawn_agent 回执的 agent_id 与子请求 client_metadata.thread_id 强关联；结果由 wait_agent 回流闭合。"
      : spawn
        ? "通过子 Agent 实例顺序与父级 Agent tool_use 顺序关联；子分支内部由 x-claude-code-agent-id 强关联。"
        : "通过稳定子 Agent 实例 ID 强关联；未找到可配对的父级启动调用。",
    spawn: spawn ? publicSpawn(spawn) : null,
    launch,
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

function buildAgentMessageBranch({ agentId, messages, index, spawn, launch, returned: observedReturn, semantics }) {
  const ordered = [...(messages || [])].sort((left, right) => compareRequestsByIndex(left.request, right.request));
  const returnedMessage = [...ordered].reverse().find((item) => item.summary?.status === "completed") || null;
  const returned = observedReturn || (returnedMessage
    ? {
        id: `return:${spawn?.id || agentId || index + 1}`,
        spawn_id: spawn?.id || `agent:${agentId || index + 1}`,
        parent_request_id: returnedMessage.request.id,
        parent_request_index: returnedMessage.request.request_index,
        result_preview: semantics.previewText(returnedMessage.summary?.result || returnedMessage.summary?.preview || "", 260),
      }
    : null);
  const label = launch?.nickname || spawn?.description || spawn?.label || returnedMessage?.summary?.name || `Subagent ${index + 1}`;
  return {
    id: `branch-${index + 1}-${agentId || spawn?.id || "agent-message"}`,
    label,
    agent_id: agentId || spawn?.id || `agent-message-${index + 1}`,
    agent_type: "Codex Agent",
    confidence: spawn && ordered.length ? "high_agent_message" : ordered.length ? "high_agent_id" : "medium_spawn_only",
    linkage_note: observedReturn
      ? "通过 spawn_agent 启动回执中的 agent_id 与 wait_agent 终态结果关联；当前未捕获子线程自身的模型请求。"
      : returnedMessage
        ? "通过 spawn_agent task_name 与 agent_message author 强关联；启动回执与业务结果分开呈现。"
        : ordered.length
          ? "已捕获子 Agent 消息，但尚未观察到 FINAL_ANSWER 业务结果。"
          : "已捕获 spawn_agent 启动及回执，尚未观察到对应 agent_message 业务结果。",
    spawn: spawn ? publicSpawn(spawn) : null,
    launch,
    return: returned,
    request_ids: ordered.map((item) => item.request.id),
    request_indexes: ordered.map((item) => item.request.request_index),
    first_request_index: ordered[0]?.request?.request_index || spawn?.parent_request_index || null,
    last_request_index: ordered.at(-1)?.request?.request_index || spawn?.parent_request_index || null,
    response_tool_call_count: 0,
    request_tool_result_count: 0,
    status: returned ? "returned" : "running",
    steps: ordered.map((item) => ({
      request_id: item.request.id,
      request_index: item.request.request_index,
      response_id: null,
      response_captured: true,
      finish_reason: item.summary?.message_type || "agent_message",
      event_type: "agent_message",
      response_tool_calls: [],
      request_tool_results: [],
      response_preview: semantics.previewText(item.summary?.result || item.summary?.preview || "", 220),
    })),
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
    annotateParentBranch(requestById.get(branch.launch?.parent_request_id), "launch_branch_ids", branch.id);
    annotateParentBranch(requestById.get(branch.return?.parent_request_id), "returned_branch_ids", branch.id);
    annotateParentEvent(requestById.get(branch.spawn?.parent_request_id), "agent_spawn_events", {
      branch_id: branch.id,
      spawn_id: branch.spawn?.id || null,
      name: branch.spawn?.name || null,
      label: branch.spawn?.label || branch.label || null,
      description: branch.spawn?.description || null,
      subagent_type: branch.spawn?.subagent_type || branch.agent_type || null,
      context_mode: branch.spawn?.context_mode || null,
      task_message_visibility: branch.spawn?.task_message_visibility || null,
      prompt_preview: branch.spawn?.prompt_preview || null,
    });
    annotateParentEvent(requestById.get(branch.launch?.parent_request_id), "agent_launch_events", {
      branch_id: branch.id,
      spawn_id: branch.launch?.spawn_id || branch.spawn?.id || null,
      agent_id: branch.launch?.agent_id || branch.agent_id || null,
      result_preview: branch.launch?.result_preview || null,
    });
    annotateParentEvent(requestById.get(branch.return?.parent_request_id), "agent_return_events", {
      branch_id: branch.id,
      spawn_id: branch.return?.spawn_id || branch.spawn?.id || null,
      agent_id: branch.agent_id || null,
      result_preview: branch.return?.result_preview || null,
    });
  }
}

function annotateParentBranch(request, field, branchId) {
  if (!request) return;
  request.trace ||= {};
  request.trace[field] ||= [];
  request.trace[field].push(branchId);
}

function annotateParentEvent(request, field, event) {
  if (!request || !event?.branch_id) return;
  request.trace ||= {};
  request.trace[field] ||= [];
  if (request.trace[field].some((item) => item.branch_id === event.branch_id && item.spawn_id === event.spawn_id)) return;
  request.trace[field].push(event);
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
    context_mode: spawn.context_mode || null,
    task_message_visibility: spawn.task_message_visibility || null,
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
  return call.arguments?.prompt || call.arguments?.task || call.arguments?.message || call.semantic?.prompt_preview || "";
}

function spawnType(call) {
  return (
    call.trace?.agent_spawn?.subagent_type ||
    call.semantic?.subagent_type ||
    call.arguments?.subagent_type ||
    call.arguments?.agent_type ||
    call.arguments?.agentType ||
    call.arguments?.type ||
    null
  );
}

function spawnLabel(call) {
  const traceSpawn = call.trace?.agent_spawn || null;
  const args = call.arguments || {};
  return (
    traceSpawn?.description ||
    call.semantic?.agent_label ||
    args.description ||
    args.taskName ||
    args.task_name ||
    traceSpawn?.subagent_type ||
    args.subagent_type ||
    args.agent_type ||
    call.name ||
    "Agent"
  );
}

function spawnPromptKey(call, normalizePrompt) {
  return call.trace?.agent_spawn?.prompt_key || promptKey(spawnPrompt(call), normalizePrompt);
}

function isAgentSpawnTool(name) {
  return AGENT_SPAWN_TOOL.test(String(name || ""));
}

function isCodexAgentSpawn(spawn) {
  return String(spawn?.name || "").toLowerCase() === "spawn_agent";
}

function collectAgentMessages(requests, semantics) {
  if (typeof semantics.extractAgentMessages !== "function") return [];
  const output = [];
  for (const request of requests || []) {
    for (const item of semantics.extractAgentMessages(request) || []) {
      if (!item?.summary) continue;
      output.push({ request, message: item.message || null, summary: item.summary });
    }
  }
  return output;
}

function messageMatchesSpawn(item, spawn, launch) {
  const author = String(item?.summary?.author || "").trim();
  if (!author) return false;
  if (launch?.agent_id && author === launch.agent_id) return true;
  const taskName = String(spawn?.raw_arguments?.task_name || spawn?.description || "").trim();
  return Boolean(taskName && (author === taskName || author.endsWith(`/${taskName}`)));
}

function codexAgentIdFromSpawn(spawn) {
  const taskName = String(spawn?.raw_arguments?.task_name || spawn?.description || spawn?.label || "").trim();
  return taskName || `spawn:${spawn?.id || "unknown"}`;
}

function parseToolResultPayload(content) {
  if (content && typeof content === "object") return content;
  try {
    const parsed = JSON.parse(String(content || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseCodexWaitResults(content) {
  const payload = parseToolResultPayload(content);
  const statusMap = payload?.status;
  if (statusMap && typeof statusMap === "object" && !Array.isArray(statusMap)) {
    return Object.entries(statusMap)
      .map(([agentId, status]) => terminalAgentStatus(agentId, status))
      .filter(Boolean);
  }

  const output = [];
  const pattern = /"([^"]+)"\s*:\s*\{\s*"(completed|failed|errored|error|cancelled|canceled|closed|shutdown|not_found)"\s*:/gi;
  for (const match of String(content || "").matchAll(pattern)) {
    output.push({ agent_id: match[1], status: normalizedTerminalStatus(match[2]), result: String(content || "") });
  }
  return output;
}

function terminalAgentStatus(agentId, value) {
  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedAgentId || !value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["completed", "failed", "errored", "error", "cancelled", "canceled", "closed", "shutdown", "not_found"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const result = value[key];
    return {
      agent_id: normalizedAgentId,
      status: normalizedTerminalStatus(key),
      result: typeof result === "string" ? result : JSON.stringify(result ?? null),
    };
  }
  return null;
}

function normalizedTerminalStatus(value) {
  return String(value || "").toLowerCase() === "completed" ? "completed" : "failed";
}

function taskMessageVisibility(value) {
  if (typeof value !== "string" || !value.trim()) return "missing";
  return /^gAAAA[A-Za-z0-9_=-]+$/.test(value.trim()) ? "encrypted_in_rollout" : "visible";
}

function compareRequestsByIndex(left, right) {
  return Number(left?.request_index || 0) - Number(right?.request_index || 0);
}

function assertSemantics(semantics) {
  for (const name of ["extractHistoryToolCalls", "firstUserPromptText", "normalizePrompt", "previewText", "stableJson", "childAgentType"]) {
    if (typeof semantics[name] !== "function") throw new Error(`subagent graph semantics.${name} is required`);
  }
}
