import fs from "node:fs";
import assert from "node:assert/strict";

const clientSource = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");
const markdownSource = fs.readFileSync(new URL("../src/viewer/markdown.js", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../src/viewer/styles.css", import.meta.url), "utf8");

assert.match(clientSource, /const TIMELINE_WINDOW_THRESHOLD = 180;/, "timeline window threshold should be explicit");
assert.match(clientSource, /const TIMELINE_WINDOW_SIZE = 120;/, "timeline window size should be explicit");
assert.match(clientSource, /const AGENT_BRANCH_PAGE_SIZE = 24;/, "large multi-agent views should page branches");
assert.match(clientSource, /const AGENT_EVENT_LIMIT = 80;/, "large multi-agent views should cap the initial event strip");
assert.match(clientSource, /function timelineWindowInfo\(turns, requests\)/, "timelineWindowInfo should exist");
assert.match(clientSource, /els\.timeline\.innerHTML = requests\.length \? renderTurnTimeline\(turnWindow, requests\)/, "main timeline should render the computed window");
assert.match(clientSource, /return baseTurnList\(turns, requests\);/, "turn rail universe should keep the full turn list");
assert.match(clientSource, /data-turn-window-jump/, "window edge jump controls should be wired");
assert.match(clientSource, /function jumpToTurn\(turnId, scroll = true\)/, "turn rail jumps should re-render the active window");
assert.match(clientSource, /const RAW_MESSAGE_MARKDOWN_INLINE_CHARS = 5000;/, "organized Messages view should cap markdown rendering");
assert.match(clientSource, /function truncateOrganizedMessageText\(text\)/, "organized Messages truncation helper should exist");
assert.match(clientSource, /function displaySourceLabel\(label\)[\s\S]*?Write the title in/, "source labels should hide appended title-generation instructions");
assert.match(clientSource, /renderSafeMarkdown\(markdownText\.text\)/, "organized Messages should render the truncated markdown text");
assert.match(markdownSource, /export function renderSafeMarkdown\(text\)/, "safe markdown renderer should be testable as a module");
assert.match(clientSource, /messageTextTruncated/, "organized Messages truncation should be visible to users");
assert.match(clientSource, /state\.openSupportingTimelines\.has\(turnId\)/, "supporting timelines should only render after they are opened");
assert.match(clientSource, /const dashboardBody = dashboardOpen/, "multi-agent dashboard details should only render after opening");
assert.match(clientSource, /collapsed\s*\?\s*""\s*:\s*`<div class="agent-branch-body">/, "collapsed subagent branches should not render hidden detail DOM");
assert.match(clientSource, /events\.slice\(0, AGENT_EVENT_LIMIT\)/, "agent event rendering should obey the explicit cap");
assert.match(stylesSource, /\.timeline-window-edge-card/, "window edge UI should be styled");
assert.match(stylesSource, /\.raw-message-truncation/, "organized Messages truncation notice should be styled");

console.log("timeline window smoke passed");
