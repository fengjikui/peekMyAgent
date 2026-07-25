#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildToolCallDetailView } from "../src/viewer/tool-call-view-model.js";
import { renderOrganizedToolCalls } from "../src/viewer/tool-call-renderer.js";

const calls = [
  {
    type: "tool_use",
    id: "call-anthropic",
    name: "Bash",
    input: { command: "pwd && ls", timeout: 120000 },
  },
  {
    type: "function_call",
    call_id: "call-openai",
    name: "exec_command",
    arguments: '{"cmd":"git status --short","workdir":"/tmp/project"}',
  },
  {
    id: "call-chat",
    type: "function",
    function: { name: "web_search", arguments: '{"query":"agent trace"}' },
  },
];

const view = buildToolCallDetailView(calls);
assert.equal(view.length, 3);
assert.equal(view[0].protocolType, "tool_use");
assert.equal(view[0].parameterSource, "input");
assert.equal(view[0].parameterEntries[0].presentation, "command");
assert.equal(view[1].protocolType, "function_call");
assert.equal(view[1].parameters.cmd, "git status --short");
assert.equal(view[2].protocolType, "function");
assert.equal(view[2].parameterSource, "function.arguments");

const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const html = renderOrganizedToolCalls({
  calls: [
    ...calls,
    {
      type: "custom_tool_call",
      call_id: 'unsafe"><script>',
      name: "<unsafe>",
      input: "line one\nline two",
    },
  ],
  translate: (key) => key,
  escapeHtml,
});
assert.match(html, /tool-call-detail-list/);
assert.match(html, /tool_use/);
assert.match(html, /function_call/);
assert.match(html, /pwd &amp;&amp; ls/);
assert.match(html, /git status --short/);
assert.match(html, /function\.arguments/);
assert.doesNotMatch(html, /<unsafe>/);
assert.doesNotMatch(html, /<script>/);

console.log("tool call detail contract smoke passed");
