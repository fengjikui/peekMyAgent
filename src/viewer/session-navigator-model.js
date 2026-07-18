import { buildSourceEvidenceView } from "./evidence-view-model.js";

export function buildSessionNavigatorView({
  sources = [],
  activeSourceId = null,
  selectedFamilyKey = null,
  collapsedProjects = {},
  openSourceMenuId = null,
  openProjectMenuKey = null,
  translate,
  projectNameFromWorkspace = defaultProjectNameFromWorkspace,
  projectGroupKey = defaultProjectGroupKey,
  displaySourceLabel = defaultDisplaySourceLabel,
  shortId = defaultShortId,
} = {}) {
  if (typeof translate !== "function") throw new Error("translate is required");

  const families = buildSourceFamilyOptions(sources, {
    activeSourceId,
    selectedFamilyKey,
    translate,
  });
  const activeFamily = families.find((family) => family.active) || families[0] || null;
  const visibleSources = activeFamily
    ? sources.filter((source) => sourceFamilyKey(source) === activeFamily.key)
    : [];

  return {
    families,
    activeFamilyKey: activeFamily?.key || null,
    agentGroups: groupSourcesByAgentAndProject(visibleSources, {
      translate,
      projectNameFromWorkspace,
      projectGroupKey,
    }).map((agentGroup) => ({
      agent: agentGroup.agent,
      showTitle: activeFamily?.kind === "imported",
      projects: agentGroup.projects.map((projectGroup) => {
        const collapsed = collapsedProjects[projectGroup.key] === true;
        return {
          ...projectGroup,
          collapsed,
          menuOpen: openProjectMenuKey === projectGroup.key,
          canDelete: projectGroup.sources.every((source) => source.deletable !== false),
          sourceViews: collapsed
            ? []
            : projectGroup.sources.map((source) =>
                buildSessionItemView(source, {
                  activeSourceId,
                  openSourceMenuId,
                  translate,
                  displaySourceLabel,
                  shortId,
                }),
              ),
        };
      }),
    })),
  };
}

export function buildSourceFamilyOptions(
  sources,
  { activeSourceId = null, selectedFamilyKey = null, translate } = {},
) {
  if (typeof translate !== "function") throw new Error("translate is required");
  const familyMap = new Map();
  for (const source of sources || []) {
    const key = sourceFamilyKey(source);
    if (!familyMap.has(key)) {
      familyMap.set(key, {
        key,
        kind: key === "imported" ? "imported" : "agent",
        label: key === "imported" ? translate("importedTraces") : String(source.agent || translate("unknownAgent")),
        count: 0,
        sources: [],
      });
    }
    const family = familyMap.get(key);
    family.count += 1;
    family.sources.push(source);
  }

  const families = [...familyMap.values()];
  const activeSource = (sources || []).find((source) => source.id === activeSourceId);
  const requestedKey = activeSource ? sourceFamilyKey(activeSource) : selectedFamilyKey;
  const activeKey = families.some((family) => family.key === requestedKey)
    ? requestedKey
    : families[0]?.key || null;
  return families.map((family) => ({
    ...family,
    active: family.key === activeKey,
  }));
}

export function sourceFamilyKey(source) {
  const kind = String(source?.kind || "").toLowerCase();
  if (kind === "imported_trace" || kind === "imported_history") return "imported";
  return `agent:${String(source?.agent || "unknown").trim().toLowerCase() || "unknown"}`;
}

export function groupSourcesByAgentAndProject(
  sources,
  { translate, projectNameFromWorkspace = defaultProjectNameFromWorkspace, projectGroupKey = defaultProjectGroupKey } = {},
) {
  if (typeof translate !== "function") throw new Error("translate is required");
  const agentMap = new Map();
  for (const source of sources || []) {
    const agent = source.agent || "Unknown Agent";
    const project = source.project || projectNameFromWorkspace(source.workspace) || translate("unassignedProject");
    const workspace = source.workspace || "";
    const projectIdentity = workspace || source.project || "__unassigned__";
    const key = projectGroupKey(agent, projectIdentity);
    if (!agentMap.has(agent)) agentMap.set(agent, { agent, projectMap: new Map() });
    const agentGroup = agentMap.get(agent);
    if (!agentGroup.projectMap.has(key)) {
      agentGroup.projectMap.set(key, { key, agent, workspace, project, sources: [] });
    }
    agentGroup.projectMap.get(key).sources.push(source);
  }
  return [...agentMap.values()].map((agentGroup) => ({
    agent: agentGroup.agent,
    projects: [...agentGroup.projectMap.values()],
  }));
}

function buildSessionItemView(
  source,
  { activeSourceId, openSourceMenuId, translate, displaySourceLabel, shortId },
) {
  const codexPending = source.kind === "codex_rollout_pending";
  const label = codexPending ? translate("codexPendingTitle") : displaySourceLabel(source.label);
  const evidence = buildSourceEvidenceView(source, { translate });
  const requestLabel = codexPending
    ? translate("codexPendingRequestLabel")
    : Number.isFinite(source.request_count)
      ? translate("requestUnit", { count: source.request_count })
      : translate("liveTrace");
  return {
    id: source.id || "",
    active: source.id === activeSourceId,
    available: Boolean(source.available),
    pinned: Boolean(source.pinned),
    menuOpen: openSourceMenuId === source.id,
    status: source.live_status || (source.live_watch_id ? "stopped" : "static"),
    canDelete: source.deletable !== false,
    label,
    subtitle: source.conversation_id ? shortId(source.conversation_id) : source.agent || "",
    evidenceMode: evidence.mode,
    requestLabel: [requestLabel, evidence.navigatorSuffix].filter(Boolean).join(" · "),
    pinLabel: source.pinned ? translate("unpin") : translate("pin"),
  };
}

function defaultProjectNameFromWorkspace(workspace) {
  return String(workspace || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function defaultProjectGroupKey(agent, project) {
  return `${encodeURIComponent(agent || "Unknown Agent")}::${encodeURIComponent(project || "")}`;
}

function defaultDisplaySourceLabel(label) {
  return String(label || "").trim();
}

function defaultShortId(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}
