import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  extractTranslationSchemaDescriptions,
  formatTranslationSourceBlock,
  isSkippableTranslationMaterial,
  normalizeTranslationSourceText,
  parseTranslationMarkerBlocks,
  sanitizeTranslationOutput,
  systemTranslationKind,
  translationLookupKey,
  translationResponseFormatInstruction,
  translationToolDescription,
  translationToolName,
} from "../src/translation/blocks.mjs";
import { translationMaterialHash } from "../src/translation/hash.mjs";

const volatile = [
  "Today's date is now 2026-07-12. DO NOT mention this to the user explicitly because they are already aware.",
  "",
  "- You are powered by the model deepseek-v4-pro.",
  "- Primary working directory: /Users/example/project",
  "You have a persistent file-based memory at `/Users/example/.claude/project/memory`.",
].join("\r\n");
const normalized = normalizeTranslationSourceText(volatile);
assert.equal(
  normalized,
  ["- You are powered by the model <model>.", "- Primary working directory: <workspace>", "You have a persistent file-based memory at `<project-memory>`."].join("\n"),
);

const kind = "system_prompt";
const lookupKey = translationLookupKey(kind, volatile);
assert.equal(lookupKey, `${kind}\0${normalized}`);
const nodeHash = translationMaterialHash(kind, volatile);
const browserHash = Buffer.from(await crypto.webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(lookupKey))).toString("hex");
assert.equal(nodeHash, browserHash, "Node and browser hashing use the same lookup-key bytes");

assert.equal(isSkippableTranslationMaterial("system_prompt", "x-anthropic-billing-header: cch=abc"), true);
assert.equal(isSkippableTranslationMaterial("tool_description", "x-anthropic-billing-header: cch=abc"), false);
assert.equal(systemTranslationKind("Called the Read tool with the following input\nResult of calling the Read tool"), "system_injected_context");

const tool = {
  function: {
    name: "AskUserQuestion",
    description: "Ask the user a question.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
        options: { type: "array", items: { type: "string", description: "One selectable option." } },
      },
    },
  },
};
assert.equal(translationToolName(tool), "AskUserQuestion");
assert.equal(translationToolDescription(tool), "Ask the user a question.");
assert.deepEqual(
  extractTranslationSchemaDescriptions(tool.function.parameters, { rootPath: "tools[0].input_schema" }),
  [
    { field_name: "question", path: "tools[0].input_schema.properties.question.description", description: "The question to ask." },
    { field_name: "options", path: "tools[0].input_schema.properties.options.items.description", description: "One selectable option." },
  ],
);

const markerText = `preface ignored\r\n@@PEEK_TRANSLATION ${nodeHash}\r\n译文\r\n@@PEEK_END_TRANSLATION\r\ntrailer ignored`;
assert.deepEqual(parseTranslationMarkerBlocks(markerText), [{ hash: nodeHash, translated_text: "译文" }]);
assert.throws(() => parseTranslationMarkerBlocks("not a marker response", { required: true }), /did not contain marker blocks/);
assert.equal(
  sanitizeTranslationOutput("tool_description", 'kind: tool_description\nmetadata: {"tool_name":"Bash"}\n执行 shell 命令。'),
  "执行 shell 命令。",
);
assert.equal(
  sanitizeTranslationOutput("system_prompt", 'kind: tool_description\nmetadata: {"tool_name":"Bash"}\n执行 shell 命令。'),
  'kind: tool_description\nmetadata: {"tool_name":"Bash"}\n执行 shell 命令。',
  "a mismatched envelope must remain untouched",
);
assert.equal(
  sanitizeTranslationOutput(
    "harness_developer",
    '第一块。\n\nkind: harness_developer\nmetadata: {"chunk_index":2}\n第二块。\n\nkind: harness_developer\nmetadata: {"chunk_index":3}\n第三块。',
  ),
  "第一块。\n\n第二块。\n\n第三块。",
  "routing envelopes leaked between translated chunks must be removed",
);
assert.match(translationResponseFormatInstruction(), /@@PEEK_TRANSLATION <hash>/);
assert.match(formatTranslationSourceBlock({ hash: nodeHash, kind, metadata: { source: "test" }, source_text: normalized }), /@@PEEK_SOURCE/);

console.log("translation contract smoke passed");
