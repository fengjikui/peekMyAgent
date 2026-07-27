#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildTranslationSectionView,
  filterToolTranslationGroups,
  filterToolTranslationGroupsByName,
  groupToolTranslationMaterials,
  responseInvokedToolNames,
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
assert.deepEqual(filterToolTranslationGroupsByName(groups, new Set(["Bash"])).map((group) => group.toolName), ["Bash"]);
assert.deepEqual(
  responseInvokedToolNames({
    tool_calls: [
      { name: "Bash" },
      { function: { name: "Read" } },
      { tool_name: "Bash" },
    ],
  }),
  ["Bash", "Read"],
);
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
assert.equal(toolsView.groups[0].materials[1].metadata.field_name, "prompt");
assert.equal(toolsView.groups[0].hit, 2);

const invokedToolsView = buildTranslationSectionView({
  section: "tools",
  materials,
  toolNames: new Set(["Bash"]),
  displaySource: true,
  translatedTextFor,
  labelForKind: (kind) => `kind:${kind}`,
});
assert.deepEqual(invokedToolsView.groups.map((group) => group.toolName), ["Bash"]);
assert.equal(invokedToolsView.totalGroups, 2);
assert.equal(invokedToolsView.scopedGroups, 1);
assert.equal(invokedToolsView.groups[0].description.displayText, "Run a shell command.");

const unavailableInvokedToolsView = buildTranslationSectionView({
  section: "tools",
  materials,
  toolNames: new Set(["spawn_agent"]),
  translatedTextFor,
});
assert.equal(unavailableInvokedToolsView.totalGroups, 2);
assert.equal(unavailableInvokedToolsView.scopedGroups, 0);
assert.deepEqual(unavailableInvokedToolsView.groups, []);

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
  toolFilter: { available: true, mode: "all", invoked: 1, total: 2 },
  translate,
  escapeHtml,
});
assert.match(toolbar, /2\/3 cached zh-CN/);
assert.match(toolbar, /class="active" data-translation-mode="zh-CN"/);
assert.match(toolbar, /data-translation-copy-all="tools"/);
assert.match(toolbar, /data-tools-schema-filter="invoked"/);
assert.match(renderTranslationControls({
  section: "developer",
  stats: { total: 1, hit: 0, missing: 1 },
  cacheAvailable: false,
  generating: false,
  targetLanguage: "zh-CN",
  languageLabel: "中文",
  translationMode: "source",
  sectionLabel: "Developer",
  translate,
  escapeHtml,
}), /data-translation-section="developer"/);
assert.match(renderTranslationControls({
  section: "response",
  stats: { total: 2, hit: 1, missing: 1 },
  cacheAvailable: true,
  generating: false,
  targetLanguage: "zh-CN",
  languageLabel: "中文",
  translationMode: "zh-CN",
  sectionLabel: "Response",
  translate,
  escapeHtml,
}), /data-translation-section="response"/);

const toolsHtml = renderTranslationSection({ view: toolsView, emptyText: "empty", ...dependencies });
assert.match(toolsHtml, /tool-translation-group/);
assert.match(toolsHtml, /data-raw-search-target="true"/);
assert.match(toolsHtml, /启动一个专注的子 Agent。/);
assert.doesNotMatch(toolsHtml, /Agent · description/);
assert.match(toolsHtml, /data-translation-retranslate="action-1"/);
assert.match(toolsHtml, /tool-translation-description/);
assert.match(toolsHtml, /tool-translation-parameters/);
assert.equal((toolsHtml.match(/<details class="tool-translation-source">/g) || []).length, 1);
assert.doesNotMatch(toolsHtml, /parameter-summary/);
assert.equal(actionDescriptors.length, 1);
assert.equal(actionDescriptors[0].metadata.label, "Agent");
assert.equal(actionDescriptors[0].metadata.group, "tool");
assert.equal(actionDescriptors[0].materials.length, 2);
assert.equal(actionDescriptors[0].materials[1].metadata.field_name, "prompt");

const sourceToolsHtml = renderTranslationSection({ view: invokedToolsView, emptyText: "empty", ...dependencies });
assert.match(sourceToolsHtml, /Run a shell command\./);
assert.doesNotMatch(sourceToolsHtml, /tool-translation-source/);

const namespaceMaterials = [
  {
    kind: "tool_description",
    source_text: "Send a follow-up task.",
    metadata: {
      tool_name: "collaboration.followup_task",
      tool_leaf_name: "followup_task",
      tool_namespace: "collaboration",
      tool_namespace_tool_count: 2,
    },
  },
  {
    kind: "tool_parameter_description",
    source_text: "Target agent.",
    metadata: {
      tool_name: "collaboration.followup_task",
      tool_leaf_name: "followup_task",
      tool_namespace: "collaboration",
      tool_namespace_tool_count: 2,
      field_name: "target",
    },
  },
  {
    kind: "tool_description",
    source_text: "Send a message.",
    metadata: {
      tool_name: "collaboration.send_message",
      tool_leaf_name: "send_message",
      tool_namespace: "collaboration",
      tool_namespace_tool_count: 2,
    },
  },
];
const namespaceView = buildTranslationSectionView({
  section: "tools",
  materials: namespaceMaterials,
  translatedTextFor: () => "",
  labelForKind: (kind) => kind,
});
assert.deepEqual(namespaceView.groups.map((group) => group.toolName), [
  "collaboration.followup_task",
  "collaboration.send_message",
]);
assert.deepEqual(namespaceView.groups.map((group) => group.toolDisplayName), ["followup_task", "send_message"]);
assert.equal(namespaceView.groups[0].namespace, "collaboration");
assert.deepEqual(
  filterToolTranslationGroupsByName(groupToolTranslationMaterials(namespaceMaterials), new Set(["followup_task"]))
    .map((group) => group.toolName),
  ["collaboration.followup_task"],
  "response tool names can select a qualified namespace leaf by its callable name",
);
const namespaceActions = [];
const namespaceHtml = renderTranslationSection({
  view: namespaceView,
  emptyText: "empty",
  ...dependencies,
  registerAction: (descriptor) => {
    namespaceActions.push(descriptor);
    return `namespace-action-${namespaceActions.length}`;
  },
});
assert.equal((namespaceHtml.match(/class="tool-translation-group"/g) || []).length, 2);
assert.match(namespaceHtml, /collaboration ·/);
assert.match(namespaceHtml, />followup_task<\/strong>/);
assert.match(namespaceHtml, />send_message<\/strong>/);
assert.doesNotMatch(namespaceHtml, />collaboration\.followup_task<\/strong>/);
assert.equal(namespaceActions[0].metadata.tool_name, "collaboration.followup_task");

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
