import { fallbackTimelineTurns } from "./trace-timeline-model.js";

export function renderTraceQueryBar({ timelineView, query, filter, resultPageSize, translate, escapeHtml }) {
  const counts = timelineView.filterCounts;
  const matchCount = timelineView.matchCount;
  const shownCount = timelineView.shownCount;
  const filters = [
    ["all", translate("traceFilterAll", { count: counts.all })],
    ["issues", translate("traceFilterIssues", { count: counts.issues })],
    ["slow", translate("traceFilterSlow", { count: counts.slow })],
    ["tools", translate("traceFilterTools", { count: counts.tools })],
    ["subagents", translate("traceFilterSubagents", { count: counts.subagents })],
  ];
  return `
    <label class="trace-search-field">
      <input type="search" value="${escapeHtml(query)}" placeholder="${escapeHtml(translate("traceSearchPlaceholder"))}" aria-label="${escapeHtml(translate("traceSearchAria"))}" data-trace-search>
    </label>
    <div class="trace-filter-group" role="group" aria-label="${escapeHtml(translate("traceFilterAria"))}">
      ${filters
        .map(
          ([value, label]) =>
            `<button class="trace-filter ${filter === value ? "active" : ""}" type="button" data-trace-filter="${escapeHtml(value)}" aria-pressed="${escapeHtml(String(filter === value))}">${escapeHtml(label)}</button>`,
        )
        .join("")}
    </div>
    ${
      timelineView.queryActive
        ? `<div class="trace-match-status">
            <span>${escapeHtml(translate("traceMatchCount", { shown: shownCount, total: matchCount }))}</span>
            ${
              matchCount > shownCount
                ? `<button type="button" data-trace-more>${escapeHtml(translate("traceShowMore", { count: Math.min(resultPageSize, matchCount - shownCount) }))}</button>`
                : ""
            }
          </div>`
        : ""
    }
  `;
}

export function renderTraceNoResults({ translate, escapeHtml }) {
  return `
    <section class="trace-no-results">
      <h3>${escapeHtml(translate("traceNoResultsTitle"))}</h3>
      <p>${escapeHtml(translate("traceNoResultsBody"))}</p>
    </section>
  `;
}

export function renderEmptyTimeline({ summary, translate, escapeHtml }) {
  return `
    <section class="empty-timeline">
      <h3>${escapeHtml(translate("emptyTimelineTitle"))}</h3>
      <p>${escapeHtml(translate("emptyTimelineBody"))}</p>
      <div class="empty-grid">
        ${renderSummaryMetric(translate("emptyStatus"), summary?.status || translate("emptyWatching"), { translate, escapeHtml })}
        ${renderSummaryMetric(translate("emptyWatch"), summary?.watch_ids?.join(", ") || translate("emptyNotRecorded"), { translate, escapeHtml })}
        ${renderSummaryMetric(translate("emptyCapture"), summary?.capture_label || "exact proxy capture", { translate, escapeHtml })}
      </div>
    </section>
  `;
}

export function renderTurnTimeline({
  turnWindowOrTurns,
  requests,
  requestExcerpt,
  renderTurnGroup,
  translate,
  escapeHtml,
}) {
  const turnWindow = Array.isArray(turnWindowOrTurns)
    ? {
        turns: turnWindowOrTurns,
        allTurns: turnWindowOrTurns,
        start: 0,
        end: turnWindowOrTurns.length,
        total: turnWindowOrTurns.length,
        windowed: false,
      }
    : turnWindowOrTurns;
  const normalizedTurns =
    Array.isArray(turnWindow?.turns) && turnWindow.turns.length
      ? turnWindow.turns
      : fallbackTimelineTurns(requests, { requestExcerpt });
  const requestMap = new Map(requests.map((request) => [request.id, request]));
  return [
    renderTimelineWindowEdge({ turnWindow, edge: "before", translate, escapeHtml }),
    ...normalizedTurns.map((turn) => renderTurnGroup(turn, requestMap)),
    renderTimelineWindowEdge({ turnWindow, edge: "after", translate, escapeHtml }),
  ].join("");
}

export function renderTimelineWindowEdge({ turnWindow, edge, translate, escapeHtml }) {
  if (!turnWindow?.windowed) return "";
  const hiddenCount = edge === "before" ? turnWindow.start : turnWindow.total - turnWindow.end;
  if (hiddenCount <= 0) return "";
  const target = edge === "before" ? turnWindow.allTurns?.[0] : turnWindow.allTurns?.at(-1);
  const label =
    edge === "before"
      ? translate("timelineWindowBefore", { count: hiddenCount })
      : translate("timelineWindowAfter", { count: hiddenCount });
  const summary = translate("timelineWindowSummary", {
    start: turnWindow.start + 1,
    end: turnWindow.end,
    total: turnWindow.total,
  });
  return `
    <section class="timeline-window-edge-card ${edge}" aria-label="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(summary)}</span>
      ${
        target?.id
          ? `<button type="button" data-turn-window-jump="${escapeHtml(target.id)}">${escapeHtml(edge === "before" ? translate("jumpToFirstTurn") : translate("jumpToLastTurn"))}</button>`
          : ""
      }
    </section>
  `;
}

function renderSummaryMetric(label, value, { translate, escapeHtml }) {
  return `
    <div class="summary-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || translate("emptyNotRecorded"))}</strong>
    </div>
  `;
}
