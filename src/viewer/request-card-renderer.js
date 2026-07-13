export function renderTimelineRequestCard({
  requestId,
  requestIndex,
  upstreamOpen = false,
  upstreamEntryHtml = "",
  upstreamBodyHtml = "",
  toolExchangeHtml = "",
  assistantResponseHtml = "",
  translate,
  escapeHtml,
}) {
  return `
    <article class="request-card" id="${escapeHtml(requestId)}" data-card="${escapeHtml(requestId)}">
      ${upstreamEntryHtml}
      <details class="request-upstream-details request-upstream-panel" data-upstream-panel="${escapeHtml(requestId)}" ${upstreamOpen ? "open" : ""}>
        <summary class="upstream-panel-summary">${escapeHtml(translate("upstreamDetails", { index: requestIndex }))}</summary>
        ${upstreamBodyHtml}
      </details>
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
  } = entry;
  return `
    <section class="upstream-entry ${escapeHtml(kindClass)} ${userTurn ? "user-turn" : ""} ${compact ? "compact" : ""}">
      <div class="upstream-entry-row">
        <div class="upstream-entry-title">
          <span class="request-index">#${escapeHtml(requestIndex)}</span>
          <span class="upstream-label">${escapeHtml(label)}</span>
        </div>
        ${metaHtml ? `<div class="upstream-entry-meta" aria-label="${escapeHtml(ownerAria)}">${metaHtml}</div>` : ""}
        <div class="upstream-entry-actions">
          ${actionsHtml}
        </div>
      </div>
      ${preview ? `<div class="upstream-entry-preview">${escapeHtml(preview)}</div>` : ""}
    </section>
  `;
}

export function renderTimelineUpstreamQuickActions({ requestId, expanded = false, sections = [], translate, escapeHtml }) {
  return `
    <button class="inspect-button upstream-toggle-button" type="button" data-upstream-toggle="${escapeHtml(requestId)}" aria-expanded="${expanded ? "true" : "false"}">
      <span class="toggle-label">${escapeHtml(expanded ? translate("collapseUpstream") : translate("expandUpstream"))}</span>
    </button>
    ${sections
      .map(
        ({ section, label }) => `
          <button class="raw-section-button" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="${escapeHtml(section)}">${escapeHtml(label)}</button>
        `,
      )
      .join("")}
    <button class="raw-button compact" type="button" data-raw="${escapeHtml(requestId)}" title="${escapeHtml(translate("fullCaptureTitle"))}">Raw</button>
  `;
}

export function renderTimelineToolExchange({ pairs = [], counts = {}, translate, escapeHtml, renderPre, serializeArguments }) {
  if (!pairs.length) return "";
  return `
    <section class="summary-block">
      <p class="block-title">${escapeHtml(translate("currentToolExchange", { calls: counts.calls || 0, results: counts.results || 0 }))}</p>
      <div class="tool-exchange-list">
        ${pairs
          .map((pair) => renderTimelineToolExchangeItem({ pair, translate, escapeHtml, renderPre, serializeArguments }))
          .join("")}
      </div>
    </section>
  `;
}

export function renderTimelineAssistantResponse({ view, translate, escapeHtml, renderMarkdown, renderTranslationMarkdown, renderPre, serialize }) {
  const {
    requestId,
    expanded = false,
    longResponse = false,
    visibleText = "",
    meta = [],
    toolCalls = [],
    thinking = null,
  } = view;
  return `
    <section class="summary-block assistant-response-block ${expanded ? "expanded" : ""}">
      <div class="block-title-row">
        <div class="response-heading">
          <p class="block-title">${escapeHtml(translate("assistantReply"))}</p>
          <div class="response-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        </div>
        <div class="response-actions">
          ${
            toolCalls.length
              ? `<button class="mini-raw-button" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="tool_calls" data-raw-mode="response">Tool use · ${escapeHtml(String(toolCalls.length))}</button>`
              : ""
          }
          ${
            longResponse
              ? `<button class="mini-raw-button response-toggle-button" type="button" data-response-toggle="${escapeHtml(requestId)}">${escapeHtml(expanded ? translate("collapse") : translate("viewAll"))}</button>`
              : ""
          }
          <button class="mini-raw-button" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="response" data-raw-mode="response">Raw</button>
        </div>
      </div>
      ${renderTimelineAssistantThinking({ thinking, escapeHtml, renderTranslationMarkdown, renderPre })}
      ${renderTimelineAssistantToolCalls({ toolCalls, translate, escapeHtml, renderPre, serialize })}
      ${
        visibleText
          ? `<div class="text-box assistant-response-text assistant-response-markdown ${longResponse && !expanded ? "collapsed" : ""}">${renderMarkdown(visibleText)}</div>`
          : toolCalls.length
            ? ""
            : `<div class="empty-box">${escapeHtml(translate("responseNoText"))}</div>`
      }
      ${longResponse ? `<p class="response-hint">${escapeHtml(expanded ? translate("responseExpandedHint") : translate("responseCollapsedHint"))}</p>` : ""}
    </section>
  `;
}

function renderTimelineToolExchangeItem({ pair, translate, escapeHtml, renderPre, serializeArguments }) {
  const { call, result, confidence } = pair;
  const title = call?.name || result?.id || "tool_result";
  const confidenceLabel = confidence === "id" ? translate("pairedById") : confidence === "call_only" ? translate("waitingToolResult") : translate("unpairedToolResult");
  return `
    <article class="tool-exchange">
      <header>
        <span class="tool-exchange-kind">${call ? "Tool use" : "Tool result"}</span>
        <strong>${escapeHtml(title)}</strong>
        ${call?.id || result?.id ? `<code>${escapeHtml(call?.id || result?.id)}</code>` : ""}
        <em>${escapeHtml(confidenceLabel)}</em>
      </header>
      ${
        call
          ? `<div class="tool-event tool-use">
              <p>${escapeHtml(translate("argumentsLabel"))}</p>
              ${renderPre(serializeArguments(call.arguments))}
            </div>`
          : ""
      }
      ${
        result
          ? `<div class="tool-event tool-result">
              <p>${escapeHtml(translate("resultLabel"))}</p>
              ${renderPre(result.content || "(empty)")}
            </div>`
          : `<div class="tool-event empty-tool-result">${escapeHtml(translate("noMatchedToolResult"))}</div>`
      }
    </article>
  `;
}

function renderTimelineAssistantToolCalls({ toolCalls, translate, escapeHtml, renderPre, serialize }) {
  if (!toolCalls.length) return "";
  return `
    <section class="assistant-tool-calls">
      <p class="block-title">${escapeHtml(translate("assistantToolUse", { count: toolCalls.length }))}</p>
      <div class="assistant-tool-list">
        ${toolCalls.map((call) => renderPre(`tool_use ${call.name || "unknown"}${call.id ? ` (${call.id})` : ""}\n${serialize(call.arguments ?? null)}`)).join("")}
      </div>
    </section>
  `;
}

function renderTimelineAssistantThinking({ thinking, escapeHtml, renderTranslationMarkdown, renderPre }) {
  if (!thinking?.text) return "";
  return `
    <details class="assistant-thinking">
      <summary>
        <span>Thinking</span>
        <em>${escapeHtml(thinking.charCount)}</em>
        <small>${escapeHtml(thinking.preview)}</small>
      </summary>
      <div class="details-body">
        <div class="thinking-translation-toolbar">
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(thinking.actionId)}" ${thinking.translationLoading ? "disabled" : ""}>${escapeHtml(thinking.actionLabel)}</button>
        </div>
        ${thinking.translation ? `<div class="thinking-translation">${renderTranslationMarkdown(thinking.translation)}</div>` : ""}
        ${renderPre(thinking.text)}
      </div>
    </details>
  `;
}
