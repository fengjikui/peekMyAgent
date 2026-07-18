#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  rawResponseSectionValue,
  rawSectionData,
  rawUpstreamComposition,
  rawUpstreamRequestMetadata,
  rawUpstreamRequestValue,
} from "../src/viewer/raw-view-model.js";

const request = {
  id: "request-1",
  context_delta: { status: "changed" },
  raw: {
    capture_id: "capture-1",
    watch_id: "watch-1",
    request_index: 3,
    method: "POST",
    path: "/v1/messages",
    body: {
      system: "system prompt",
      tools: [{ name: "Bash" }],
      messages: [
        { role: "system", content: "message system" },
        { role: "user", content: "hello" },
      ],
    },
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      raw_body_length: 2048,
      captured_body_length: 1024,
      received_at: "2026-07-12T00:00:00.000Z",
      body_json: { type: "message" },
    },
    upstream_status: 200,
    upstream_error: null,
  },
  summary: {
    current_tool_calls: [{ name: "Read" }],
    current_tool_results: [{ tool_use_id: "call-1" }],
    composition: {
      total_chars: 100,
      response_text_chars: 20,
      response_thinking_chars: 10,
      sections: { system: 30, response_text: 20, response_thinking: 10 },
      ratios: { system: 0.3, output_to_input: 0.2 },
    },
    response: {
      captured: true,
      message_id: "message-1",
      text: "done",
      thinking: "plan",
      tool_calls: [{ id: "call-1", name: "Bash", arguments: { command: "pwd" } }],
      finish_reason: "tool_use",
      usage: { output_tokens: 12 },
      stream: true,
      event_count: 8,
    },
  },
};

const upstream = rawUpstreamRequestValue(request);
assert.equal(upstream.body.system, "system prompt");
assert.equal("response" in upstream, false, "upstream request view must not contain the downstream response");
assert.equal("upstream_status" in upstream, false);
assert.equal("upstream_error" in upstream, false);

const composition = rawUpstreamComposition(request);
assert.equal(composition.total_chars, 100);
assert.equal("response_text_chars" in composition, false);
assert.equal("response_thinking_chars" in composition, false);
assert.equal("response_text" in composition.sections, false);
assert.equal("response_thinking" in composition.sections, false);
assert.equal("output_to_input" in composition.ratios, false);
assert.equal(request.summary.composition.response_text_chars, 20, "view-model filtering must not mutate the source DTO");

const metadata = rawUpstreamRequestMetadata(request);
assert.equal(metadata.capture_id, "capture-1");
assert.deepEqual(metadata.context_delta, { status: "changed" });
assert.equal("response" in metadata, false);
assert.equal("status" in metadata, false);

assert.deepEqual(rawSectionData(request, "system").value, {
  body_system: "system prompt",
  message_system: [{ role: "system", content: "message system" }],
});
assert.deepEqual(rawSectionData(request, "tools").value, [{ name: "Bash" }]);
assert.equal(rawSectionData(request, "messages").value.length, 2);
assert.deepEqual(rawSectionData(request, "upstream_tool_calls", { translate: () => "current" }).value.current, [{ name: "Read" }]);
assert.deepEqual(rawSectionData(request, "tool_results", { translate: () => "results" }).value.results, [{ tool_use_id: "call-1" }]);
assert.deepEqual(
  rawSectionData(request, "harness", {
    translate: () => "Harness",
    harnessMaterials: [{ kind: "harness_codex_internal", source_text: "injected", metadata: { label: "Objective", category: "internal", tag: "codex_internal_context", path: "messages[2]" } }],
  }),
  { title: "Harness", value: [{ kind: "harness_codex_internal", label: "Objective", category: "internal", source_tag: "codex_internal_context", path: "messages[2]", text: "injected" }] },
);

const downstream = rawResponseSectionValue(request);
assert.equal(downstream.complete_response.id, "message-1");
assert.equal(downstream.complete_response.stop_reason, "tool_use");
assert.equal(downstream.complete_response.content.at(-1).type, "tool_use");
assert.equal(downstream.parsed_from_response.text, "done");
assert.equal(downstream.response_capture.status, 200);
assert.equal(downstream.response_capture.content_type, "text/event-stream");
assert.equal(downstream.response_capture.body_json_available, true);
assert.equal(rawSectionData(request, "response").value.complete_response.text, "done");

const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
assert.match(
  clientSource,
  /harnessMaterials:\s*section === "harness" \? sectionTranslationMaterials\(request, "harness"\) : \[\]/,
  "the interactive Harness tab must reuse the section translation material adapter",
);
assert.doesNotMatch(
  clientSource,
  /collectHarnessTranslationMaterials/,
  "the Harness tab must not call a removed translation helper",
);

console.log("raw view model contract smoke passed");
