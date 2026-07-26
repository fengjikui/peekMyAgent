import { buildToolCallDetailView } from "./tool-call-view-model.js";

export function renderOrganizedToolCalls({
  calls,
  translate,
  escapeHtml,
}) {
  const items = buildToolCallDetailView(calls);
  if (!items.length) {
    return `<div class="empty-box">${escapeHtml(translate("toolCallDetailEmpty"))}</div>`;
  }
  return `
    <section class="tool-call-detail-list">
      ${items.map((item) => renderToolCall(item, { translate, escapeHtml })).join("")}
    </section>
  `;
}

function renderToolCall(item, { translate, escapeHtml }) {
  return `
    <article class="tool-call-detail">
      <header class="tool-call-detail-header">
        <div class="tool-call-detail-identity">
          <code class="tool-call-protocol">${escapeHtml(item.protocolType)}</code>
          <strong>${escapeHtml(item.name)}</strong>
        </div>
        <div class="tool-call-detail-meta">
          ${item.status ? `<span>${escapeHtml(item.status)}</span>` : ""}
          ${item.callId ? `<code>${escapeHtml(String(item.callId))}</code>` : ""}
        </div>
      </header>
      <div class="tool-call-detail-body">
        <div class="tool-call-detail-label">
          <span>${escapeHtml(translate("toolCallParameters"))}</span>
          ${item.parameterSource ? `<code>${escapeHtml(item.parameterSource)}</code>` : ""}
        </div>
        ${renderParameters(item, { translate, escapeHtml })}
      </div>
    </article>
  `;
}

function renderParameters(item, dependencies) {
  const { translate, escapeHtml } = dependencies;
  if (item.parameterEntries.length) {
    return `<dl class="tool-call-parameter-list">${item.parameterEntries
      .map((entry) => renderParameterEntry(entry, dependencies))
      .join("")}</dl>`;
  }
  if (item.parameters == null || item.parameters === "") {
    return `<p class="tool-call-empty">${escapeHtml(translate("toolCallNoParameters"))}</p>`;
  }
  return `<pre class="tool-call-code"><code>${escapeHtml(formatValue(item.parameters))}</code></pre>`;
}

function renderParameterEntry(entry, { escapeHtml }) {
  const value =
    entry.presentation === "scalar"
      ? `<span class="tool-call-scalar">${escapeHtml(formatValue(entry.value))}</span>`
      : `<pre class="tool-call-code ${entry.presentation === "command" ? "is-command" : ""}"><code>${escapeHtml(
          formatValue(entry.value),
        )}</code></pre>`;
  return `
    <div class="tool-call-parameter kind-${escapeHtml(entry.presentation)}">
      <dt><code>${escapeHtml(entry.key)}</code></dt>
      <dd>${value}</dd>
    </div>
  `;
}

function formatValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
