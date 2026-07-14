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
const agentComposerControllerSource = fs.readFileSync(new URL("../src/viewer/agent-composer-controller.js", import.meta.url), "utf8");
const sessionNavigatorControllerSource = fs.readFileSync(new URL("../src/viewer/session-navigator-controller.js", import.meta.url), "utf8");
const sourceTimelineControllerSource = fs.readFileSync(new URL("../src/viewer/source-timeline-controller.js", import.meta.url), "utf8");
const translationCacheControllerSource = fs.readFileSync(new URL("../src/viewer/translation-cache-controller.js", import.meta.url), "utf8");
const translationGenerationOperationSource = fs.readFileSync(new URL("../src/viewer/translation-generation-operation.js", import.meta.url), "utf8");

assert.match(source, /import \{[\s\S]*?buildTraceTimelineView,[\s\S]*?from "\.\/trace-timeline-model\.js";/);
assert.match(source, /import \{ TraceTimelineController \} from "\.\/trace-timeline-controller\.js";/);
assert.match(source, /import \{ SourceTimelineController \} from "\.\/source-timeline-controller\.js";/);
assert.match(source, /const sourceTimelineController = new SourceTimelineController\(/);
assert.match(source, /TranslationCacheController,[\s\S]*?translationAgentCandidatesForData,[\s\S]*?from "\.\/translation-cache-controller\.js";/);
assert.match(source, /const translationCacheController = new TranslationCacheController\(/);
assert.match(source, /import \{ runTranslationGenerationOperation \} from "\.\/translation-generation-operation\.js";/);
assert.doesNotMatch(source, /TimelineEntityStore|sourceLoadSeq|function continueTimelineCursor\(/);
assert.doesNotMatch(source, /state\.(?:translations|translationLookup|translationAutoRefresh)/);
assert.doesNotMatch(source, /function (?:translationAgentCandidatesForData|buildTranslationLookup|maybeAutoRefreshTranslations)\(/);
assert.match(source, /onAutoRefresh: \(context\) => \{[\s\S]*?automatic: true, \.\.\.context/);
assert.match(functionSource("isTranslationGenerationCurrent"), /translationCacheController\.isOperationCurrent/);
assert.match(functionSource("generateTranslationsForActiveSource"), /source_id: sourceId,[\s\S]*?target_language: targetLanguage/);
assert.match(functionSource("generateTranslationsForActiveSource"), /runTranslationGenerationOperation\(\{[\s\S]*?isCurrent:[\s\S]*?onStale:/);
assert.match(functionSource("retranslateTranslationBlock"), /runTranslationGenerationOperation\(\{[\s\S]*?isCurrent:[\s\S]*?onStale:/);
assert.match(sourceTimelineControllerSource, /import \{ TimelineEntityStore \} from "\.\/timeline-entity-store\.js";/);
assert.match(sourceTimelineControllerSource, /this\.store = new TimelineEntityStore\(\)/);
assert.doesNotMatch(sourceTimelineControllerSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bstate\./);
assert.doesNotMatch(translationCacheControllerSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(translationGenerationOperationSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(source, /\bmergeTimelinePage\(/, "application code should use the persistent normalized entity store");
assert.match(source, /renderTurnTimeline as renderTurnTimelineView,[\s\S]*?from "\.\/trace-timeline-renderer\.js";/);
assert.match(
  source,
  /renderTimelineAssistantResponse as renderTimelineAssistantResponseView,[\s\S]*?renderTimelineRequestCard as renderTimelineRequestCardView,[\s\S]*?from "\.\/request-card-renderer\.js";/,
);
assert.match(source, /import \{ AGENT_BRANCH_PAGE_SIZE, buildAgentGraphView \} from "\.\/agent-graph-model\.js";/);
assert.match(source, /import \{ renderAgentGraph as renderAgentGraphView \} from "\.\/agent-graph-renderer\.js";/);
assert.match(source, /import \{ buildUpstreamDetailView \} from "\.\/upstream-detail-model\.js";/);
assert.match(source, /import \{ renderUpstreamDetail as renderUpstreamDetailView \} from "\.\/upstream-detail-renderer\.js";/);
assert.match(source, /import \{ AgentComposerController \} from "\.\/agent-composer-controller\.js";/);
assert.match(source, /import \{ SessionNavigatorController \} from "\.\/session-navigator-controller\.js";/);
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
assert.match(source, /const agentComposerController = new AgentComposerController\(/);
assert.match(functionSource("renderComposerSurface"), /agentComposerController\.render\(state\.data\.source\)/);
assert.doesNotMatch(source, /function renderAgentComposer\(/);
assert.doesNotMatch(source, /function bindAgentComposer\(/);
assert.doesNotMatch(source, /function sendAgentComposerMessage\(/);
assert.doesNotMatch(agentComposerControllerSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);
assert.match(source, /const sessionNavigatorController = new SessionNavigatorController\(/);
assert.match(functionSource("renderSessionNav"), /sessionNavigatorController\.render\(\{[\s\S]*?sources: state\.sources,[\s\S]*?activeSourceId: state\.activeSourceId/);
assert.doesNotMatch(source, /function renderSourceGroups\(/);
assert.doesNotMatch(source, /function renderProjectGroup\(/);
assert.doesNotMatch(source, /function renderSessionItem\(/);
assert.doesNotMatch(source, /function closeNavMenuOnce\(/);
assert.doesNotMatch(sessionNavigatorControllerSource, /\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);

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
