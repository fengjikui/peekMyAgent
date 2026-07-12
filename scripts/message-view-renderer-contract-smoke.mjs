#!/usr/bin/env node
import assert from "node:assert/strict";
import { messageViewModel, normalizeMessageBlocks, safeMessageClassName, truncateMessageText } from "../src/viewer/message-view-model.js";
import { renderMessagesControls, renderMessagesSection } from "../src/viewer/messages-renderer.js";

assert.deepEqual(normalizeMessageBlocks("hello"), [{ type: "text", text: "hello", raw: "hello" }]);
assert.equal(normalizeMessageBlocks({ content: [] })[0].type, "empty");
assert.equal(safeMessageClassName("Tool Result / User"), "tool-result-user");
assert.equal(truncateMessageText("abcdef", 4).text, "abcd\n\n...");

const view = messageViewModel(
  {
    role: "assistant",
    content: [
      { type: "text", text: "**hello**" },
      { type: "tool_use", name: "Bash", id: "call-1", input: { command: "pwd" } },
      { type: "tool_result", content: "done", tool_use_id: "call-1" },
    ],
  },
  3,
);
assert.equal(view.role, "assistant");
assert.equal(view.blocks[0].isText, true);
assert.equal(view.blocks[1].text, "Bash (call-1)");
assert.equal(view.blocks[1].isText, false);
assert.equal(view.blocks[2].text, "done");
assert.equal(view.blocks[2].isText, false);

const translate = (key, values = {}) => `${key}${values.total ? `:${values.shown}/${values.total}` : ""}`;
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const dependencies = {
  translate,
  escapeHtml,
  renderRawDetail: (title, value) => `<raw title="${title}">${JSON.stringify(value)}</raw>`,
  renderMarkdown: (text) => `<md>${escapeHtml(text)}</md>`,
  renderJson: (value) => `<json>${escapeHtml(JSON.stringify(value))}</json>`,
  formatNumber: String,
};

const controls = renderMessagesControls({ section: "messages", mode: "organized", translate, escapeHtml });
assert.match(controls, /data-messages-mode="organized"/);
assert.match(controls, /class="active" data-messages-mode="organized"/);
assert.equal(renderMessagesControls({ section: "system", mode: "organized", translate, escapeHtml }), "");

const organized = renderMessagesSection({ messagesValue: [{ role: "user", content: [{ type: "text", text: "<script>" }] }], mode: "organized", ...dependencies });
assert.match(organized, /role-user/);
assert.match(organized, /<md>&lt;script><\/md>/);
assert.doesNotMatch(organized, /<script>/);

const structured = renderMessagesSection({ messagesValue: [{ role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "pwd" } }] }], mode: "organized", ...dependencies });
assert.match(structured, /raw-message-raw/);
assert.match(structured, /<json>/);

const source = renderMessagesSection({ messagesValue: [{ role: "user", content: "hello" }], mode: "source", ...dependencies });
assert.match(source, /<raw title="messages \/ history">/);

console.log("message view model and renderer contract smoke passed");
