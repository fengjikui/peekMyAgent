#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  renderRawDetail,
  renderRawSearchControls,
  renderRawSearchResults,
  renderRawSectionEvidence,
  renderRawSourceNotice,
  renderRawStickyControls,
  renderRequestDetailError,
  renderRequestDetailLoading,
  renderRequestRawNavigation,
  renderResponseRawNavigation,
} from "../src/viewer/raw-inspector-renderer.js";
import {
  renderMetadataControls,
  renderOrganizedMetadata,
} from "../src/viewer/metadata-renderer.js";

const translate = (key, values = {}) => `${key}${values.section ? `:${values.section}` : ""}${values.count != null ? `:${values.count}` : ""}`;
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const request = {
  id: 'request"><script>',
  raw: {
    body: {
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Developer instruction" }] }],
    },
  },
  summary: { current_tool_calls: [{ name: "Bash" }], current_tool_results: [{ id: "call-1" }] },
};

const requestNav = renderRequestRawNavigation({ request, activeSection: "tools", hasPrevious: true, translate, escapeHtml });
assert.match(requestNav, /rawFull/);
assert.match(requestNav, /rawProtocol/);
assert.match(requestNav, /System diff/);
assert.match(requestNav, /rawDeveloper/);
assert.match(requestNav, /rawHistory/);
assert.match(requestNav, /rawMessage/);
assert.doesNotMatch(requestNav, /data-raw-section="upstream_tool_calls"/);
assert.doesNotMatch(requestNav, /data-raw-section="tool_results"/);
assert.ok(requestNav.indexOf("rawFull") < requestNav.indexOf("Metadata"));
assert.ok(requestNav.indexOf('data-raw-section="protocol"') < requestNav.indexOf('data-raw-section="system"'));
assert.doesNotMatch(requestNav, /<script>/);
assert.doesNotMatch(requestNav, /data-raw-mode=/);

const requestNavWithoutDeveloper = renderRequestRawNavigation({
  request: { ...request, raw: { body: { input: [{ type: "message", role: "user", content: "hello" }] } } },
  activeSection: "full",
  hasPrevious: false,
  translate,
  escapeHtml,
});
assert.doesNotMatch(requestNavWithoutDeveloper, /rawDeveloper/);

const focusedToolNav = renderRequestRawNavigation({
  request,
  activeSection: "upstream_tool_calls",
  hasPrevious: true,
  translate,
  escapeHtml,
});
assert.match(focusedToolNav, />\s*tool_use\s*</);

const responseNav = renderResponseRawNavigation({ request, activeSection: "response", translate, escapeHtml });
assert.match(responseNav, /rawNavDownstream/);
assert.match(responseNav, /rawNavReference/);
assert.match(responseNav, /Tools schema/);
assert.match(responseNav, /currentResponseToolCalls/);
assert.match(responseNav, /data-raw-mode="response"/);

const codexResponseNav = renderResponseRawNavigation({
  request: {
    ...request,
    summary: {
      response: {
        complete_response: {
          output: [
            { type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"pwd"}' },
            { type: "tool_search_call", call_id: "call-2", arguments: '{"query":"tools"}' },
          ],
        },
      },
    },
  },
  activeSection: "tool_calls",
  translate,
  escapeHtml,
});
assert.match(codexResponseNav, /function_call \/ tool_search_call/);
assert.doesNotMatch(codexResponseNav, />tool_use</);

const reconstructedResponseNav = renderResponseRawNavigation({
  request: { ...request, summary: { evidence: { response: { available: true, exact: false } } } },
  activeSection: "response",
  translate,
  escapeHtml,
});
assert.match(reconstructedResponseNav, /rawReconstructedResponse/);

const eventNav = renderRequestRawNavigation({
  request: { ...request, summary: { evidence: { kind: "semantic_event" } } },
  activeSection: "system",
  hasPrevious: true,
  translate,
  escapeHtml,
});
assert.match(eventNav, /rawEventSource/);
assert.match(eventNav, /rawEventMetadata/);
assert.doesNotMatch(eventNav, />System</);
assert.doesNotMatch(eventNav, /System diff/);

const reconstructedNav = renderRequestRawNavigation({
  request: { ...request, summary: { evidence: { request: { available: true, exact: false } } } },
  activeSection: "full",
  hasPrevious: false,
  translate,
  escapeHtml,
});
assert.match(reconstructedNav, /rawReconstructedRequest/);
assert.doesNotMatch(reconstructedNav, />rawFull</);

const controls = renderRawSearchControls({ query: 'Claude"', scope: "System", matches: 3, position: "2/3", translate, escapeHtml });
assert.match(controls, /2\/3/);
assert.match(controls, /data-raw-search-nav="previous"/);
assert.match(controls, /value="Claude&quot;"/);

const stickyControls = renderRawStickyControls({
  navigation: "<nav>sections</nav>",
  searchControls: "<search>query</search>",
  viewControls: '<div data-messages-mode="source">source</div>',
});
assert.match(stickyControls, /raw-sticky-controls/);
assert.match(stickyControls, /data-messages-mode="source"/);

const longSearchValue = `${"x".repeat(520)} Claude tail match`;
const highlightedValues = [];
const results = renderRawSearchResults({
  query: "Claude",
  scope: "System",
  entries: [{ path: "system[0]", scope: "system", text: `${"x".repeat(417)}...`, value: longSearchValue }],
  translate,
  escapeHtml,
  highlightSnippet: (text) => {
    highlightedValues.push(text);
    return `<mark>${escapeHtml(text)}</mark>`;
  },
  renderPre: (text) => `<pre>${escapeHtml(text)}</pre>`,
});
assert.match(results, /data-raw-search-target/);
assert.ok(highlightedValues.includes(longSearchValue), "Raw search must highlight the complete value rather than its leading preview");
assert.match(results, /Claude tail match<\/mark>/);
assert.match(results, /<pre>.*Claude tail match<\/pre>/s);

assert.match(renderRawDetail({ title: "system", value: { ok: true }, escapeHtml, renderJson: JSON.stringify }), /json-node/);
assert.match(renderRequestDetailLoading({ translate, escapeHtml }), /requestDetailLoading/);
assert.match(renderRequestDetailError({ error: new Error("bad <detail>"), translate, escapeHtml }), /requestDetailLoadFailed/);
assert.doesNotMatch(renderRequestDetailError({ error: new Error("bad <detail>"), translate, escapeHtml }), /<detail>/);
assert.match(renderRawSourceNotice({ title: "Reference", text: "Not response", escapeHtml }), /raw-source-notice/);
const sectionEvidence = renderRawSectionEvidence({
  evidence: { tone: 'derived"><script>', badge: "PMA <view>", text: "Derived <not raw>" },
  escapeHtml,
});
assert.match(sectionEvidence, /raw-section-evidence/);
assert.match(sectionEvidence, /PMA &lt;view>/);
assert.doesNotMatch(sectionEvidence, /<script>/);
assert.equal(renderRawSectionEvidence({ evidence: null, escapeHtml }), "");

const metadataControls = renderMetadataControls({ mode: "organized", translate, escapeHtml });
assert.match(metadataControls, /data-metadata-mode="source"/);
assert.match(metadataControls, /data-metadata-mode="organized"/);
assert.match(metadataControls, /class="active" data-metadata-mode="organized"/);

const metadataSummary = renderOrganizedMetadata({
  view: {
    identity: [{ key: "request_index", value: 18 }],
    transport: [{ key: "path", value: "/v1/messages?<unsafe>" }],
    providerUsage: {
      input: 120,
      cache: 80,
      actualInput: 40,
      output: 12,
      totalInput: 120,
      cacheRatio: 2 / 3,
      actualRatio: 1 / 3,
    },
    composition: {
      unit: "chars",
      total: 1000,
      sections: [
        { key: "system", chars: 300, ratio: 0.3 },
        { key: "tools", chars: 500, ratio: 0.5 },
      ],
    },
    attribution: {
      facts: [
        { key: "actor", value: "background_service" },
        { key: "relation", value: "independent" },
      ],
      evidence: [
        {
          origin: "request_body",
          field: "client_metadata.x-codex-turn-metadata.request_kind",
          value: "memory",
        },
      ],
    },
    evidence: {
      transport: "capture_proxy",
      request: { exact: true, available: true },
      headerRedactions: ["authorization"],
      contextDelta: { new_messages: 1 },
    },
  },
  translate,
  escapeHtml,
  formatNumber: (value) => String(value),
});
assert.match(metadataSummary, /metadata-summary/);
assert.match(metadataSummary, /metadataCapturedFact/);
assert.match(metadataSummary, /metadataProviderFact/);
assert.match(metadataSummary, /metadataCalculated/);
assert.match(metadataSummary, /metadataAttribution/);
assert.match(metadataSummary, /metadataAttributionEvidence/);
assert.match(metadataSummary, /client_metadata\.x-codex-turn-metadata\.request_kind/);
assert.match(metadataSummary, /66\.7%/);
assert.match(metadataSummary, /30\.0%/);
assert.doesNotMatch(metadataSummary, /<unsafe>/);

console.log("raw inspector renderer contract smoke passed");
