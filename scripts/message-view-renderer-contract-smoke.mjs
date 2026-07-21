#!/usr/bin/env node
import assert from "node:assert/strict";
import { responseInputItemToMessage } from "../src/shared/request-payload.mjs";
import {
  inferMessageRole,
  messageTimelineRequestIndexes,
  normalizeMessageBlocks,
  organizedMessagesViewModel,
  responseConversationMessages,
  safeMessageClassName,
  truncateMessageText,
  upstreamConversationMessageSections,
  upstreamToolResultMessages,
} from "../src/viewer/message-view-model.js";
import { renderMessagesControls, renderMessagesSection } from "../src/viewer/messages-renderer.js";

assert.deepEqual(normalizeMessageBlocks("hello"), [{ type: "text", text: "hello", raw: "hello" }]);
assert.equal(normalizeMessageBlocks({ content: [] })[0].type, "empty");
assert.equal(safeMessageClassName("Tool Result / User"), "tool-result-user");
assert.equal(truncateMessageText("abcdef", 4).text, "abcd\n\n...");

assert.equal(inferMessageRole({ type: "reasoning", summary: [] }), "assistant");
assert.equal(inferMessageRole({ type: "function_call", name: "exec_command" }), "assistant");
assert.equal(inferMessageRole({ type: "function_call_output", output: "done" }), "tool");

const translate = (key, values = {}) => `${key}${values.total ? `:${values.shown}/${values.total}` : ""}`;
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const dependencies = {
  translate,
  escapeHtml,
  renderRawDetail: (title, value) => `<raw title="${title}">${JSON.stringify(value)}</raw>`,
  renderMarkdown: (text) => `<md>${escapeHtml(text)}</md>`,
  renderJson: (value) => `<json>${escapeHtml(JSON.stringify(value))}</json>`,
  formatNumber: String,
  translatedTextFor: () => "",
  targetLanguageLabel: "中文（简体）",
  translationLoading: false,
  registerTranslationAction: ({ kind }) => `translate-${kind}`,
};

const controls = renderMessagesControls({ section: "history", mode: "organized", translate, escapeHtml });
assert.match(controls, /data-messages-mode="organized"/);
assert.match(controls, /class="active" data-messages-mode="organized"/);
assert.ok(
  controls.indexOf('data-messages-mode="source"') < controls.indexOf('data-messages-mode="organized"'),
  "The source view must remain the left-most message view option",
);
assert.match(renderMessagesControls({ section: "message", mode: "source", translate, escapeHtml }), /data-messages-mode="source"/);
assert.match(renderMessagesControls({ section: "developer", mode: "organized", translate, escapeHtml }), /data-messages-mode="organized"/);
assert.match(renderMessagesControls({ section: "response", mode: "organized", translate, escapeHtml }), /data-messages-mode="organized"/);
assert.match(renderMessagesControls({ section: "tool_results", mode: "organized", translate, escapeHtml }), /data-messages-mode="organized"/);
assert.equal(renderMessagesControls({ section: "system", mode: "organized", translate, escapeHtml }), "");

const organized = renderMessagesSection({ messagesValue: [{ role: "user", content: [{ type: "text", text: "<script>" }] }], mode: "organized", ...dependencies });
assert.match(organized, /role-user/);
assert.match(organized, /<md>&lt;script><\/md>/);
assert.doesNotMatch(organized, /<script>/);

const dedupedHarness = renderMessagesSection({
  messagesValue: [
    { role: "developer", content: [{ type: "input_text", text: "<permissions instructions>Full access.</permissions instructions>" }] },
    { role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/tmp/project</cwd></environment_context>" }] },
    { role: "user", content: [{ type: "input_text", text: "**真实用户消息**" }] },
  ],
  mode: "organized",
  ...dependencies,
});
assert.doesNotMatch(dedupedHarness, /permissions instructions|environment_context|role-developer/);
assert.match(dedupedHarness, /<md>\*\*真实用户消息\*\*<\/md>/);

const developerView = renderMessagesSection({
  messagesValue: [
    { role: "developer", content: [{ type: "input_text", text: "<permissions instructions>Full access.</permissions instructions>" }] },
  ],
  mode: "organized",
  preserveHarnessText: true,
  ...dependencies,
});
assert.match(developerView, /role-developer/);
assert.match(developerView, /permissions instructions/);

const codexCompactHandoff = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
**Handoff Summary**
- Keep the original payload visible in History.`;
const compactHistory = renderMessagesSection({
  messagesValue: [{ role: "user", content: [{ type: "input_text", text: codexCompactHandoff }] }],
  mode: "organized",
  ...dependencies,
});
assert.match(compactHistory, /Handoff Summary/);
assert.match(compactHistory, /Keep the original payload visible in History/);

const structured = renderMessagesSection({ messagesValue: [{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } }] }], mode: "organized", ...dependencies });
assert.match(structured, /raw-message-tool-heading/);
assert.match(structured, /Bash/);
assert.match(structured, /call-1/);
assert.match(structured, /messageParameters/);
assert.match(structured, /<json>/);

const responsesMessages = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "question one" }] },
  { type: "reasoning", summary: [{ type: "summary_text", text: "reason one" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "question two" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect the workspace." }] },
  { type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}', call_id: "call-1" },
  { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call-2" },
  { type: "function_call_output", call_id: "call-1", output: "/tmp" },
  { type: "function_call_output", call_id: "call-2", output: "README.md" },
];
const responseGroups = organizedMessagesViewModel(responsesMessages, { timelineRequestIndexes: [1, 2, 3] });
assert.deepEqual(
  responseGroups.map(({ timelineRequestIndex, kind, role, blockCount }) => ({ timelineRequestIndex, kind, role, blockCount })),
  [
    { timelineRequestIndex: 1, kind: "user_input", role: "user", blockCount: 1 },
    { timelineRequestIndex: 1, kind: "model_response", role: "assistant", blockCount: 2 },
    { timelineRequestIndex: 2, kind: "user_input", role: "user", blockCount: 1 },
    { timelineRequestIndex: 2, kind: "model_response", role: "assistant", blockCount: 3 },
    { timelineRequestIndex: 3, kind: "tool_results", role: "tool", blockCount: 2 },
  ],
);
assert.equal(responseGroups[3].blocks[1].toolCall.name, "exec_command");
assert.equal(responseGroups[3].blocks[1].toolCall.callId, "call-1");
assert.deepEqual(responseGroups[3].blocks[1].toolCall.parameters, { cmd: "pwd" });
assert.equal(responseGroups[4].blocks[0].toolResult.output, "/tmp");

const toolSearchMessages = [
  {
    type: "tool_search_call",
    call_id: "call-search",
    arguments: { query: "Multi-agent tools", limit: 5 },
  },
  {
    type: "tool_search_output",
    call_id: "call-search",
    tools: [
      {
        type: "namespace",
        name: "multi_agent_v1",
        description: "Tools for spawning and managing sub-agents.",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            description: "Spawn an agent with a bounded task.",
            strict: false,
            defer_loading: true,
            parameters: {
              type: "object",
              properties: {
                message: { type: "string", description: "Initial task for the new agent." },
              },
              required: ["message"],
              additionalProperties: false,
            },
          },
          { type: "function", name: "wait_agent", description: "Wait for an agent" },
        ],
      },
    ],
  },
];
assert.deepEqual(responseInputItemToMessage(toolSearchMessages[0]), {
  role: "assistant",
  source_type: "tool_search_call",
  content: [{
    type: "tool_use",
    id: "call-search",
    name: "tool_search",
    input: { query: "Multi-agent tools", limit: 5 },
  }],
});
assert.deepEqual(responseInputItemToMessage(toolSearchMessages[1]), {
  role: "tool",
  source_type: "tool_search_output",
  codex_item_type: "tool_search_output",
  tool_call_id: "call-search",
  name: "tool_search",
  content: toolSearchMessages[1].tools,
});
const toolSearchGroups = organizedMessagesViewModel(toolSearchMessages, { timelineRequestIndexes: [11, 12] });
assert.equal(toolSearchGroups[0].blocks[0].toolCall.name, "tool_search");
assert.equal(toolSearchGroups[1].blocks[0].toolResult.name, "tool_search");
assert.equal(toolSearchGroups[1].blocks[0].toolResult.toolSearch.namespaceCount, 1);
assert.equal(toolSearchGroups[1].blocks[0].toolResult.toolSearch.toolCount, 2);
assert.equal(toolSearchGroups[1].blocks[0].toolResult.toolSearch.groups[0].tools[0].description, "Spawn an agent with a bounded task.");
assert.equal(toolSearchGroups[1].blocks[0].toolResult.toolSearch.groups[0].tools[0].parameters.required[0], "message");
assert.equal(toolSearchGroups[1].blocks[0].toolResult.toolSearch.groups[0].tools[0].parameterDescriptions[0].field_name, "message");
assert.deepEqual(
  toolSearchGroups[1].blocks[0].toolResult.toolSearch.groups[0].tools.map((tool) => tool.name),
  ["spawn_agent", "wait_agent"],
);
const renderedToolSearch = renderMessagesSection({
  messagesValue: toolSearchMessages,
  timelineRequestIndexes: [11, 12],
  mode: "organized",
  ...dependencies,
});
assert.match(renderedToolSearch, /tool_search/);
assert.match(renderedToolSearch, /multi_agent_v1/);
assert.match(renderedToolSearch, /spawn_agent/);
assert.match(renderedToolSearch, /wait_agent/);
assert.match(renderedToolSearch, /messageToolSearchSummary/);
assert.match(renderedToolSearch, /Spawn an agent with a bounded task/);
assert.match(renderedToolSearch, /Initial task for the new agent/);
assert.match(renderedToolSearch, /messageToolParameterSchema/);
assert.match(renderedToolSearch, /messageToolDefinitionRaw/);
assert.match(renderedToolSearch, /data-translation-retranslate="translate-tool_description"/);
assert.match(renderedToolSearch, /data-translation-retranslate="translate-tool_parameter_description"/);
assert.doesNotMatch(renderedToolSearch, /unknown|messageTextFallback/);

const toolResultRequest = {
  context_delta: { previous_messages: 1, new_messages: 1 },
  raw: {
    body: {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Find the agent tools" }] },
        toolSearchMessages[1],
      ],
    },
  },
};
assert.deepEqual(upstreamToolResultMessages(toolResultRequest), [toolSearchMessages[1]]);

const postCompactionRequest = {
  request_index: 21,
  context_delta: {
    baseline: false,
    previous_request_index: 20,
    previous_messages: 52,
    total_messages: 5,
    reused_messages: 0,
    new_messages: 5,
  },
  raw: {
    body: {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Earlier user request" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Another language model summarized the earlier conversation." }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>Full access.</permissions instructions>" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/tmp/project</cwd></environment_context>" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Current user request after compaction" }] },
      ],
    },
  },
};
const postCompactionSections = upstreamConversationMessageSections(postCompactionRequest);
assert.deepEqual(
  postCompactionSections.history.map((message) => message.content[0].text),
  ["Earlier user request", "Another language model summarized the earlier conversation."],
  "A rewritten compacted context remains History even when no raw prefix is reusable",
);
assert.deepEqual(
  postCompactionSections.current.map((message) => message.content[0].text),
  ["Current user request after compaction"],
  "The latest visible user input remains the current Message after compaction",
);

const exactRequest = {
  request_index: 4,
  context_delta: { previous_messages: 8, new_messages: 5 },
  raw: {
    body: {
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>Full access.</permissions instructions>" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context><cwd>/tmp/project</cwd></environment_context>" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "question one" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "reason one" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "question two" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer two" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd and ls" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect the workspace." }] },
        { type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}', call_id: "call-1" },
        { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call-2" },
        { type: "function_call_output", call_id: "call-1", output: "/tmp" },
        { type: "function_call_output", call_id: "call-2", output: "README.md" },
      ],
    },
  },
  summary: {
    response: {
      captured: true,
      complete_response: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "summarize the outputs" },
          { type: "text", text: "**Done.**" },
        ],
      },
    },
  },
};
const exactSections = upstreamConversationMessageSections(exactRequest);
assert.equal(exactSections.history.length, 6, "History excludes System/Harness material but keeps prior user and assistant items");
assert.equal(exactSections.current.length, 5, "Message contains only the current upstream delta");
assert.doesNotMatch(JSON.stringify(exactSections.history), /permissions instructions|environment_context/);
const historyGroups = organizedMessagesViewModel(exactSections.history, { timelineRequestIndexes: [1, 2, 3] });
assert.deepEqual(
  historyGroups.map(({ timelineRequestIndex, kind }) => ({ timelineRequestIndex, kind })),
  [
    { timelineRequestIndex: 1, kind: "user_input" },
    { timelineRequestIndex: 1, kind: "model_response" },
    { timelineRequestIndex: 2, kind: "user_input" },
    { timelineRequestIndex: 2, kind: "model_response" },
    { timelineRequestIndex: 3, kind: "user_input" },
  ],
);
const currentGroups = organizedMessagesViewModel(exactSections.current, { timelineRequestIndexes: [1, 2, 3, 4] });
assert.deepEqual(
  currentGroups.map(({ timelineRequestIndex, kind, blockCount }) => ({ timelineRequestIndex, kind, blockCount })),
  [
    { timelineRequestIndex: 3, kind: "model_response", blockCount: 3 },
    { timelineRequestIndex: 4, kind: "tool_results", blockCount: 2 },
  ],
);
const responseMessages = responseConversationMessages(exactRequest);
assert.deepEqual(responseMessages[0].content.map((block) => block.type), ["thinking", "text"]);
assert.equal(responseMessages[0].content[1].text, "**Done.**");

const groupedResponses = renderMessagesSection({
  messagesValue: responsesMessages,
  timelineRequestIndexes: [1, 2, 3],
  mode: "organized",
  ...dependencies,
});
assert.match(groupedResponses, /#2/);
assert.match(groupedResponses, /messageModelResponse/);
assert.match(groupedResponses, /messageToolResults/);
assert.match(groupedResponses, /exec_command/);
assert.match(groupedResponses, /call-1/);
assert.match(groupedResponses, /messageRole: <strong>assistant<\/strong>/);
assert.doesNotMatch(groupedResponses, /messageRole: <strong>unknown<\/strong>|#\d+ unknown/);

assert.deepEqual(
  messageTimelineRequestIndexes(
    { request_index: 4, context_delta: { previous_request_index: 2 } },
    [
      { request_index: 1 },
      { request_index: 2, context_delta: { previous_request_index: 1 } },
      { request_index: 3, context_delta: { previous_request_index: 2 } },
    ],
  ),
  [1, 2, 4],
);

const source = renderMessagesSection({
  messagesValue: [{ role: "user", content: "hello" }],
  sourceTitle: "History",
  mode: "source",
  ...dependencies,
});
assert.match(source, /<raw title="History">/);

const sourceWithHarness = renderMessagesSection({
  messagesValue: [{ role: "developer", content: "<permissions instructions>Full access.</permissions instructions>" }],
  mode: "source",
  ...dependencies,
});
assert.match(sourceWithHarness, /permissions instructions/);

console.log("message view model and renderer contract smoke passed");
