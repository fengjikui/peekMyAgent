export function renderSystemDiffView({ model, previousIndex, currentIndex, translate, escapeHtml }) {
  const t = typeof translate === "function" ? translate : (key) => key;
  const escape = typeof escapeHtml === "function" ? escapeHtml : defaultEscapeHtml;
  const summary = diffSummaryText(model, t);
  const legend = model.mode === "summary" ? renderBlockLegend(t, escape) : renderLineLegend(t, escape);
  const content =
    model.mode === "summary"
      ? renderBoundedSummary(model, t, escape)
      : model.mode === "line"
        ? `<div class="diff-lines">${model.rows.map((row) => renderDiffRow(row, t, escape)).join("")}</div>`
        : `<div class="empty-box">${escape(t("systemDiffTextIdentical"))}</div>`;

  return `
    <section class="system-diff" data-system-diff-mode="${escape(model.mode)}">
      <div class="diff-summary">
        <div>
          <h3>${escape(t("systemPromptDiffTitle"))}</h3>
          <p>#${escape(previousIndex)} → #${escape(currentIndex)} · ${escape(summary)}</p>
        </div>
        ${legend}
      </div>
      ${content}
    </section>
  `;
}

function diffSummaryText(model, t) {
  if (model.mode === "summary") {
    return t("diffBlocksChanged", { added: model.addedBlocks, removed: model.removedBlocks });
  }
  if (model.mode === "line") {
    return t("diffRowsChanged", { added: model.addedLines, removed: model.removedLines });
  }
  return t("noVisibleLineChanges");
}

function renderBoundedSummary(model, t, escape) {
  return `
    <div class="diff-bounded-note">
      <div>
        <strong>${escape(t("systemDiffBoundedTitle"))}</strong>
        <span>${escape(
          t("systemDiffBoundedDescription", {
            beforeLines: formatNumber(model.before.lines),
            afterLines: formatNumber(model.after.lines),
            prefix: formatNumber(model.sharedPrefixLines),
            suffix: formatNumber(model.sharedSuffixLines),
            blockLines: formatNumber(model.blockLines),
          }),
        )}</span>
      </div>
      <code title="${escape(t("systemDiffFingerprintTitle"))}">${escape(model.before.fingerprint)} → ${escape(model.after.fingerprint)}</code>
    </div>
    <div class="diff-lines diff-block-lines">
      ${model.rows.map((row) => renderDiffBlockRow(row, t, escape)).join("")}
    </div>
  `;
}

function renderLineLegend(t, escape) {
  return `
    <div class="diff-legend" aria-label="${escape(t("diffLegendAria"))}">
      <span class="legend-remove">${escape(t("diffRemove"))}</span>
      <span class="legend-add">${escape(t("diffAdd"))}</span>
      <span class="legend-context">${escape(t("diffContext"))}</span>
    </div>
  `;
}

function renderBlockLegend(t, escape) {
  return `
    <div class="diff-legend" aria-label="${escape(t("diffLegendAria"))}">
      <span class="legend-remove">${escape(t("diffRemovedBlock"))}</span>
      <span class="legend-add">${escape(t("diffAddedBlock"))}</span>
      <span class="legend-context">${escape(t("diffMatchedBlock"))}</span>
    </div>
  `;
}

function renderDiffRow(row, t, escape) {
  if (row.type === "skip") return `<div class="diff-skip">${escape(t("diffSkip", { count: row.count }))}</div>`;
  const marker = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
  return `
    <div class="diff-line ${escape(row.type)}">
      <span class="diff-marker">${marker}</span>
      <span class="diff-line-number">${escape(row.oldLine)}</span>
      <span class="diff-line-number">${escape(row.newLine)}</span>
      <code>${escape(row.text)}</code>
    </div>
  `;
}

function renderDiffBlockRow(row, t, escape) {
  if (row.type === "skip") return `<div class="diff-skip">${escape(t("diffSkipBlocks", { count: row.count }))}</div>`;
  const marker = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
  const preview = row.preview || t("diffEmptyBlock");
  return `
    <div class="diff-line diff-block-line ${escape(row.type)}">
      <span class="diff-marker">${marker}</span>
      <span class="diff-line-number">${escape(row.oldLine)}</span>
      <span class="diff-line-number">${escape(row.newLine)}</span>
      <code><span class="diff-block-hash">${escape(row.hash)}</span>${escape(preview)}</code>
    </div>
  `;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function defaultEscapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
