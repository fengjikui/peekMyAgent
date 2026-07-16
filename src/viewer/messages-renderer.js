import { messageViewModel } from "./message-view-model.js";

export function renderMessagesControls({ section, mode, translate, escapeHtml }) {
  if (section !== "messages") return "";
  return `
    <div class="translation-toolbar compact">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(translate("messagesViewAria"))}">
        <button type="button" class="${mode === "organized" ? "active" : ""}" data-messages-mode="organized">${escapeHtml(translate("messagesOrganized"))}</button>
        <button type="button" class="${mode === "source" ? "active" : ""}" data-messages-mode="source">${escapeHtml(translate("messagesOriginal"))}</button>
      </div>
    </div>
  `;
}

export function renderMessagesSection({ messagesValue, mode, translate, escapeHtml, renderRawDetail, renderMarkdown, renderJson, formatNumber }) {
  const messages = Array.isArray(messagesValue) ? messagesValue : [];
  if (mode === "source") return renderRawDetail("messages / history", messages);
  if (!messages.length) return `<div class="empty-box">${escapeHtml(translate("messagesEmpty"))}</div>`;
  return `<section class="raw-message-list">${messages
    .map((message, index) => renderMessage(messageViewModel(message, index), { translate, escapeHtml, renderMarkdown, renderJson, formatNumber }))
    .join("")}</section>`;
}

function renderMessage(message, dependencies) {
  const { translate, escapeHtml } = dependencies;
  return `
    <article class="raw-message-card role-${escapeHtml(message.roleClass)}">
      <header class="raw-message-card-header">
        <strong>#${escapeHtml(String(message.index))} ${escapeHtml(message.role)}</strong>
        <span>${escapeHtml(translate("messageRole"))}: ${escapeHtml(message.role)}</span>
      </header>
      <div class="raw-message-blocks">
        ${message.blocks.map((block) => renderMessageBlock(block, dependencies)).join("")}
      </div>
    </article>
  `;
}

function renderMessageBlock(block, { translate, escapeHtml, renderMarkdown, renderJson, formatNumber }) {
  return `
    <section class="raw-message-block ${escapeHtml(block.isText ? "text" : "structured")}">
      <header>
        <span>${escapeHtml(translate("messageType"))}: ${escapeHtml(String(block.type))}</span>
        <em>#${escapeHtml(String(block.index))}</em>
      </header>
      ${
        block.text
          ? `<div class="raw-message-markdown">${renderMarkdown(block.textPreview.text)}</div>
             ${
               block.textPreview.truncated
                 ? `<p class="raw-message-truncation">${escapeHtml(
                     translate("messageTextTruncated", {
                       shown: formatNumber(block.textPreview.text.length),
                       total: formatNumber(block.textPreview.originalLength),
                     }),
                   )}</p>`
                 : ""
             }`
          : `<p class="raw-message-empty">${escapeHtml(translate("messageTextFallback"))}</p>`
      }
      ${
        block.isText
          ? ""
          : `<details class="raw-message-raw"><summary>${escapeHtml(translate("messageRawDetails"))}</summary><div class="json-node">${renderJson(block.raw)}</div></details>`
      }
    </section>
  `;
}
