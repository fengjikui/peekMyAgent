#!/usr/bin/env node
import assert from "node:assert/strict";
import { TimelinePageAssembler } from "../src/server/timeline-page-assembler.mjs";
import { projectTimelineViewerData } from "../src/server/timeline-view-projector.mjs";
import { createViewerTraceProjector, headerValue, textPreview, uniqueValues } from "../src/server/viewer-trace-projector.mjs";

const sourceDisplay = {
  displayProjectName: (workspace) => String(workspace || "").split(/[\\/]/).filter(Boolean).at(-1) || "Unknown project",
  inferWatchMode: (source) => source.mode || "Single session",
  captureLabel: (source) => source.kind,
  liveStatusLabel: (status) => status || "stored",
};
const projector = createViewerTraceProjector({
  sourceDisplay,
  now: () => "2026-07-14T00:00:00.000Z",
});

const source = {
  id: "stored-test",
  agent: "Claude Code",
  confidence: "exact",
  kind: "proxy_capture",
  workspace: "/tmp/project-alpha",
  mode: "single_session",
  live_status: "watching",
  live_watch_id: "watch-1",
  conversation_id: "conversation-1234567890",
  request_count: 5,
  response_count: 4,
  raw_body_bytes: 12_345,
};
const firstResponseJson = {
  id: "message-1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "I will inspect the disk." }],
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 20 },
};
const captures = [
  {
    capture_id: "capture-1",
    request_index: 1,
    received_at: "2026-07-14T00:00:01.000Z",
    method: "POST",
    path: "/v1/messages",
    watch_id: "watch-1",
    conversation_id: source.conversation_id,
    workspace: source.workspace,
    headers: {
      "x-claude-code-agent-id": "agent-main",
      "x-claude-code-session-id": "session-1234567890",
    },
    raw_body_length: 400,
    body: {
      model: "claude-test",
      system: [{ type: "text", text: "You are a coding agent." }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "Check disk usage" }],
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body_json: firstResponseJson,
      body_text: JSON.stringify(firstResponseJson),
      raw_body_length: 220,
    },
  },
  {
    capture_id: "capture-2",
    request_index: 2,
    received_at: "2026-07-14T00:00:02.000Z",
    method: "POST",
    path: "/v1/messages",
    watch_id: "watch-1",
    conversation_id: source.conversation_id,
    workspace: source.workspace,
    headers: { "x-claude-code-session-id": "session-1234567890" },
    raw_body_length: 700,
    body: {
      model: "claude-test",
      system: [{ type: "text", text: "You are a coding agent." }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "Check disk usage" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "df -h" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "Filesystem 50% used" }],
        },
      ],
    },
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body_text: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"message-2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":150,"output_tokens":0}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Disk usage is 50%."}}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ].join("\n\n"),
      raw_body_length: 640,
    },
  },
];

const partial = projector.initialPartialInfo({ requestedLimit: 2, loadedCount: 2, totalCount: 5 });
const data = projector.buildData({ source, captures, partial, command: { cwd: source.workspace } });

assert.equal(data.generated_at, "2026-07-14T00:00:00.000Z");
assert.equal(data.requests.length, 2);
assert.equal(data.turns.length, 1, "tool-result continuation remains in the initiating user turn");
assert.equal(data.stats.request_count, 5, "partial view uses authoritative source totals");
assert.equal(data.stats.response_count, 4);
assert.equal(data.stats.partial_loaded_request_count, 2);
assert.equal(data.partial.has_more, true);
assert.equal(data.source.workbench.project, "project-alpha");
assert.deepEqual(data.source.workbench.watch_ids, ["watch-1"]);
assert.equal(data.source.workbench.conversation_label, "conversa...7890");
assert.equal(data.requests[0].summary.current_user, "Check disk usage");
assert.equal(data.requests[0].counts.tools, 1);
assert.equal(data.requests[0].summary.response.finish_reason, "tool_use");
assert.equal(data.requests[0].raw.response.body_text, undefined, "body_json removes the duplicate response text");
assert.equal(data.requests[0].raw.response.body_text_omitted.reason, "duplicated_body_json");
assert.equal(data.requests[1].summary.current_tool_results[0].content, "Filesystem 50% used");
assert.equal(data.requests[1].summary.response.text, "Disk usage is 50%.");
assert.equal(data.requests[1].raw.response.body_text, undefined, "SSE text is summarized instead of copied into compact DTOs");
assert.equal(data.requests[1].raw.response.body_text_omitted.reason, "stream");
assert.equal(data.requests[1].trace.claude_session_id_prefix, "session-1234");

const codexSpecialOperations = projector.buildData({
  source: {
    ...source,
    id: "codex-exact-operations",
    agent: "Codex",
    kind: "codex_proxy_exact",
    request_count: 5,
    response_count: 5,
  },
  captures: [
    {
      capture_id: "codex-main",
      request_index: 1,
      method: "POST",
      path: "/v1/responses",
      capture_adapter: "codex_responses_v1",
      headers: {},
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "Inspect the project." }] }] },
    },
    {
      capture_id: "codex-child",
      request_index: 2,
      method: "POST",
      path: "/v1/responses",
      capture_adapter: "codex_responses_v1",
      headers: { "x-openai-subagent": "[REDACTED:header]" },
      header_redactions: [{ field_path: "headers.x-openai-subagent", reason: "sensitive_header" }],
      body: {
        client_metadata: {
          thread_id: "codex-child-thread",
          "x-codex-parent-thread-id": "codex-parent-thread",
        },
        input: [{ role: "user", content: [{ type: "input_text", text: "Inspect package.json." }] }],
      },
    },
    {
      capture_id: "codex-memory",
      request_index: 3,
      method: "POST",
      path: "/v1/responses",
      capture_adapter: "codex_responses_v1",
      headers: {},
      body: {
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory", thread_source: "user" }),
        },
        input: [{ role: "user", content: [{ type: "input_text", text: "Analyze this rollout and extract memory." }] }],
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body_json: {
          id: "response-memory",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Memory extraction finished." }] }],
        },
      },
    },
    {
      capture_id: "codex-prewarm",
      request_index: 4,
      method: "POST",
      path: "/v1/responses",
      capture_adapter: "codex_responses_v1",
      headers: {},
      body: {
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "prewarm", thread_source: "user" }),
        },
        input: [],
      },
    },
    {
      capture_id: "codex-compact",
      request_index: 5,
      method: "POST",
      path: "/v1/responses/compact",
      upstream_path: "/backend-api/codex/responses/compact",
      capture_adapter: "codex_responses_v1",
      headers: { "x-openai-subagent": "true" },
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "Prior live context" }] }] },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body_json: { output: [{ type: "compaction", encrypted_content: "opaque" }] },
      },
    },
  ],
});
assert.equal(codexSpecialOperations.requests[1].is_subagent, true, "exact Codex child request uses the observed subagent header");
assert.equal(codexSpecialOperations.requests[1].source_hint.label, "Codex 子 Agent");
assert.equal(codexSpecialOperations.requests[1].trace.agent_instance_id, "codex-child-thread");
assert.equal(codexSpecialOperations.requests[1].trace.parent_agent_instance_id, "codex-parent-thread");
assert.equal(codexSpecialOperations.requests[1].trace.context_chain_key, "agent:Codex:codex-child-thread");
assert.equal(codexSpecialOperations.requests[2].source_hint.type, "background");
assert.equal(codexSpecialOperations.requests[2].source_hint.operation, "codex_memory_extraction");
assert.equal(codexSpecialOperations.requests[2].trace.actor_type, "side");
assert.equal(codexSpecialOperations.requests[2].trace.context_chain_key, "side:Codex:codex_memory_extraction");
assert.equal(codexSpecialOperations.requests[2].summary.current_user, "", "background prompts do not become user-turn identities");
assert.equal(codexSpecialOperations.requests[2].summary.entry.kind, "agent_internal");
assert.equal(codexSpecialOperations.requests[2].summary.response.text, "Memory extraction finished.");
assert.equal(codexSpecialOperations.requests[3].source_hint.type, "metadata");
assert.equal(codexSpecialOperations.requests[3].source_hint.operation, "responses_prewarm");
assert.equal(codexSpecialOperations.requests[3].source_hint.relation, "current_dialogue");
assert.equal(codexSpecialOperations.requests[3].source_hint.turn_placement, "next_turn");
assert.deepEqual(codexSpecialOperations.requests[4].summary.entry, {
  operation: "context_compaction",
  kind: "compact",
  label: "Harness 上下文压缩请求",
  label_key: "contextCompactionRequest",
});
assert.equal(codexSpecialOperations.requests[4].source_hint.type, "metadata");
assert.equal(codexSpecialOperations.requests[4].source_hint.operation, "context_compaction");
assert.equal(codexSpecialOperations.turns.length, 2, "independent background requests become standalone side-channel groups");
assert.equal(codexSpecialOperations.turns[0].kind, "conversation_turn");
assert.equal(codexSpecialOperations.turns[0].internal_request_count, 3, "subagent, prewarm, and compaction requests remain associated with the active Turn");
assert.equal(codexSpecialOperations.turns[1].kind, "independent_background");
assert.equal(codexSpecialOperations.turns[1].index, null, "background side channels never consume a user Turn number");
assert.deepEqual(codexSpecialOperations.turns[1].request_ids, ["codex-memory"]);

const codexAdditionalToolsData = projector.buildData({
  source: {
    ...source,
    id: "codex-additional-tools",
    agent: "Codex",
    kind: "codex_proxy_exact",
    request_count: 1,
    response_count: 1,
  },
  captures: [
    {
      capture_id: "codex-request-65-shape",
      request_index: 65,
      method: "POST",
      path: "/v1/responses",
      capture_adapter: "codex_responses_v1",
      headers: {},
      body: {
        model: "gpt-5.6-terra",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              { type: "custom", name: "exec" },
              { type: "custom", name: "wait" },
              { type: "function", name: "request_user_input" },
            ],
          },
          { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect request 65." }] },
        ],
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body_json: {
          id: "response-65",
          status: "completed",
          output: [
            { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect it." }] },
            { type: "custom_tool_call", call_id: "call-65", name: "exec", input: "status" },
          ],
        },
      },
    },
  ],
});
const codexRequest65 = codexAdditionalToolsData.requests[0];
assert.equal(codexRequest65.protocol, "openai_responses");
assert.equal(codexRequest65.counts.tools, 3, "input additional_tools contributes to the request tool inventory");
assert.deepEqual(codexRequest65.summary.tool_names, ["exec", "wait", "request_user_input"]);
assert.deepEqual(codexRequest65.summary.roles, ["developer", "user"], "additional_tools is not shown as an empty Developer message");
assert.equal(codexRequest65.summary.protocol_exchange.request.counts.instruction_blocks, 1);
assert.equal(codexRequest65.summary.protocol_exchange.request.tool_stages[0].kind, "added");
assert.equal(codexRequest65.summary.protocol_exchange.request.tool_stages[0].source_path, "$.input[0].tools");
assert.deepEqual(
  codexRequest65.summary.protocol_exchange.response.output_items.map((item) => item.semantic),
  ["reasoning", "tool_call"],
);
assert.equal(codexRequest65.summary.protocol_exchange.response.output_items[1].name, "exec");

const detail = projector.projectRequestDetailWindow(captures, source, "capture-2", { startIndex: 0 });
assert.equal(detail.id, "capture-2");
assert.equal(detail.detail_scope, "request_window");
assert.ok(detail.context_delta, "detail-window projection retains adjacent-request context semantics");
assert.equal(projector.projectRequestDetailWindow([], source, "missing"), null);

const inferredTitle = projector.inferCaptureTitle({
  body: {
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-0", content: "ignored" }] },
      { role: "user", content: "A real user title" },
    ],
  },
});
assert.equal(inferredTitle, "A real user title");

const codexExactTitle = projector.inferCaptureTitle({
  body: {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Injected repository policy</INSTRUCTIONS>" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly PMA_EXACT_PROXY_OK." }],
      },
    ],
  },
});
assert.equal(codexExactTitle, "Reply with exactly PMA_EXACT_PROXY_OK.", "Codex exact titles use the latest real user input, not earlier Harness context");

const assemblerDependencies = projector.timelineAssemblerDependencies();
for (const name of ["summarizeCapture", "buildTurns", "buildStats", "buildWorkbench"]) {
  assert.equal(typeof assemblerDependencies[name], "function", `${name} is an explicit cursor assembler port`);
}
assert.equal(typeof assemblerDependencies.contextSemantics, "object");
assert.equal(typeof assemblerDependencies.lineageSemantics, "object");

const completeSource = { ...source, request_count: 2, response_count: 2, raw_body_bytes: 1_100 };
const completeData = projector.buildData({ source: completeSource, captures, command: { cwd: completeSource.workspace } });
const compactCompleteData = projectTimelineViewerData(completeData);
const assembler = new TimelinePageAssembler(projector.timelineAssemblerDependencies());
const assemblerState = assembler.createState({ source: completeSource, command: { cwd: completeSource.workspace } });
const cursorPage = assembler.append(assemblerState, {
  captures,
  page: { has_more: false, total_count: captures.length },
});
assert.deepEqual(cursorPage.requests, compactCompleteData.requests, "full and cursor paths share the same compact request projection");
assert.deepEqual(cursorPage.turns, compactCompleteData.turns, "full and cursor paths share the same Turn semantics");
assert.deepEqual(cursorPage.agent_trace, compactCompleteData.agent_trace, "full and cursor paths share the same Agent graph semantics");

assert.equal(headerValue({ "X-Test": ["one", "two"] }, "x-test"), "one, two");
assert.equal(textPreview("  alpha\n beta  ", 20), "alpha\n beta");
assert.deepEqual(uniqueValues(["a", "", "a", null, 0, false, "b"]), ["a", 0, false, "b"]);
assert.throws(() => createViewerTraceProjector(), /sourceDisplay\.displayProjectName must be a function/);

console.log("viewer trace projector contract smoke passed");
