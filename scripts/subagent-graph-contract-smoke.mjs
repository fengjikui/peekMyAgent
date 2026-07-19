#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  annotateSubagentLineage,
  attachSubagentGraphToTurns,
  buildSubagentGraph,
  createSubagentLineageState,
} from "../src/trace/subagent-graph.mjs";
import { codexAgentMessageSummary, isCodexAgentMessage } from "../src/trace/message-semantics.mjs";
import { projectTimelineRequest } from "../src/server/timeline-view-projector.mjs";

const prompts = {
  header: "Inspect the request timeline and report the important invariant.",
  body: "Inspect the translation cache and report the important invariant.",
};
const spawns = [
  toolCall("spawn-header", "Agent", { description: "Inspect timeline", prompt: prompts.header, subagent_type: "Explore" }),
  toolCall("spawn-body", "Agent", { description: "Inspect translations", prompt: prompts.body, subagent_type: "general-purpose" }),
];
const requests = [
  request(1, {
    response: response("parent-spawn", "tool_use", { tool_calls: spawns, text: "Launching two agents." }),
  }),
  request(2, {
    agentId: "header-agent-a",
    debugSource: "agent:builtin:Explore",
    messages: [{ role: "user", content: prompts.header }],
    response: response("header-read", "tool_use", { tool_calls: [toolCall("read-header", "Read", { file_path: "src/trace/turn-timeline.mjs" })] }),
  }),
  request(3, {
    messages: [{ role: "user", content: prompts.body }],
    response: response("body-read", "tool_use", { tool_calls: [toolCall("read-body", "Read", { file_path: "src/translation/blocks.mjs" })] }),
  }),
  request(4, {
    agentId: "header-agent-a",
    debugSource: "agent:builtin:Explore",
    messages: [{ role: "user", content: prompts.header }],
    currentToolResults: [{ id: "read-header", content: "timeline source" }],
    response: response("header-done", "end_turn", { text: "Timeline invariant." }),
  }),
  request(5, {
    messages: [{ role: "user", content: prompts.body }],
    currentToolResults: [{ id: "read-body", content: "translation source" }],
    response: response("body-done", "end_turn", { text: "Translation invariant." }),
  }),
  request(6, {
    messages: [
      { role: "assistant", content: spawns.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })) },
    ],
    currentToolResults: [
      { id: "spawn-header", content: "Timeline invariant." },
      { id: "spawn-body", content: "Translation invariant." },
    ],
    response: response("parent-done", "end_turn", { text: "Both agents returned." }),
  }),
  request(7, {
    sourceHint: { type: "metadata", label: "metadata" },
    messages: [{ role: "user", content: prompts.body }],
    response: response("metadata", "end_turn", { text: "metadata" }),
  }),
];

const semantics = {
  extractHistoryToolCalls(item) {
    const output = [];
    for (const message of item.raw?.body?.messages || []) {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "tool_use") output.push(toolCall(part.id, part.name, part.input));
      }
    }
    return output;
  },
  extractAgentMessages(item) {
    if (item.summary?.entry?.kind === "subagent_result" && item.summary.entry.subagent) {
      return [{ message: null, summary: item.summary.entry.subagent }];
    }
    return (item.raw?.body?.messages || [])
      .filter(isCodexAgentMessage)
      .map((message) => ({ message, summary: codexAgentMessageSummary(message) }));
  },
  firstUserPromptText(item) {
    const message = (item.raw?.body?.messages || []).find((entry) => entry?.role === "user" && typeof entry.content === "string");
    return message?.content || "";
  },
  normalizePrompt(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  },
  previewText(value, limit) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
  },
  stableJson(value) {
    return JSON.stringify(value, Object.keys(value || {}).sort());
  },
  childAgentType(item, spawn) {
    if (spawn?.subagent_type) return spawn.subagent_type;
    return item.debug_source?.replace(/^agent:builtin:/, "") || "Subagent";
  },
};

annotateSubagentLineage(requests, semantics);
assert.equal(requests[1].trace.claude_agent_id, "header-agent-a", "header-attributed child keeps its strong instance id");
assert.match(requests[2].trace.claude_agent_id, /^body:[a-f0-9]{12}$/, "body-only child receives a stable synthetic instance id");
assert.equal(requests[2].trace.claude_agent_id, requests[4].trace.claude_agent_id, "body-only rounds sharing the initial prompt share one instance");
assert.equal(requests[2].subagent_type, "general-purpose", "body-only child inherits type from its parent spawn");
assert.equal(requests[6].is_subagent, false, "metadata request is never promoted to a child branch");

const pagedRequests = [
  request(1, { response: response("parent-spawn", "tool_use", { tool_calls: spawns, text: "Launching two agents." }) }),
  request(2, { messages: [{ role: "user", content: prompts.body }], response: response("body-read", "end_turn", { text: "done" }) }),
];
const lineageState = createSubagentLineageState();
annotateSubagentLineage(pagedRequests.slice(0, 1), semantics, { state: lineageState });
annotateSubagentLineage(pagedRequests.slice(1), semantics, { state: lineageState });
assert.match(pagedRequests[1].trace.claude_agent_id, /^body:[a-f0-9]{12}$/, "a body-only child can match a spawn from an earlier page");
assert.equal(pagedRequests[1].subagent_type, "general-purpose");
assert.equal(lineageState.spawnByPromptKey.size, 2);
assert.throws(
  () => annotateSubagentLineage([], semantics, { state: { spawnByPromptKey: {} } }),
  /spawnByPromptKey must be a Map/,
);

const graph = buildSubagentGraph(requests, semantics);
assert.equal(graph.version, 2);
assert.equal(graph.branch_count, 2);
assert.equal(graph.spawn_count, 2);
assert.equal(graph.return_count, 2);
assert.equal(graph.confidence, "high");
assert.deepEqual(
  graph.branches.map((branch) => branch.request_indexes),
  [
    [2, 4],
    [3, 5],
  ],
  "interleaved rounds remain grouped by child instance",
);
assert.deepEqual(graph.branches.map((branch) => branch.status), ["returned", "returned"]);
assert.equal(graph.branches[0].spawn.id, "spawn-header", "header branch uses ordered spawn fallback");
assert.equal(graph.branches[1].spawn.id, "spawn-body", "body-only branch uses prompt-hash pairing");
assert.equal(graph.branches[0].steps[0].response_tool_calls[0].id, "read-header");
assert.equal(graph.branches[1].steps[1].request_tool_results[0].id, "read-body");
assert.equal(requests[0].trace.spawn_branch_ids.length, 2, "parent spawn request references both branches");
assert.equal(requests[5].trace.returned_branch_ids.length, 2, "parent return request references both branches");
assert.equal(requests[1].trace.agent_branch.index, 1);
assert.equal(requests[2].trace.agent_branch.index, 2);

const turns = [
  { id: "turn-1", request_ids: requests.slice(0, 6).map((item) => item.id), request_indexes: [1, 2, 3, 4, 5, 6] },
  { id: "turn-2", request_ids: [requests[6].id], request_indexes: [7] },
];
attachSubagentGraphToTurns(turns, graph);
assert.deepEqual(turns[0].agent_branches, graph.branches.map((branch) => branch.id));
assert.equal(turns[0].agent_branch_count, 2);
assert.equal(turns[1].agent_branch_count, 0);

const codexSpawn = toolCall("spawn-codex-probe", "spawn_agent", {
  task_name: "/root/context_probe",
  fork_turns: "all",
  message: "Inspect the inherited context.",
});
const codexRequests = [
  request(11, {
    response: response("codex-spawn", "tool_use", { tool_calls: [codexSpawn], text: "Starting a child agent." }),
  }),
  request(12, {
    currentToolResults: [{ id: codexSpawn.id, content: JSON.stringify({ task_name: "/root/context_probe" }) }],
    response: response("codex-wait", "tool_use", { text: "Waiting for the child result." }),
  }),
  request(13, {
    messages: [codexAgentMessage({ author: "/root/context_probe", result: "The child inherited the selected turns." })],
    entry: {
      kind: "subagent_result",
      subagent: codexAgentMessageSummary(codexAgentMessage({ author: "/root/context_probe", result: "The child inherited the selected turns." })),
    },
    response: response("codex-parent-final", "end_turn", { text: "The child result arrived." }),
  }),
];
const codexGraph = buildSubagentGraph(codexRequests, semantics);
assert.equal(codexGraph.version, 2);
assert.equal(codexGraph.branch_count, 1);
assert.equal(codexGraph.spawn_count, 1);
assert.equal(codexGraph.return_count, 1, "FINAL_ANSWER agent_message is the Codex business return");
assert.equal(codexGraph.returns[0].spawn_id, codexSpawn.id);
assert.equal(codexGraph.spawns[0].context_mode, "all");
assert.equal(codexGraph.spawns[0].task_message_visibility, "visible");
assert.equal("raw_arguments" in codexGraph.spawns[0], false, "public graph never exposes raw or encrypted spawn arguments");
assert.equal(codexGraph.branches[0].launch.parent_request_index, 12, "spawn tool output is only a launch acknowledgement");
assert.equal(codexGraph.branches[0].return.parent_request_index, 13);
assert.equal(codexGraph.branches[0].status, "returned");
assert.equal(codexGraph.branches[0].steps[0].event_type, "agent_message");
assert.equal(codexRequests[1].trace.returned_branch_ids, undefined, "launch acknowledgement is never annotated as a return");
assert.deepEqual(codexRequests[0].trace.spawn_branch_ids, [codexGraph.branches[0].id]);
assert.deepEqual(codexRequests[1].trace.launch_branch_ids, [codexGraph.branches[0].id]);
assert.deepEqual(codexRequests[2].trace.returned_branch_ids, [codexGraph.branches[0].id]);
assert.equal(codexRequests[0].trace.agent_spawn_events[0].spawn_id, codexSpawn.id);
assert.equal(codexRequests[0].trace.agent_spawn_events[0].context_mode, "all");
assert.equal("raw_arguments" in codexRequests[0].trace.agent_spawn_events[0], false);
assert.equal(codexRequests[1].trace.agent_launch_events[0].agent_id, "/root/context_probe");
assert.equal(codexRequests[2].trace.agent_return_events[0].result_preview, "The child inherited the selected turns.");

const compactCodexGraph = buildSubagentGraph(codexRequests.map(projectTimelineRequest), semantics);
assert.equal(compactCodexGraph.branch_count, 1);
assert.equal(compactCodexGraph.return_count, 1, "compact timeline data retains Codex subagent completion semantics");
assert.equal(compactCodexGraph.branches[0].label, "/root/context_probe");
assert.equal(compactCodexGraph.branches[0].spawn.context_mode, "all");
assert.equal(compactCodexGraph.branches[0].spawn.task_message_visibility, "visible");
assert.equal(compactCodexGraph.branches[0].status, "returned");

console.log("subagent graph contract smoke passed");

function request(index, options = {}) {
  return {
    id: `request-${index}`,
    request_index: index,
    is_subagent: Boolean(options.agentId),
    source_hint: options.sourceHint || (options.agentId ? { type: "subagent", label: "child", confidence: "high" } : { type: "user", label: "user" }),
    debug_source: options.debugSource || "",
    raw: { body: { messages: options.messages || [] } },
    trace: {
      actor_type: options.agentId ? "child" : "main",
      ...(options.agentId ? { claude_agent_id: options.agentId } : {}),
      ...(options.debugSource ? { debug_source: options.debugSource } : {}),
    },
    summary: {
      entry: options.entry || null,
      current_tool_results: options.currentToolResults || [],
      response: options.response || response(`response-${index}`, "end_turn", { text: "done" }),
    },
  };
}

function response(messageId, finishReason, { tool_calls = [], text = "" } = {}) {
  return {
    captured: true,
    message_id: messageId,
    finish_reason: finishReason,
    tool_calls,
    text,
    preview: text,
  };
}

function toolCall(id, name, argumentsValue) {
  return { id, name, arguments: argumentsValue };
}

function codexAgentMessage({ author, result }) {
  return {
    role: "user",
    codex_item_type: "agent_message",
    author,
    recipient: "/root",
    content: `Message Type: FINAL_ANSWER\nSender: ${author}\nPayload:\n${result}`,
  };
}
