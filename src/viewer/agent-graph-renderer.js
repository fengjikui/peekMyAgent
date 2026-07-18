export function renderAgentGraph(view, { translate, escapeHtml, shortId, shortPreview }) {
  if (!view) return "";
  const typeNames = [...new Set(view.typeEntries.map((entry) => agentBranchName(entry, translate)))];
  const summaryStatus = agentSummaryStatus(view.statusCounts, translate);
  const dependencies = { translate, escapeHtml, shortId, shortPreview, showBranchType: typeNames.length > 1 };
  return `
    <details class="agent-branch-map" aria-label="${escapeHtml(translate("multiAgentAria"))}" data-agent-dashboard="${escapeHtml(view.turnId)}" ${view.dashboardOpen ? "open" : ""}>
      <summary class="agent-branch-summary" data-agent-dashboard-toggle="${escapeHtml(view.turnId)}">
        ${view.summaryDots.map((color) => `<span class="agent-summary-dot" style="--branch-color:${escapeHtml(color)}" aria-hidden="true"></span>`).join("")}
        ${view.summaryOverflow ? `<span class="agent-summary-more">+${escapeHtml(String(view.summaryOverflow))}</span>` : ""}
        <strong>${escapeHtml(translate("multiAgentSummary", { count: view.branchCount }))}</strong>
        <span class="agent-branch-summary-types">${escapeHtml(typeNames.join(" / "))}</span>
        <span class="agent-branch-summary-status">${escapeHtml(summaryStatus)}</span>
      </summary>
      ${view.dashboardOpen ? renderAgentDashboard(view, dependencies) : ""}
    </details>
  `;
}

function renderAgentDashboard(view, dependencies) {
  const { translate, escapeHtml } = dependencies;
  return `
    ${view.showStatusFilters ? renderAgentStatusToolbar(view, dependencies) : ""}
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
    ${renderAgentEventStrip(view, dependencies)}
    ${renderAgentEvidence(view, dependencies)}
  `;
}

function renderAgentStatusToolbar(view, { translate, escapeHtml }) {
  const { returned, completed, running } = view.statusCounts;
  return `
    <div class="agent-branch-toolbar">
      <div class="agent-status-filters" role="group" aria-label="${escapeHtml(translate("agentStatusFilterAria"))}">
        ${renderAgentFilterButton(view.turnId, "all", translate("agentFilterAll", { count: view.branchCount }), view.activeFilter, escapeHtml)}
        ${renderAgentFilterButton(view.turnId, "running", translate("agentFilterRunning", { count: running }), view.activeFilter, escapeHtml)}
        ${renderAgentFilterButton(view.turnId, "completed", translate("agentFilterCompleted", { count: completed }), view.activeFilter, escapeHtml)}
        ${renderAgentFilterButton(view.turnId, "returned", translate("agentFilterReturned", { count: returned }), view.activeFilter, escapeHtml)}
      </div>
      <span>${escapeHtml(translate("agentShowingCount", { shown: view.visibleBranches.length, total: view.filteredCount }))}</span>
    </div>
  `;
}

function renderAgentFilterButton(turnId, filter, label, activeFilter, escapeHtml) {
  return `<button class="agent-status-filter ${filter === activeFilter ? "active" : ""}" type="button" data-agent-status-filter="${escapeHtml(turnId)}" data-agent-filter-value="${escapeHtml(filter)}" aria-pressed="${escapeHtml(String(filter === activeFilter))}">${escapeHtml(label)}</button>`;
}

function renderAgentBranch(entry, dependencies) {
  const { branch, index, color, expanded, detailSteps, returnEdge } = entry;
  const { translate, escapeHtml, shortPreview, showBranchType } = dependencies;
  const title = branch.label || branch.agent_type || translate("subagentFallback", { index: index + 1 });
  const summary = agentBranchCompactSummary(branch, translate);
  const name = agentBranchName(entry, translate);
  return `
    <article class="agent-branch-card ${expanded ? "" : "collapsed"}" data-branch="${escapeHtml(branch.id)}" style="--branch-color:${escapeHtml(color)}">
      <button class="agent-branch-toggle" type="button" data-agent-branch-toggle="${escapeHtml(branch.id)}" aria-expanded="${escapeHtml(String(expanded))}">
        <span class="agent-branch-index">${escapeHtml(expanded ? "▾" : "▸")}</span>
        <div>
          <strong>${showBranchType ? `<span class="agent-type-chip">${escapeHtml(name)}</span> ` : ""}${escapeHtml(translate("childSeq", { index: index + 1 }))} · ${escapeHtml(title)}</strong>
          <p class="agent-branch-compact">${escapeHtml(summary)}</p>
        </div>
        <span class="agent-branch-status ${escapeHtml(branch.status || "unknown")}">${escapeHtml(branchStatusLabel(branch.status, translate))}</span>
      </button>
      ${
        expanded
          ? `<div class="agent-branch-body">
              ${branch.spawn ? renderBranchEdge(translate("parentCall"), branch.spawn.parent_request_id, `#${branch.spawn.parent_request_index} · ${branch.spawn.label || branch.spawn.id}`, dependencies) : ""}
              ${branch.launch ? renderBranchEdge(translate("launchAcknowledgement"), branch.launch.parent_request_id, `#${branch.launch.parent_request_index} · ${shortPreview(branch.launch.result_preview, 90)}`, dependencies) : ""}
              <div class="agent-branch-steps">
                ${(detailSteps || []).map((detailStep) => renderAgentBranchStep(detailStep, dependencies)).join("")}
              </div>
              ${returnEdge ? renderBranchEdge(translate("resultReturn"), returnEdge.parent_request_id, `#${returnEdge.parent_request_index} · ${shortPreview(returnEdge.result_preview, 90)}`, dependencies) : ""}
            </div>`
          : ""
      }
    </article>
  `;
}

function renderAgentEventStrip(view, { translate, escapeHtml }) {
  if (!view.events.length) return "";
  return `
    <details class="agent-event-strip" aria-label="${escapeHtml(translate("eventOrder"))}">
      <summary class="agent-event-label">${escapeHtml(translate("agentInterleavedTimeline", { count: view.eventCount }))}</summary>
      <div class="agent-event-list">
        ${view.events.map((event) => renderAgentEvent(event, translate, escapeHtml)).join("")}
      </div>
    </details>
  `;
}

function renderAgentEvidence(view, { translate, escapeHtml }) {
  const evidence = [
    translate("agentLinkageSignal", { signal: view.summary.signal }),
    view.spawnIndexes.length ? translate("agentSpawnEvidence", { indexes: requestIndexes(view.spawnIndexes) }) : "",
    view.launchIndexes.length ? translate("agentLaunchEvidence", { indexes: requestIndexes(view.launchIndexes) }) : "",
    view.returnIndexes.length ? translate("agentReturnEvidence", { indexes: requestIndexes(view.returnIndexes) }) : "",
  ].filter(Boolean);
  return `
    <details class="agent-linkage-evidence">
      <summary>${escapeHtml(translate("agentLinkageEvidence", { confidence: branchConfidenceLabel(view.confidence, translate) }))}</summary>
      <div>${evidence.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
    </details>
  `;
}

function renderAgentEvent(event, translate, escapeHtml) {
  return `
    <button class="agent-event" type="button" data-request-jump="${escapeHtml(event.requestId || "")}">
      <strong>#${escapeHtml(event.requestIndex || "")}</strong>
      <span>${escapeHtml(`${translate("childSeq", { index: event.branchIndex + 1 })} ${agentEventTypeLabel(event.type, translate)}`)}</span>
    </button>
  `;
}

function agentEventTypeLabel(type, translate) {
  const key = {
    spawn: "agentEventSpawn",
    launch: "agentEventLaunch",
    return: "agentEventReturn",
    tool_use: "agentEventToolUse",
    tool_result: "agentEventToolResult",
    done: "agentEventDone",
    request: "agentEventRequest",
  }[type];
  return key ? translate(key) : type;
}

function renderBranchEdge(label, requestId, text, { translate, escapeHtml }) {
  return `
    <button class="branch-edge" type="button" data-request-jump="${escapeHtml(requestId || "")}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text || translate("emptyNotRecorded"))}</strong>
    </button>
  `;
}

function renderAgentBranchStep(detailStep, { translate, escapeHtml, shortId, shortPreview }) {
  const { step, representsReturn, displayPreview } = detailStep;
  const responseCalls = step.response_tool_calls || [];
  const requestResults = step.request_tool_results || [];
  const title =
    representsReturn
      ? translate("subagentResultReturn")
      : step.event_type === "agent_message"
      ? translate("subagentReply")
      : responseCalls.length
        ? translate("requestTools", { tools: responseCalls.map((call) => call.name).join(", ") })
        : step.finish_reason === "end_turn"
          ? translate("subagentReply")
          : translate("modelRequest");
  return `
    <button class="agent-branch-step" type="button" data-request-jump="${escapeHtml(step.request_id)}">
      <span class="step-request">#${escapeHtml(step.request_index)}</span>
      <span class="step-body">
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml([step.response_id ? `response ${shortId(step.response_id)}` : "", step.finish_reason ? `finish ${step.finish_reason}` : ""].filter(Boolean).join(" · "))}</em>
        ${responseCalls.length ? `<small>tool_use ${escapeHtml(responseCalls.map((call) => `${call.name}${call.id ? `:${shortId(call.id)}` : ""}`).join(", "))}</small>` : ""}
        ${requestResults.length ? `<small>tool_result ${escapeHtml(requestResults.map((result) => shortId(result.id)).join(", "))}</small>` : ""}
        ${displayPreview ? `<small>${escapeHtml(shortPreview(displayPreview, 110))}</small>` : ""}
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
  const edges = [
    branch.spawn ? translate("agentPathSpawn", { index: branch.spawn.parent_request_index }) : "",
    branch.launch ? translate("agentPathLaunch", { index: branch.launch.parent_request_index }) : "",
    branch.return ? translate("agentPathReturn", { index: branch.return.parent_request_index }) : "",
  ].filter(Boolean).join(" · ");
  return [
    agentContextLabel(branch.spawn?.context_mode, translate),
    translate("agentObservedEvents", { count: requestCount }),
    toolUse || toolResult ? translate("turnTools", { calls: toolUse, results: toolResult }) : "",
    edges,
  ].filter(Boolean).join(" · ");
}

function agentSummaryStatus(statusCounts, translate) {
  return [
    statusCounts.running ? translate("agentFilterRunning", { count: statusCounts.running }) : "",
    statusCounts.completed ? translate("agentFilterCompleted", { count: statusCounts.completed }) : "",
    statusCounts.returned ? translate("agentFilterReturned", { count: statusCounts.returned }) : "",
  ].filter(Boolean).join(" · ");
}

function requestIndexes(indexes) {
  return indexes.map((index) => `#${index}`).join(", ");
}

function agentContextLabel(mode, translate) {
  if (mode === "all") return translate("agentContextInherited");
  if (mode === "none") return translate("agentContextIsolated");
  return "";
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
