#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  TIMELINE_VIEW_LIMITS,
  projectTimelineRequest,
  projectTimelineViewerData,
} from "../src/server/timeline-view-projector.mjs";

const longText = "trace payload ".repeat(100);
const roles = Array.from({ length: TIMELINE_VIEW_LIMITS.roleCount + 3 }, (_, index) => `role-${index}`);
const toolNames = Array.from({ length: TIMELINE_VIEW_LIMITS.toolNameCount + 2 }, (_, index) => `tool-${index}`);
const request = {
  id: "request-1",
  context_delta: {
    added: 7,
    previews: Array.from({ length: TIMELINE_VIEW_LIMITS.contextPreviewCount + 2 }, (_, index) => ({
      role: index ? "assistant" : "user",
      kind: "message",
      text: `${index} ${longText}`,
      private_field: "must not cross the projection boundary",
    })),
  },
  summary: {
    current_user: longText,
    system_preview: longText,
    assistant_preview: longText,
    internal_request_preview: longText,
    history_stack: [{ role: "user", text: longText }, { role: "assistant", text: longText }],
    roles,
    tool_names: toolNames,
    tool_calls: [{ name: "HistoricalTool", arguments: { secret: longText } }],
    tool_results: [{ id: "old-result", content: longText }],
    current_tool_calls: [{ name: "CurrentTool", arguments: { z: longText, a: "first" } }],
    current_tool_results: [{ id: "current-result", content: longText }],
    entry: {
      kind: "subagent_return",
      text: longText,
      subagent: { preview: longText, result: longText },
    },
    composition: {
      unit: "chars",
      total_payload_chars: 1000,
      input_chars: 100,
      sections: {
        current_user: { chars: 100 },
        history_context: { chars: 200 },
        system: { chars: 300 },
        tools: { chars: 400 },
        response_text: { chars: 500 },
      },
      internal_diagnostic: "not part of the timeline DTO",
    },
    response: {
      text: longText,
      thinking: longText,
      thinking_preview: longText,
      preview: longText,
      complete_response: { content: [{ type: "text", text: longText }] },
      tool_calls: [
        {
          name: "exec",
          arguments:
            'const result = await tools.web__run({weather:[{location:"Jiaxing"}]}); text(result);',
        },
        { name: "ResponseTool", arguments: { content: longText } },
      ],
    },
  },
  raw: {
    body_source: "original",
    raw_body_length: 123456,
    headers: { authorization: "must not cross the projection boundary" },
    body: {
      model: "test-model",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: longText }],
      system: [{ type: "text", text: longText }],
      tools: [{ name: "CurrentTool", description: longText }],
      private_param: longText,
    },
    response: {
      status: 200,
      received_at: "2026-07-14T00:00:00.000Z",
      headers: { "content-type": "application/json" },
      body_json: { content: longText },
      body_text: longText,
    },
  },
};

const original = structuredClone(request);
const projected = projectTimelineRequest(request);

assert.deepEqual(request, original, "projection must not mutate the full request DTO");
assert.equal(projected.detail_omitted, true);
assert.equal(projected.summary.history_stack.length, 0);
assert.deepEqual(projected.summary.history_stack_omitted, { count: 2 });
assert.equal(projected.summary.roles.length, TIMELINE_VIEW_LIMITS.roleCount);
assert.deepEqual(projected.summary.roles_omitted, { count: 3, total: roles.length });
assert.equal(projected.summary.tool_names.length, TIMELINE_VIEW_LIMITS.toolNameCount);
assert.deepEqual(projected.summary.tool_names_omitted, { count: 2, total: toolNames.length });
assert.deepEqual(projected.summary.tool_calls_omitted, { count: 1 });
assert.deepEqual(projected.summary.tool_results_omitted, { count: 1 });
assert.equal(projected.summary.tool_calls, undefined);
assert.equal(projected.summary.tool_results, undefined);
assert.ok(projected.summary.current_user.length <= TIMELINE_VIEW_LIMITS.currentUserChars + 3);
assert.equal(projected.context_delta.previews.length, TIMELINE_VIEW_LIMITS.contextPreviewCount);
assert.equal(projected.context_delta.previews[0].private_field, undefined);
assert.deepEqual(projected.context_delta.previews_omitted, { count: 2, total: TIMELINE_VIEW_LIMITS.contextPreviewCount + 2 });
assert.equal(projected.summary.composition.sections.response_text, undefined);
assert.equal(projected.summary.composition.internal_diagnostic, undefined);
assert.equal(projected.summary.response.complete_response, undefined);
assert.equal(projected.summary.response.preview, undefined);
assert.equal(projected.summary.response.complete_response_omitted, true);
assert.deepEqual(projected.summary.response.tool_calls[0].semantic, {
  schema_version: 1,
  kind: "nested_tool_dispatch",
  skill_name: null,
  nested_tool_names: ["web__run"],
  evidence: { source: "tool_arguments", confidence: "high" },
});
assert.equal(projected.summary.response.tool_calls[1].semantic, undefined);
assert.equal(projected.summary.response.tool_calls[1].arguments.omitted.reason, "compact_view");
assert.match(projected.summary.response.tool_calls[1].arguments.preview, /^\{"content":/);
assert.equal(projected.summary.current_tool_results[0].content.length, TIMELINE_VIEW_LIMITS.toolArgumentChars + 3);
assert.equal(projected.raw.headers, undefined);
assert.deepEqual(projected.raw.body, { model: "test-model", stream: true, max_tokens: 1024 });
assert.deepEqual(projected.raw.body_omitted, { messages: 1, tools: 1, system: 1, raw_body_length: 123456 });
assert.equal(projected.raw.response.headers, undefined);
assert.equal(projected.raw.response.body_json_omitted, true);
assert.equal(projected.raw.response.body_text, undefined);
assert.equal(projected.raw.response.body_text_omitted.reason, "compact_view");
assert.deepEqual(projectTimelineRequest(projected), projected, "compact projection must be idempotent for cursor assembly");

const projectedData = projectTimelineViewerData({ source: { id: "source-1" }, requests: [request] });
assert.equal(projectedData.source.id, "source-1");
assert.equal(projectedData.requests[0].detail_omitted, true);
assert.deepEqual(projectTimelineViewerData({ requests: null }).requests, []);

const source = fs.readFileSync(new URL("../src/server/timeline-view-projector.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /from ["']node:(?:fs|http|net|path|sqlite)/, "projector must not own I/O or persistence");
assert.doesNotMatch(source, /viewer\/server\.mjs/, "projector dependency direction must not point back to Viewer Server");

console.log("timeline view projector contract smoke passed");
