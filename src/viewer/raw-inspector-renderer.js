import {
  requestHasSemanticEvent,
  requestUsesReconstructedUpstream,
  responseUsesReconstructedDownstream,
} from "./raw-view-model.js";

export function renderRequestRawNavigation({ request, activeSection, hasPrevious, translate, escapeHtml }) {
  if (requestHasSemanticEvent(request)) {
    return `<div class="raw-section-nav request-sections">${renderSectionButtons(
      [
        ["full", translate("rawEventSource")],
        ["metadata", translate("rawEventMetadata")],
      ],
      request.id,
      activeSection === "metadata" ? "metadata" : "full",
      escapeHtml,
    )}</div>`;
  }
  const focusedToolSection =
    activeSection === "upstream_tool_calls"
      ? [["upstream_tool_calls", "tool_use"]]
      : activeSection === "tool_results"
        ? [["tool_results", "tool_result"]]
        : [];
  const sections = [
    ["full", translate(requestUsesReconstructedUpstream(request) ? "rawReconstructedRequest" : "rawFull")],
    ["system", "System"],
    ...(hasPrevious ? [["system_diff", "System diff"]] : []),
    ["tools", "Tools"],
    ["harness", "Harness"],
    ["history", translate("rawHistory")],
    ["message", translate("rawMessage")],
    ...focusedToolSection,
    ["metadata", "Metadata"],
  ];
  return `<div class="raw-section-nav request-sections">${renderSectionButtons(sections, request.id, activeSection, escapeHtml)}</div>`;
}

export function renderResponseRawNavigation({ request, activeSection, translate, escapeHtml }) {
  const downstream = [
    ["response", responseUsesReconstructedDownstream(request) ? translate("rawReconstructedResponse") : "Response"],
    ["tool_calls", "tool_use"],
  ];
  return `
    <div class="raw-section-nav">
      ${renderSectionGroup(translate("rawNavDownstream"), downstream, request.id, activeSection, escapeHtml, "response")}
      ${renderSectionGroup(translate("rawNavReference"), [["tools", "Tools schema"]], request.id, activeSection, escapeHtml, "response")}
    </div>
  `;
}

export function renderRawDetail({ title, value, escapeHtml, renderJson }) {
  return `
    <details open>
      <summary>${escapeHtml(title)}</summary>
      <div class="json-node">${renderJson(value)}</div>
    </details>
  `;
}

export function renderRawStickyControls({ navigation, searchControls, translationControls }) {
  return `
    <div class="raw-sticky-controls">
      ${navigation}
      ${searchControls}
      ${translationControls}
    </div>
  `;
}

export function renderRawSearchControls({ query, scope, matches, position, translate, escapeHtml }) {
  return `
    <div class="raw-search-bar">
      <label class="raw-search-input-wrap">
        <span>${escapeHtml(translate("rawSearchScope", { section: scope }))}</span>
        <input
          type="search"
          value="${escapeHtml(query)}"
          placeholder="${escapeHtml(translate("rawSearchPlaceholder", { section: scope }))}"
          aria-label="${escapeHtml(translate("rawSearchAria"))}"
          data-raw-search="true"
        />
      </label>
      ${
        query
          ? `<span class="raw-search-count" data-raw-search-position title="${escapeHtml(translate("rawSearchResultCount", { count: matches }))}">${escapeHtml(position)}</span>
             <span class="raw-search-navigation" role="group" aria-label="${escapeHtml(translate("rawSearchResultCount", { count: matches }))}">
               <button type="button" data-raw-search-nav="previous" title="${escapeHtml(translate("rawSearchPrevious"))}" aria-label="${escapeHtml(translate("rawSearchPrevious"))}" ${matches ? "" : "disabled"}>↑</button>
               <button type="button" data-raw-search-nav="next" title="${escapeHtml(translate("rawSearchNext"))}" aria-label="${escapeHtml(translate("rawSearchNext"))}" ${matches ? "" : "disabled"}>↓</button>
             </span>
             <button type="button" class="raw-search-clear" data-raw-search-clear="true">${escapeHtml(translate("rawSearchClear"))}</button>`
          : ""
      }
    </div>
  `;
}

export function renderRawSearchResults({ query, scope, entries, translate, escapeHtml, highlightSnippet, renderPre, limit = 120 }) {
  if (!query) return "";
  if (!entries.length) return `<div class="empty-box">${escapeHtml(translate("rawSearchNoResults", { section: scope, query }))}</div>`;
  return `
    <section class="raw-search-results">
      ${entries
        .slice(0, limit)
        .map((entry) => {
          const entryPath = entry.path || scope;
          const entryValue = entry.value ?? entry.text;
          return `
            <article class="raw-search-result" data-raw-search-target="true">
              <header>
                <strong>${highlightSnippet(entryPath, query)}</strong>
                <span>${escapeHtml(translate("rawSearchMatchedIn", { scope: entry.scope || scope }))}</span>
              </header>
              <p>${highlightSnippet(entryValue, query)}</p>
              ${entry.value !== entry.text ? `<details><summary>${escapeHtml(translate("rawSearchValue"))}</summary>${renderPre(entry.value)}</details>` : ""}
            </article>
          `;
        })
        .join("")}
    </section>
  `;
}

export function renderRequestDetailLoading({ translate, escapeHtml }) {
  return `<div class="empty-box">${escapeHtml(translate("requestDetailLoading"))}</div>`;
}

export function renderRequestDetailError({ error, translate, escapeHtml }) {
  return `<div class="empty-box error">${escapeHtml(translate("requestDetailLoadFailed", { message: error?.message || String(error || "unknown") }))}</div>`;
}

export function renderRawSourceNotice({ title, text, escapeHtml }) {
  return `
    <div class="raw-source-notice">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

export function renderRawSectionEvidence({ evidence, escapeHtml }) {
  if (!evidence?.text) return "";
  return `
    <aside class="raw-section-evidence ${escapeHtml(evidence.tone || "partial")}">
      <strong>${escapeHtml(evidence.badge || "")}</strong>
      <span>${escapeHtml(evidence.text)}</span>
    </aside>
  `;
}

function renderSectionGroup(label, sections, requestId, activeSection, escapeHtml, mode) {
  if (!sections.length) return "";
  return `
    <div class="raw-section-nav-group">
      <span class="raw-section-nav-label">${escapeHtml(label)}</span>
      ${renderSectionButtons(sections, requestId, activeSection, escapeHtml, mode)}
    </div>
  `;
}

function renderSectionButtons(sections, requestId, activeSection, escapeHtml, mode = "request") {
  return sections
    .map(
      ([section, label]) => `
        <button class="${section === activeSection ? "active" : ""}" type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="${escapeHtml(section)}" ${mode === "response" ? 'data-raw-mode="response"' : ""}>
          ${escapeHtml(label)}
        </button>
      `,
    )
    .join("");
}
