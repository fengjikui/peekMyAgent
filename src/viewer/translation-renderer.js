export function renderTranslationControls({
  section,
  stats,
  cacheAvailable,
  cacheTargetLanguage = "",
  generating,
  generateError = "",
  generateMessage = "",
  targetLanguage,
  languageLabel,
  translationMode,
  sectionLabel,
  toolFilter = null,
  translate,
  escapeHtml,
}) {
  if (!["system", "tools", "harness"].includes(section)) return "";
  const statusText = cacheAvailable
    ? translate("translationCacheHit", {
        hit: stats.hit,
        total: stats.total,
        language: cacheTargetLanguage || languageLabel,
      })
    : translate("translationCacheMissing", { language: languageLabel });
  return `
    <div class="translation-toolbar">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(translate("translationModeAria"))}">
        <button type="button" class="${translationMode === "source" ? "active" : ""}" data-translation-mode="source" data-translation-section="${escapeHtml(section)}">${escapeHtml(translate("source"))}</button>
        <button type="button" class="${translationMode === targetLanguage ? "active" : ""}" data-translation-mode="${escapeHtml(targetLanguage)}" data-translation-section="${escapeHtml(section)}">${escapeHtml(languageLabel)}</button>
      </div>
      <div class="translation-toolbar-actions">
        ${renderToolFilter(toolFilter, translate, escapeHtml)}
        <span class="translation-status ${generateError ? "error" : stats.missing ? "partial" : "ready"}">${escapeHtml(generateError || generateMessage || statusText)}</span>
        <button type="button" class="translation-generate-button" data-translation-copy-all="${escapeHtml(section)}" ${stats.total ? "" : "disabled"} title="${escapeHtml(translate("copyAllTitle", { section: sectionLabel }))}">${escapeHtml(translate("copyAll"))}</button>
        <button type="button" class="translation-generate-button" data-translation-generate="true" data-translation-section="${escapeHtml(section)}" ${generating ? "disabled" : ""} title="${escapeHtml(translate("refreshSectionTitle", { section: sectionLabel }))}">${escapeHtml(generating ? translate("updating") : translate("updateCurrentSection"))}</button>
      </div>
    </div>
  `;
}

export function renderTranslationSection({
  view,
  emptyText,
  generating,
  targetLanguageLabel,
  translate,
  escapeHtml,
  renderMarkdown,
  renderPre,
  registerAction,
}) {
  if (view.type === "tools") {
    if (!view.groups.length) return `<div class="empty-box">${escapeHtml(emptyText)}</div>`;
    return `
      <section class="tool-translation-list">
        ${view.groups
          .map((group) =>
            renderToolTranslationGroup(group, {
              searchTarget: Boolean(view.query),
              generating,
              targetLanguageLabel,
              translate,
              escapeHtml,
              renderMarkdown,
              renderPre,
              registerAction,
            }),
          )
          .join("")}
      </section>
    `;
  }
  if (!view.items.length) return `<div class="empty-box">${escapeHtml(emptyText)}</div>`;
  return `
    <section class="translation-list">
      ${view.items
        .map((block) =>
          renderTranslationBlock({
            block,
            searchTarget: Boolean(view.query),
            generating,
            targetLanguageLabel,
            translate,
            escapeHtml,
            renderMarkdown,
            renderPre,
            registerAction,
          }),
        )
        .join("")}
    </section>
  `;
}

export function renderTranslationBlock({
  block,
  compact = false,
  searchTarget = false,
  generating,
  targetLanguageLabel,
  translate,
  escapeHtml,
  renderMarkdown,
  renderPre,
  registerAction,
}) {
  const actionId = registerAction({
    kind: block.kind,
    sourceText: block.sourceText,
    metadata: { ...block.metadata, label: block.actionLabel || block.label },
  });
  return `
    <article class="translation-block ${escapeHtml(block.kindClass)} ${compact ? "compact" : ""} ${block.hit ? "hit" : "miss"}" ${searchTarget ? 'data-raw-search-target="true"' : ""}>
      <header>
        ${block.label ? `<strong>${escapeHtml(block.label)}</strong>` : ""}
        <span class="translation-block-meta">
          <span class="translation-kind">${escapeHtml(block.kindLabel || block.kind)}</span>
          <span class="translation-cache-state">${escapeHtml(block.hit ? translate("cacheState", { language: targetLanguageLabel }) : translate("missingTranslation"))}</span>
          <button type="button" class="translation-inline-button" data-translation-copy="${escapeHtml(actionId)}" title="${escapeHtml(translate("copyBlockTitle"))}">${escapeHtml(translate("copy"))}</button>
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${generating ? "disabled" : ""}>${escapeHtml(block.hit ? translate("retranslate") : translate("translate"))}</button>
        </span>
      </header>
      ${renderMarkdown(block.displayText)}
      <details>
        <summary>${escapeHtml(translate("source"))}</summary>
        <div class="details-body">${renderPre(block.sourceText)}</div>
      </details>
    </article>
  `;
}

function renderToolTranslationGroup(group, dependencies) {
  const { searchTarget, generating, targetLanguageLabel, translate, escapeHtml, renderMarkdown, renderPre, registerAction } = dependencies;
  const actionId = registerAction({
    kind: "tool_description",
    sourceText: "",
    metadata: { label: group.toolName, group: "tool", tool_name: group.toolName },
    materials: group.materials,
  });
  const originalText = toolOriginalText(group, translate);
  return `
    <section class="tool-translation-group" ${searchTarget ? 'data-raw-search-target="true"' : ""}>
      <header class="tool-translation-group-header">
        <div class="tool-translation-group-identity">
          <strong>${escapeHtml(group.toolName)}</strong>
          <span>${escapeHtml(group.description ? translate("toolDescriptionCount") : translate("noToolDescription"))} · ${escapeHtml(translate("parameterCount", { count: group.parameters.total }))}</span>
        </div>
        <div class="tool-translation-group-actions">
          <span class="translation-cache-state">${escapeHtml(
            group.hit
              ? `${translate("cacheState", { language: targetLanguageLabel })} ${group.hit}/${group.total}`
              : translate("missingTranslation"),
          )}</span>
          <button type="button" class="translation-inline-button" data-translation-copy="${escapeHtml(actionId)}" title="${escapeHtml(translate("copyBlockTitle"))}">${escapeHtml(translate("copy"))}</button>
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${generating ? "disabled" : ""}>${escapeHtml(group.hit ? translate("retranslateTool") : translate("translateTool"))}</button>
        </div>
      </header>
      ${
        group.description
          ? `<div class="tool-translation-description">${renderMarkdown(group.description.displayText)}</div>`
          : ""
      }
      ${group.parameters.total ? renderToolParameterList(group.parameters, dependencies) : ""}
      ${
        group.displaySource
          ? ""
          : `<details class="tool-translation-source">
              <summary>${escapeHtml(translate("source"))}</summary>
              <div class="details-body">${renderPre(originalText)}</div>
            </details>`
      }
    </section>
  `;
}

function renderToolParameterList(parameters, { translate, escapeHtml, renderMarkdown }) {
  return `
    <section class="tool-translation-parameters">
      <h4>${escapeHtml(translate("parameterDescriptions"))} · ${escapeHtml(String(parameters.total))}</h4>
      <div class="tool-parameter-list">
        ${parameters.items
          .map(
            (item) => `
              <section class="tool-parameter-item">
                <strong>${escapeHtml(item.label)}</strong>
                ${renderMarkdown(item.displayText)}
              </section>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderToolFilter(toolFilter, translate, escapeHtml) {
  if (!toolFilter?.available) return "";
  const invokedOnly = toolFilter.mode === "invoked";
  return `<button type="button" class="translation-tool-filter ${invokedOnly ? "active" : ""}" data-tools-schema-filter="${invokedOnly ? "all" : "invoked"}" aria-pressed="${invokedOnly ? "true" : "false"}">${escapeHtml(
    invokedOnly
      ? translate("showAllTools", { count: toolFilter.total })
      : translate("showInvokedTools", { count: toolFilter.invoked }),
  )}</button>`;
}

function toolOriginalText(group, translate) {
  const parts = [];
  if (group.description) {
    parts.push(`## ${translate("toolDescription")}`, "", group.description.sourceText);
  }
  if (group.parameters.items.length) {
    parts.push(
      `## ${translate("parameterDescriptions")}`,
      "",
      group.parameters.items.map((item) => `### ${item.label}\n${item.sourceText}`).join("\n\n"),
    );
  }
  return parts.join("\n\n");
}
