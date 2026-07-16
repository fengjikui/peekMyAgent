#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  createViewerTranslationAdapter,
  extractHarnessTranslationParts,
} from "../src/server/viewer-translation-adapter.mjs";

const compactPrompt = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Your task is to create a detailed summary of the conversation so far.",
  "Wrap your analysis in <analysis> tags then provide a <summary> block.",
].join("\n\n");

const harnessMessages = [
  { role: "user", content: "<system-reminder>Deferred tools are now available.</system-reminder>" },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }, { type: "text", text: compactPrompt }] },
  { role: "user", content: "<command-name>/init</command-name>\n<command-message>init</command-message>\nInspect this project and create AGENTS.md." },
  { role: "user", content: "[SUGGESTION MODE: suggest the next user action]" },
  { role: "user", content: "<task-notification><task-id>task-1</task-id><result>Background result</result></task-notification>" },
];

const harnessParts = extractHarnessTranslationParts(harnessMessages);
assert.deepEqual(
  [...new Set(harnessParts.map((part) => part.kind))].sort(),
  ["harness_command", "harness_compact", "harness_reminder", "harness_suggestion"],
  "adapter recognizes the four supported Harness prompt families",
);
assert.equal(harnessParts.some((part) => part.text.includes("Background result")), false, "task notifications are not translation prompts");

const source = { id: "source-a", workspace: "/tmp/workspace", conversation_id: "conversation-a" };
const requests = [
  {
    id: "request-system",
    request_index: 0,
    watch_id: "watch-a",
    raw: {
      body: {
        system: [{ type: "text", text: "You are a coding agent." }],
        tools: [],
        messages: [],
      },
    },
  },
  {
    id: "request-tools",
    request_index: 1,
    watch_id: "watch-a",
    raw: {
      body: {
        tools: [
          {
            name: "Read",
            description: "Read one file from disk.",
            input_schema: {
              type: "object",
              properties: { file_path: { type: "string", description: "Absolute path to the file." } },
            },
          },
        ],
        messages: harnessMessages,
      },
    },
  },
];

const calls = [];
let serviceOptions;
const adapter = createViewerTranslationAdapter({
  projectRoot: process.cwd(),
  loadViewerData(input) {
    calls.push({ operation: "loadViewerData", input });
    return { source, requests };
  },
  loadRequestDetail(input) {
    calls.push({ operation: "loadRequestDetail", input });
    return { source, request: requests.find((request) => request.id === input.requestId) };
  },
  sanitize: {
    agent: String,
    targetLanguage: String,
    sourceId: String,
    section: String,
    requestId: String,
  },
  slugify: (value) => String(value || "agent").toLowerCase().replace(/\s+/g, "-"),
  serviceFactory(options) {
    serviceOptions = options;
    return {
      loadPublicCache(input) {
        return { operation: "cache", input };
      },
      generate(input) {
        return { operation: "generate", input };
      },
    };
  },
});

assert.equal(typeof serviceOptions.materialProvider.fromSource, "function", "adapter supplies the TranslationService material-provider port");
assert.deepEqual(adapter.loadPublicCache({ agent: "Claude Code" }), { operation: "cache", input: { agent: "Claude Code" } });
assert.deepEqual(adapter.generate({ section: "tools" }), { operation: "generate", input: { section: "tools" } });

const sourceMaterials = adapter.collectFromSource({ sourceId: source.id, section: "tools", targetLanguage: "ja-JP" });
assert.equal(calls[0].operation, "loadViewerData", "source refresh reads the source projection");
assert.deepEqual(calls[0].input, { sourceId: source.id, requireSource: true });
assert.equal(sourceMaterials.sourceCount, 1);
assert.deepEqual(sourceMaterials.materials.map((item) => item.kind), ["tool_description", "tool_parameter_description"]);
assert.ok(sourceMaterials.materials.every((item) => item.target_language === "ja-JP"));
assert.ok(sourceMaterials.materials.every((item) => item.occurrences[0].source_id === source.id));

calls.length = 0;
const requestMaterials = adapter.collectFromSource({
  sourceId: source.id,
  requestId: "request-tools",
  section: "harness",
  targetLanguage: "zh-CN",
});
assert.equal(calls.length, 1, "request refresh does not fall back to a full-source read");
assert.equal(calls[0].operation, "loadRequestDetail");
assert.deepEqual(calls[0].input, { sourceId: source.id, requestId: "request-tools", requireSource: true });
assert.deepEqual(
  [...new Set(requestMaterials.materials.map((item) => item.kind))].sort(),
  ["harness_command", "harness_compact", "harness_reminder", "harness_suggestion"],
);

const inputMaterials = adapter.collectFromInput({
  materials: [{ kind: "thinking", source_text: "Reason about the task." }],
  sourceId: "source-manual",
  requestId: "request-manual",
  targetLanguage: "fr",
});
assert.equal(inputMaterials.sourceCount, 1);
assert.equal(inputMaterials.materials[0].kind, "thinking");
assert.equal(inputMaterials.materials[0].target_language, "fr");
assert.equal(inputMaterials.materials[0].occurrences[0].request_id, "request-manual");

assert.throws(
  () => createViewerTranslationAdapter({ loadViewerData() {}, loadRequestDetail: null }),
  /loadRequestDetail is required/,
  "adapter rejects an incomplete Viewer data port",
);

console.log("viewer translation adapter contract smoke passed");
