export function renderAgentGraph(
  view,
  { translate, escapeHtml, shortPreview, selectedTimelineHtml = "" },
) {
  if (!view) return "";
  const summaryStatus = agentSummaryStatus(view.statusCounts, translate);
  const dependencies = { translate, escapeHtml, shortPreview };
  return `
    <details class="agent-branch-map" aria-label="${escapeHtml(translate("multiAgentAria"))}" data-agent-dashboard="${escapeHtml(view.turnId)}" ${view.dashboardOpen ? "open" : ""}>
      <summary class="agent-branch-summary" data-agent-dashboard-toggle="${escapeHtml(view.turnId)}">
        ${view.summaryDots.map((visual) => renderAgentGlyph(visual, escapeHtml, "agent-summary-glyph")).join("")}
        ${view.summaryOverflow ? `<span class="agent-summary-more">+${escapeHtml(String(view.summaryOverflow))}</span>` : ""}
        <strong>${escapeHtml(translate("multiAgentSummary", { count: view.branchCount }))}</strong>
        <span class="agent-branch-summary-status">${escapeHtml(summaryStatus)}</span>
      </summary>
      ${view.dashboardOpen ? renderAgentDashboard(view, { ...dependencies, selectedTimelineHtml }) : ""}
    </details>
  `;
}

function renderAgentDashboard(view, dependencies) {
  const { translate, escapeHtml, selectedTimelineHtml } = dependencies;
  return `
    <div class="agent-tab-list" role="tablist" aria-label="${escapeHtml(translate("agentTabsAria"))}">
      ${view.branchEntries.map((entry) => renderAgentTab(entry, view.selectedBranch?.branch.id, dependencies)).join("")}
    </div>
    ${renderSelectedAgentBranch(view.selectedBranch, selectedTimelineHtml, dependencies)}
    ${renderAgentEvidence(view, dependencies)}
  `;
}

function renderAgentTab(entry, selectedBranchId, { translate, escapeHtml }) {
  const selected = entry.branch.id === selectedBranchId;
  return `
    <button class="agent-tab ${selected ? "active" : ""}" type="button" role="tab" aria-selected="${escapeHtml(String(selected))}" data-agent-branch-select="${escapeHtml(entry.branch.id)}" style="--branch-color:${escapeHtml(entry.visual.color)}">
      ${renderAgentGlyph(entry.visual, escapeHtml, "agent-tab-glyph")}
      <span class="agent-tab-copy">
        <strong>${escapeHtml(entry.displayName)}</strong>
        <small>${escapeHtml(`${translate("childSeq", { index: entry.index + 1 })} · ${branchStatusLabel(entry.branch.status, translate)}`)}</small>
      </span>
    </button>
  `;
}

function renderSelectedAgentBranch(entry, selectedTimelineHtml, dependencies) {
  if (!entry) return "";
  const { branch, displayName, visual } = entry;
  const { translate, escapeHtml } = dependencies;
  const requestCount = branch.request_ids?.length || 0;
  const meta = [
    branch.agent_type || "",
    agentContextLabel(branch.spawn?.context_mode, translate),
    translate("agentTimelineRequestCount", { count: requestCount }),
  ].filter(Boolean).join(" · ");
  return `
    <section class="agent-selected-branch" role="tabpanel" data-agent-selected-branch="${escapeHtml(branch.id)}" style="--branch-color:${escapeHtml(visual.color)}">
      <header class="agent-selected-header">
        ${renderAgentGlyph(visual, escapeHtml, "agent-selected-glyph")}
        <div>
          <strong>${escapeHtml(displayName)}</strong>
          <span>${escapeHtml(meta)}</span>
        </div>
        <span class="agent-branch-status ${escapeHtml(branch.status || "unknown")}">${escapeHtml(branchStatusLabel(branch.status, translate))}</span>
      </header>
      ${branch.spawn ? renderAgentTaskEvidence(branch.spawn, dependencies) : ""}
      ${renderAgentRelations(branch, dependencies)}
      <div class="agent-selected-timeline" aria-label="${escapeHtml(translate("agentSelectedTimelineAria", { name: displayName }))}">
        ${selectedTimelineHtml || `<p class="agent-timeline-empty">${escapeHtml(translate("agentNoTimeline"))}</p>`}
      </div>
    </section>
  `;
}

function renderAgentRelations(branch, { translate, escapeHtml, shortPreview }) {
  const relations = [
    branch.spawn
      ? renderBranchRelation(
          translate("parentCall"),
          branch.spawn.parent_request_id,
          `#${branch.spawn.parent_request_index} · ${branch.spawn.label || branch.spawn.id}`,
          escapeHtml,
        )
      : "",
    branch.launch
      ? renderBranchRelation(
          translate("launchAcknowledgement"),
          branch.launch.parent_request_id,
          `#${branch.launch.parent_request_index} · ${shortPreview(branch.launch.result_preview, 90)}`,
          escapeHtml,
        )
      : "",
    branch.return
      ? renderBranchRelation(
          translate("resultReturn"),
          branch.return.parent_request_id,
          `#${branch.return.parent_request_index} · ${shortPreview(branch.return.result_preview, 90)}`,
          escapeHtml,
        )
      : "",
  ].filter(Boolean);
  if (!relations.length) return "";
  return `<div class="agent-relation-strip" aria-label="${escapeHtml(translate("agentRelationsAria"))}">${relations.join("")}</div>`;
}

function renderBranchRelation(label, requestId, text, escapeHtml) {
  if (!requestId) return "";
  return `
    <button class="agent-relation" type="button" data-request-jump="${escapeHtml(requestId)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text || "")}</strong>
    </button>
  `;
}

function renderAgentTaskEvidence(spawn, { translate, escapeHtml, shortPreview }) {
  const text =
    spawn.task_message_visibility === "encrypted_in_rollout"
      ? translate("agentTaskEncrypted")
      : spawn.prompt_preview
        ? translate("agentTaskPreview", { text: shortPreview(spawn.prompt_preview, 180) })
        : spawn.task_message_visibility === "missing"
          ? translate("agentTaskUnavailable")
          : "";
  return text ? `<p class="agent-task-evidence">${escapeHtml(text)}</p>` : "";
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

function renderAgentGlyph(visual, escapeHtml, className) {
  return `<span class="agent-identity-glyph ${escapeHtml(className)} glyph-${escapeHtml(visual.glyph)}" style="--branch-color:${escapeHtml(visual.color)}" aria-hidden="true"></span>`;
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
