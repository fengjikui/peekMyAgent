#!/usr/bin/env node
import assert from "node:assert/strict";
import { TranslationMaterialCollector, countTranslationMaterialsByKind } from "../src/translation/materials.mjs";

const source = { id: "source-a", workspace: "/workspace", conversation_id: "conversation-a" };
const first = request(1, "deepseek-v4-pro", "/workspace/a");
const second = request(2, "claude-sonnet", "/workspace/b");
const collector = createCollector();
collector.collectRequest(first, source).collectRequest(second, source);
const materials = collector.materials();
const counts = countTranslationMaterialsByKind(materials);

assert.equal(counts.system_prompt, 2, "volatile model/workspace lines normalize into one block while message.system remains separate");
assert.equal(counts.tool_description, 1);
assert.equal(counts.tool_parameter_description, 2);
assert.equal(counts.harness_reminder, 1);
assert.equal(materials.some((item) => item.source_text.startsWith("x-anthropic-billing-header")), false, "billing header is not translation material");

const normalizedSystem = materials.find((item) => item.kind === "system_prompt" && item.source_text.includes("<model>"));
assert.ok(normalizedSystem);
assert.match(normalizedSystem.source_text, /Primary working directory: <workspace>/);
assert.equal(normalizedSystem.occurrence_count, 2, "same normalized system block keeps both request occurrences");
assert.deepEqual(normalizedSystem.occurrences.map((item) => item.request_index), [1, 2]);

const toolDescription = materials.find((item) => item.kind === "tool_description");
assert.equal(toolDescription.metadata.tool_name, "Read");
assert.equal(toolDescription.occurrence_count, 2);
const parameterNames = materials.filter((item) => item.kind === "tool_parameter_description").map((item) => item.metadata.field_name).sort();
assert.deepEqual(parameterNames, ["encoding", "file_path"]);

const toolOnly = createCollector();
toolOnly.collectRequest(first, source, { section: "tools" });
assert.deepEqual([...new Set(toolOnly.materials().map((item) => item.kind))].sort(), ["tool_description", "tool_parameter_description"]);

const manual = createCollector();
manual.collectInput(
  [
    {
      kind: "thinking",
      source_text: "Translate this reasoning block.",
      metadata: { label: "line\u0000 break", nested: { keep: "yes", dropped_by_depth: { child: "no" } } },
    },
  ],
  { source_id: "manual", request_id: "request-manual" },
);
const manualMaterial = manual.materials()[0];
assert.equal(manualMaterial.metadata.label, "line break");
assert.deepEqual(manualMaterial.metadata.nested, { keep: "yes", dropped_by_depth: {} });

const limited = createCollector({ materials: 1, blockChars: 1000, totalChars: 1000 });
limited.collectInput(
  [
    { kind: "manual_a", source_text: "first block" },
    { kind: "manual_b", source_text: "second block" },
  ],
  {},
);
assert.throws(() => limited.materials(), (error) => error.statusCode === 413 && /count is too large/.test(error.message));

console.log("translation materials contract smoke passed");

function createCollector(limits = undefined) {
  return new TranslationMaterialCollector({
    targetLanguage: "zh-CN",
    contentText,
    extractHarnessParts(messages) {
      const output = [];
      for (const [index, message] of messages.entries()) {
        const match = String(contentText(message.content)).match(/<system-reminder>([\s\S]*?)<\/system-reminder>/);
        if (match) output.push({ kind: "harness_reminder", text: match[1], label: "Framework reminder", path: `messages[${index}]` });
      }
      return output;
    },
    tooLarge(message) {
      return Object.assign(new Error(message), { statusCode: 413 });
    },
    limits,
  });
}

function request(index, model, workspace) {
  return {
    id: `request-${index}`,
    request_index: index,
    watch_id: "watch-a",
    workspace,
    conversation_id: "conversation-a",
    raw: {
      body: {
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=1" },
          { type: "text", text: `- You are powered by the model ${model}.\n- Primary working directory: ${workspace}` },
        ],
        messages: [
          { role: "system", content: "Always return concise evidence." },
          { role: "user", content: "<system-reminder>Use repository evidence.</system-reminder>\nInspect the project." },
        ],
        tools: [
          {
            name: "Read",
            description: "Read a file from the workspace.",
            input_schema: {
              type: "object",
              properties: {
                file_path: { type: "string", description: "Absolute path to the file." },
                options: {
                  type: "object",
                  properties: { encoding: { type: "string", description: "Text encoding used to read the file." } },
                },
              },
            },
          },
        ],
      },
    },
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  if (content?.text) return content.text;
  if (content?.content) return contentText(content.content);
  return "";
}
