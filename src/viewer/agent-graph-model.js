export const AGENT_SUMMARY_DOT_LIMIT = 8;

const AGENT_BRANCH_COLORS = [
  "oklch(56% 0.2 258)",
  "oklch(52% 0.12 155)",
  "oklch(55% 0.13 302)",
  "oklch(57% 0.13 75)",
  "oklch(54% 0.19 27)",
  "oklch(55% 0.11 210)",
  "oklch(58% 0.14 340)",
  "oklch(52% 0.12 125)",
];
const AGENT_BRANCH_GLYPHS = ["circle", "square", "diamond", "triangle", "hexagon", "cross"];

export function buildAgentGraphView({ turn, trace, dashboardOpen = false, selectedBranchId = null } = {}) {
  const turnId = String(turn?.id || "");
  const branchIds = new Set(Array.isArray(turn?.agent_branches) ? turn.agent_branches : []);
  const branches = (Array.isArray(trace?.branches) ? trace.branches : [])
    .filter((branch) => branchIds.has(branch.id))
    .sort((left, right) => Number(left.first_request_index || 0) - Number(right.first_request_index || 0));
  if (!branches.length) return null;

  const branchEntries = branches.map((branch, index) => ({
    branch,
    index,
    displayName: agentBranchDisplayName(branch, index),
    visual: agentBranchVisualIdentity(branch),
  }));
  const selectedBranch =
    branchEntries.find((entry) => entry.branch.id === selectedBranchId) || branchEntries[0];
  const statusCounts = {
    returned: branches.filter((branch) => branch.status === "returned").length,
    completed: branches.filter((branch) => branch.status === "completed").length,
    running: branches.filter((branch) => branch.status === "running").length,
  };
  const allEvents = agentFlowEvents(branchEntries);

  return {
    turnId,
    dashboardOpen: Boolean(dashboardOpen),
    branches,
    branchEntries,
    branchCount: branches.length,
    selectedBranch,
    summaryDots: branchEntries.slice(0, AGENT_SUMMARY_DOT_LIMIT).map(({ visual }) => visual),
    summaryOverflow: Math.max(0, branches.length - AGENT_SUMMARY_DOT_LIMIT),
    spawnIndexes: uniqueIndexes(branches, (branch) => branch.spawn?.parent_request_index),
    launchIndexes: uniqueIndexes(branches, (branch) => branch.launch?.parent_request_index),
    returnIndexes: uniqueIndexes(branches, (branch) => branch.return?.parent_request_index),
    statusCounts,
    confidence: trace?.confidence,
    summary: {
      branches: branches.length,
      requests: branches.reduce((sum, branch) => sum + (branch.request_ids?.length || 0), 0),
      returned: statusCounts.returned,
      calls: branches.reduce((sum, branch) => sum + (branch.response_tool_call_count || 0), 0),
      results: branches.reduce((sum, branch) => sum + (branch.request_tool_result_count || 0), 0),
      signal: trace?.signals?.child_instance || "agent id",
    },
    events: allEvents,
    eventCount: allEvents.length,
  };
}

export function agentBranchVisualIdentity(branch = {}) {
  const identity = String(branch.agent_id || branch.id || branch.label || "subagent");
  const hash = stableIdentityHash(identity);
  return {
    identity,
    color: AGENT_BRANCH_COLORS[hash % AGENT_BRANCH_COLORS.length],
    glyph: AGENT_BRANCH_GLYPHS[Math.floor(hash / AGENT_BRANCH_COLORS.length) % AGENT_BRANCH_GLYPHS.length],
  };
}

export function agentBranchDisplayName(branch = {}, index = 0) {
  return (
    branch.launch?.nickname ||
    branch.label ||
    branch.spawn?.description ||
    branch.spawn?.label ||
    branch.agent_type ||
    `Subagent ${index + 1}`
  );
}

export function agentFlowEvents(branchEntries = []) {
  const events = [];
  for (const [displayIndex, entry] of branchEntries.entries()) {
    const branch = entry?.branch || entry;
    const branchIndex = Number.isInteger(entry?.index) ? entry.index : displayIndex;
    if (branch.spawn?.parent_request_index) {
      events.push(agentEvent(branchIndex, "spawn", branch.spawn.parent_request_id, branch.spawn.parent_request_index, events.length));
    }
    if (branch.launch?.parent_request_index) {
      events.push(agentEvent(branchIndex, "launch", branch.launch.parent_request_id, branch.launch.parent_request_index, events.length));
    }
    for (const step of branch.steps || []) {
      events.push(agentEvent(branchIndex, agentStepEventType(step), step.request_id, step.request_index, events.length));
    }
    const returnAlreadyRepresented = (branch.steps || []).some((step) => stepRepresentsReturn(step, branch.return));
    if (branch.return?.parent_request_index && !returnAlreadyRepresented) {
      events.push(agentEvent(branchIndex, "return", branch.return.parent_request_id, branch.return.parent_request_index, events.length));
    }
  }
  return events.sort((left, right) => Number(left.requestIndex || 0) - Number(right.requestIndex || 0) || left.order - right.order);
}

export function agentStepEventType(step = {}) {
  if (step.event_type === "agent_message") return "return";
  if (step.request_tool_results?.length) return "tool_result";
  if (step.response_tool_calls?.length) return "tool_use";
  if (step.finish_reason === "end_turn") return "done";
  return "request";
}

function stepRepresentsReturn(step, returned) {
  if (step?.event_type !== "agent_message" || !returned) return false;
  return (
    Boolean(step.request_id && returned.parent_request_id) &&
    step.request_id === returned.parent_request_id &&
    Number(step.request_index || 0) === Number(returned.parent_request_index || 0)
  );
}

function stableIdentityHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function uniqueIndexes(branches, pick) {
  return [...new Set(branches.map(pick).filter(Boolean))];
}

function agentEvent(branchIndex, type, requestId, requestIndex, order) {
  return { branchIndex, type, requestId, requestIndex, order };
}
