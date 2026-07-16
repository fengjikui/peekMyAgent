export function buildSessionNavigatorView({
  sources = [],
  activeSourceId = null,
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

  return {
    agentGroups: groupSourcesByAgentAndProject(sources, {
      translate,
      projectNameFromWorkspace,
      projectGroupKey,
    }).map((agentGroup) => ({
      agent: agentGroup.agent,
      projects: agentGroup.projects.map((projectGroup) => {
        const collapsed = collapsedProjects[projectGroup.key] === true;
        return {
          ...projectGroup,
          collapsed,
          menuOpen: openProjectMenuKey === projectGroup.key,
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
  const label = displaySourceLabel(source.label);
  return {
    id: source.id || "",
    active: source.id === activeSourceId,
    available: Boolean(source.available),
    pinned: Boolean(source.pinned),
    menuOpen: openSourceMenuId === source.id,
    status: source.live_watch_id ? source.live_status || "stopped" : "static",
    label,
    subtitle: source.conversation_id ? shortId(source.conversation_id) : source.agent || "",
    requestLabel: translate("requestUnit", { count: source.request_count || 0 }),
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
