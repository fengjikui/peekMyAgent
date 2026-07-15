#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  renderRawDetail,
  renderRawSearchControls,
  renderRawSearchResults,
  renderRawSourceNotice,
  renderRequestDetailError,
  renderRequestDetailLoading,
  renderRequestRawNavigation,
  renderResponseRawNavigation,
} from "../src/viewer/raw-inspector-renderer.js";

const translate = (key, values = {}) => `${key}${values.section ? `:${values.section}` : ""}${values.count != null ? `:${values.count}` : ""}`;
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const request = {
  id: 'request"><script>',
  summary: { current_tool_calls: [{ name: "Bash" }], current_tool_results: [{ id: "call-1" }] },
};

const requestNav = renderRequestRawNavigation({ request, activeSection: "tools", hasPrevious: true, translate, escapeHtml });
assert.match(requestNav, /rawFull/);
assert.match(requestNav, /System diff/);
assert.match(requestNav, /tool_use/);
assert.match(requestNav, /tool_result/);
assert.ok(requestNav.indexOf("rawFull") < requestNav.indexOf("Metadata"));
assert.doesNotMatch(requestNav, /<script>/);
assert.doesNotMatch(requestNav, /data-raw-mode=/);

const responseNav = renderResponseRawNavigation({ request, activeSection: "response", translate, escapeHtml });
assert.match(responseNav, /rawNavDownstream/);
assert.match(responseNav, /rawNavReference/);
assert.match(responseNav, /Tools schema/);
assert.match(responseNav, /data-raw-mode="response"/);

const controls = renderRawSearchControls({ query: 'Claude"', scope: "System", matches: 3, position: "2/3", translate, escapeHtml });
assert.match(controls, /2\/3/);
assert.match(controls, /data-raw-search-nav="previous"/);
assert.match(controls, /value="Claude&quot;"/);

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

console.log("raw inspector renderer contract smoke passed");
