#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  inferRequestSource,
  isTitleGenerationRequest,
} from "../src/trace/request-profile.mjs";

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

console.log("opencode request classification smoke passed");
