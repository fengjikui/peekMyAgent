#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildTranslationSectionView,
  filterToolTranslationGroups,
  groupToolTranslationMaterials,
  translationBlockView,
  translationKindClass,
  translationMaterialMatchesQuery,
  translationSectionStats,
} from "../src/viewer/translation-view-model.js";
import {
  renderTranslationBlock,
  renderTranslationControls,
  renderTranslationSection,
} from "../src/viewer/translation-renderer.js";

const materials = [
  {
    kind: "tool_description",
    source_text: "Start a focused subagent.",
    metadata: { tool_name: "Agent", path: "tools[0].description" },
  },
  {
    kind: "tool_parameter_description",
    source_text: "Task prompt for the subagent.",
    metadata: { tool_name: "Agent", field_name: "prompt", path: "tools[0].input_schema.properties.prompt.description" },
  },
  {
    kind: "tool_description",
    source_text: "Run a shell command.",
    metadata: { tool_name: "Bash", path: "tools[1].description" },
  },
];
const translations = new Map([
  ["Start a focused subagent.", "启动一个专注的子 Agent。"],
  ["Task prompt for the subagent.", "子 Agent 的任务提示。"],
]);
const translatedTextFor = (_kind, sourceText) => translations.get(sourceText) || "";

const groups = groupToolTranslationMaterials(materials);
assert.deepEqual(groups.map((group) => group.toolName), ["Agent", "Bash"]);
assert.equal(groups[0].description.source_text, "Start a focused subagent.");
assert.equal(groups[0].parameters.length, 1);
assert.equal(translationMaterialMatchesQuery(materials[0], { query: "启动", translatedTextFor }), true);
assert.equal(translationMaterialMatchesQuery(materials[2], { query: "agent", translatedTextFor }), false);
assert.deepEqual(filterToolTranslationGroups(groups, { query: "Agent", translatedTextFor }).map((group) => group.toolName), ["Agent"]);
assert.deepEqual(filterToolTranslationGroups(groups, { query: "任务提示", translatedTextFor }).map((group) => group.toolName), ["Agent"]);
assert.deepEqual(translationSectionStats(materials, { translatedTextFor }), { total: 3, hit: 2, missing: 1 });
assert.equal(translationKindClass("harness_reminder"), "harness-kind");

const toolsView = buildTranslationSectionView({
  section: "tools",
  materials,
  query: "Agent",
  translatedTextFor,
  labelForKind: (kind) => `kind:${kind}`,
});
assert.equal(toolsView.type, "tools");
assert.equal(toolsView.totalMaterials, 3);
assert.equal(toolsView.searchMatchCount, 1);
assert.equal(toolsView.groups[0].description.kindLabel, "kind:tool_description");
assert.equal(toolsView.groups[0].parameters.hit, 1);
assert.equal(toolsView.groups[0].parameters.materials[0].metadata.field_name, "prompt");

const systemView = buildTranslationSectionView({
  section: "system",
  materials: [{ kind: "system_prompt", source_text: "You are Claude.", metadata: { source: "body.system", index: 2 } }],
  translatedTextFor: () => "你是 Claude。",
  labelForKind: () => "System",
});
assert.equal(systemView.items[0].label, "body.system #3");
assert.equal(systemView.items[0].displayText, "你是 Claude。");

const block = translationBlockView({
  material: { kind: "system_prompt", source_text: "<unsafe>", metadata: {} },
  label: '<script>alert("x")</script>',
  labelForKind: () => "System",
});
assert.equal(block.hit, false);
assert.equal(block.kindLabel, "System");

const translate = (key, values = {}) => {
  if (key === "translationCacheHit") return `${values.hit}/${values.total} cached ${values.language}`;
  if (key === "parameterCount") return `${values.count} parameters`;
  if (key === "cacheState") return `${values.language} cache`;
  return key;
};
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const actionDescriptors = [];
const dependencies = {
  generating: false,
  targetLanguageLabel: "中文",
  translate,
  escapeHtml,
  renderMarkdown: (text) => `<md>${escapeHtml(text)}</md>`,
  renderPre: (text) => `<pre>${escapeHtml(text)}</pre>`,
  registerAction: (descriptor) => {
    actionDescriptors.push(descriptor);
    return `action-${actionDescriptors.length}`;
  },
};

const toolbar = renderTranslationControls({
  section: "tools",
  stats: { total: 3, hit: 2, missing: 1 },
  cacheAvailable: true,
  cacheTargetLanguage: "zh-CN",
  generating: false,
  targetLanguage: "zh-CN",
  languageLabel: "中文",
  translationMode: "zh-CN",
  sectionLabel: "Tools",
  translate,
  escapeHtml,
});
assert.match(toolbar, /2\/3 cached zh-CN/);
assert.match(toolbar, /class="active" data-translation-mode="zh-CN"/);
assert.match(toolbar, /data-translation-copy-all="tools"/);

const toolsHtml = renderTranslationSection({ view: toolsView, emptyText: "empty", ...dependencies });
assert.match(toolsHtml, /tool-translation-group/);
assert.match(toolsHtml, /data-raw-search-target="true"/);
assert.match(toolsHtml, /启动一个专注的子 Agent。/);
assert.doesNotMatch(toolsHtml, /Agent · description/);
assert.match(toolsHtml, /data-translation-retranslate="action-2"/);
assert.equal(actionDescriptors.length, 2);
assert.equal(actionDescriptors[0].metadata.label, "Agent");
assert.equal(actionDescriptors[1].materials.length, 1);
assert.equal(actionDescriptors[1].materials[0].metadata.field_name, "prompt");

const unsafeHtml = renderTranslationBlock({ block, ...dependencies });
assert.doesNotMatch(unsafeHtml, /<script>/);
assert.match(unsafeHtml, /&lt;script&gt;/);
assert.match(unsafeHtml, /&lt;unsafe&gt;/);

const emptyHtml = renderTranslationSection({
  view: { type: "list", items: [], query: "missing" },
  emptyText: 'No <match>',
  ...dependencies,
});
assert.match(emptyHtml, /No &lt;match&gt;/);

console.log("translation view model and renderer contract smoke passed");
