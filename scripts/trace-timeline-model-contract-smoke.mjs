import assert from "node:assert/strict";

import {
  buildTraceTimelineView,
  fallbackTimelineTurns,
  findTurnLeadRequest,
  filterTraceTurns,
  timelineWindow,
  traceFilterCounts,
  traceFilterShowsMechanismStory,
  traceRequestHasSubagentActivity,
  traceRequestHasIssue,
  traceRequestHasTools,
  traceRequestIsSlow,
} from "../src/viewer/trace-timeline-model.js";

const requests = [
  request("r1", 1, { user: "hello", response: "welcome" }),
  request("r2", 2, { user: "inspect disk", tools: [{ name: "Bash", arguments: { command: "df -h" } }], latency: 6100 }),
  request("r3", 3, { user: "tool result", toolResults: [{ content: "permission denied" }] }),
  request("r4", 4, { user: "child task", subagent: true, response: "child complete" }),
];
const turns = [
  turn("t1", 1, ["r1"], "hello"),
  turn("t2", 2, ["r2", "r3"], "inspect disk"),
  turn("t3", 3, ["r4"], "delegate child"),
];

assert.deepEqual(traceFilterCounts(requests), {
  all: 4,
  issues: 1,
  slow: 1,
  tools: 2,
  subagents: 1,
});
assert.equal(traceRequestHasIssue(requests[2]), true);
assert.equal(traceRequestIsSlow(requests[1]), true);
assert.equal(traceRequestHasTools(requests[1]), true);
assert.equal(traceRequestHasTools(requests[2]), true);
assert.equal(traceRequestHasSubagentActivity(requests[3]), true);
assert.equal(traceRequestHasSubagentActivity({ trace: { spawn_branch_ids: ["branch-1"] } }), true);
assert.equal(traceRequestHasSubagentActivity({ trace: { launch_branch_ids: ["branch-1"] } }), true);
assert.equal(traceRequestHasSubagentActivity({ summary: { entry: { kind: "subagent_result" } } }), true);
assert.equal(traceFilterShowsMechanismStory("tools"), true);
assert.equal(traceFilterShowsMechanismStory("subagents"), true);
assert.equal(traceFilterShowsMechanismStory("issues"), false);

const issueView = buildTraceTimelineView({ turns, requests, filter: "issues" });
assert.equal(issueView.queryActive, true);
assert.equal(issueView.matchCount, 1);
assert.deepEqual(issueView.filteredTurns.map((item) => item.id), ["t2"]);
assert.deepEqual(issueView.filteredTurns[0].request_ids, ["r3"]);
assert.deepEqual(issueView.filteredTurns[0].all_request_ids, ["r2", "r3"]);
assert.equal(issueView.filteredTurns[0].trace_filter, "issues");

const toolView = buildTraceTimelineView({ turns, requests, filter: "tools", resultLimit: 1 });
assert.equal(toolView.matchCount, 2);
assert.equal(toolView.shownCount, 1);
assert.deepEqual(toolView.filteredTurns[0].request_ids, ["r2"]);

const turnTitleView = buildTraceTimelineView({ turns, requests, query: "delegate child" });
assert.equal(turnTitleView.matchCount, 1, "turn-level matches should resolve to one lead request");
assert.deepEqual(turnTitleView.filteredTurns[0].request_ids, ["r4"]);

const latestView = buildTraceTimelineView({ turns, requests, latestOnly: true });
assert.equal(latestView.shownCount, requests.length, "unfiltered views should report the complete visible result set");
assert.deepEqual(latestView.railTurns.map((item) => item.id), ["t3"]);
assert.deepEqual(latestView.turnWindow.turns.map((item) => item.id), ["t3"]);

const queryOverridesLatest = buildTraceTimelineView({ turns, requests, latestOnly: true, query: "hello" });
assert.deepEqual(queryOverridesLatest.railTurns.map((item) => item.id), ["t1"]);

const manyTurns = Array.from({ length: 10 }, (_, index) => ({ id: `t${index + 1}` }));
const centered = timelineWindow({ turns: manyTurns, activeId: "t7", threshold: 4, size: 4 });
assert.equal(centered.windowed, true);
assert.deepEqual(centered.turns.map((item) => item.id), ["t5", "t6", "t7", "t8"]);
assert.deepEqual(timelineWindow({ turns: manyTurns, latestOnly: true, threshold: 4, size: 4 }).turns, manyTurns);

const fallback = fallbackTimelineTurns(requests, { requestExcerpt: (item) => item.summary.current_user });
assert.equal(fallback.length, requests.length);
assert.equal(fallback[3].subagent_count, 1);
assert.equal(fallback[2].tool_result_count, 1);

assert.equal(findTurnLeadRequest([requests[1], requests[2]], turns[1])?.id, "r2");
assert.equal(filterTraceTurns({ turns, requests, query: "missing", resultLimit: 24 }).length, 0);

console.log("trace timeline model contract smoke passed");

function request(id, requestIndex, { user, response = "", tools = [], toolResults = [], latency = 0, subagent = false } = {}) {
  return {
    id,
    request_index: requestIndex,
    is_subagent: subagent,
    source_hint: { type: "main" },
    summary: {
      current_user: user,
      entry: { label: "User input", text: user },
      response: {
        text: response,
        preview: response,
        latency_ms: latency,
        tool_calls: tools,
      },
      current_tool_calls: tools,
      current_tool_results: toolResults,
      tool_names: tools.map((item) => item.name),
    },
    counts: {},
  };
}

function turn(id, index, requestIds, userInput) {
  return {
    id,
    index,
    title: userInput,
    user_input: userInput,
    request_ids: requestIds,
    request_count: requestIds.length,
  };
}
