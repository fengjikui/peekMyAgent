export const AGENT_BRANCH_PAGE_SIZE = 24;
export const AGENT_EVENT_LIMIT = 80;
export const AGENT_SUMMARY_DOT_LIMIT = 8;
export const AGENT_STATUS_FILTER_THRESHOLD = 6;

const AGENT_BRANCH_COLORS = ["#2563eb", "#16a34a", "#b4690e", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d"];
const AGENT_STATUS_FILTERS = new Set(["all", "running", "completed", "returned"]);

export function buildAgentGraphView({
  turn,
  trace,
  dashboardOpen = false,
  activeFilter = "all",
  branchLimit = AGENT_BRANCH_PAGE_SIZE,
  expandedBranchIds = new Set(),
} = {}) {
  const turnId = String(turn?.id || "");
  const branchIds = new Set(Array.isArray(turn?.agent_branches) ? turn.agent_branches : []);
  const branches = (Array.isArray(trace?.branches) ? trace.branches : [])
    .filter((branch) => branchIds.has(branch.id))
    .sort((left, right) => Number(left.first_request_index || 0) - Number(right.first_request_index || 0));
  if (!branches.length) return null;

  const normalizedFilter = AGENT_STATUS_FILTERS.has(activeFilter) ? activeFilter : "all";
  const branchEntries = branches.map((branch, index) => {
    const returnStepIndex = (branch.steps || []).findIndex((step) => stepRepresentsReturn(step, branch.return));
    return {
      branch,
      index,
      color: agentBranchColor(index),
      expanded: expandedBranchIds.has(branch.id),
      detailSteps: (branch.steps || []).map((step, stepIndex) => ({
        step,
        representsReturn: stepIndex === returnStepIndex,
        displayPreview:
          stepIndex === returnStepIndex ? branch.return?.result_preview || step.response_preview : step.response_preview,
      })),
      returnEdge: returnStepIndex >= 0 ? null : branch.return,
      returnRepresentedByStep: returnStepIndex >= 0,
    };
  });
  const filteredEntries = normalizedFilter === "all" ? branchEntries : branchEntries.filter(({ branch }) => branch.status === normalizedFilter);
  const normalizedLimit = Math.max(AGENT_BRANCH_PAGE_SIZE, Math.floor(Number(branchLimit) || AGENT_BRANCH_PAGE_SIZE));
  const visibleBranches = filteredEntries.slice(0, normalizedLimit);
  const hiddenBranchCount = Math.max(0, filteredEntries.length - visibleBranches.length);
  const statusCounts = {
    returned: branches.filter((branch) => branch.status === "returned").length,
    completed: branches.filter((branch) => branch.status === "completed").length,
    running: branches.filter((branch) => branch.status === "running").length,
  };
  const allEvents = agentFlowEvents(filteredEntries);

  return {
    turnId,
    dashboardOpen: Boolean(dashboardOpen),
    activeFilter: normalizedFilter,
    branches,
    branchCount: branches.length,
    typeEntries: branchEntries,
    summaryDots: branchEntries.slice(0, AGENT_SUMMARY_DOT_LIMIT).map(({ color }) => color),
    summaryOverflow: Math.max(0, branches.length - AGENT_SUMMARY_DOT_LIMIT),
    spawnIndexes: uniqueIndexes(branches, (branch) => branch.spawn?.parent_request_index),
    launchIndexes: uniqueIndexes(branches, (branch) => branch.launch?.parent_request_index),
    returnIndexes: uniqueIndexes(branches, (branch) => branch.return?.parent_request_index),
    statusCounts,
    showStatusFilters: branches.length > AGENT_STATUS_FILTER_THRESHOLD,
    confidence: trace?.confidence,
    summary: {
      branches: branches.length,
      requests: branches.reduce((sum, branch) => sum + (branch.request_ids?.length || 0), 0),
      returned: statusCounts.returned,
      calls: branches.reduce((sum, branch) => sum + (branch.response_tool_call_count || 0), 0),
      results: branches.reduce((sum, branch) => sum + (branch.request_tool_result_count || 0), 0),
      signal: trace?.signals?.child_instance || "agent id",
    },
    filteredCount: filteredEntries.length,
    visibleBranches,
    hiddenBranchCount,
    nextPageCount: Math.min(AGENT_BRANCH_PAGE_SIZE, hiddenBranchCount),
    events: allEvents.slice(0, AGENT_EVENT_LIMIT),
    eventCount: allEvents.length,
  };
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

function stepRepresentsReturn(step, returned) {
  if (step?.event_type !== "agent_message" || !returned) return false;
  return (
    Boolean(step.request_id && returned.parent_request_id) &&
    step.request_id === returned.parent_request_id &&
    Number(step.request_index || 0) === Number(returned.parent_request_index || 0)
  );
}

export function agentStepEventType(step = {}) {
  if (step.event_type === "agent_message") return "return";
  if (step.request_tool_results?.length) return "tool_result";
  if (step.response_tool_calls?.length) return "tool_use";
  if (step.finish_reason === "end_turn") return "done";
  return "request";
}

function agentBranchColor(index) {
  return AGENT_BRANCH_COLORS[index % AGENT_BRANCH_COLORS.length];
}

function uniqueIndexes(branches, pick) {
  return [...new Set(branches.map(pick).filter(Boolean))];
}

function agentEvent(branchIndex, type, requestId, requestIndex, order) {
  return { branchIndex, type, requestId, requestIndex, order };
}
