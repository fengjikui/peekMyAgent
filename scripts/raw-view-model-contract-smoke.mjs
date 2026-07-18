#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildRequestEvidenceView,
  buildSourceEvidenceView,
  sourceEvidenceMode,
} from "../src/viewer/evidence-view-model.js";
import {
  requestHasSemanticEvent,
  requestUsesReconstructedUpstream,
  rawResponseSectionValue,
  rawSemanticEventMetadata,
  rawSectionData,
  rawUpstreamComposition,
  rawUpstreamRequestMetadata,
  rawUpstreamRequestValue,
  responseUsesReconstructedDownstream,
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

const semanticEventRequest = {
  id: "event-1",
  raw: {
    capture_id: "event-capture-1",
    watch_id: "watch-1",
    request_index: 21,
    method: "EVENT",
    path: "/codex/rollout/context_compacted",
    body_source: "reconstructed",
    body: {
      codex: {
        semantic_event: {
          schema_version: 1,
          category: "context_lifecycle",
          type: "context_compacted",
          actor: "harness",
          source: "codex_rollout",
          evidence: { origin: "codex_rollout", fidelity: "exact", exact_wire_event: false },
          data: { retained_message_count: 11 },
        },
      },
    },
  },
  summary: { evidence: { kind: "semantic_event", limitations: ["exact_wire_unavailable"] } },
};
assert.equal(requestHasSemanticEvent(semanticEventRequest), true);
assert.equal(rawSectionData(semanticEventRequest, "full", { translate: (key) => key }).title, "rawEventSource");
assert.equal(rawSectionData(semanticEventRequest, "metadata", { translate: (key) => key }).title, "rawEventMetadata");
assert.equal(rawSemanticEventMetadata(semanticEventRequest).semantic_event.type, "context_compacted");
assert.deepEqual(rawSemanticEventMetadata(semanticEventRequest).evidence.limitations, ["exact_wire_unavailable"]);
assert.equal(requestUsesReconstructedUpstream(semanticEventRequest), false, "semantic events use event labels instead of request fidelity labels");

const reconstructedRequest = {
  ...request,
  summary: {
    ...request.summary,
    evidence: { request: { available: true, exact: false } },
  },
};
assert.equal(requestUsesReconstructedUpstream(reconstructedRequest), true);
assert.equal(rawSectionData(reconstructedRequest, "full", { translate: (key) => key }).title, "rawReconstructedRequest");
const reconstructedEvidenceView = buildRequestEvidenceView(
  { ...reconstructedRequest, request_index: 3 },
  {
    translate: (key, values = {}) => `${key}${values.index == null ? "" : `:${values.index}`}`,
  },
);
assert.equal(reconstructedEvidenceView.upstream.mode, "reconstructed");
assert.equal(reconstructedEvidenceView.upstream.expandLabel, "expandReconstructedUpstream");
assert.equal(reconstructedEvidenceView.upstream.detailsLabel, "reconstructedUpstreamDetails:3");

const semanticSource = { kind: "codex_rollout_local", confidence: "semantic" };
assert.equal(sourceEvidenceMode(semanticSource), "reconstructed");
assert.equal(
  buildSourceEvidenceView(semanticSource, { translate: (key) => (key === "semanticReconstruction" ? "Semantic reconstruction" : key) })
    .navigatorSuffix,
  "Semantic reconstruction",
);
assert.equal(sourceEvidenceMode({ kind: "proxy_capture", confidence: "exact" }), "exact");

const exactProxyRequestReconstructedFromBlocks = {
  ...request,
  raw: { ...request.raw, body_source: "reconstructed" },
  summary: {
    ...request.summary,
    evidence: { request: { origin: "network_proxy", available: true, exact: true } },
  },
};
assert.equal(
  requestUsesReconstructedUpstream(exactProxyRequestReconstructedFromBlocks),
  false,
  "an exact proxy artifact remains a full request even when its persisted JSON was rebuilt from content blocks",
);
assert.equal(responseUsesReconstructedDownstream(reconstructedRequest), false, "request and response fidelity are evaluated independently");
assert.equal(
  responseUsesReconstructedDownstream({
    ...request,
    summary: { ...request.summary, evidence: { response: { available: true, exact: false } } },
  }),
  true,
);

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
assert.doesNotMatch(
  clientSource,
  /renderRawDetail\("system"|renderRawDetail\("tools"|renderRawDetail\("messages \/ history"/,
  "the full request tab must not append duplicate System, Tools, or Messages trees after the complete request",
);

console.log("raw view model contract smoke passed");
