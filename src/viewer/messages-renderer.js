import { organizedMessagesViewModel } from "./message-view-model.js";

export function renderMessagesControls({ section, mode, translate, escapeHtml }) {
  if (!["developer", "history", "message", "messages", "response", "tool_results"].includes(section)) return "";
  return `
    <div class="translation-toolbar compact">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(translate("messagesViewAria"))}">
        <button type="button" class="${mode === "source" ? "active" : ""}" data-messages-mode="source">${escapeHtml(translate("messagesOriginal"))}</button>
        <button type="button" class="${mode === "organized" ? "active" : ""}" data-messages-mode="organized">${escapeHtml(translate("messagesOrganized"))}</button>
      </div>
    </div>
  `;
}

export function renderMessagesSection({
  messagesValue,
  mode,
  preserveHarnessText = false,
  timelineRequestIndexes = [],
  sourceTitle = "messages",
  translate,
  escapeHtml,
  renderRawDetail,
  renderMarkdown,
  renderJson,
  formatNumber,
  translatedTextFor,
  targetLanguageLabel,
  translationLoading,
  registerTranslationAction,
}) {
  const messages = Array.isArray(messagesValue) ? messagesValue : [];
  if (mode === "source") return renderRawDetail(sourceTitle, messages);
  if (!messages.length) return `<div class="empty-box">${escapeHtml(translate("messagesEmpty"))}</div>`;
  const groups = organizedMessagesViewModel(messages, { timelineRequestIndexes, preserveHarnessText });
  if (!groups.length) return `<div class="empty-box">${escapeHtml(translate("messagesOrganizedEmpty"))}</div>`;
  return `<section class="raw-message-list">${groups
    .map((group) =>
      renderMessageGroup(group, {
        translate,
        escapeHtml,
        renderMarkdown,
        renderJson,
        formatNumber,
        translatedTextFor,
        targetLanguageLabel,
        translationLoading,
        registerTranslationAction,
      }),
    )
    .join("")}</section>`;
}

function renderMessageGroup(group, dependencies) {
  const { translate, escapeHtml } = dependencies;
  const requestLabel = group.timelineRequestIndex == null
    ? escapeHtml(translate("messageHistoryGroup"))
    : `#${escapeHtml(String(group.timelineRequestIndex))}`;
  const kindLabel = translate(messageGroupLabelKey(group.kind));
  return `
    <article class="raw-message-group role-${escapeHtml(group.roleClass)} kind-${escapeHtml(group.kind)}">
      <header class="raw-message-group-header">
        <div class="raw-message-group-title">
          <span class="raw-message-timeline-index">${requestLabel}</span>
          <strong>${escapeHtml(kindLabel)}</strong>
        </div>
        <span class="raw-message-group-count">${escapeHtml(translate("messageGroupBlocks", { count: group.blockCount }))}</span>
      </header>
      <div class="raw-message-blocks">
        ${group.blocks.map((block) => renderMessageBlock(block, dependencies)).join("")}
      </div>
    </article>
  `;
}

function renderMessageBlock(block, dependencies) {
  const { translate, escapeHtml } = dependencies;
  const inferred = block.roleInferred
    ? `<span class="raw-message-inferred" title="${escapeHtml(translate("messageRoleInferredTitle"))}">${escapeHtml(translate("messageRoleInferred"))}</span>`
    : "";
  return `
    <section class="raw-message-block kind-${escapeHtml(block.kind)}">
      <header class="raw-message-block-header">
        <div class="raw-message-block-tags">
          <span>${escapeHtml(translate("messageType"))}: <strong>${escapeHtml(String(block.type))}</strong></span>
          <span>${escapeHtml(translate("messageRole"))}: <strong>${escapeHtml(String(block.role))}</strong></span>
          ${inferred}
        </div>
        <em>${escapeHtml(translate("messageSourceIndex", { index: block.sourceIndex }))}</em>
      </header>
      ${renderMessageBlockBody(block, dependencies)}
    </section>
  `;
}

function renderMessageBlockBody(block, dependencies) {
  if (block.kind === "tool_call") return renderToolCall(block, dependencies);
  if (block.kind === "tool_result") return renderToolResult(block, dependencies);
  if (block.kind === "reasoning") {
    return block.text
      ? renderMessageText(block, dependencies)
      : `<p class="raw-message-empty">${dependencies.escapeHtml(dependencies.translate("messageReasoningUnavailable"))}</p>`;
  }
  if (block.kind === "text") {
    return block.text
      ? renderMessageText(block, dependencies)
      : `<p class="raw-message-empty">${dependencies.escapeHtml(dependencies.translate("messageTextFallback"))}</p>`;
  }
  return `<details class="raw-message-raw"><summary>${dependencies.escapeHtml(
    dependencies.translate("messageRawDetails"),
  )}</summary><div class="json-node">${dependencies.renderJson(block.raw)}</div></details>`;
}

function renderMessageText(block, { translate, escapeHtml, renderMarkdown, formatNumber }) {
  return `<div class="raw-message-markdown">${renderMarkdown(block.textPreview.text)}</div>
    ${
      block.textPreview.truncated
        ? `<p class="raw-message-truncation">${escapeHtml(
            translate("messageTextTruncated", {
              shown: formatNumber(block.textPreview.text.length),
              total: formatNumber(block.textPreview.originalLength),
            }),
          )}</p>`
        : ""
    }`;
}

function renderToolCall(block, { translate, escapeHtml, renderJson }) {
  const call = block.toolCall || {};
  return `
    <div class="raw-message-tool-heading">
      <strong>${escapeHtml(call.name || translate("messageUnknownTool"))}</strong>
      ${call.callId ? `<code>${escapeHtml(call.callId)}</code>` : ""}
    </div>
    <div class="raw-message-tool-field">
      <span>${escapeHtml(translate("messageParameters"))}</span>
      <div class="json-node raw-message-tool-json">${renderJson(call.parameters ?? {})}</div>
    </div>
  `;
}

function renderToolResult(block, dependencies) {
  const { translate, escapeHtml } = dependencies;
  const result = block.toolResult || {};
  return `
    ${
      result.callId || result.name
        ? `<div class="raw-message-tool-heading">
            <strong>${escapeHtml(result.name || translate("messageToolOutput"))}</strong>
            ${result.callId ? `<code>${escapeHtml(result.callId)}</code>` : ""}
          </div>`
        : ""
    }
    <div class="raw-message-tool-field">
      <span>${escapeHtml(translate("messageOutput"))}</span>
      ${
        result.toolSearch
          ? renderToolSearchResult(result.toolSearch, dependencies)
          : `<pre class="raw-message-tool-output">${escapeHtml(result.output || translate("messageTextFallback"))}</pre>`
      }
    </div>
  `;
}

function renderToolSearchResult(result, dependencies) {
  const { translate, escapeHtml } = dependencies;
  if (!result.groups.length) {
    return `<p class="raw-message-empty">${escapeHtml(translate("messageToolSearchEmpty"))}</p>`;
  }
  return `
    <div class="raw-message-tool-search-result">
      <div class="raw-message-tool-search-summary">${escapeHtml(
        translate("messageToolSearchSummary", {
          namespaces: result.namespaceCount,
          tools: result.toolCount,
        }),
      )}</div>
      ${result.groups
        .map(
          (group) => `
            <section class="raw-message-tool-search-group">
              <div class="raw-message-tool-search-heading">
                <code>${escapeHtml(group.name)}</code>
                <span>${escapeHtml(group.type)}</span>
              </div>
              ${group.description ? renderToolSearchDescription(group.description, group.name, dependencies) : ""}
              ${
                group.tools.length
                  ? `<div class="raw-message-tool-search-tools">${group.tools
                      .map((tool) => renderDiscoveredTool(tool, dependencies))
                      .join("")}</div>`
                  : ""
              }
            </section>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderDiscoveredTool(tool, dependencies) {
  const { translate, escapeHtml, renderJson } = dependencies;
  const flags = [
    tool.strict === null ? "" : `strict: ${String(tool.strict)}`,
    tool.deferLoading === null ? "" : `defer_loading: ${String(tool.deferLoading)}`,
  ].filter(Boolean);
  return `
    <details class="raw-message-discovered-tool">
      <summary>
        <code>${escapeHtml(tool.name)}</code>
        <span>${escapeHtml(tool.type)}</span>
        ${flags.length ? `<em>${escapeHtml(flags.join(" · "))}</em>` : ""}
      </summary>
      <div class="raw-message-discovered-tool-body">
        ${tool.description ? renderToolSearchDescription(tool.description, tool.name, dependencies) : ""}
        ${renderToolParameterDescriptions(tool, dependencies)}
        ${
          tool.parameters
            ? `<details class="raw-message-tool-schema">
                <summary>${escapeHtml(translate("messageToolParameterSchema"))}</summary>
                <div class="json-node raw-message-tool-json">${renderJson(tool.parameters)}</div>
              </details>`
            : ""
        }
        <details class="raw-message-tool-schema">
          <summary>${escapeHtml(translate("messageToolDefinitionRaw"))}</summary>
          <div class="json-node raw-message-tool-json">${renderJson(tool.raw)}</div>
        </details>
      </div>
    </details>
  `;
}

function renderToolSearchDescription(sourceText, toolName, dependencies) {
  const { translate, escapeHtml, renderMarkdown, translatedTextFor, targetLanguageLabel, translationLoading } = dependencies;
  const translatedText = translatedTextFor?.("tool_description", sourceText) || "";
  const actionId = registerToolTranslationAction(
    {
      kind: "tool_description",
      sourceText,
      metadata: { tool_name: toolName, label: `${toolName} · description` },
    },
    dependencies,
  );
  return `
    <section class="raw-message-tool-description ${translatedText ? "translated" : ""}">
      <header>
        <span>${escapeHtml(translate("toolDescription"))}${translatedText && targetLanguageLabel ? ` · ${escapeHtml(targetLanguageLabel)}` : ""}</span>
        ${
          actionId
            ? `<button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${translationLoading ? "disabled" : ""}>${escapeHtml(translatedText ? translate("retranslate") : translate("translate"))}</button>`
            : ""
        }
      </header>
      <div class="raw-message-markdown">${renderMarkdown(translatedText || sourceText)}</div>
      ${
        translatedText
          ? `<details><summary>${escapeHtml(translate("source"))}</summary><div class="raw-message-markdown">${renderMarkdown(sourceText)}</div></details>`
          : ""
      }
    </section>
  `;
}

function renderToolParameterDescriptions(tool, dependencies) {
  const { translate, escapeHtml, renderMarkdown, translatedTextFor, targetLanguageLabel, translationLoading } = dependencies;
  const descriptions = Array.isArray(tool.parameterDescriptions) ? tool.parameterDescriptions : [];
  if (!descriptions.length) return "";
  const materials = descriptions.map((item) => ({
    kind: "tool_parameter_description",
    source_text: item.description,
    metadata: { tool_name: tool.name, path: item.path, field_name: item.field_name },
  }));
  const translatedCount = descriptions.filter((item) => translatedTextFor?.("tool_parameter_description", item.description)).length;
  const actionId = registerToolTranslationAction(
    {
      kind: "tool_parameter_description",
      sourceText: "",
      materials,
      metadata: { tool_name: tool.name, label: translate("parameterDescriptions") },
    },
    dependencies,
  );
  return `
    <section class="raw-message-tool-parameters">
      <header>
        <strong>${escapeHtml(translate("parameterDescriptions"))} · ${escapeHtml(String(descriptions.length))}</strong>
        <span>
          ${translatedCount && targetLanguageLabel ? `${escapeHtml(targetLanguageLabel)} ${translatedCount}/${descriptions.length}` : ""}
          ${
            actionId
              ? `<button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${translationLoading ? "disabled" : ""}>${escapeHtml(translatedCount ? translate("retranslateParameters") : translate("translateParameters"))}</button>`
              : ""
          }
        </span>
      </header>
      <div class="raw-message-tool-parameter-list">
        ${descriptions
          .map((item) => {
            const translated = translatedTextFor?.("tool_parameter_description", item.description) || "";
            return `<section>
              <code>${escapeHtml(item.field_name || item.path)}</code>
              <div class="raw-message-markdown">${renderMarkdown(translated || item.description)}</div>
            </section>`;
          })
          .join("")}
      </div>
    </section>
  `;
}

function registerToolTranslationAction(action, { registerTranslationAction }) {
  return typeof registerTranslationAction === "function" ? registerTranslationAction(action) : "";
}

function messageGroupLabelKey(kind) {
  if (kind === "model_response") return "messageModelResponse";
  if (kind === "tool_results") return "messageToolResults";
  if (kind === "user_input") return "messageUserInput";
  return "messageContextInput";
}
