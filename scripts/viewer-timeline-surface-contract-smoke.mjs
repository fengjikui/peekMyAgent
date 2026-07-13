import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(new URL("../src/viewer/trace-timeline-controller.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/viewer/trace-timeline-renderer.js", import.meta.url), "utf8");
const requestCardRendererSource = fs.readFileSync(new URL("../src/viewer/request-card-renderer.js", import.meta.url), "utf8");
const agentGraphModelSource = fs.readFileSync(new URL("../src/viewer/agent-graph-model.js", import.meta.url), "utf8");
const agentGraphRendererSource = fs.readFileSync(new URL("../src/viewer/agent-graph-renderer.js", import.meta.url), "utf8");
const upstreamDetailModelSource = fs.readFileSync(new URL("../src/viewer/upstream-detail-model.js", import.meta.url), "utf8");
const upstreamDetailRendererSource = fs.readFileSync(new URL("../src/viewer/upstream-detail-renderer.js", import.meta.url), "utf8");

assert.match(source, /import \{[\s\S]*?buildTraceTimelineView,[\s\S]*?from "\.\/trace-timeline-model\.js";/);
assert.match(source, /import \{ TraceTimelineController \} from "\.\/trace-timeline-controller\.js";/);
assert.match(source, /renderTurnTimeline as renderTurnTimelineView,[\s\S]*?from "\.\/trace-timeline-renderer\.js";/);
assert.match(
  source,
  /renderTimelineAssistantResponse as renderTimelineAssistantResponseView,[\s\S]*?renderTimelineRequestCard as renderTimelineRequestCardView,[\s\S]*?from "\.\/request-card-renderer\.js";/,
);
assert.match(source, /import \{ AGENT_BRANCH_PAGE_SIZE, buildAgentGraphView \} from "\.\/agent-graph-model\.js";/);
assert.match(source, /import \{ renderAgentGraph as renderAgentGraphView \} from "\.\/agent-graph-renderer\.js";/);
assert.match(source, /import \{ buildUpstreamDetailView \} from "\.\/upstream-detail-model\.js";/);
assert.match(source, /import \{ renderUpstreamDetail as renderUpstreamDetailView \} from "\.\/upstream-detail-renderer\.js";/);
assert.match(source, /function renderAll\(\) \{[\s\S]*?renderHeaderSurface\(\);[\s\S]*?renderTimelineSurface\(\{ updateViewControls: false \}\);[\s\S]*?renderComposerSurface\(\);/);
assert.match(
  functionSource("renderTimelineSurface"),
  /clearTranslationActions\("timeline"\);[\s\S]*?traceTimelineController\.render\([\s\S]*?renderTraceQueryBarView[\s\S]*?renderTurnTimelineView/,
);
assert.match(source, /traceTimelineController\.bind\(\);/);
assert.doesNotMatch(source, /function bindTimelineEvents\(/, "Timeline events should be owned by the controller");
assert.doesNotMatch(source, /function bindTraceQueryEvents\(/, "query events should be owned by the controller");
assert.match(controllerSource, /timelineElement\.addEventListener\("click"/);
assert.match(controllerSource, /queryElement\.addEventListener\("compositionstart"/);
assert.match(rendererSource, /export function renderTurnTimeline/);
assert.match(requestCardRendererSource, /export function renderTimelineRequestCard/);
assert.match(requestCardRendererSource, /export function renderTimelineAssistantResponse/);
assert.match(source, /renderTimelineRequestCardView\(/);
assert.match(source, /renderTimelineAssistantResponseView\(/);
assert.doesNotMatch(source, /function renderAssistantToolCalls\(/);
assert.doesNotMatch(source, /function renderAssistantThinking\(/);
assert.doesNotMatch(source, /function renderToolExchangeItem\(/);
assert.doesNotMatch(requestCardRendererSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
assert.match(source, /const view = buildAgentGraphView\(/);
assert.match(source, /return renderAgentGraphView\(view,/);
assert.doesNotMatch(source, /function renderAgentBranch\(/);
assert.doesNotMatch(source, /function renderAgentMapCard\(/);
assert.doesNotMatch(source, /function agentFlowEvents\(/);
assert.doesNotMatch(agentGraphModelSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(agentGraphRendererSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
assert.match(source, /renderUpstreamDetailView\(buildUpstreamDetailView\(request,/);
assert.doesNotMatch(source, /function renderHistoryStack\(/);
assert.doesNotMatch(source, /function renderCurrentMessageDelta\(/);
assert.doesNotMatch(source, /function renderContextComposition\(/);
assert.doesNotMatch(upstreamDetailModelSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(upstreamDetailRendererSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);

for (const functionName of [
  "jumpToTurn",
  "jumpToAgentBranch",
  "toggleAgentBranch",
  "toggleUpstreamDetails",
  "syncUpstreamDetailsState",
  "toggleLatestOnly",
  "toggleResponseExpansion",
]) {
  const body = functionSource(functionName);
  assert.match(body, /renderTimelineSurface\(\)/, `${functionName} should refresh only the Timeline surface`);
  assert.doesNotMatch(body, /renderAll\(\)/, `${functionName} must not rebuild the whole Viewer`);
}

assert.doesNotMatch(functionSource("retranslateTranslationBlock"), /renderAll\(\)/, "block translation should not rebuild the Viewer");
assert.match(
  source,
  /clientStore\.subscribe\(\(change\) => \{[\s\S]*?syncActiveTurnDom\(change\.state\.activeId\)[\s\S]*?syncActiveRequestDom\(change\.state\.activeRequestId\)/,
  "Client Store selection notifications should own active DOM synchronization",
);
assert.match(functionSource("markActiveTurn"), /clientStore\.setSelection/);
assert.doesNotMatch(functionSource("markActiveTurn"), /querySelectorAll/);
assert.match(functionSource("markActiveRequest"), /clientStore\.setSelection/);
assert.doesNotMatch(functionSource("markActiveRequest"), /querySelectorAll/);
assert.doesNotMatch(functionSource("syncActiveTurnDom"), /document\.querySelectorAll/);
assert.doesNotMatch(functionSource("syncActiveRequestDom"), /document\.querySelectorAll/);
assert.match(functionSource("syncActiveTurnDom"), /traceTimelineController\.syncActiveTurn/);
assert.match(functionSource("syncActiveRequestDom"), /traceTimelineController\.syncActiveRequest/);

console.log("viewer timeline surface contract smoke passed");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}
