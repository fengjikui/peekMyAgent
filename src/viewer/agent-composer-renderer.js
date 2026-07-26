export function renderAgentComposer(view, { escapeHtml }) {
  if (!view?.visible) return "";
  if (!view.expanded) {
    return `
      <div class="agent-compose-launcher">
        <button class="agent-compose-toggle" type="button" data-agent-compose-toggle aria-expanded="false" ${view.canExpand ? "" : "disabled"} title="${escapeHtml(view.targetText)}">
          ${escapeHtml(view.canExpand ? view.openLabel : view.targetText)}
        </button>
      </div>
    `;
  }
  return `
    <form class="agent-compose-form ${view.enabled ? "" : "disabled"}" data-agent-compose data-source-id="${escapeHtml(view.sourceId)}">
      <div class="agent-compose-target">
        <strong>${escapeHtml(view.agentLabel)}</strong>
        <span>${escapeHtml(view.targetText)}</span>
        ${view.showResumeNote ? `<span class="agent-compose-note">${escapeHtml(view.resumeNote)}</span>` : ""}
        <button class="icon-button agent-compose-collapse" type="button" data-agent-compose-toggle aria-expanded="true" aria-label="${escapeHtml(view.closeLabel)}" title="${escapeHtml(view.closeLabel)}">×</button>
      </div>
      <div class="agent-compose-row">
        <textarea class="agent-compose-input" name="message" rows="1" placeholder="${escapeHtml(view.placeholder)}" aria-label="${escapeHtml(view.placeholder)}" ${view.enabled ? "" : "disabled"}>${escapeHtml(view.draft)}</textarea>
        <button class="primary-button small agent-compose-send" type="submit" ${view.enabled ? "" : "disabled"}>
          ${escapeHtml(view.buttonLabel)}
        </button>
      </div>
      <p class="agent-compose-status ${view.statusError ? "error" : ""}" data-agent-compose-status ${view.statusMessage ? "" : "hidden"}>${escapeHtml(view.statusMessage)}</p>
    </form>
  `;
}
