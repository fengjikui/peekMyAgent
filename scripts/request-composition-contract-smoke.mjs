import assert from "node:assert/strict";
import fs from "node:fs";
import { analyzeMessageComposition, analyzeRequestComposition } from "../src/trace/request-composition.mjs";

const currentUser = { role: "user", content: "next" };
const toolUse = {
  role: "assistant",
  content: [{ type: "tool_use", id: "call-1", name: "Read", input: { file_path: "/tmp/a" } }],
};
const toolResult = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "call-1", content: "disk ok" }],
};
const frameworkReminder = { role: "user", content: "<system-reminder>policy</system-reminder>" };
const suggestion = { role: "user", content: "[SUGGESTION MODE: answer briefly]" };
const messages = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "answer" },
  toolUse,
  toolResult,
  frameworkReminder,
  suggestion,
  currentUser,
];

const messageStats = analyzeMessageComposition(messages, currentUser);
assert.equal(messageStats.human_user_chars, "hello".length + "next".length);
assert.equal(messageStats.assistant_chars, "answer".length);
assert.ok(messageStats.tool_use_chars > 0, "tool_use is measured from normalized tool calls");
assert.equal(messageStats.tool_result_chars, "disk ok".length);
assert.equal(messageStats.agent_internal_chars, frameworkReminder.content.length + suggestion.content.length);
assert.equal(messageStats.current_user_chars, "next".length);
assert.equal(
  messageStats.total_chars,
  messageStats.human_user_chars
    + messageStats.assistant_chars
    + messageStats.tool_use_chars
    + messageStats.tool_result_chars
    + messageStats.agent_internal_chars
    + messageStats.other_chars,
  "message classes account for the full measured message content",
);

const tools = [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }];
const body = {
  model: "test-model",
  max_tokens: 128,
  system: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }],
  tools,
  messages,
};
const composition = analyzeRequestComposition({
  body,
  messages,
  systemParts: [{ text: "alpha" }, { text: "beta" }],
  tools,
  currentUser,
  responseSummary: { text: "done", thinking: "plan" },
  rawBodyLength: 1000,
});

assert.equal(composition.unit, "chars");
assert.equal(composition.total_payload_chars, 1000, "capture-recorded request size remains the total-size authority");
assert.equal(composition.input_chars, 1000);
assert.equal(composition.sections.system.chars, 9);
assert.equal(composition.sections.tools.chars, JSON.stringify(tools).length);
assert.equal(composition.sections.params.chars, JSON.stringify({ model: "test-model", max_tokens: 128 }).length);
assert.equal(composition.sections.messages.chars, messageStats.total_chars);
assert.equal(composition.current_user_chars, 4);
assert.equal(composition.history_context_chars, messageStats.total_chars - 4);
assert.equal(composition.tool_use_chars, messageStats.tool_use_chars);
assert.equal(composition.tool_result_chars, 7);
assert.equal(composition.agent_internal_chars, messageStats.agent_internal_chars);
assert.equal(composition.response_text_chars, 4);
assert.equal(composition.response_thinking_chars, 4);
assert.equal(composition.ratios.current_user_to_input, 0.004);
assert.equal(composition.ratios.system_to_input, 0.009);
assert.equal(composition.ratios.output_to_input, 0.004);
assert.match(composition.note, /字符数近似/);

const fallback = analyzeRequestComposition({ body: { model: "m" } });
assert.equal(fallback.total_payload_chars, JSON.stringify({ model: "m" }).length);
assert.equal(fallback.sections.system.ratio, 0);

const mixedHumanMessage = {
  role: "user",
  content: [
    { type: "text", text: "human says" },
    { type: "tool_use", id: "call-mixed", name: "Read", input: {} },
  ],
};
const mixedStats = analyzeMessageComposition([mixedHumanMessage], mixedHumanMessage);
assert.equal(mixedStats.tool_use_chars, 0, "visible human text keeps a mixed user message in the human bucket");
assert.ok(mixedStats.human_user_chars > "human says".length);

const moduleSource = fs.readFileSync(new URL("../src/trace/request-composition.mjs", import.meta.url), "utf8");
assert.doesNotMatch(moduleSource, /from ["']\.\.\/(?:viewer|server|core|adapters)\//, "request composition stays inside the Trace Domain");

console.log("request composition contract smoke passed");
