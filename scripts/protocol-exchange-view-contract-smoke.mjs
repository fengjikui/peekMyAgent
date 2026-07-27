#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderProtocolExchange } from "../src/viewer/protocol-exchange-renderer.js";
import { buildProtocolExchangeView } from "../src/viewer/protocol-exchange-view-model.js";

const request = {
  id: 'request-65"><script>',
  request_index: 65,
  model: "gpt-5.6-terra",
  protocol: "openai_responses",
  summary: {
    protocol_exchange: {
      protocol: "openai_responses",
      protocol_label: "OpenAI Responses",
      request: {
        counts: { instruction_blocks: 2, input_items: 6, tools: 3, unknown_items: 1 },
        instruction_blocks: [
          { source_path: "$.input[1]", role: "developer", item_type: "message", chars: 21335 },
        ],
        tool_stages: [
          {
            kind: "added",
            source_path: "$.input[0].tools",
            input_index: 0,
            tool_count: 3,
            effective_tool_count: 3,
            namespace_count: 1,
            namespaces: [
              { name: "web", qualified_name: 'web\"><img src=x>', source_path: "$.input[0].tools[1]", tool_count: 1 },
            ],
            tools: [
              { name: "exec", type: "custom", namespace: null, deferred: false },
              { name: '<unsafe tool="x">', qualified_name: 'web.<unsafe tool="x">', type: "function", namespace: "web", source_path: "$.input[0].tools[1].tools[0]", deferred: true },
            ],
            tools_omitted: 1,
          },
        ],
        input_items: [
          { index: 0, source_path: "$.input[0]", item_type: "additional_tools", role: "developer", semantic: "tools_added", tool_names: ["exec", "wait"] },
          { index: 1, source_path: "$.input[1]", item_type: "message", role: "developer", semantic: "instruction", chars: 21335 },
          { index: 2, source_path: "$.input[2]", item_type: "message", role: "user", semantic: "user_message", chars: 18 },
          { index: 3, source_path: "$.input[3]", item_type: "custom_tool_call_output", role: "tool", semantic: "tool_result", call_id: "call-prior" },
          { index: 4, source_path: "$.input[4]", item_type: "future_item", role: "assistant", semantic: "assistant_message", schema_known: false },
          { index: 5, source_path: "$.input[5]", item_type: "mcp_list_tools", role: "assistant", semantic: "tool_discovery", schema_known: true },
        ],
      },
      response: {
        status: "completed",
        counts: { output_items: 3, reasoning_items: 1, tool_calls: 1, tool_approvals: 1 },
        output_items: [
          { index: 0, source_path: "$.output[0]", item_type: "reasoning", role: "assistant", semantic: "reasoning", chars: 12 },
          { index: 1, source_path: "$.output[1]", item_type: "custom_tool_call", role: "assistant", semantic: "tool_call", call_id: "call-current", name: "exec" },
          { index: 2, source_path: "$.output[2]", item_type: "mcp_approval_request", role: "assistant", semantic: "tool_approval", call_id: "approval-current", name: "remote" },
        ],
      },
    },
  },
};

const view = buildProtocolExchangeView(request);
assert.equal(view.requestId, request.id);
assert.equal(view.protocolLabel, "OpenAI Responses");
assert.equal(view.upstream.toolStages[0].kind, "added");
assert.equal(view.upstream.toolStages[0].namespaceCount, 1);
assert.equal(view.upstream.toolStages[0].namespaces[0].qualifiedName, 'web\"><img src=x>');
assert.equal(view.upstream.toolStages[0].tools[1].qualifiedName, 'web.<unsafe tool="x">');
assert.equal(view.upstream.items[0].semantic, "tools_added");
assert.equal(view.upstream.items[0].section, "tools");
assert.equal(view.upstream.items[3].section, "tool_results");
assert.equal(view.upstream.items[4].schemaKnown, false);
assert.equal(view.upstream.items[5].section, "full");
assert.equal(view.downstream.items[1].callId, "call-current");
assert.equal(view.downstream.items[1].section, "tool_calls");
assert.equal(view.downstream.items[1].mode, "response");
assert.equal(view.downstream.items[2].section, "response");

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const translate = (key, values = {}) => `${key}${values.count != null ? `:${values.count}` : ""}`;
const html = renderProtocolExchange(view, {
  translate,
  escapeHtml,
  formatNumber: (value) => String(value),
});

assert.match(html, /protocol-exchange-view/);
assert.match(html, /OpenAI Responses/);
assert.match(html, /gpt-5\.6-terra/);
assert.match(html, /protocolToolsAdded/);
assert.match(html, /protocolNamespaceToolCount:1/);
assert.match(html, /web\.&lt;unsafe tool=&quot;x&quot;&gt;/);
assert.match(html, /\$\.input\[0\]\.tools/);
assert.match(html, /additional_tools/);
assert.match(html, /custom_tool_call/);
assert.match(html, /call-current/);
assert.match(html, /data-raw-section="developer"/);
assert.match(html, /data-raw-section="tools"/);
assert.match(html, /data-raw-section="response" data-raw-mode="response"/);
assert.match(html, /protocolInstructionTranslationPolicy/);
assert.match(html, /protocolContextTranslationPolicy/);
assert.match(html, /protocolResponseTranslationPolicy/);
assert.match(html, /protocolUnknownItems/);
assert.match(html, /protocolSchemaUnknown/);
assert.doesNotMatch(html, /<unsafe/);
assert.doesNotMatch(html, /<img/);
assert.match(html, /&lt;unsafe tool=&quot;x&quot;&gt;/);
assert.doesNotMatch(html, /<script>/);

assert.equal(buildProtocolExchangeView({}), null);

const modelSource = fs.readFileSync(new URL("../src/viewer/protocol-exchange-view-model.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/viewer/protocol-exchange-renderer.js", import.meta.url), "utf8");
for (const source of [modelSource, rendererSource]) {
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
}

console.log("protocol exchange view contract smoke passed");
