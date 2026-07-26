export function renderMetadataControls({ mode, translate, escapeHtml }) {
  return `
    <div class="translation-toolbar compact">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(translate("metadataViewAria"))}">
        <button type="button" class="${mode === "source" ? "active" : ""}" data-metadata-mode="source">${escapeHtml(translate("metadataOriginal"))}</button>
        <button type="button" class="${mode === "organized" ? "active" : ""}" data-metadata-mode="organized">${escapeHtml(translate("metadataOrganized"))}</button>
      </div>
    </div>
  `;
}

export function renderOrganizedMetadata({ view, translate, escapeHtml, formatNumber }) {
  return `
    <section class="metadata-summary">
      ${renderFactsSection({
        title: translate("metadataIdentity"),
        source: translate("metadataCapturedFact"),
        facts: view.identity,
        translate,
        escapeHtml,
        formatNumber,
      })}
      ${renderFactsSection({
        title: translate("metadataTransport"),
        source: translate("metadataCapturedFact"),
        facts: view.transport,
        translate,
        escapeHtml,
        formatNumber,
      })}
      ${renderProviderUsage(view.providerUsage, { translate, escapeHtml, formatNumber })}
      ${renderComposition(view.composition, { translate, escapeHtml, formatNumber })}
      ${renderAttribution(view.attribution, { translate, escapeHtml, formatNumber })}
      ${renderEvidence(view.evidence, { translate, escapeHtml, formatNumber })}
    </section>
  `;
}

function renderAttribution(attribution, { translate, escapeHtml, formatNumber }) {
  if (!attribution?.facts?.length) return "";
  return `
    <section class="metadata-summary-section">
      ${renderSectionHeading(translate("metadataAttribution"), translate("metadataInferredFact"), escapeHtml)}
      <dl class="metadata-fact-list compact">
        ${attribution.facts
          .map(
            (fact) => `
              <div>
                <dt>${escapeHtml(metadataKeyLabel(fact.key, translate))}</dt>
                <dd>${escapeHtml(formatMetadataValue(metadataTranslatedValue(fact.value, translate), formatNumber))}</dd>
              </div>
            `,
          )
          .join("")}
      </dl>
      ${
        attribution.evidence?.length
          ? `<details class="metadata-evidence-details">
              <summary>${escapeHtml(translate("metadataAttributionEvidence"))}</summary>
              <pre>${escapeHtml(JSON.stringify(attribution.evidence, null, 2))}</pre>
            </details>`
          : ""
      }
    </section>
  `;
}

function renderFactsSection({ title, source, facts = [], translate, escapeHtml, formatNumber }) {
  if (!facts.length) return "";
  return `
    <section class="metadata-summary-section">
      ${renderSectionHeading(title, source, escapeHtml)}
      <dl class="metadata-fact-list">
        ${facts
          .map(
            (fact) => `
              <div>
                <dt>${escapeHtml(metadataKeyLabel(fact.key, translate))}</dt>
                <dd>${escapeHtml(formatMetadataValue(fact.value, formatNumber))}</dd>
              </div>
            `,
          )
          .join("")}
      </dl>
    </section>
  `;
}

function renderProviderUsage(usage, { translate, escapeHtml, formatNumber }) {
  if (!usage) return "";
  const items = [
    ["input", usage.input],
    ["cache", usage.cache],
    ["actual", usage.actualInput],
    ["output", usage.output],
  ];
  return `
    <section class="metadata-summary-section">
      ${renderSectionHeading(translate("metadataProviderUsage"), translate("metadataProviderFact"), escapeHtml)}
      <div class="metadata-metric-strip">
        ${items
          .map(
            ([key, value]) => `
              <span>
                <small>${escapeHtml(translate(`metadataUsage_${key}`))}</small>
                <strong>${escapeHtml(formatNumber(Number(value || 0)))}</strong>
                ${
                  key === "cache" || key === "actual"
                    ? `<em>${escapeHtml(formatPercent(key === "cache" ? usage.cacheRatio : usage.actualRatio))}</em>`
                    : ""
                }
              </span>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderComposition(composition, { translate, escapeHtml, formatNumber }) {
  if (!composition?.sections?.length) return "";
  return `
    <section class="metadata-summary-section">
      ${renderSectionHeading(translate("metadataComposition"), translate("metadataCalculated"), escapeHtml)}
      <div class="metadata-composition-head">
        <span>${escapeHtml(translate("metadataPayloadTotal"))}</span>
        <strong>${escapeHtml(formatNumber(composition.total))} ${escapeHtml(composition.unit)}</strong>
      </div>
      <div class="metadata-composition-list">
        ${composition.sections
          .map(
            (item) => `
              <span class="metadata-composition-item kind-${escapeHtml(item.key)}">
                <small>${escapeHtml(translate(`metadataComposition_${item.key}`))}</small>
                <strong>${escapeHtml(formatPercent(item.ratio))}</strong>
                <em>${escapeHtml(formatNumber(item.chars))} ${escapeHtml(composition.unit)}</em>
              </span>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderEvidence(evidence, { translate, escapeHtml, formatNumber }) {
  const facts = [
    evidence.transport ? { key: "evidence_transport", value: evidence.transport } : null,
    evidence.request?.exact != null ? { key: "evidence_exact", value: evidence.request.exact } : null,
    evidence.request?.available != null ? { key: "evidence_available", value: evidence.request.available } : null,
    evidence.headerRedactions
      ? {
          key: "header_redactions",
          value: Array.isArray(evidence.headerRedactions)
            ? evidence.headerRedactions.length
            : Object.keys(evidence.headerRedactions).length,
        }
      : null,
  ].filter(Boolean);
  if (!facts.length && !evidence.contextDelta) return "";
  return `
    <section class="metadata-summary-section">
      ${renderSectionHeading(translate("metadataEvidence"), translate("metadataNormalized"), escapeHtml)}
      ${
        facts.length
          ? `<dl class="metadata-fact-list compact">
              ${facts
                .map(
                  (fact) => `
                    <div>
                      <dt>${escapeHtml(metadataKeyLabel(fact.key, translate))}</dt>
                      <dd>${escapeHtml(formatMetadataValue(fact.value, formatNumber))}</dd>
                    </div>
                  `,
                )
                .join("")}
            </dl>`
          : ""
      }
      ${
        evidence.contextDelta
          ? `<details class="metadata-evidence-details">
              <summary>${escapeHtml(translate("metadataContextDelta"))}</summary>
              <pre>${escapeHtml(JSON.stringify(evidence.contextDelta, null, 2))}</pre>
            </details>`
          : ""
      }
    </section>
  `;
}

function renderSectionHeading(title, source, escapeHtml) {
  return `
    <header class="metadata-summary-heading">
      <h3>${escapeHtml(title)}</h3>
      <span>${escapeHtml(source)}</span>
    </header>
  `;
}

function metadataKeyLabel(key, translate) {
  const translated = translate(`metadataKey_${key}`);
  return translated === `metadataKey_${key}` ? key : translated;
}

function formatMetadataValue(value, formatNumber) {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function metadataTranslatedValue(value, translate) {
  if (typeof value !== "string") return value;
  const translated = translate(`metadataValue_${value}`);
  return translated === `metadataValue_${value}` ? value : translated;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(Number(value || 0) >= 0.1 ? 1 : 2)}%`;
}
