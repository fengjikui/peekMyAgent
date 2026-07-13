#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildUpstreamDetailView, providerUsageForRequest } from "../src/viewer/upstream-detail-model.js";
import { renderUpstreamDetail } from "../src/viewer/upstream-detail-renderer.js";

const request = {
  id: "request-7",
  request_index: 7,
  source_hint: { type: "metadata" },
  counts: { system: 4, tools: 20, messages: 8, history: 6, raw_body_bytes: 4096 },
  context_delta: {
    new_messages: 2,
    previews: [
      { kind: "assistant", role: "assistant", text: "Previous answer" },
      { kind: "user", role: "user", text: "Current <question>" },
    ],
  },
  summary: {
    system_preview: "System <contract>",
    tool_names: Array.from({ length: 20 }, (_, index) => `Tool${index + 1}`),
    roles: ["user", "assistant", "user"],
    internal_request_preview: "Internal <request>",
    history_stack: [
      {
        index: 1,
        kind: "user",
        role: "user",
        text: "Hello <script>",
        context_status: "reused",
        command_message: { name: "/compact" },
        tool_calls: [{ id: "call-123456789", name: "Bash", arguments_preview: '{"command":"pwd"}' }],
        tool_results: [{ id: "call-123456789", content: "/tmp" }],
      },
      {
        index: 2,
        kind: "framework_reminder",
        role: "user",
        text: "Reminder",
        full_text: "Reminder <full>",
        char_count: 15,
      },
    ],
    composition: {
      total_payload_chars: 12000,
      sections: {
        system: { ratio: 0.1, chars: 1200 },
        tools: { ratio: 0.7, chars: 8400 },
        history_context: { ratio: 0.15, chars: 1800 },
        current_user: { ratio: 0.05, chars: 600 },
      },
    },
    response: {
      usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
    },
  },
};

const view = buildUpstreamDetailView(request, { cleanText: (value) => String(value || "").trim() });
assert.equal(view.requestId, "request-7");
assert.deepEqual(view.system, { count: 4, preview: "System <contract>", composition: { key: "system", ratio: 0.1, chars: 1200 } });
assert.equal(view.tools.names.length, 18);
assert.equal(view.tools.hiddenCount, 2);
assert.deepEqual(view.history.roles, ["user", "assistant", "user"]);
assert.equal(view.history.items[0].toolCalls[0].argumentsPreview, '{"command":"pwd"}');
assert.equal(view.currentMessage.kind, "messages");
assert.equal(view.currentMessage.count, 2);
assert.deepEqual(view.providerStats, {
  totalPayloadChars: 12000,
  input: 100,
  cache: 900,
  output: 50,
  actualRatio: 0.1,
  cacheRatio: 0.9,
});

assert.deepEqual(
  providerUsageForRequest({
    summary: {
      response: {
        usage: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens: 20,
        },
      },
    },
  }),
  { input: 100, output: 20, cache: 80, actualInput: 20, total: 100 },
);

const subagentView = buildUpstreamDetailView({
  summary: {
    entry: {
      kind: "subagent_result",
      subagent: {
        name: "Explore",
        status: "completed",
        preview: "Fallback",
        result: "**Result** <unsafe>",
      },
    },
  },
});
assert.deepEqual(subagentView.currentMessage, {
  kind: "subagent_result",
  name: "Explore",
  status: "completed",
  fallbackText: "Fallback",
  markdownText: "**Result** <unsafe>",
});

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const translate = (key, values = {}) =>
  `${key}${Object.keys(values).length ? `:${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")}` : ""}`;
const dependencies = {
  translate,
  escapeHtml,
  renderPre: (value) => `<pre>${escapeHtml(value)}</pre>`,
  renderMarkdown: (value) => `<p>${escapeHtml(value)}</p>`,
  formatBytes: (value) => `${value} bytes`,
  formatCharCount: (value) => `${value} chars`,
  formatCompactNumber: (value) => String(value),
  formatPercent: (value) => `${Math.round(value * 100)}%`,
  shortId: (value) => String(value || "").slice(0, 8),
  shortPreview: (value, limit) => String(value || "").slice(0, limit),
  commandMessageLabel: () => "Command /compact",
  messageKindLabel: (kind, role) => `${kind || role}`,
};

const html = renderUpstreamDetail(view, dependencies);
assert.match(html, /systemSummary:count=4/);
assert.match(html, /System &lt;contract&gt;/);
assert.match(html, /toolsCount:count=20/);
assert.match(html, /Tool18/);
assert.doesNotMatch(html, /Tool19/);
assert.match(html, /<span class="tool-chip">\+2<\/span>/);
assert.match(html, /historyStack:count=2/);
assert.match(html, /Command \/compact/);
assert.match(html, /call-123/);
assert.match(html, /Reminder &lt;full&gt;/);
assert.match(html, /Current &lt;question&gt;/);
assert.match(html, /providerTokenStats/);
assert.match(html, /cache<\/em>\s*<strong>900 · 90%/);
assert.match(html, /actualUpstream:count=12000 chars/);
assert.doesNotMatch(html, /<script>/);

const subagentHtml = renderUpstreamDetail(subagentView, dependencies);
assert.match(subagentHtml, /subagent-result-event/);
assert.match(subagentHtml, /Explore · completed/);
assert.match(subagentHtml, /\*\*Result\*\* &lt;unsafe&gt;/);

const modelSource = fs.readFileSync(new URL("../src/viewer/upstream-detail-model.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/viewer/upstream-detail-renderer.js", import.meta.url), "utf8");
for (const source of [modelSource, rendererSource]) {
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
}

console.log("upstream detail view contract smoke passed");
