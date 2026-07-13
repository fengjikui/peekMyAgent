export function renderAgentGraph(view, { translate, escapeHtml, shortId, shortPreview }) {
  if (!view) return "";
  const typeNames = [...new Set(view.typeEntries.map((entry) => agentBranchName(entry, translate)))];
  return `
    <details class="agent-branch-map" aria-label="${escapeHtml(translate("multiAgentAria"))}" data-agent-dashboard="${escapeHtml(view.turnId)}" ${view.dashboardOpen ? "open" : ""}>
      <summary class="agent-branch-summary" data-agent-dashboard-toggle="${escapeHtml(view.turnId)}">
        ${view.summaryDots.map((color) => `<span class="agent-summary-dot" style="--branch-color:${escapeHtml(color)}" aria-hidden="true"></span>`).join("")}
        ${view.summaryOverflow ? `<span class="agent-summary-more">+${escapeHtml(String(view.summaryOverflow))}</span>` : ""}
        <strong>${escapeHtml(translate("multiAgentSummary", { count: view.branchCount }))}</strong>
        <span class="agent-branch-summary-types">${escapeHtml(typeNames.join(" / "))}</span>
      </summary>
      ${view.dashboardOpen ? renderAgentDashboard(view, { translate, escapeHtml, shortId, shortPreview }) : ""}
    </details>
  `;
}

function renderAgentDashboard(view, dependencies) {
  const { translate, escapeHtml } = dependencies;
  const { returned, completed, running } = view.statusCounts;
  return `
    <div class="agent-branch-head">
      <div>
        <p>${escapeHtml(translate("branchSummary", view.summary))}</p>
        <p class="agent-branch-status-line">${escapeHtml(translate("branchStatusSummary", { returned, completed, running }))}</p>
      </div>
      <div class="agent-branch-head-meta">
        ${view.spawnIndexes.length ? `<span>spawn #${escapeHtml(view.spawnIndexes.join(", #"))}</span>` : ""}
        ${view.returnIndexes.length ? `<span>return #${escapeHtml(view.returnIndexes.join(", #"))}</span>` : ""}
        <span>${escapeHtml(branchConfidenceLabel(view.confidence, translate))}</span>
      </div>
    </div>
    <div class="agent-branch-toolbar">
      <div class="agent-status-filters" role="group" aria-label="${escapeHtml(translate("agentStatusFilterAria"))}">
        ${renderAgentFilterButton(view.turnId, "all", translate("agentFilterAll", { count: view.branchCount }), view.activeFilter, escapeHtml)}
        ${renderAgentFilterButton(view.turnId, "running", translate("agentFilterRunning", { count: running }), view.activeFilter, escapeHtml)}
        ${renderAgentFilterButton(view.turnId, "completed", translate("agentFilterCompleted", { count: completed }), view.activeFilter, escapeHtml)}
        ${renderAgentFilterButton(view.turnId, "returned", translate("agentFilterReturned", { count: returned }), view.activeFilter, escapeHtml)}
      </div>
      <span>${escapeHtml(translate("agentShowingCount", { shown: view.visibleBranches.length, total: view.filteredCount }))}</span>
    </div>
    <div class="agent-flow-map">
      ${view.visibleBranches.map((entry) => renderAgentMapCard(entry, dependencies)).join("")}
    </div>
    ${renderAgentEventStrip(view, dependencies)}
    <div class="agent-branch-details" aria-label="${escapeHtml(translate("subagentDetails"))}">
      <div class="agent-branch-grid">
        ${
          view.visibleBranches.length
            ? view.visibleBranches.map((entry) => renderAgentBranch(entry, dependencies)).join("")
            : `<p class="agent-filter-empty">${escapeHtml(translate("noAgentsForFilter"))}</p>`
        }
      </div>
      ${
        view.hiddenBranchCount
          ? `<button class="agent-branch-load-more" type="button" data-agent-branch-more="${escapeHtml(view.turnId)}">${escapeHtml(translate("showMoreAgents", { count: view.nextPageCount }))}</button>`
          : ""
      }
    </div>
  `;
}

function renderAgentFilterButton(turnId, filter, label, activeFilter, escapeHtml) {
  return `<button class="agent-status-filter ${filter === activeFilter ? "active" : ""}" type="button" data-agent-status-filter="${escapeHtml(turnId)}" data-agent-filter-value="${escapeHtml(filter)}" aria-pressed="${escapeHtml(String(filter === activeFilter))}">${escapeHtml(label)}</button>`;
}

function renderAgentBranch(entry, dependencies) {
  const { branch, index, color, expanded, firstRequestTitle } = entry;
  const { translate, escapeHtml, shortId, shortPreview } = dependencies;
  const title = branch.label || branch.agent_type || translate("subagentFallback", { index: index + 1 });
  const summary = agentBranchCompactSummary(branch, translate);
  const name = agentBranchName(entry, translate);
  return `
    <article class="agent-branch-card ${expanded ? "" : "collapsed"}" data-branch="${escapeHtml(branch.id)}" style="--branch-color:${escapeHtml(color)}">
      <button class="agent-branch-toggle" type="button" data-agent-branch-toggle="${escapeHtml(branch.id)}" aria-expanded="${escapeHtml(String(expanded))}">
        <span class="agent-branch-index">${escapeHtml(expanded ? "▾" : "▸")}</span>
        <div>
          <strong><span class="agent-type-chip">${escapeHtml(name)}</span> ${escapeHtml(translate("childSeq", { index: index + 1 }))} · ${escapeHtml(title)}</strong>
          <p>${escapeHtml(shortId(branch.agent_id))} · ${escapeHtml(firstRequestTitle)}</p>
          <p class="agent-branch-compact">${escapeHtml(summary)}</p>
        </div>
        <span class="agent-branch-status ${escapeHtml(branch.status || "unknown")}">${escapeHtml(branchStatusLabel(branch.status, translate))}</span>
      </button>
      ${
        expanded
          ? `<div class="agent-branch-body">
              ${branch.spawn ? renderBranchEdge(translate("parentCall"), branch.spawn.parent_request_id, `#${branch.spawn.parent_request_index} · ${branch.spawn.label || branch.spawn.id}`, dependencies) : ""}
              <div class="agent-branch-steps">
                ${(branch.steps || []).map((step) => renderAgentBranchStep(step, dependencies)).join("")}
              </div>
              ${branch.return ? renderBranchEdge(translate("resultReturn"), branch.return.parent_request_id, `#${branch.return.parent_request_index} · ${shortPreview(branch.return.result_preview, 90)}`, dependencies) : ""}
              <p class="agent-branch-note">${escapeHtml(branch.linkage_note || "")}</p>
            </div>`
          : ""
      }
    </article>
  `;
}

function renderAgentMapCard(entry, dependencies) {
  const { branch, index, color } = entry;
  const { translate, escapeHtml, shortPreview } = dependencies;
  const title = branch.label || branch.agent_type || translate("subagentFallback", { index: index + 1 });
  const name = agentBranchName(entry, translate);
  const indexes = [
    branch.spawn?.parent_request_index ? `#${branch.spawn.parent_request_index}` : "",
    ...(branch.request_indexes || []).slice(0, 4).map((requestIndex) => `#${requestIndex}`),
    branch.return?.parent_request_index ? `#${branch.return.parent_request_index}` : "",
  ].filter(Boolean);
  const overflow = Math.max(0, (branch.request_indexes?.length || 0) - 4);
  return `
    <button class="agent-map-card ${escapeHtml(branch.status || "unknown")}" type="button" data-agent-branch-jump="${escapeHtml(branch.id)}" style="--branch-color:${escapeHtml(color)}" title="${escapeHtml(branch.linkage_note || translate("jumpToAgentBranch"))}">
      <span class="agent-map-topline">
        <span class="agent-map-dot" aria-hidden="true"></span>
        <strong>${escapeHtml(name)}</strong>
        <span class="agent-map-seq">${escapeHtml(translate("childSeq", { index: index + 1 }))}</span>
        <em>${escapeHtml(branchStatusLabel(branch.status, translate))}</em>
      </span>
      <span class="agent-map-title">${escapeHtml(shortPreview(title, 44))}</span>
      <span class="agent-map-indexes">${escapeHtml(indexes.join(" → ") || translate("noRecordedRequests"))}${overflow ? ` <span>+${escapeHtml(String(overflow))}</span>` : ""}</span>
    </button>
  `;
}

function renderAgentEventStrip(view, { translate, escapeHtml }) {
  if (!view.events.length) return "";
  return `
    <div class="agent-event-strip" aria-label="${escapeHtml(translate("eventOrder"))}">
      <span class="agent-event-label">${escapeHtml(translate("eventOrderCount", { shown: view.events.length, total: view.eventCount }))}</span>
      <div class="agent-event-list">
        ${view.events.map((event) => renderAgentEvent(event, translate, escapeHtml)).join("")}
      </div>
    </div>
  `;
}

function renderAgentEvent(event, translate, escapeHtml) {
  return `
    <button class="agent-event" type="button" data-agent-jump="${escapeHtml(event.requestId || "")}">
      <strong>#${escapeHtml(event.requestIndex || "")}</strong>
      <span>${escapeHtml(`${translate("childSeq", { index: event.branchIndex + 1 })} ${event.type}`)}</span>
    </button>
  `;
}

function renderBranchEdge(label, requestId, text, { translate, escapeHtml }) {
  return `
    <button class="branch-edge" type="button" data-agent-jump="${escapeHtml(requestId || "")}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text || translate("emptyNotRecorded"))}</strong>
    </button>
  `;
}

function renderAgentBranchStep(step, { translate, escapeHtml, shortId, shortPreview }) {
  const responseCalls = step.response_tool_calls || [];
  const requestResults = step.request_tool_results || [];
  const title = responseCalls.length ? translate("requestTools", { tools: responseCalls.map((call) => call.name).join(", ") }) : step.finish_reason === "end_turn" ? translate("subagentReply") : translate("modelRequest");
  return `
    <button class="agent-branch-step" type="button" data-agent-jump="${escapeHtml(step.request_id)}">
      <span class="step-request">#${escapeHtml(step.request_index)}</span>
      <span class="step-body">
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml([step.response_id ? `response ${shortId(step.response_id)}` : "", step.finish_reason ? `finish ${step.finish_reason}` : ""].filter(Boolean).join(" · "))}</em>
        ${responseCalls.length ? `<small>tool_use ${escapeHtml(responseCalls.map((call) => `${call.name}${call.id ? `:${shortId(call.id)}` : ""}`).join(", "))}</small>` : ""}
        ${requestResults.length ? `<small>tool_result ${escapeHtml(requestResults.map((result) => shortId(result.id)).join(", "))}</small>` : ""}
        ${step.response_preview ? `<small>${escapeHtml(shortPreview(step.response_preview, 110))}</small>` : ""}
      </span>
    </button>
  `;
}

function agentBranchName(entry, translate) {
  return entry.branch.agent_type || entry.branch.spawn?.subagent_type || translate("subagentFallback", { index: entry.index + 1 });
}

function agentBranchCompactSummary(branch, translate) {
  const requestCount = branch.request_ids?.length || 0;
  const toolUse = branch.response_tool_call_count || 0;
  const toolResult = branch.request_tool_result_count || 0;
  const edges = [branch.spawn ? `spawn #${branch.spawn.parent_request_index}` : "", branch.return ? `return #${branch.return.parent_request_index}` : ""].filter(Boolean).join(" · ");
  return [translate("turnRequests", { count: requestCount }), toolUse || toolResult ? translate("turnTools", { calls: toolUse, results: toolResult }) : "", edges].filter(Boolean).join(" · ");
}

function branchStatusLabel(status, translate) {
  if (status === "returned") return translate("returned");
  if (status === "completed") return translate("completed");
  if (status === "running") return translate("running");
  return translate("unknown");
}

function branchConfidenceLabel(confidence, translate) {
  if (confidence === "high") return translate("highConfidence");
  if (confidence === "medium") return translate("mediumConfidence");
  if (confidence === "none") return translate("noBranch");
  return confidence || translate("notEvaluated");
}
