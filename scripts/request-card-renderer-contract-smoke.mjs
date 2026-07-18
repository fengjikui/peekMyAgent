#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  renderTimelineAssistantResponse,
  renderTimelineRequestCard,
  renderTimelineToolExchange,
  renderTimelineUpstreamEntry,
  renderTimelineUpstreamQuickActions,
} from "../src/viewer/request-card-renderer.js";

const translate = (key, values = {}) =>
  `${key}${Object.keys(values).length ? `:${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")}` : ""}`;
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const renderPre = (value) => `<pre>${escapeHtml(value)}</pre>`;

const actions = renderTimelineUpstreamQuickActions({
  requestId: 'request-<1>',
  expanded: true,
  sections: [
    { section: "system", label: "System" },
    { section: "tool_results", label: "tool_result" },
  ],
  translate,
  escapeHtml,
});
assert.match(actions, /data-upstream-toggle="request-&lt;1&gt;" aria-expanded="true"/);
assert.match(actions, /data-raw-section="tool_results"/);
assert.match(actions, /collapseUpstream/);

const reconstructedActions = renderTimelineUpstreamQuickActions({
  requestId: "request-reconstructed",
  expanded: false,
  sections: [],
  expandLabel: "Expand reconstructed upstream",
  collapseLabel: "Collapse reconstructed upstream",
  rawTitle: "Semantic reconstruction, not wire exact",
  translate,
  escapeHtml,
});
assert.match(reconstructedActions, />Expand reconstructed upstream</);
assert.match(reconstructedActions, /title="Semantic reconstruction, not wire exact"/);

const eventActions = renderTimelineUpstreamQuickActions({
  requestId: "request-event",
  expandable: false,
  sections: [],
  translate,
  escapeHtml,
});
assert.doesNotMatch(eventActions, /data-upstream-toggle/);
assert.match(eventActions, /data-raw="request-event"/);

const upstream = renderTimelineUpstreamEntry({
  entry: {
    requestIndex: 7,
    kindClass: "tool-result",
    userTurn: true,
    label: '<User & result>',
    preview: 'value <script>alert("x")</script>',
    ownerAria: "owner",
    metaHtml: '<span class="trusted-meta">subagent1</span>',
    actionsHtml: actions,
  },
  escapeHtml,
});
assert.match(upstream, /upstream-entry tool-result user-turn/);
assert.match(upstream, /&lt;User &amp; result&gt;/);
assert.doesNotMatch(upstream, /<script>/);
assert.match(upstream, /trusted-meta/);

const exchange = renderTimelineToolExchange({
  pairs: [
    {
      call: { id: "call-1", name: "Bash", arguments: { command: "pwd" } },
      result: { id: "call-1", content: "/tmp" },
      confidence: "id",
    },
    {
      call: { id: "call-2", name: "Read", arguments: { file_path: "<secret>" } },
      result: null,
      confidence: "call_only",
    },
  ],
  counts: { calls: 2, results: 1 },
  translate,
  escapeHtml,
  renderPre,
  serializeArguments: (value) => JSON.stringify(value, null, 2),
});
assert.match(exchange, /currentToolExchange:calls=2,results=1/);
assert.match(exchange, /pairedById/);
assert.match(exchange, /waitingToolResult/);
assert.match(exchange, /&lt;secret&gt;/);
assert.match(exchange, /noMatchedToolResult/);
assert.equal(
  renderTimelineToolExchange({
    pairs: [],
    counts: { calls: 0, results: 0 },
    translate,
    escapeHtml,
    renderPre,
    serializeArguments: JSON.stringify,
  }),
  "",
);

const response = renderTimelineAssistantResponse({
  view: {
    requestId: "request-7",
    expanded: false,
    longResponse: true,
    visibleText: "**Answer** <unsafe>",
    meta: ["12ms", "finish: tool_use", "input 120"],
    toolCalls: [{ id: "call-1", name: "Bash", arguments: { command: "pwd" } }],
    thinking: {
      text: "Need inspect first.",
      charCount: "19 chars",
      preview: "Need inspect",
      translation: "先检查。",
      actionId: "translation-1",
      actionLabel: "Retranslate",
      translationLoading: true,
    },
  },
  translate,
  escapeHtml,
  renderMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderTranslationMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderPre,
  serialize: (value) => JSON.stringify(value),
});
assert.match(response, /assistant-response-markdown collapsed/);
assert.match(response, /data-response-toggle="request-7"/);
assert.match(response, /data-raw-section="tool_calls" data-raw-mode="response"/);
assert.match(response, /translation-inline-button[^>]*disabled/);
assert.match(response, /先检查。/);
assert.match(response, /tool_use Bash \(call-1\)/);
assert.doesNotMatch(response, /<unsafe>/);

const emptyResponse = renderTimelineAssistantResponse({
  view: { requestId: "request-empty", visibleText: "", toolCalls: [] },
  translate,
  escapeHtml,
  renderMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderTranslationMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderPre,
  serialize: JSON.stringify,
});
assert.match(emptyResponse, /responseNoText/);

const toolOnlyResponse = renderTimelineAssistantResponse({
  view: {
    requestId: "request-tool-only",
    visibleText: "",
    toolCalls: [{ id: "call-tool-only", name: "Read", arguments: { file_path: "README.md" } }],
  },
  translate,
  escapeHtml,
  renderMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderTranslationMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderPre,
  serialize: JSON.stringify,
});
assert.doesNotMatch(toolOnlyResponse, /responseNoText/);
assert.match(toolOnlyResponse, /tool_use Read \(call-tool-only\)/);

const semanticSpawnResponse = renderTimelineAssistantResponse({
  view: {
    requestId: "request-agent-spawn",
    visibleText: "",
    toolCalls: [
      {
        id: "spawn-1",
        name: "spawn_agent",
        arguments: { message: "gAAAA-secret-ciphertext" },
        displayName: "spawn_agent · context_probe",
        displayLines: ["Inherited parent context", "Task payload hidden"],
        suppressArguments: true,
      },
    ],
  },
  translate,
  escapeHtml,
  renderMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderTranslationMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  renderPre,
  serialize: JSON.stringify,
});
assert.match(semanticSpawnResponse, /spawn_agent · context_probe/);
assert.match(semanticSpawnResponse, /Inherited parent context/);
assert.doesNotMatch(semanticSpawnResponse, /gAAAA-secret-ciphertext/);

const card = renderTimelineRequestCard({
  requestId: 'request-<7>',
  requestIndex: 7,
  upstreamOpen: true,
  upstreamEntryHtml: upstream,
  upstreamBodyHtml: '<div data-body="trusted"></div>',
  toolExchangeHtml: exchange,
  assistantResponseHtml: response,
  translate,
  escapeHtml,
});
assert.match(card, /id="request-&lt;7&gt;" data-card="request-&lt;7&gt;"/);
assert.match(card, /data-upstream-panel="request-&lt;7&gt;" open/);
assert.match(card, /upstreamDetails:index=7/);
assert.match(card, /data-body="trusted"/);
assert.match(card, /assistant-response-block/);

const reconstructedCard = renderTimelineRequestCard({
  requestId: "request-reconstructed",
  requestIndex: 8,
  upstreamDetailsLabel: "Reconstructed upstream details #8",
  translate,
  escapeHtml,
});
assert.match(reconstructedCard, /Reconstructed upstream details #8/);

const eventCard = renderTimelineRequestCard({
  requestId: "request-event",
  requestIndex: 21,
  upstreamEntryHtml: '<section class="semantic-event"></section>',
  upstreamBodyHtml: '<div data-body="must-not-render"></div>',
  showUpstreamDetails: false,
  translate,
  escapeHtml,
});
assert.doesNotMatch(eventCard, /request-upstream-details/);
assert.doesNotMatch(eventCard, /must-not-render/);

console.log("request card renderer contract smoke passed");
