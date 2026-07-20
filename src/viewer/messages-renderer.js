import { organizedMessagesViewModel } from "./message-view-model.js";

export function renderMessagesControls({ section, mode, translate, escapeHtml }) {
  if (!["history", "message", "messages", "response"].includes(section)) return "";
  return `
    <div class="translation-toolbar compact">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(translate("messagesViewAria"))}">
        <button type="button" class="${mode === "organized" ? "active" : ""}" data-messages-mode="organized">${escapeHtml(translate("messagesOrganized"))}</button>
        <button type="button" class="${mode === "source" ? "active" : ""}" data-messages-mode="source">${escapeHtml(translate("messagesOriginal"))}</button>
      </div>
    </div>
  `;
}

export function renderMessagesSection({
  messagesValue,
  mode,
  timelineRequestIndexes = [],
  sourceTitle = "messages",
  translate,
  escapeHtml,
  renderRawDetail,
  renderMarkdown,
  renderJson,
  formatNumber,
}) {
  const messages = Array.isArray(messagesValue) ? messagesValue : [];
  if (mode === "source") return renderRawDetail(sourceTitle, messages);
  if (!messages.length) return `<div class="empty-box">${escapeHtml(translate("messagesEmpty"))}</div>`;
  const groups = organizedMessagesViewModel(messages, { timelineRequestIndexes });
  if (!groups.length) return `<div class="empty-box">${escapeHtml(translate("messagesOrganizedEmpty"))}</div>`;
  return `<section class="raw-message-list">${groups
    .map((group) => renderMessageGroup(group, { translate, escapeHtml, renderMarkdown, renderJson, formatNumber }))
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

function renderMessageBlock(block, { translate, escapeHtml, renderMarkdown, renderJson, formatNumber }) {
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
      ${renderMessageBlockBody(block, { translate, escapeHtml, renderMarkdown, renderJson, formatNumber })}
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

function renderToolResult(block, { translate, escapeHtml }) {
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
      <pre class="raw-message-tool-output">${escapeHtml(result.output || translate("messageTextFallback"))}</pre>
    </div>
  `;
}

function messageGroupLabelKey(kind) {
  if (kind === "model_response") return "messageModelResponse";
  if (kind === "tool_results") return "messageToolResults";
  if (kind === "user_input") return "messageUserInput";
  return "messageContextInput";
}
