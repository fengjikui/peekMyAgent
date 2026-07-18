export const TURN_STORY_MAX_STEPS = 7;

const ORCHESTRATION_TOOL_NAMES = new Set(["spawn_agent", "wait_agent", "close_agent", "send_message"]);

export function buildTurnStoryView({
  turn,
  requests,
  agentTrace,
  translate,
  maxSteps = TURN_STORY_MAX_STEPS,
} = {}) {
  const orderedRequests = [...(Array.isArray(requests) ? requests : [])].sort(
    (left, right) => Number(left?.request_index || 0) - Number(right?.request_index || 0),
  );
  if (!orderedRequests.length || typeof translate !== "function") return null;

  const branches = turnAgentBranches(turn, agentTrace);
  const callIndex = responseToolCallIndex(orderedRequests);
  const finalResponseRequest = [...orderedRequests].reverse().find((request) => isFinalAnswerRequest(request));
  const hasToolExchange = orderedRequests.some(
    (request) => (request?.summary?.response?.tool_calls?.length || 0) + (request?.summary?.current_tool_results?.length || 0) > 0,
  );
  const hasLifecycle = orderedRequests.some((request) => semanticEventFor(request));
  if (!hasToolExchange && !hasLifecycle && !branches.length) return null;

  const orchestrationCallIds = new Set(branches.map((branch) => branch?.spawn?.id).filter(Boolean));
  const events = [];
  const leadRequest = orderedRequests.find((request) => isUserEntry(request)) || orderedRequests[0];
  if (isUserEntry(leadRequest)) {
    events.push(
      storyStep({
        kind: "user",
        label: translate(leadRequest?.summary?.command_message ? "turnStoryUserCommand" : "turnStoryUserRequest"),
        request: leadRequest,
        order: eventOrder(leadRequest, 0),
      }),
    );
  }

  for (const request of orderedRequests) {
    const results = request?.summary?.current_tool_results || [];
    const resultGroups = new Map();
    for (const result of results) {
      const call = callIndex.get(result?.id || result?.tool_use_id || "");
      if (shouldAggregateAgentCall(call, orchestrationCallIds, branches.length)) continue;
      const descriptor = toolDescriptor(call);
      const key = `${descriptor.kind}:${descriptor.name}`;
      if (!resultGroups.has(key)) resultGroups.set(key, descriptor);
    }
    let resultOffset = 10;
    for (const descriptor of resultGroups.values()) {
      events.push(
        storyStep({
          kind: descriptor.kind === "skill" ? "skill-result" : "tool-result",
          label:
            descriptor.kind === "skill"
              ? translate("turnStorySkillResult", { skill: descriptor.name })
              : translate("turnStoryToolResult", { tool: descriptor.name }),
          request,
          order: eventOrder(request, resultOffset++),
        }),
      );
    }

    let callOffset = 30;
    for (const call of request?.summary?.response?.tool_calls || []) {
      if (shouldAggregateAgentCall(call, orchestrationCallIds, branches.length)) continue;
      const descriptor = toolDescriptor(call);
      events.push(
        storyStep({
          kind: descriptor.kind === "skill" ? "skill" : "tool-call",
          label:
            descriptor.kind === "skill"
              ? translate(descriptor.semanticKind === "skill_load" ? "skillLoadObserved" : "skillInstructionReadObserved", {
                  skill: descriptor.name,
                })
              : translate("turnStoryCallTool", { tool: descriptor.name }),
          request,
          order: eventOrder(request, callOffset++),
        }),
      );
    }

    const lifecycle = semanticEventFor(request);
    if (lifecycle?.type === "context_compacted") {
      events.push(
        storyStep({
          kind: "lifecycle",
          label: translate("turnStoryContextCompacted"),
          request,
          order: eventOrder(request, 60),
        }),
      );
    }

    if (request === finalResponseRequest) {
      events.push(
        storyStep({
          kind: "answer",
          label: translate("turnStoryFinalAnswer"),
          request,
          order: eventOrder(request, 90),
        }),
      );
    }
  }

  addAgentLifecycleEvents(events, branches, translate);
  const steps = collapseStorySteps(dedupeSteps(events.sort((left, right) => left.order - right.order)), maxSteps, translate);
  if (steps.length < 2) return null;
  return {
    turnId: String(turn?.id || ""),
    steps,
  };
}

function addAgentLifecycleEvents(events, branches, translate) {
  if (!branches.length) return;
  const spawnEvents = branches.map((branch) => branch.spawn).filter(Boolean);
  const launchEvents = branches.map((branch) => branch.launch).filter(Boolean);
  const returnEvents = branches.map((branch) => branch.return).filter(Boolean);
  if (spawnEvents.length) {
    events.push(
      aggregateAgentStep({
        kind: "agent-spawn",
        label: translate("turnStorySpawnAgents", { count: spawnEvents.length }),
        events: spawnEvents,
        offset: 35,
      }),
    );
  }
  if (launchEvents.length) {
    events.push(
      aggregateAgentStep({
        kind: "agent-launch",
        label: translate("turnStoryAgentLaunches", { count: launchEvents.length, total: branches.length }),
        events: launchEvents,
        offset: 45,
      }),
    );
  }
  if (returnEvents.length) {
    events.push(
      aggregateAgentStep({
        kind: "agent-return",
        label: translate("turnStoryAgentReturns", { count: returnEvents.length, total: branches.length }),
        events: returnEvents,
        offset: 55,
      }),
    );
  }
}

function aggregateAgentStep({ kind, label, events, offset }) {
  const first = [...events].sort((left, right) => Number(left?.parent_request_index || 0) - Number(right?.parent_request_index || 0))[0];
  return {
    kind,
    label,
    requestId: String(first?.parent_request_id || ""),
    requestIndex: Number(first?.parent_request_index || 0) || null,
    order: Number(first?.parent_request_index || 0) * 100 + offset,
  };
}

function storyStep({ kind, label, request, order }) {
  return {
    kind,
    label: String(label || ""),
    requestId: String(request?.id || ""),
    requestIndex: Number(request?.request_index || 0) || null,
    order,
  };
}

function eventOrder(request, offset) {
  return Number(request?.request_index || 0) * 100 + offset;
}

function responseToolCallIndex(requests) {
  const index = new Map();
  for (const request of requests) {
    for (const call of request?.summary?.response?.tool_calls || []) {
      if (call?.id) index.set(call.id, call);
    }
  }
  return index;
}

function toolDescriptor(call) {
  const semantic = call?.semantic || {};
  if (semantic.kind === "skill_load" || semantic.kind === "skill_instruction_read") {
    return {
      kind: "skill",
      name: semantic.skill_name || call?.name || "unknown",
      semanticKind: semantic.kind,
    };
  }
  const nestedNames = (semantic.nested_tool_names || []).filter(Boolean);
  return {
    kind: "tool",
    name: nestedNames.length ? nestedNames.join(" / ") : call?.name || "tool",
    semanticKind: semantic.kind || null,
  };
}

function shouldAggregateAgentCall(call, orchestrationCallIds, hasBranches) {
  if (!hasBranches || !call) return false;
  return orchestrationCallIds.has(call.id) || ORCHESTRATION_TOOL_NAMES.has(String(call.name || "").toLocaleLowerCase());
}

function turnAgentBranches(turn, agentTrace) {
  const branchIds = new Set(Array.isArray(turn?.agent_branches) ? turn.agent_branches : []);
  return (Array.isArray(agentTrace?.branches) ? agentTrace.branches : []).filter((branch) => branchIds.has(branch.id));
}

function semanticEventFor(request) {
  return request?.summary?.entry?.semantic_event || request?.semantic_event || null;
}

function isUserEntry(request) {
  const kind = request?.summary?.entry?.kind;
  return kind === "user_input" || Boolean(request?.summary?.command_message);
}

function isFinalAnswerRequest(request) {
  const response = request?.summary?.response;
  return Boolean(response?.captured && response?.text && response.finish_reason !== "tool_use");
}

function dedupeSteps(steps) {
  const deduped = [];
  for (const step of steps) {
    const previous = deduped.at(-1);
    if (previous?.kind === step.kind && previous?.label === step.label && previous?.requestId === step.requestId) continue;
    deduped.push(step);
  }
  return deduped;
}

function collapseStorySteps(steps, maxSteps, translate) {
  const limit = Math.max(4, Math.floor(Number(maxSteps) || TURN_STORY_MAX_STEPS));
  if (steps.length <= limit) return steps;
  const leading = Math.ceil((limit - 1) / 2);
  const trailing = limit - leading - 1;
  const hidden = steps.length - leading - trailing;
  return [
    ...steps.slice(0, leading),
    {
      kind: "collapsed",
      label: translate("turnStoryMoreSteps", { count: hidden }),
      requestId: "",
      requestIndex: null,
      order: Number.NaN,
    },
    ...steps.slice(-trailing),
  ];
}
