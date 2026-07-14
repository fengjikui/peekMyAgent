#!/usr/bin/env node
import assert from "node:assert/strict";
import { TranslationActionController } from "../src/viewer/translation-action-controller.js";
import {
  translationActionMaterials,
  translationBlockClipboardText,
  translationSectionClipboardText,
} from "../src/viewer/translation-action-model.js";

testClipboardModel();
await testSectionGeneration();
await testStaleGenerationCannotCommit();
await testGroupedRetranslationAndActionRegistry();

console.log("translation action model and controller contract smoke passed");

function testClipboardModel() {
  const materials = toolMaterials();
  const dependencies = {
    translatedTextFor(kind, sourceText) {
      return `${kind}:${sourceText}:translated`;
    },
    labelForKind(kind) {
      return `kind-${kind}`;
    },
    translate,
  };
  const block = translationBlockClipboardText(
    { ...materials[0], sourceText: materials[0].source_text, metadata: { label: "Bash · description" } },
    dependencies,
  );
  assert.match(block, /^## Bash · description  \[tool_description\]/);
  assert.match(block, /Source:\nRun shell commands/);
  assert.match(block, /Translation:\ntool_description:Run shell commands:translated/);

  const section = translationSectionClipboardText(
    {
      section: "tools",
      request: { request_index: 7 },
      materials,
      sectionLabel: "Tools",
    },
    dependencies,
  );
  assert.match(section, /^# Tools · Request 7/m);
  assert.match(section, /^## Tool: Bash$/m, "copy-all output must identify the tool before its descriptions");
  assert.match(section, /^### Parameter: command$/m);
  assert.deepEqual(translationActionMaterials({ kind: "system_prompt", sourceText: "system", metadata: { index: 0 } }), [
    { kind: "system_prompt", source_text: "system", metadata: { index: 0 } },
  ]);
}

async function testSectionGeneration() {
  const fixture = createControllerFixture();
  const outcome = await fixture.controller.generateSection("tools");

  assert.equal(outcome.status, "completed");
  assert.deepEqual(fixture.calls.details, ["request-1"]);
  assert.equal(fixture.calls.generate.length, 1);
  assert.deepEqual(fixture.calls.generate[0], {
    agent: "Claude Code",
    source_id: "source-1",
    request_id: "request-1",
    section: "tools",
    force: true,
    target_language: "zh-CN",
  });
  assert.equal(fixture.calls.reloads, 1);
  assert.deepEqual(fixture.calls.modes, [{ mode: "zh-CN", reason: "translation-generated" }]);
  assert.equal(fixture.generationState.loading, false);
  assert.match(fixture.generationState.message, /^translationSectionCompletedWithTranslated/);
  assert.deepEqual(
    fixture.calls.rawRenders,
    [
      ["request-1", "tools", "request"],
      ["request-1", "tools", "request"],
    ],
    "the active raw section is rendered while starting and after the current operation commits",
  );
}

async function testStaleGenerationCannotCommit() {
  const provider = deferred();
  const fixture = createControllerFixture({ generate: () => provider.promise });
  const running = fixture.controller.generateSection("system");
  await Promise.resolve();
  await Promise.resolve();
  fixture.context.sourceId = "source-2";
  provider.resolve({ translate: { translated: 1, remaining: 0 } });
  const outcome = await running;

  assert.equal(outcome.status, "stale");
  assert.equal(outcome.stage, "generate");
  assert.equal(fixture.calls.reloads, 0, "a provider result from the previous Source must not refresh the new cache");
  assert.deepEqual(fixture.calls.modes, [], "a stale result must not switch the current translation mode");
  assert.deepEqual(fixture.generationState, { loading: false, error: "", message: "" });
}

async function testGroupedRetranslationAndActionRegistry() {
  const fixture = createControllerFixture();
  const rawAction = fixture.controller.registerAction({
    kind: "tool_description",
    sourceText: "Run shell commands",
    section: "tools",
    surface: "raw",
    metadata: { label: "Bash · description" },
  });
  const timelineAction = fixture.controller.registerAction({
    kind: "tool_parameter_description",
    sourceText: "",
    section: "tools",
    surface: "timeline",
    materials: toolMaterials(),
  });

  assert.equal(fixture.controller.copyBlock(rawAction, "copy-button"), true);
  assert.equal(fixture.calls.copies.length, 1);
  assert.equal(fixture.calls.copies[0].target, "copy-button");
  assert.match(fixture.calls.copies[0].text, /Bash · description/);
  assert.equal(fixture.controller.copySection("tools", "copy-all-button"), true);
  assert.match(fixture.calls.copies[1].text, /^## Tool: Bash$/m);

  fixture.controller.clearActions("raw");
  assert.equal(fixture.controller.copyBlock(rawAction), false, "surface clearing removes only matching actions");
  const outcome = await fixture.controller.retranslate(timelineAction);
  assert.equal(outcome.status, "completed");
  assert.equal(fixture.calls.generate.at(-1).materials.length, 2, "parameter/tool groups are sent in one provider request");
  assert.equal(fixture.calls.timelineRenders, 1);
  assert.deepEqual(fixture.calls.modes.at(-1), { mode: "zh-CN", reason: "translation-block-generated" });
  assert.match(fixture.generationState.message, /^retranslatedParametersDone/);

  fixture.controller.clearActions();
  const resetAction = fixture.controller.registerAction({ kind: "system_prompt", sourceText: "system" });
  assert.equal(resetAction, "1", "clearing all actions resets stable render-local action ids");
}

function createControllerFixture({ generate = null } = {}) {
  const context = {
    sourceId: "source-1",
    targetLanguage: "zh-CN",
    targetLanguageLabel: "中文（简体）",
    agent: "Claude Code",
    activeSection: "tools",
    requestId: "request-1",
    rawMode: "request",
  };
  let generationState = { loading: false, error: "", message: "" };
  let cacheRevision = 1;
  const requests = new Map([["request-1", { id: "request-1", request_index: 7 }]]);
  const calls = {
    details: [],
    generate: [],
    reloads: 0,
    modes: [],
    rawRenders: [],
    timelineRenders: 0,
    copies: [],
    warnings: [],
  };
  const controller = new TranslationActionController({
    getContext: () => context,
    getGenerationState: () => generationState,
    setGenerationState: (next) => {
      generationState = next;
    },
    cache: {
      captureOperation: ({ sourceId, targetLanguage, agent }) => ({ sourceId, targetLanguage, agent, revision: cacheRevision }),
      isOperationCurrent: (operation) => operation.revision === cacheRevision,
      reload: async () => {
        calls.reloads += 1;
      },
      isAvailable: () => true,
    },
    data: {
      ensureRequestDetail: async (requestId) => {
        calls.details.push(requestId);
      },
      requestFor: (requestId) => requests.get(requestId) || null,
      sectionMaterials: (_request, section) => (section === "tools" ? toolMaterials() : []),
      sectionStats: () => ({ total: 2, hit: 2, missing: 0 }),
    },
    api: {
      generateTranslations: async (payload) => {
        calls.generate.push(payload);
        if (generate) return generate(payload);
        return { translate: { translated: 2, remaining: 0 } };
      },
    },
    ui: {
      translate,
      translatedTextFor: (kind, sourceText) => `${kind}:${sourceText}:translated`,
      labelForKind: (kind) => kind,
      sectionLabel: (section) => (section === "tools" ? "Tools" : section),
      copyText: (text, target) => calls.copies.push({ text, target }),
      renderRaw: (requestId, section, mode) => calls.rawRenders.push([requestId, section, mode]),
      renderTimeline: () => {
        calls.timelineRenders += 1;
      },
      setTranslationMode: (mode, options) => calls.modes.push({ mode, reason: options.reason }),
      warn: (message, error) => calls.warnings.push([message, error?.message]),
    },
  });
  return {
    controller,
    context,
    calls,
    get generationState() {
      return generationState;
    },
    invalidateCache() {
      cacheRevision += 1;
    },
  };
}

function toolMaterials() {
  return [
    {
      kind: "tool_description",
      source_text: "Run shell commands",
      metadata: { tool_name: "Bash" },
    },
    {
      kind: "tool_parameter_description",
      source_text: "Command to run",
      metadata: { tool_name: "Bash", field_name: "command" },
    },
  ];
}

function translate(key, vars = {}) {
  const labels = {
    sourceLabel: "Source",
    translationLabel: "Translation",
    requestClipboardTitle: "Request {index}",
    toolClipboardHeading: "Tool",
    toolDescription: "Tool description",
    parameterClipboardHeading: "Parameter: {name}",
  };
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    labels[key] || `${key}${Object.keys(vars).length ? ` ${JSON.stringify(vars)}` : ""}`,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
