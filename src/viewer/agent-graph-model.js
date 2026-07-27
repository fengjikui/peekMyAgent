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

export function buildAgentGraphView({ turn, trace, selectedBranchId = null, dashboardOpen = false } = {}) {
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

  return {
    turnId,
    dashboardOpen: Boolean(dashboardOpen),
    branches,
    branchEntries,
    branchCount: branches.length,
    selectedBranch,
    spawnIndexes: uniqueIndexes(branches, (branch) => branch.spawn?.parent_request_index),
    launchIndexes: uniqueIndexes(branches, (branch) => branch.launch?.parent_request_index),
    returnIndexes: uniqueIndexes(branches, (branch) => branch.return?.parent_request_index),
    confidence: trace?.confidence,
    signal: trace?.signals?.child_instance || "agent id",
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
