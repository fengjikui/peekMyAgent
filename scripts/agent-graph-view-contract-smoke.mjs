#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAgentGraphView } from "../src/viewer/agent-graph-model.js";
import { renderAgentGraph } from "../src/viewer/agent-graph-renderer.js";

const branches = [
  branch({
    id: "branch-b",
    agentId: "agent-b-very-long-id",
    label: "Inspect <disk>",
    agentType: "Explore",
    firstRequestIndex: 14,
    requestIndexes: [14, 23],
    status: "running",
    toolCalls: 1,
    toolResults: 1,
    spawnIndex: 13,
    returnIndex: null,
    steps: [
      {
        request_id: "request-23",
        request_index: 23,
        response_id: "response-b",
        response_tool_calls: [{ id: "call-b", name: "Bash" }],
        request_tool_results: [{ id: "call-b" }],
        response_preview: "Disk result <unsafe>",
      },
    ],
  }),
  branch({
    id: "branch-a",
    agentId: "agent-a-very-long-id",
    label: "Count files",
    agentType: "general-purpose",
    firstRequestIndex: 8,
    requestIndexes: [8, 15],
    status: "returned",
    toolCalls: 0,
    toolResults: 0,
    spawnIndex: 6,
    returnIndex: 16,
    steps: [
      {
        request_id: "request-15",
        request_index: 15,
        response_id: "response-a",
        finish_reason: "end_turn",
        response_preview: "Counted files",
      },
    ],
  }),
];

const trace = { confidence: "high", signals: { child_instance: "x-claude-code-agent-id" }, branches };
const requestMap = new Map([
  ["request-8", { title: "First A" }],
  ["request-14", { title: "First B" }],
]);
const turn = { id: "turn-7", agent_branches: ["branch-a", "branch-b"] };
const view = buildAgentGraphView({
  turn,
  trace,
  requestMap,
  dashboardOpen: true,
  activeFilter: "all",
  branchLimit: 24,
  expandedBranchIds: new Set(["branch-a"]),
  requestTitle: (request) => request.title || "missing",
});

assert.equal(view.branchCount, 2);
assert.deepEqual(view.branches.map((item) => item.id), ["branch-a", "branch-b"]);
assert.deepEqual(view.visibleBranches.map((entry) => [entry.branch.id, entry.index, entry.expanded]), [
  ["branch-a", 0, true],
  ["branch-b", 1, false],
]);
assert.deepEqual(view.statusCounts, { returned: 1, completed: 0, running: 1 });
assert.equal(view.showStatusFilters, false);
assert.deepEqual(view.spawnIndexes, [6, 13]);
assert.deepEqual(view.launchIndexes, []);
assert.deepEqual(view.returnIndexes, [16]);
assert.deepEqual(view.summary, {
  branches: 2,
  requests: 4,
  returned: 1,
  calls: 1,
  results: 1,
  signal: "x-claude-code-agent-id",
});
assert.deepEqual(
  view.events.map((event) => [event.requestIndex, event.branchIndex, event.type]),
  [
    [6, 0, "spawn"],
    [13, 1, "spawn"],
    [15, 0, "done"],
    [16, 0, "return"],
    [23, 1, "tool_result"],
  ],
);

const returnedOnly = buildAgentGraphView({ turn, trace, activeFilter: "returned" });
assert.deepEqual(returnedOnly.visibleBranches.map((entry) => [entry.branch.id, entry.index]), [["branch-a", 0]]);
const runningOnly = buildAgentGraphView({ turn, trace, activeFilter: "running" });
assert.deepEqual(runningOnly.visibleBranches.map((entry) => [entry.branch.id, entry.index]), [["branch-b", 1]]);
assert.equal(buildAgentGraphView({ turn: { id: "empty", agent_branches: [] }, trace }), null);

const codexReturnView = buildAgentGraphView({
  turn: { id: "turn-codex", agent_branches: ["branch-codex"] },
  trace: {
    branches: [
      {
        ...branch({
          id: "branch-codex",
          agentId: "/root/probe",
          label: "Probe context",
          agentType: "Codex Agent",
          firstRequestIndex: 33,
          requestIndexes: [33],
          status: "returned",
          toolCalls: 0,
          toolResults: 0,
          spawnIndex: 30,
          returnIndex: 33,
          steps: [{ request_id: "request-33", request_index: 33, event_type: "agent_message", finish_reason: "FINAL_ANSWER" }],
        }),
        launch: { parent_request_id: "request-31", parent_request_index: 31, result_preview: "task accepted" },
      },
    ],
  },
});
assert.deepEqual(
  codexReturnView.events.map((event) => [event.requestIndex, event.type]),
  [[30, "spawn"], [31, "launch"], [33, "return"]],
  "the agent_message step represents the return once instead of duplicating the return edge",
);
assert.deepEqual(codexReturnView.launchIndexes, [31]);

const manyBranches = Array.from({ length: 26 }, (_, index) =>
  branch({
    id: `branch-${index + 1}`,
    agentId: `agent-${index + 1}`,
    label: `Agent ${index + 1}`,
    agentType: "Explore",
    firstRequestIndex: index + 1,
    requestIndexes: [index + 1],
    status: "running",
    toolCalls: 0,
    toolResults: 0,
    spawnIndex: index + 1,
    returnIndex: null,
    steps: [],
  }),
);
const pagedView = buildAgentGraphView({
  turn: { id: "turn-many", agent_branches: manyBranches.map((item) => item.id) },
  trace: { branches: manyBranches },
  dashboardOpen: true,
  branchLimit: 24,
});
assert.equal(pagedView.visibleBranches.length, 24);
assert.equal(pagedView.showStatusFilters, true);
assert.equal(pagedView.hiddenBranchCount, 2);
assert.equal(pagedView.nextPageCount, 2);
assert.equal(pagedView.summaryDots.length, 8);
assert.equal(pagedView.summaryOverflow, 18);

const translate = (key, values = {}) =>
  `${key}${Object.keys(values).length ? `:${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")}` : ""}`;
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const html = renderAgentGraph(view, {
  translate,
  escapeHtml,
  shortId: (value) => String(value || "").slice(0, 7),
  shortPreview: (value, limit) => String(value || "").slice(0, limit),
});

assert.match(html, /data-agent-dashboard="turn-7" open/);
assert.match(html, /multiAgentSummary:count=2/);
assert.match(html, /agentFilterRunning:count=1 · agentFilterReturned:count=1/);
assert.match(html, /general-purpose \/ Explore/);
assert.doesNotMatch(html, /data-agent-status-filter=/, "small boards should not spend space on status filters");
assert.match(html, /data-agent-branch-toggle="branch-a" aria-expanded="true"/);
assert.match(html, /data-agent-branch-toggle="branch-b" aria-expanded="false"/);
assert.match(html, /data-agent-jump="request-15"/);
assert.match(html, /childSeq:index=2 agentEventToolResult/);
assert.match(html, /agentInterleavedTimeline:count=5/);
assert.match(html, /agentLinkageEvidence:confidence=highConfidence/);
assert.match(html, /agentLinkageSignal:signal=x-claude-code-agent-id/);
assert.match(html, /agentPathSpawn:index=6/);
assert.match(html, /agentPathReturn:index=16/);
assert.match(html, /Inspect &lt;disk&gt;/);
assert.doesNotMatch(html, /<unsafe>/);

const pagedHtml = renderAgentGraph(pagedView, {
  translate,
  escapeHtml,
  shortId: (value) => String(value || "").slice(0, 7),
  shortPreview: (value, limit) => String(value || "").slice(0, limit),
});
assert.match(pagedHtml, /data-agent-status-filter="turn-many" data-agent-filter-value="all" aria-pressed="true"/);

const modelSource = fs.readFileSync(new URL("../src/viewer/agent-graph-model.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/viewer/agent-graph-renderer.js", import.meta.url), "utf8");
for (const source of [modelSource, rendererSource]) {
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
}

console.log("agent graph view contract smoke passed");

function branch({
  id,
  agentId,
  label,
  agentType,
  firstRequestIndex,
  requestIndexes,
  status,
  toolCalls,
  toolResults,
  spawnIndex,
  returnIndex,
  steps,
}) {
  return {
    id,
    agent_id: agentId,
    label,
    agent_type: agentType,
    first_request_index: firstRequestIndex,
    request_ids: requestIndexes.map((index) => `request-${index}`),
    request_indexes: requestIndexes,
    status,
    response_tool_call_count: toolCalls,
    request_tool_result_count: toolResults,
    spawn: {
      parent_request_id: `request-${spawnIndex}`,
      parent_request_index: spawnIndex,
      label: `spawn ${label}`,
      subagent_type: agentType,
    },
    return: returnIndex
      ? {
          parent_request_id: `request-${returnIndex}`,
          parent_request_index: returnIndex,
          result_preview: `${label} returned`,
        }
      : null,
    steps,
    linkage_note: `${label} linkage`,
  };
}
