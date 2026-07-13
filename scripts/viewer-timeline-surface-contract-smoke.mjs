import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/viewer/client.js", import.meta.url), "utf8");

assert.match(source, /import \{[\s\S]*?buildTraceTimelineView,[\s\S]*?from "\.\/trace-timeline-model\.js";/);
assert.match(source, /function renderAll\(\) \{[\s\S]*?renderHeaderSurface\(\);[\s\S]*?renderTimelineSurface\(\{ updateViewControls: false \}\);[\s\S]*?renderComposerSurface\(\);/);
assert.match(source, /function renderTimelineSurface\([\s\S]*?clearTranslationActions\("timeline"\);[\s\S]*?bindTimelineEvents\(\);/);
assert.match(source, /function bindTimelineEvents\(\) \{[\s\S]*?els\.timeline\.querySelectorAll/);
assert.doesNotMatch(functionSource("bindTimelineEvents"), /document\.querySelectorAll/);

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

console.log("viewer timeline surface contract smoke passed");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}
