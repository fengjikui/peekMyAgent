export function renderUpstreamDetail(view, dependencies) {
  if (!view) return "";
  const { translate, escapeHtml, renderPre } = dependencies;
  return `
    <div class="request-body">
      <details>
        <summary class="metric-summary">
          <span>${escapeHtml(translate("systemSummary", { count: view.system.count }))}</span>
          ${renderCompositionSectionStat(view.system.composition, dependencies)}
        </summary>
        <div class="details-body">${renderPre(view.system.preview || translate("noSystemSummary"))}</div>
      </details>
      <details>
        <summary class="metric-summary">
          <span>${escapeHtml(translate("toolsCount", { count: view.tools.count }))}</span>
          ${renderCompositionSectionStat(view.tools.composition, dependencies)}
        </summary>
        <div class="details-body">
          <div class="tool-list">
            ${view.tools.names.map((name) => `<span class="tool-chip">${escapeHtml(name)}</span>`).join("")}
            ${view.tools.hiddenCount ? `<span class="tool-chip">+${escapeHtml(view.tools.hiddenCount)}</span>` : ""}
          </div>
        </div>
      </details>
      ${renderHistoryStack(view.history, dependencies)}
      ${renderInternalRequest(view.internalRequest, dependencies)}
      ${renderCurrentMessage(view.currentMessage, dependencies)}
      ${renderProviderStats(view.providerStats, dependencies)}
    </div>
  `;
}

function renderHistoryStack(history, dependencies) {
  const { translate, escapeHtml, formatBytes } = dependencies;
  return `
    <details>
      <summary class="metric-summary">
        <span>${escapeHtml(translate("historyStack", { count: history.count }))}</span>
        ${renderCompositionSectionStat(history.composition, dependencies)}
      </summary>
      <div class="details-body">
        <div class="history-stack-meta">
          <span>roles: ${escapeHtml(history.roles.join(" -> ") || "empty")}</span>
          <span>history=${escapeHtml(String(history.historyCount))}</span>
          <span>raw=${escapeHtml(formatBytes(history.rawBodyBytes))}</span>
        </div>
        ${
          history.items.length
            ? `<div class="history-stack">${history.items.map((item) => renderHistoryItem(item, dependencies)).join("")}</div>`
            : `<div class="empty-box">${escapeHtml(translate("noHistoryMessages"))}</div>`
        }
      </div>
    </details>
  `;
}

function renderHistoryItem(item, dependencies) {
  if (item.kind === "framework_reminder") return renderFrameworkReminder(item, dependencies);
  const { translate, escapeHtml, renderPre, shortId, commandMessageLabel, messageKindLabel } = dependencies;
  const chips = [
    `<span class="history-chip role">role: ${escapeHtml(item.role)}</span>`,
    renderHistoryContextChip(item.contextStatus, dependencies),
    item.currentUser ? `<span class="history-chip current">${escapeHtml(translate("currentUserInput"))}</span>` : "",
    item.commandMessage ? `<span class="history-chip command">${escapeHtml(commandMessageLabel(item.commandMessage))}</span>` : "",
    ...item.toolCalls.map((call) => `<span class="history-chip tool">call ${escapeHtml(call.name)}${call.id ? ` · ${escapeHtml(shortId(call.id))}` : ""}</span>`),
    ...item.toolResults.map((result) => `<span class="history-chip result">result${result.id ? ` · ${escapeHtml(shortId(result.id))}` : ""}</span>`),
  ].join("");
  return `
    <article class="history-stack-item ${escapeHtml(item.kind)} role-${escapeHtml(item.role)}">
      <header>
        <span class="history-index">#${escapeHtml(String(item.index))}</span>
        <strong>${escapeHtml(item.label || messageKindLabel(item.kind, item.role))}</strong>
        <div class="history-chips">${chips}</div>
      </header>
      ${item.text ? `<p>${escapeHtml(item.text)}</p>` : `<p class="muted">${escapeHtml(translate("noTextContent"))}</p>`}
      ${
        item.toolCalls.length
          ? `<div class="history-tool-detail">${item.toolCalls.map((call) => renderPre(`${translate("argumentsLabel")} ${call.name}${call.id ? ` (${call.id})` : ""}\n${call.argumentsPreview || "(empty)"}`)).join("")}</div>`
          : ""
      }
      ${
        item.toolResults.length
          ? `<div class="history-tool-detail">${item.toolResults.map((result) => renderPre(`${translate("resultLabel")}${result.id ? ` (${result.id})` : ""}\n${result.content || "(empty)"}`)).join("")}</div>`
          : ""
      }
    </article>
  `;
}

function renderHistoryContextChip(status, { translate, escapeHtml }) {
  if (status === "reused") return `<span class="history-chip reused">${escapeHtml(translate("historyReused"))}</span>`;
  if (status === "new") return `<span class="history-chip new">${escapeHtml(translate("historyNew"))}</span>`;
  if (status === "baseline") return `<span class="history-chip baseline">${escapeHtml(translate("baseline"))}</span>`;
  return "";
}

function renderFrameworkReminder(item, { translate, escapeHtml, renderPre, formatCharCount }) {
  return `
    <article class="history-stack-item framework_reminder role-${escapeHtml(item.role)}">
      <details>
        <summary>
          <span class="history-index">#${escapeHtml(String(item.index))}</span>
          <strong>${escapeHtml(item.label || translate("frameworkReminder"))}</strong>
          <span class="history-chip framework">${escapeHtml(translate("frameworkAutoAdded"))}</span>
          ${item.charCount ? `<span class="history-chip">${escapeHtml(formatCharCount(item.charCount))}</span>` : ""}
        </summary>
        <div class="history-framework-body">${renderPre(item.fullText || item.text || "(empty)")}</div>
      </details>
    </article>
  `;
}

function renderInternalRequest(value, { translate, escapeHtml, renderPre, shortPreview }) {
  if (!value) return "";
  return `
    <details class="internal-request">
      <summary>${escapeHtml(translate("agentInternalRequest", { preview: shortPreview(value, 72) }))}</summary>
      <div class="details-body">${renderPre(value)}</div>
    </details>
  `;
}

function renderCurrentMessage(message, dependencies) {
  if (!message) return "";
  if (message.kind === "subagent_result") return renderSubagentResult(message, dependencies);
  const { translate, escapeHtml, messageKindLabel } = dependencies;
  return `
    <section class="summary-block message-delta-block">
      <div class="block-title-row">
        <p class="block-title">${escapeHtml(translate("currentRoundMessages"))}</p>
        <span class="block-title-meta">
          ${renderCompositionSectionStat(message.composition, dependencies, translate("currentUser"))}
          <span class="message-delta-count">${escapeHtml(translate("itemCount", { count: message.count }))}</span>
        </span>
      </div>
      <div class="message-delta-list">
        ${message.items
          .map(
            (item) => `
              <article class="message-delta-item">
                <span>${escapeHtml(messageKindLabel(item.kind, item.role))}</span>
                <p>${escapeHtml(item.text || "(empty)")}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSubagentResult(message, { translate, escapeHtml, renderMarkdown }) {
  const name = message.name || translate("subagentFallback", { index: "" }).trim();
  return `
    <section class="summary-block message-delta-block subagent-result-event">
      <div class="block-title-row">
        <p class="block-title">${escapeHtml(translate("currentResultEvent"))}</p>
        <span class="block-title-meta">
          ${name ? `<span class="message-delta-count">${escapeHtml(name)}${message.status ? ` · ${escapeHtml(message.status)}` : ""}</span>` : ""}
        </span>
      </div>
      <div class="subagent-result-markdown assistant-response-markdown" title="${escapeHtml(message.fallbackText || message.markdownText)}">
        ${renderMarkdown(message.markdownText)}
      </div>
    </section>
  `;
}

function renderProviderStats(stats, dependencies) {
  if (!stats) return "";
  const { translate, escapeHtml, formatCharCount, formatCompactNumber, formatPercent } = dependencies;
  const tokens = [
    stats.input ? ["input", formatCompactNumber(stats.input), translate("providerInputTokenTitle")] : null,
    stats.cache ? ["cache", `${formatCompactNumber(stats.cache)} · ${formatPercent(stats.cacheRatio)}`, translate("cacheHitTokenTitle")] : null,
    stats.cache ? ["actual", formatPercent(stats.actualRatio), translate("nonCacheInputTitle")] : null,
    stats.output ? ["output", formatCompactNumber(stats.output), translate("providerOutputTokenTitle")] : null,
  ].filter(Boolean);
  return `
    <section class="summary-block composition-block">
      <div class="block-title-row">
        <div class="composition-heading">
          <p class="block-title">${escapeHtml(translate("providerTokenStats"))}</p>
          ${tokens.map(([label, value, title]) => renderTokenMetric(label, value, title, dependencies)).join("")}
        </div>
        <span class="composition-total">${escapeHtml(translate("actualUpstream", { count: formatCharCount(stats.totalPayloadChars) }))}</span>
      </div>
    </section>
  `;
}

function renderCompositionSectionStat(stat, { escapeHtml, formatPercent, formatCharCount }, label = "") {
  if (!stat) return "";
  return `
    <span class="composition-metric ${escapeHtml(compositionSectionClass(stat.key))}">
      ${label ? `<em>${escapeHtml(label)}</em>` : ""}
      <strong>${escapeHtml(formatPercent(stat.ratio))}</strong>
      <small>${escapeHtml(formatCharCount(stat.chars))}</small>
    </span>
  `;
}

function renderTokenMetric(label, value, title, { escapeHtml }) {
  return `
    <span class="composition-token" title="${escapeHtml(title || "")}">
      <em>${escapeHtml(label)}</em>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function compositionSectionClass(key) {
  if (key === "current_user") return "user";
  if (key === "history_context") return "history";
  if (key === "tool_result") return "tool";
  return key || "params";
}
