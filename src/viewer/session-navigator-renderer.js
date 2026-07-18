export function renderSessionNavigator(view, { escapeHtml, translate }) {
  if (!view) return "";
  if (typeof escapeHtml !== "function") throw new Error("escapeHtml is required");
  if (typeof translate !== "function") throw new Error("translate is required");
  return `
    ${renderFamilySelector(view, { escapeHtml, translate })}
    <div class="source-family-sessions">
      ${view.agentGroups.map((agentGroup) => renderAgentGroup(agentGroup, { escapeHtml, translate })).join("")}
    </div>
  `;
}

function renderFamilySelector(view, { escapeHtml, translate }) {
  if (!view.families?.length) return "";
  return `
    <label class="source-family-control">
      <span>${escapeHtml(translate("observedAgent"))}</span>
      <select data-source-family-select aria-label="${escapeHtml(translate("observedAgentAria"))}">
        ${view.families
          .map(
            (family) =>
              `<option value="${escapeHtml(family.key)}" ${family.active ? "selected" : ""}>${escapeHtml(family.label)} · ${family.count}</option>`,
          )
          .join("")}
      </select>
    </label>
  `;
}

function renderAgentGroup(agentGroup, dependencies) {
  const { escapeHtml } = dependencies;
  return `
    <section class="source-agent-group">
      ${agentGroup.showTitle ? `<p class="source-agent-title">${escapeHtml(agentGroup.agent)}</p>` : ""}
      ${agentGroup.projects.map((projectGroup) => renderProjectGroup(projectGroup, dependencies)).join("")}
    </section>
  `;
}

function renderProjectGroup(projectGroup, { escapeHtml, translate }) {
  return `
    <section class="source-project-group ${projectGroup.collapsed ? "collapsed" : ""} ${projectGroup.menuOpen ? "menu-open" : ""}">
      <div class="source-project-header">
        <button class="source-project-toggle" type="button" data-project-toggle="${escapeHtml(projectGroup.key)}" aria-expanded="${String(!projectGroup.collapsed)}" title="${escapeHtml(projectGroup.workspace || projectGroup.project)}">
          <span class="source-project-chevron" aria-hidden="true">›</span>
          <span class="source-project-name">${escapeHtml(projectGroup.project)}</span>
          <span class="source-project-count">${projectGroup.sources.length}</span>
        </button>
        <span class="source-project-actions" aria-label="${escapeHtml(translate("projectActionsAria"))}">
          <button class="session-action menu-trigger" type="button" data-project-action="menu" data-project-key="${escapeHtml(projectGroup.key)}" title="${escapeHtml(translate("moreActions"))}" aria-haspopup="menu" aria-expanded="${String(projectGroup.menuOpen)}">⋯</button>
        </span>
        ${renderProjectMenu(projectGroup, { escapeHtml, translate })}
      </div>
      ${projectGroup.collapsed ? "" : `<div class="source-project-sessions">${projectGroup.sourceViews.map((source) => renderSessionItem(source, { escapeHtml, translate })).join("")}</div>`}
    </section>
  `;
}

function renderProjectMenu(projectGroup, { escapeHtml, translate }) {
  if (!projectGroup.menuOpen) return "";
  return `<div class="session-menu project-menu" role="menu">
    <button type="button" role="menuitem" data-project-action="archive" data-project-key="${escapeHtml(projectGroup.key)}">${escapeHtml(translate("archiveProject"))}</button>
    ${projectGroup.canDelete ? `<button class="danger" type="button" role="menuitem" data-project-action="delete" data-project-key="${escapeHtml(projectGroup.key)}">${escapeHtml(translate("deleteProjectData"))}</button>` : ""}
  </div>`;
}

function renderSessionItem(source, { escapeHtml, translate }) {
  return `
    <div class="session-item ${source.active ? "active" : ""} ${source.pinned ? "pinned" : ""} ${source.menuOpen ? "menu-open" : ""}" data-status="${escapeHtml(source.status)}">
      <button class="session-main" type="button" data-source="${escapeHtml(source.id)}" title="${escapeHtml(source.label)}" ${source.available ? "" : "disabled"}>
        <span class="session-dot" aria-hidden="true"></span>
        <span class="session-copy">
          <span class="session-title">${escapeHtml(source.label)}</span>
          <span class="session-subtitle">${escapeHtml(source.subtitle)} · ${escapeHtml(source.requestLabel)}</span>
        </span>
      </button>
      <span class="session-actions" aria-label="${escapeHtml(translate("sessionActionsAria"))}">
        <button class="session-action menu-trigger" type="button" data-source-action="menu" data-source-id="${escapeHtml(source.id)}" title="${escapeHtml(translate("moreActions"))}" aria-haspopup="menu" aria-expanded="${String(source.menuOpen)}">⋯</button>
      </span>
      ${renderSessionMenu(source, { escapeHtml, translate })}
    </div>
  `;
}

function renderSessionMenu(source, { escapeHtml, translate }) {
  if (!source.menuOpen) return "";
  return `<div class="session-menu" role="menu">
    <button type="button" role="menuitem" data-source-action="pin" data-source-id="${escapeHtml(source.id)}">${escapeHtml(source.pinLabel)}</button>
    <button type="button" role="menuitem" data-source-action="rename" data-source-id="${escapeHtml(source.id)}">${escapeHtml(translate("rename"))}</button>
    <button type="button" role="menuitem" data-source-action="export" data-source-id="${escapeHtml(source.id)}">${escapeHtml(translate("exportTrace"))}</button>
    <button type="button" role="menuitem" data-source-action="archive" data-source-id="${escapeHtml(source.id)}">${escapeHtml(translate("archive"))}</button>
    ${source.canDelete ? `<button class="danger" type="button" role="menuitem" data-source-action="delete" data-source-id="${escapeHtml(source.id)}">${escapeHtml(translate("deleteData"))}</button>` : ""}
  </div>`;
}
