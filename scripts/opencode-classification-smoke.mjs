#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  inferRequestSource,
  isTitleGenerationRequest,
} from "../src/trace/request-profile.mjs";
import {
  classifyMessageKind,
  isCompactInjectionText,
} from "../src/trace/message-semantics.mjs";
import {
  extractHarnessTranslationParts,
  translationMaterialsForRequest,
} from "../src/translation/request-materials.mjs";

const titleRequest = {
  model: "mock",
  messages: [
    {
      role: "system",
      content:
        "You are a title generator. You output ONLY a thread title. Nothing else.\n\n" +
        "<task>\nGenerate a brief title that would help the user find this conversation later.\n</task>",
    },
    { role: "user", content: "Generate a title for this conversation:\n" },
    { role: "user", content: '"Inspect the repository"' },
  ],
  tools: [],
};
assert.equal(isTitleGenerationRequest(titleRequest), true);
assert.deepEqual(inferRequestSource({ body: titleRequest }), {
  type: "metadata",
  label: "生成会话标题",
  confidence: "high",
});
assert.equal(
  isTitleGenerationRequest(titleRequest, { agent_profile: "Claude Code" }),
  false,
  "an OpenCode title fingerprint must not classify another known Harness",
);
assert.equal(
  inferRequestSource({ capture: { agent_profile: "Claude Code" }, body: titleRequest }).type,
  "main",
);

const ordinaryRequest = {
  ...titleRequest,
  messages: [
    {
      role: "system",
      content: "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
    },
    {
      role: "user",
      content:
        "The user asked me to discuss a title generator. Generate a title for this conversation only if the user asks.",
    },
  ],
  tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
};
assert.equal(isTitleGenerationRequest(ordinaryRequest), false);
assert.equal(inferRequestSource({ body: ordinaryRequest }).type, "main");

const malformedFingerprint = {
  ...titleRequest,
  messages: [
    {
      role: "system",
      content: "You are a title generator. You output ONLY a thread title. Nothing else.",
    },
    { role: "user", content: "Generate a title for this conversation:" },
  ],
};
assert.equal(isTitleGenerationRequest(malformedFingerprint), false);

const compactPrompt = [
  "Create a new anchored summary from the conversation history.",
  "",
  "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged.",
].join("\n");
const compactMessage = { role: "user", content: compactPrompt };
assert.equal(isCompactInjectionText(compactPrompt), true);
assert.equal(classifyMessageKind(compactMessage), "compact");
const compactMaterials = translationMaterialsForRequest({
  raw: {
    body: {
      messages: [
        {
          role: "system",
          content: "You are an anchored context summarization assistant for coding sessions.",
        },
        compactMessage,
      ],
    },
  },
}, {
  section: "harness",
  extractHarnessParts: extractHarnessTranslationParts,
});
assert.deepEqual(compactMaterials.map((item) => item.kind), ["harness_compact"]);
assert.equal(
  isCompactInjectionText("Please explain how anchored summaries work."),
  false,
  "ordinary user discussion must not be promoted to Harness evidence",
);

console.log("opencode request classification smoke passed");
