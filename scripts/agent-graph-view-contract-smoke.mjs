#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  agentBranchVisualIdentity,
  buildAgentGraphView,
} from "../src/viewer/agent-graph-model.js";
import { renderAgentGraph } from "../src/viewer/agent-graph-renderer.js";

const stylesSource = fs.readFileSync(new URL("../src/viewer/styles.css", import.meta.url), "utf8");

const branches = [
  branch({
    id: "branch-euclid",
    agentId: "agent-euclid-stable-id",
    label: "Euclid",
    agentType: "Explore",
    firstRequestIndex: 14,
    requestIndexes: [14, 23],
    status: "running",
    toolCalls: 1,
    toolResults: 1,
    spawnIndex: 13,
    launchIndex: 14,
    returnIndex: null,
    steps: [
      {
        request_id: "request-23",
        request_index: 23,
        response_tool_calls: [{ id: "call-b", name: "Bash" }],
        request_tool_results: [{ id: "call-b" }],
      },
    ],
  }),
  branch({
    id: "branch-ptolemy",
    agentId: "agent-ptolemy-stable-id",
    label: "Ptolemy <unsafe>",
    agentType: "general-purpose",
    firstRequestIndex: 8,
    requestIndexes: [8, 15],
    status: "returned",
    toolCalls: 0,
    toolResults: 0,
    spawnIndex: 6,
    launchIndex: 7,
    returnIndex: 16,
    steps: [
      {
        request_id: "request-15",
        request_index: 15,
        finish_reason: "end_turn",
      },
    ],
  }),
];

const trace = { confidence: "high", signals: { child_instance: "client_metadata.thread_id" }, branches };
const turn = { id: "turn-7", agent_branches: ["branch-ptolemy", "branch-euclid"] };
const view = buildAgentGraphView({
  turn,
  trace,
  selectedBranchId: "branch-euclid",
});

assert.equal(view.branchCount, 2);
assert.equal(view.dashboardOpen, false, "the multi-Agent console is folded by default");
assert.deepEqual(view.branches.map((item) => item.id), ["branch-ptolemy", "branch-euclid"]);
assert.deepEqual(view.branchEntries.map((entry) => [entry.branch.id, entry.index, entry.displayName]), [
  ["branch-ptolemy", 0, "Ptolemy <unsafe>"],
  ["branch-euclid", 1, "Euclid"],
]);
assert.equal(view.selectedBranch.branch.id, "branch-euclid");
assert.deepEqual(view.spawnIndexes, [6, 13]);
assert.deepEqual(view.launchIndexes, [7, 14]);
assert.deepEqual(view.returnIndexes, [16]);
assert.equal(view.signal, "client_metadata.thread_id");

const defaultSelection = buildAgentGraphView({ turn, trace });
assert.equal(defaultSelection.selectedBranch.branch.id, "branch-ptolemy", "the first stable branch is selected by default");
assert.equal(buildAgentGraphView({ turn: { id: "empty", agent_branches: [] }, trace }), null);

const originalVisuals = new Map(view.branchEntries.map((entry) => [entry.branch.id, entry.visual]));
const reordered = buildAgentGraphView({
  turn,
  trace: { ...trace, branches: [...branches].reverse() },
});
for (const entry of reordered.branchEntries) {
  assert.deepEqual(entry.visual, originalVisuals.get(entry.branch.id), "color and glyph must not depend on branch display order");
}
assert.deepEqual(
  agentBranchVisualIdentity({ agent_id: "agent-euclid-stable-id" }),
  agentBranchVisualIdentity({ agent_id: "agent-euclid-stable-id", id: "different-wrapper-id" }),
  "stable Agent identity takes precedence over generated branch ids",
);

const translate = (key, values = {}) =>
  `${key}${Object.keys(values).length ? `:${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(",")}` : ""}`;
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const rendererDependencies = {
  translate,
  escapeHtml,
  shortPreview: (value, limit) => String(value || "").slice(0, limit),
  selectedTimelineHtml: '<article data-card="request-14">trusted child timeline</article>',
};
const foldedHtml = renderAgentGraph(view, rendererDependencies);
assert.match(foldedHtml, /<details class="agent-branch-map"[^>]*data-agent-dashboard="turn-7"/);
assert.match(foldedHtml, /data-agent-dashboard-toggle="turn-7"/);
assert.doesNotMatch(foldedHtml, /role="tablist"/, "folded dashboards should not render their tab content");
assert.doesNotMatch(foldedHtml, /trusted child timeline/, "folded dashboards should not build hidden request-card DOM");

const openView = buildAgentGraphView({
  turn,
  trace,
  selectedBranchId: "branch-euclid",
  dashboardOpen: true,
});
const html = renderAgentGraph(openView, rendererDependencies);

assert.match(html, /<details class="agent-branch-map"[^>]*data-agent-dashboard="turn-7"[^>]*open/);
assert.match(html, /role="tablist"/);
assert.equal((html.match(/data-agent-branch-select=/g) || []).length, 2, "every child Agent receives one tab");
assert.match(html, /data-agent-branch-select="branch-euclid"[^>]*style=/);
assert.match(html, /data-agent-branch-select="branch-euclid"[\s\S]*?class="agent-tab-name">Euclid<\/strong>/);
assert.doesNotMatch(html, /childSeq:index=/, "Agent tabs should contain only their identity glyph and name");
assert.match(html, /data-agent-selected-branch="branch-euclid"/);
assert.match(
  stylesSource,
  /\.agent-branch-map\s*\{[^}]*background:\s*transparent;/,
  "expanded child-Agent timelines should reuse the main timeline surface without a white details background",
);
assert.match(html, /data-card="request-14">trusted child timeline/);
assert.match(html, /agentSelectedTimelineAria:name=Euclid/);
assert.ok(
  html.indexOf('data-card="request-14"') < html.indexOf('class="agent-branch-lineage"'),
  "the full child request timeline should lead, with parent linkage kept as secondary evidence",
);
assert.match(html, /data-request-jump="request-13"/);
assert.match(html, /data-request-jump="request-14"/);
assert.match(html, /agentLinkageEvidence:confidence=highConfidence/);
assert.match(html, /Ptolemy &lt;unsafe&gt;/);
assert.doesNotMatch(html, /Ptolemy <unsafe>/);
assert.doesNotMatch(html, /data-agent-branch-toggle=/);
assert.doesNotMatch(html, /data-agent-status-filter=/);
assert.doesNotMatch(html, /agentInterleavedTimeline/);
assert.match(html, /data-agent-dashboard-toggle="turn-7"/);

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
  launchIndex,
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
      prompt_preview: `Inspect ${label}`,
    },
    launch: launchIndex
      ? {
          parent_request_id: `request-${launchIndex}`,
          parent_request_index: launchIndex,
          nickname: label,
          result_preview: `${label} launched`,
        }
      : null,
    return: returnIndex
      ? {
          parent_request_id: `request-${returnIndex}`,
          parent_request_index: returnIndex,
          result_preview: `${label} returned`,
        }
      : null,
    steps,
  };
}
