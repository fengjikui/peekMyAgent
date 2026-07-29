import fs from "node:fs";
import assert from "node:assert/strict";
import {
  RequestRailController,
  REQUEST_RAIL_THRESHOLD,
} from "../src/viewer/request-rail.js";

const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
const agentGraphModelSource = fs.readFileSync(new URL("../src/viewer/agent-graph-model.js", import.meta.url), "utf8");
const agentGraphRendererSource = fs.readFileSync(new URL("../src/viewer/agent-graph-renderer.js", import.meta.url), "utf8");
const markdownSource = fs.readFileSync(new URL("../src/viewer/markdown.js", import.meta.url), "utf8");
const messageViewModelSource = fs.readFileSync(new URL("../src/viewer/message-view-model.js", import.meta.url), "utf8");
const messagesRendererSource = fs.readFileSync(new URL("../src/viewer/messages-renderer.js", import.meta.url), "utf8");
const timelineModelSource = fs.readFileSync(new URL("../src/viewer/trace-timeline-model.js", import.meta.url), "utf8");
const timelineRendererSource = fs.readFileSync(new URL("../src/viewer/trace-timeline-renderer.js", import.meta.url), "utf8");
const timelineControllerSource = fs.readFileSync(new URL("../src/viewer/trace-timeline-controller.js", import.meta.url), "utf8");
const turnRailSource = fs.readFileSync(new URL("../src/viewer/turn-rail.js", import.meta.url), "utf8");
const requestRailSource = fs.readFileSync(new URL("../src/viewer/request-rail.js", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../src/viewer/styles.css", import.meta.url), "utf8");

assert.match(timelineModelSource, /export const TIMELINE_WINDOW_THRESHOLD = 180;/, "timeline window threshold should be explicit");
assert.match(timelineModelSource, /export const TIMELINE_WINDOW_SIZE = 120;/, "timeline window size should be explicit");
assert.match(
  clientSource,
  /import \{ buildAgentGraphView \} from "\.\/agent-graph-model\.js";/,
  "the viewer shell should consume the Agent Graph view contract",
);
assert.match(agentGraphModelSource, /export function agentBranchVisualIdentity\(/, "Agent color and glyph identity should be directly testable");
assert.match(timelineModelSource, /export function buildTraceTimelineView\(/, "the Timeline View Model should be directly testable");
assert.match(
  clientSource,
  /renderTurnTimelineView\(\{[\s\S]*?turnWindowOrTurns: timelineView\.turnWindow,[\s\S]*?requests,/,
  "main timeline should render the computed filtered window",
);
assert.match(
  clientSource,
  /return currentTimelineView\(data\)\.railTurns\.filter\(\(turn\) => turn\.kind !== "independent_background"\);/,
  "turn rail universe should follow the Timeline View Model while excluding independent background side channels",
);
assert.match(clientSource, /import \{ TurnRailController \} from "\.\/turn-rail\.js";/, "the timeline should delegate rail interaction to its feature controller");
assert.match(clientSource, /turnRailController\.bind\(\)/, "the turn rail controller should own its browser event lifecycle");
assert.match(turnRailSource, /export function visibleTurnWindow\(/, "the turn rail window policy should be directly testable");
assert.match(turnRailSource, /syncActiveFromScroll\(\)/, "the turn rail controller should own scroll activation");
assert.equal(REQUEST_RAIL_THRESHOLD, 5, "short turns should not show a second navigation rail");
const denseRailElement = {
  hidden: false,
  innerHTML: "",
  attributes: new Map(),
  setAttribute(name, value) {
    this.attributes.set(name, value);
  },
  removeAttribute(name) {
    this.attributes.delete(name);
  },
};
const requests39To63 = Array.from({ length: 25 }, (_, offset) => ({
  id: `request-${39 + offset}`,
  request_index: 39 + offset,
  summary: { response: offset % 4 === 0 ? { tool_calls: [{ id: `call-${offset}` }] } : { text: "ok" } },
}));
new RequestRailController({
  element: denseRailElement,
  mainPanel: { clientWidth: 900 },
  getRequests: () => requests39To63,
  getActiveId: () => "request-39",
  getActiveTurnId: () => "turn-dense",
  promptFor: () => "user prompt",
  translate: (key, values = {}) => `${key}:${Object.values(values).join("/")}`,
  escapeHtml: (value) => String(value),
  onJump: () => {},
  onActiveChange: () => {},
  documentRef: {},
  windowRef: { innerWidth: 900 },
}).render();
assert.equal((denseRailElement.innerHTML.match(/data-request=/g) || []).length, 25, "#39-#63 must all exist in the dense request rail");
assert.match(denseRailElement.innerHTML, /data-request="request-63"/, "the final request must remain directly reachable");
assert.match(denseRailElement.innerHTML, /request-rail-track/, "request navigation should use one shared fixed-mark rail");
assert.equal((denseRailElement.innerHTML.match(/class="request-line"/g) || []).length, 25, "navigation should use fixed rail marks for every request");
assert.doesNotMatch(denseRailElement.innerHTML, /request-number/, "request markers should never fall back to numbered buttons");
assert.equal((denseRailElement.innerHTML.match(/id="requestRailTooltip"/g) || []).length, 1, "request navigation should render one shared tooltip outside marker buttons");
assert.doesNotMatch(denseRailElement.innerHTML, /<button class="request-mark[^>]*>[\s\S]*?request-tooltip[\s\S]*?<\/button>/, "request markers must not own a tooltip that can be clipped by the scrolling track");
const shortSignalRail = { ...denseRailElement, innerHTML: "", attributes: new Map() };
new RequestRailController({
  element: shortSignalRail,
  mainPanel: { clientWidth: 480 },
  getRequests: () => requests39To63.slice(0, REQUEST_RAIL_THRESHOLD),
  getActiveId: () => "request-39",
  getActiveTurnId: () => "turn-short",
  promptFor: () => "user prompt",
  translate: (key, values = {}) => `${key}:${Object.values(values).join("/")}`,
  escapeHtml: (value) => String(value),
  onJump: () => {},
  onActiveChange: () => {},
  documentRef: {},
  windowRef: { innerWidth: 480 },
}).render();
assert.equal((shortSignalRail.innerHTML.match(/class="request-line"/g) || []).length, REQUEST_RAIL_THRESHOLD, "the first visible request rail should already use signal marks");
assert.doesNotMatch(shortSignalRail.innerHTML, /request-number/, "short visible request rails should not render numbered buttons");
assert.match(clientSource, /import \{ RequestRailController \} from "\.\/request-rail\.js";/, "long turns should use a dedicated request rail feature");
assert.match(clientSource, /function activeTurnRequestUniverse\(\)/, "request rail scope should be the active Turn");
assert.match(clientSource, /function childRequestIdsForTurn\(turn\)/, "child requests should be removed from the main request universe");
assert.match(requestRailSource, /allowedIds\.has\(card\.dataset\.card\)/, "scroll activation should ignore child-Agent cards excluded from the rail");
assert.match(clientSource, /getActiveId: \(\) => state\.activeTimelineRequestId/, "scroll navigation should own a selection separate from Raw detail");
assert.match(clientSource, /onActiveChange: markActiveTimelineRequest/, "request rail scrolling should never replace the Raw inspector context");
assert.match(clientSource, /onLoaded: \(fullRequest\) => \{[\s\S]*?scheduleTranslationLookupRefresh\(\)/, "detail hydration should schedule translation indexing after first paint");
assert.doesNotMatch(clientSource, /onLoaded: async \(fullRequest\)/, "detail hydration must not wait for a whole-source translation rebuild");
assert.match(clientSource, /setData\(data\) \{[\s\S]*?rebuildTimelineToolOriginIndex\(data\)/, "live snapshots should prebuild tool origins when data enters the Viewer");
assert.match(clientSource, /function applyLoadedSourceData\([\s\S]*?rebuildTimelineToolOriginIndex\(data\)/, "loaded and paged snapshots should prebuild tool origins before rendering");
assert.match(clientSource, /function priorTimelineToolCalls\(request\) \{\s*return toolOriginIndex\.get\(request\?\.id\) \|\| \[\];\s*\}/, "request rendering should reuse the prebuilt origin index without rescanning");
assert.match(timelineRendererSource, /data-turn-window-jump/, "window edge jump controls should be rendered by the Timeline renderer");
assert.match(timelineControllerSource, /onTurnWindowJump/, "window edge jump controls should be wired by the Timeline controller");
assert.match(clientSource, /function jumpToTurn\(turnId, scroll = true\)/, "turn rail jumps should re-render the active window");
assert.match(messageViewModelSource, /export const DEFAULT_MESSAGE_TEXT_LIMIT = 5000;/, "organized Messages view should cap markdown rendering");
assert.match(messageViewModelSource, /export function truncateMessageText\(text, limit = DEFAULT_MESSAGE_TEXT_LIMIT\)/, "organized Messages truncation helper should remain directly testable");
assert.match(clientSource, /function displaySourceLabel\(label\)[\s\S]*?Write the title in/, "source labels should hide appended title-generation instructions");
assert.match(messagesRendererSource, /renderMarkdown\(block\.textPreview\.text\)/, "organized Messages should render the truncated markdown text");
assert.match(markdownSource, /export function renderSafeMarkdown\(text\)/, "safe markdown renderer should be testable as a module");
assert.match(messagesRendererSource, /messageTextTruncated/, "organized Messages truncation should be visible to users");
assert.match(clientSource, /state\.openSupportingTimelines\.has\(turnId\)/, "supporting timelines should only render after they are opened");
assert.match(clientSource, /function markActiveTurn[\s\S]*?scrollIntoView\(\{ behavior: "auto", block: "start" \}\)/, "Turn navigation should settle immediately so the request rail does not move beneath the pointer");
assert.match(clientSource, /function markActiveTimelineRequest[\s\S]*?scrollIntoView\(\{ behavior: "auto", block: "start" \}\)/, "request navigation should settle immediately instead of racing a smooth-scroll observer");
assert.match(requestRailSource, /track\.scrollTo\?\.\(\{ left, behavior: "auto" \}\)/, "centering an active request marker should scroll only the horizontal rail");
assert.doesNotMatch(requestRailSource, /activeButton\.scrollIntoView/, "request marker centering must not pull the main timeline away from the selected card");
assert.match(clientSource, /function requestNavigationPrompt[\s\S]*?summary\?\.current_user/, "request tooltips should use the upstream user prompt");
assert.match(agentGraphRendererSource, /data-agent-dashboard-toggle/, "the multi-Agent console should disclose its child timelines on demand");
assert.match(clientSource, /state\.openAgentDashboards\.has\(turn\.id\)/, "folded Agent consoles should not build their child request-card DOM");
assert.match(agentGraphRendererSource, /data-agent-branch-select/, "each child Agent should be selectable through a tab");
assert.match(agentGraphRendererSource, /selectedTimelineHtml/, "the selected branch should accept the shared request-card timeline language");
assert.match(clientSource, /state\.selectedAgentBranches\.set\(turn\.id, branchId\)/, "selected child Agent state should be stable per Turn");
assert.match(clientSource, /function mainTimelineRequestsForTurn\(turn, requestMap\)/, "main and supporting timelines should share child-request deduplication");
assert.doesNotMatch(agentGraphRendererSource, /data-agent-status-filter/, "the tab row replaces the old status-filter card grid");
assert.match(timelineModelSource, /export function filterTraceTurns\(/, "Trace search should filter at the turn-story level");
assert.match(timelineModelSource, /export function traceRequestHasIssue\(request\)/, "Trace search should expose an issue entry point");
assert.match(timelineModelSource, /const traceSearchTextCache = new WeakMap\(\);/, "Trace search text should be cached across keystrokes");
assert.match(timelineModelSource, /export const TRACE_RESULT_PAGE_SIZE = 24;/, "Trace query results should be progressively disclosed");
assert.match(timelineModelSource, /trace_filter_active:\s*true/, "Trace filters should render matching request evidence instead of whole turns");
assert.match(stylesSource, /\.timeline-window-edge-card/, "window edge UI should be styled");
assert.match(stylesSource, /\.agent-tab-list/, "child Agent tabs should use the shared product tab grammar");
assert.match(stylesSource, /\.agent-selected-timeline/, "the selected child timeline should have a stable reading surface");
assert.match(stylesSource, /\.request-rail\s*\{[\s\S]*?position:\s*sticky/, "request navigation should live in the main reading flow instead of a second floating side rail");
assert.match(stylesSource, /@keyframes request-signal-breathe/, "request navigation should identify the active position with restrained breathing motion");
assert.match(stylesSource, /\.request-line\s*\{[\s\S]*?transform-origin:\s*top center;/, "request marks should grow down from a fixed top edge");
assert.match(stylesSource, /\.request-line\s*\{[\s\S]*?transition:\s*transform /, "request ripples should animate without changing layout height");
assert.doesNotMatch(stylesSource, /\.request-line\s*\{[\s\S]*?transition:\s*height /, "request ripples should not grow in both directions through height animation");
assert.match(requestRailSource, /hoverClassForDistance/, "request navigation should share the Turn rail ripple grammar");
assert.doesNotMatch(stylesSource, /\.request-rail-track::before/, "request navigation should not add a baseline behind the fixed marks");
assert.match(requestRailSource, /this\.showTooltip\(button\.dataset\.request, button\)/, "request tooltip positioning should be owned by the rail controller");
assert.match(stylesSource, /--tooltip-bg:/, "request tooltip background should use an explicit theme token");
assert.match(stylesSource, /\.raw-message-truncation/, "organized Messages truncation notice should be styled");
assert.match(stylesSource, /container-name:\s*trace-main/, "the main pane should expose its own responsive container");
assert.match(stylesSource, /@container trace-main \(max-width: 720px\)/, "the topbar should adapt to the actual main-pane width");

console.log("timeline window smoke passed");
