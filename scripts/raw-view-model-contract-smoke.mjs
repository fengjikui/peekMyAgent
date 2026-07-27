#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildRawSectionEvidenceView,
  buildRequestEvidenceView,
  buildSourceEvidenceView,
  sourceEvidenceMode,
} from "../src/viewer/evidence-view-model.js";
import {
  requestHasSemanticEvent,
  requestUsesReconstructedUpstream,
  rawResponseSectionValue,
  rawResponseToolCalls,
  rawSemanticEventMetadata,
  rawSectionData,
  rawUpstreamComposition,
  rawUpstreamEvidenceMetadata,
  rawUpstreamRequestMetadata,
  rawUpstreamRequestValue,
  responseToolCallSectionLabel,
  responseUsesReconstructedDownstream,
} from "../src/viewer/raw-view-model.js";
import { buildMetadataView } from "../src/viewer/metadata-view-model.js";

const request = {
  id: "request-1",
  context_delta: { status: "changed" },
  source_hint: {
    type: "background",
    actor: "background_service",
    relation: "independent",
    operation: "codex_memory_extraction",
    request_kind: "memory",
    confidence: "high",
    evidence: [
      {
        origin: "request_body",
        field: "client_metadata.x-codex-turn-metadata.request_kind",
        value: "memory",
      },
    ],
  },
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
assert.equal(metadata.request_attribution.relation, "independent");
assert.equal("response" in metadata, false);
assert.equal("status" in metadata, false);

const metadataView = buildMetadataView({
  ...request,
  raw: {
    ...request.raw,
    conversation_id: "conversation-1",
    received_at: "2026-07-25T10:00:00.000Z",
    raw_body_length: 1000,
    body_source: "original",
  },
  summary: {
    ...request.summary,
    composition: {
      unit: "chars",
      total_payload_chars: 1000,
      input_chars: 1000,
      sections: {
        system: { chars: 300, ratio: 0.3 },
        tools: { chars: 500, ratio: 0.5 },
        history_context: { chars: 150, ratio: 0.15 },
        current_user: { chars: 50, ratio: 0.05 },
      },
    },
    response: {
      ...request.summary.response,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 80,
        output_tokens: 12,
      },
    },
  },
});
assert.equal(metadataView.identity.find((fact) => fact.key === "capture_id").value, "capture-1");
assert.equal(metadataView.providerUsage.cache, 80);
assert.equal(metadataView.providerUsage.actualInput, 100);
assert.equal(metadataView.composition.total, 1000);
assert.deepEqual(
  metadataView.attribution.facts.map((fact) => [fact.key, fact.value]),
  [
    ["actor", "background_service"],
    ["relation", "independent"],
    ["operation", "codex_memory_extraction"],
    ["request_kind", "memory"],
    ["confidence", "high"],
  ],
);
assert.equal(metadataView.attribution.evidence[0].field, "client_metadata.x-codex-turn-metadata.request_kind");
assert.deepEqual(
  metadataView.composition.sections.map((section) => section.key),
  ["system", "tools", "history_context", "current_user"],
);

assert.deepEqual(rawSectionData(request, "system").value, {
  body_system: "system prompt",
  message_system: [{ role: "system", content: "message system" }],
});
assert.deepEqual(rawSectionData(request, "tools").value, [{ name: "Bash" }]);
const protocolSection = rawSectionData(request, "protocol", { translate: () => "Protocol" });
assert.equal(protocolSection.title, "Protocol");
assert.equal(protocolSection.value.protocol, "anthropic_messages");
assert.equal(protocolSection.value.request.counts.instruction_blocks, 1);
assert.equal(protocolSection.value.request.tool_stages[0].tools[0].name, "Bash");
assert.deepEqual(rawSectionData(request, "developer", { translate: () => "Developer" }), {
  title: "Developer",
  value: [],
});
assert.equal(rawSectionData(request, "history").value.length, 1);
assert.equal(rawSectionData(request, "message").value.length, 0);
assert.deepEqual(rawSectionData(request, "upstream_tool_calls", { translate: () => "current" }).value.current, [{ name: "Read" }]);
assert.deepEqual(rawSectionData(request, "tool_results", { translate: () => "results" }).value, [{ tool_use_id: "call-1" }]);
assert.deepEqual(
  rawSectionData(request, "harness", {
    translate: () => "Harness",
    harnessMaterials: [{ kind: "harness_codex_internal", source_text: "injected", metadata: { label: "Objective", category: "internal", tag: "codex_internal_context", path: "messages[2]" } }],
  }),
  { title: "Harness", value: [{ kind: "harness_codex_internal", label: "Objective", category: "internal", source_tag: "codex_internal_context", path: "messages[2]", text: "injected" }] },
);

const downstream = rawResponseSectionValue(request);
assert.deepEqual(downstream.response, { type: "message" }, "Raw Response prefers the captured provider body");
assert.equal("complete_response" in downstream, false);
assert.equal("parsed_from_response" in downstream, false);
assert.equal(downstream.response_capture.status, 200);
assert.equal(downstream.response_capture.content_type, "text/event-stream");
assert.equal(downstream.response_capture.body_json_available, true);
assert.equal(downstream.response_capture.displayed_response, "captured_body_json");
assert.deepEqual(rawSectionData(request, "response").value.response, { type: "message" });

const streamOnlyRequest = {
  ...request,
  raw: {
    ...request.raw,
    response: {
      ...request.raw.response,
      body_json: null,
      body_text_omitted: { reason: "stream" },
    },
  },
  summary: {
    ...request.summary,
    response: {
      ...request.summary.response,
      response_protocol: "openai_responses",
      complete_response_source: "protocol_terminal_event",
      complete_response: {
        id: "resp-codex",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
          { type: "function_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"pwd"}' },
        ],
      },
    },
  },
};
const streamOnlyDownstream = rawResponseSectionValue(streamOnlyRequest);
assert.equal(streamOnlyDownstream.response.output[1].type, "function_call");
assert.equal(streamOnlyDownstream.response_capture.displayed_response, "protocol_terminal_event");
assert.equal(streamOnlyDownstream.response_capture.reconstructed, false);
assert.equal("tool_use" in streamOnlyDownstream.response, false, "Codex Raw keeps the Responses API field names");
assert.equal(responseToolCallSectionLabel(streamOnlyRequest), "function_call");
assert.equal(rawResponseToolCalls(streamOnlyRequest)[0].type, "function_call");
assert.equal(rawSectionData(streamOnlyRequest, "tool_calls").title, "function_call");

const anthropicServerToolRequest = {
  ...request,
  raw: {
    ...request.raw,
    response: {
      ...request.raw.response,
      body_json: {
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_use", id: "client-1", name: "Bash", input: { command: "pwd" } },
          { type: "server_tool_use", id: "server-1", name: "web_search", input: { query: "PMA" } },
        ],
      },
    },
  },
};
assert.deepEqual(rawResponseToolCalls(anthropicServerToolRequest).map((item) => item.type), ["tool_use", "server_tool_use"]);
assert.equal(responseToolCallSectionLabel(anthropicServerToolRequest), "tool_use / server_tool_use");

const chatStreamRequest = {
  ...streamOnlyRequest,
  summary: {
    ...streamOnlyRequest.summary,
    response: {
      ...streamOnlyRequest.summary.response,
      response_protocol: "openai_chat_completions",
      complete_response_source: "stream_reconstruction",
      complete_response: {
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "done",
              tool_calls: [
                {
                  id: "call-chat",
                  type: "function",
                  function: { name: "Bash", arguments: '{"command":"pwd"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    },
  },
};
const chatDownstream = rawResponseSectionValue(chatStreamRequest);
assert.equal(chatDownstream.response.choices[0].message.tool_calls[0].function.name, "Bash");
assert.equal(chatDownstream.response_capture.displayed_response, "stream_reconstruction");
assert.equal(chatDownstream.response_capture.reconstructed, true);
assert.equal(responseToolCallSectionLabel(chatStreamRequest), "tool_calls");

const legacyGenericStreamRequest = {
  ...streamOnlyRequest,
  summary: {
    ...streamOnlyRequest.summary,
    response: {
      ...streamOnlyRequest.summary.response,
      response_protocol: null,
      complete_response_source: null,
      complete_response: {
        id: "legacy",
        role: "assistant",
        content: [{ type: "text", text: "assembled" }],
        stream_assembly: { event_count: 12 },
      },
    },
  },
};
const legacyDownstream = rawResponseSectionValue(legacyGenericStreamRequest);
assert.equal(legacyDownstream.response, null, "legacy generic stream assemblies are not presented as protocol Raw");
assert.equal(legacyDownstream.response_capture.displayed_response, "unavailable");

const responsesRequest = {
  request_index: 4,
  context_delta: { previous_messages: 3, new_messages: 3 },
  raw: {
    body: {
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>Full access.</permissions instructions>" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect." }] },
        { type: "function_call", name: "exec_command", arguments: '{"cmd":"pwd"}', call_id: "call-1" },
        { type: "function_call_output", call_id: "call-1", output: "/tmp" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    },
  },
};
assert.equal(rawSectionData(responsesRequest, "developer", { translate: () => "Developer" }).value.length, 1);
assert.match(JSON.stringify(rawSectionData(responsesRequest, "developer").value), /permissions instructions/);
assert.deepEqual(rawSectionData(responsesRequest, "history").value.map((item) => item.type), ["message", "message"]);
assert.deepEqual(rawSectionData(responsesRequest, "message").value.map((item) => item.type), [
  "function_call",
  "function_call_output",
  "message",
]);

const completeToolSearchDescription = `Complete tool definition: ${"detail ".repeat(180)}`;
const exactToolResultRequest = {
  request_index: 11,
  context_delta: { previous_messages: 1, new_messages: 1 },
  raw: {
    body: {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Find tools" }] },
        {
          type: "tool_search_output",
          call_id: "call-search",
          tools: [
            {
              type: "namespace",
              name: "multi_agent_v1",
              description: "Agent tools",
              tools: [
                {
                  type: "function",
                  name: "spawn_agent",
                  description: completeToolSearchDescription,
                  parameters: {
                    type: "object",
                    properties: {
                      message: { type: "string", description: "Initial task" },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  },
  summary: {
    current_tool_results: [{ id: "call-search", content: "clipped" }],
  },
};
const exactToolResults = rawSectionData(exactToolResultRequest, "tool_results").value;
assert.equal(exactToolResults.length, 1);
assert.equal(exactToolResults[0].type, "tool_search_output");
assert.equal(exactToolResults[0].tools[0].tools[0].description, completeToolSearchDescription);
assert.equal(exactToolResults[0].tools[0].tools[0].parameters.properties.message.description, "Initial task");
assert.doesNotMatch(JSON.stringify(exactToolResults), /clipped/);

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

const sectionTranslate = (key) => key;
assert.equal(
  buildRawSectionEvidenceView(request, "system", { translate: sectionTranslate }),
  null,
  "exact request sections do not need a redundant evidence strip",
);
assert.deepEqual(buildRawSectionEvidenceView(request, "harness", { translate: sectionTranslate }), {
  tone: "derived",
  badge: "rawSectionEvidenceDerivedBadge",
  text: "rawSectionEvidenceHarnessExact",
});

const rolloutSectionRequest = {
  ...reconstructedRequest,
  summary: {
    ...reconstructedRequest.summary,
    evidence: {
      ...reconstructedRequest.summary.evidence,
      sections: {
        system: { source: "request", scope: "observed_upstream_delta" },
        tools: {
          source: "session_metadata",
          origin: "codex_session_meta.dynamic_tools",
          scope: "dynamic_tools_only",
          count: 1,
        },
        messages: { source: "request", scope: "observed_upstream_delta", history_complete: false },
        harness: { source: "pma_semantic_projection", scope: "observed_upstream_delta", derived: true },
      },
    },
  },
};
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "system", { translate: sectionTranslate }), {
  tone: "partial",
  badge: "rawSectionEvidenceRolloutBadge",
  text: "rawSectionEvidenceSystemObserved",
});
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "messages", { translate: sectionTranslate }), {
  tone: "partial",
  badge: "rawSectionEvidenceRolloutBadge",
  text: "rawSectionEvidenceMessagesObserved",
});
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "history", { translate: sectionTranslate }), {
  tone: "partial",
  badge: "rawSectionEvidenceRolloutBadge",
  text: "rawSectionEvidenceMessagesObserved",
});
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "message", { translate: sectionTranslate }), {
  tone: "partial",
  badge: "rawSectionEvidenceRolloutBadge",
  text: "rawSectionEvidenceMessagesObserved",
});
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "tools", { translate: sectionTranslate }), {
  tone: "partial",
  badge: "rawSectionEvidenceRolloutBadge",
  text: "rawSectionEvidenceDynamicTools",
});
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "harness", { translate: sectionTranslate }), {
  tone: "derived",
  badge: "rawSectionEvidenceDerivedBadge",
  text: "rawSectionEvidenceHarnessObserved",
});
assert.deepEqual(buildRawSectionEvidenceView(rolloutSectionRequest, "tools", { mode: "response", translate: sectionTranslate }), {
  tone: "reference",
  badge: "rawSectionEvidenceUpstreamReferenceBadge",
  text: "rawSectionEvidenceDynamicToolsReference",
});
const rolloutUpstreamEvidence = rawUpstreamEvidenceMetadata(rolloutSectionRequest);
assert.equal(rolloutUpstreamEvidence.sections.tools.origin, "codex_session_meta.dynamic_tools");
assert.equal(rolloutUpstreamEvidence.sections.tools.scope, "dynamic_tools_only");
assert.equal(rolloutUpstreamEvidence.sections.tools.count, 1);
assert.equal(rawUpstreamRequestMetadata(rolloutSectionRequest).upstream_evidence.sections.tools.count, 1);
assert.equal("response" in rawUpstreamRequestMetadata(rolloutSectionRequest).upstream_evidence, false);

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
