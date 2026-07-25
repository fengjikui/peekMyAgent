export function renderTimelineRequestCard({
  requestId,
  requestIndex,
  upstreamOpen = false,
  upstreamEntryHtml = "",
  upstreamBodyHtml = "",
  toolExchangeHtml = "",
  assistantResponseHtml = "",
  showUpstreamDetails = true,
  upstreamDetailsLabel = "",
  translate,
  escapeHtml,
}) {
  return `
    <article class="request-card" id="${escapeHtml(requestId)}" data-card="${escapeHtml(requestId)}">
      ${upstreamEntryHtml}
      ${
        showUpstreamDetails
          ? `<details class="request-upstream-details request-upstream-panel" data-upstream-panel="${escapeHtml(requestId)}" ${upstreamOpen ? "open" : ""}>
              <summary class="upstream-panel-summary">${escapeHtml(upstreamDetailsLabel || translate("upstreamDetails", { index: requestIndex }))}</summary>
              ${upstreamBodyHtml}
            </details>`
          : ""
      }
      ${toolExchangeHtml}
      ${assistantResponseHtml}
    </article>
  `;
}

export function renderTimelineUpstreamEntry({ entry, escapeHtml }) {
  const {
    requestIndex,
    kindClass = "user",
    userTurn = false,
    compact = false,
    label = "",
    preview = "",
    ownerAria = "",
    metaHtml = "",
    actionsHtml = "",
    semanticEvent = null,
  } = entry;
  return `
    <section class="upstream-entry ${escapeHtml(kindClass)} ${userTurn ? "user-turn" : ""} ${compact ? "compact" : ""}">
      <div class="upstream-entry-row">
        <div class="upstream-entry-title">
          <span class="request-index">#${escapeHtml(requestIndex)}</span>
          ${label && !userTurn ? `<span class="upstream-label">${escapeHtml(label)}</span>` : ""}
        </div>
        ${metaHtml ? `<div class="upstream-entry-meta" aria-label="${escapeHtml(ownerAria)}">${metaHtml}</div>` : ""}
        <div class="upstream-entry-actions">
          ${actionsHtml}
        </div>
      </div>
      ${semanticEvent ? renderTimelineSemanticEventSummary(semanticEvent, escapeHtml) : ""}
      ${preview ? `<div class="upstream-entry-preview">${escapeHtml(preview)}</div>` : ""}
    </section>
  `;
}

function renderTimelineSemanticEventSummary(event, escapeHtml) {
  return `
    <div class="semantic-event-summary" data-semantic-event="${escapeHtml(event.type || "unknown")}">
      <div class="semantic-event-facts">
        <strong>${escapeHtml(event.headline || "")}</strong>
        ${event.facts ? `<span>${escapeHtml(event.facts)}</span>` : ""}
      </div>
      ${event.note ? `<small>${escapeHtml(event.note)}</small>` : ""}
    </div>
  `;
}

export function renderTimelineUpstreamQuickActions({
  requestId,
  expanded = false,
  expandable = true,
  summaryOnly = false,
  sections = [],
  expandLabel = "",
  collapseLabel = "",
  rawTitle = "",
  translate,
  escapeHtml,
}) {
  if (summaryOnly) {
    return `<button class="raw-button compact" type="button" data-raw="${escapeHtml(requestId)}" title="${escapeHtml(rawTitle || translate("fullCaptureTitle"))}">${escapeHtml(translate("inspectDetails"))}</button>`;
  }
  return `
    ${
      expandable
        ? `<button class="inspect-button upstream-toggle-button" type="button" data-upstream-toggle="${escapeHtml(requestId)}" aria-expanded="${expanded ? "true" : "false"}">
             <span class="toggle-label">${escapeHtml(expanded ? collapseLabel || translate("collapseUpstream") : expandLabel || translate("expandUpstream"))}</span>
           </button>`
        : ""
    }
    ${sections
      .map(
        ({ section, label }) => `
          <button class="raw-section-button" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="${escapeHtml(section)}">${escapeHtml(label)}</button>
        `,
      )
      .join("")}
    <button class="raw-button compact" type="button" data-raw="${escapeHtml(requestId)}" title="${escapeHtml(rawTitle || translate("fullCaptureTitle"))}">${escapeHtml(translate("inspectDetails"))}</button>
  `;
}

export function renderTimelineToolExchange({ requestId, pairs = [], counts = {}, translate, escapeHtml }) {
  if (!pairs.length) return "";
  return `
    <section class="summary-block tool-exchange-summary">
      <div class="block-title-row">
        <p class="block-title">${escapeHtml(translate("currentToolExchange", { calls: counts.calls || 0, results: counts.results || 0 }))}</p>
        <button class="mini-raw-button" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="${counts.results ? "tool_results" : "upstream_tool_calls"}">${escapeHtml(translate("inspectDetails"))}</button>
      </div>
      <div class="tool-exchange-list">
        ${pairs
          .map((pair) => renderTimelineToolExchangeItem({ requestId, pair, translate, escapeHtml }))
          .join("")}
      </div>
    </section>
  `;
}

export function renderTimelineAssistantResponse({ view, translate, escapeHtml, renderMarkdown, renderTranslationMarkdown, renderPre }) {
  const {
    requestId,
    expanded = false,
    longResponse = false,
    visibleText = "",
    toolCalls = [],
    thinking = null,
  } = view;
  return `
    <section class="summary-block assistant-response-block ${expanded ? "expanded" : ""}">
      <div class="block-title-row">
        <div class="response-heading">
          <p class="block-title">${escapeHtml(translate("assistantReply"))}</p>
        </div>
        <div class="response-actions">
          ${
            longResponse
              ? `<button class="mini-raw-button response-toggle-button" type="button" data-response-toggle="${escapeHtml(requestId)}">${escapeHtml(expanded ? translate("collapse") : translate("viewAll"))}</button>`
              : ""
          }
          <button class="mini-raw-button" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="response" data-raw-mode="response">${escapeHtml(translate("inspectDetails"))}</button>
        </div>
      </div>
      ${renderTimelineAssistantThinking({ thinking, escapeHtml, renderTranslationMarkdown, renderPre })}
      ${
        visibleText
          ? `<div class="text-box assistant-response-text assistant-response-markdown ${longResponse && !expanded ? "collapsed" : ""}">${renderMarkdown(visibleText)}</div>`
          : toolCalls.length
            ? ""
            : `<div class="empty-box">${escapeHtml(translate("responseNoText"))}</div>`
      }
      ${longResponse ? `<p class="response-hint">${escapeHtml(expanded ? translate("responseExpandedHint") : translate("responseCollapsedHint"))}</p>` : ""}
      ${renderTimelineAssistantToolCalls({ requestId, toolCalls, translate, escapeHtml })}
    </section>
  `;
}

function renderTimelineToolExchangeItem({ requestId, pair, translate, escapeHtml }) {
  const { call, result, confidence } = pair;
  const title = call?.displayName || call?.name || result?.name || result?.id || "tool_result";
  const confidenceLabel = ["id", "historical_id"].includes(confidence)
    ? translate("pairedById")
    : confidence === "call_only"
      ? translate("waitingToolResult")
      : translate("unpairedToolResult");
  const kindLabel = result ? translate("toolResultSummary") : translate("toolCallSummary");
  const section = result ? "tool_results" : "upstream_tool_calls";
  return `
    <button class="tool-exchange" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="${section}">
      <span class="tool-exchange-kind">${escapeHtml(kindLabel)}</span>
      <span class="tool-exchange-identity">
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml(confidenceLabel)}</em>
      </span>
      <span class="tool-exchange-open" aria-hidden="true">&#8250;</span>
    </button>
  `;
}

function renderTimelineAssistantToolCalls({ requestId, toolCalls, translate, escapeHtml }) {
  if (!toolCalls.length) return "";
  return `
    <section class="assistant-tool-calls">
      <p class="block-title">${escapeHtml(translate("assistantToolUse", { count: toolCalls.length }))}</p>
      <div class="assistant-tool-list">
        ${toolCalls
          .map(
            (call) => `<button class="assistant-tool-summary" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="tool_calls" data-raw-mode="response">
              <span>${escapeHtml(translate("toolCallSummary"))}</span>
              <strong>${escapeHtml(call.displayName || call.name || "unknown")}</strong>
              <small>${escapeHtml((call.displayLines || []).filter(Boolean)[0] || "")}</small>
              <span class="tool-exchange-open" aria-hidden="true">&#8250;</span>
            </button>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderTimelineAssistantThinking({ thinking, escapeHtml, renderTranslationMarkdown, renderPre }) {
  if (!thinking?.text) return "";
  return `
    <div class="assistant-thinking-shell">
      <details class="assistant-thinking" data-thinking-request="${escapeHtml(thinking.requestId || "")}" ${thinking.expanded ? "open" : ""}>
        <summary>
          <span>${escapeHtml(thinking.label)}</span>
          <em>${escapeHtml(thinking.charCount)}</em>
          <small>${escapeHtml(thinking.preview)}</small>
        </summary>
        <div class="details-body">
          ${thinking.translation ? `<div class="thinking-translation">${renderTranslationMarkdown(thinking.translation)}</div>` : ""}
          ${renderPre(thinking.text)}
        </div>
      </details>
      <div class="thinking-title-action">
        <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(thinking.actionId)}" ${thinking.translationLoading ? "disabled" : ""}>${escapeHtml(thinking.actionLabel)}</button>
      </div>
    </div>
  `;
}
