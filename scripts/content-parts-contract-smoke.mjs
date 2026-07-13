import assert from "node:assert/strict";
import fs from "node:fs";
import {
  extractContentText,
  extractThinkingText,
  extractToolCalls,
  extractToolCallsFromContent,
  extractToolResults,
  parseMaybeJson,
} from "../src/trace/content-parts.mjs";

assert.equal(extractContentText(null), "");
assert.equal(extractContentText(42), "42");
assert.equal(
  extractContentText([
    { type: "thinking", thinking: "private" },
    { type: "text", text: "visible" },
    { type: "image", source: { type: "base64", data: "abc" } },
  ]),
  'visible\n{"type":"image","source":{"type":"base64","data":"abc"}}',
);
assert.equal(
  extractThinkingText([
    { type: "thinking", thinking: "plan" },
    { type: "reasoning", reasoning: "verify" },
    { type: "text", text: "answer" },
  ]),
  "plan\nverify",
);

assert.deepEqual(
  extractToolCalls([
    {
      role: "assistant",
      tool_calls: [
        { id: "openai-1", function: { name: "Read", arguments: '{"file_path":"README.md"}' } },
        { id: "openai-2", function: { name: "Bash", arguments: "not-json" } },
      ],
      content: [{ type: "tool_use", id: "anthropic-1", name: "Write", input: { file_path: "out.txt" } }],
    },
  ]),
  [
    { id: "openai-1", name: "Read", arguments: { file_path: "README.md" } },
    { id: "openai-2", name: "Bash", arguments: "not-json" },
    { id: "anthropic-1", name: "Write", arguments: { file_path: "out.txt" } },
  ],
);
assert.deepEqual(
  extractToolCallsFromContent({ type: "tool_use", id: "one", name: "Bash", input: { command: "pwd" } }),
  [{ id: "one", name: "Bash", arguments: { command: "pwd" } }],
);

assert.deepEqual(
  extractToolResults([
    { role: "tool", tool_call_id: "openai-1", content: "file contents" },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "anthropic-1", content: [{ type: "text", text: "written" }] },
        { type: "text", text: "harness continuation" },
      ],
    },
  ]),
  [
    { id: "openai-1", content: "file contents" },
    { id: "anthropic-1", content: "written" },
  ],
);
assert.deepEqual(parseMaybeJson('{"ok":true}'), { ok: true });
assert.equal(parseMaybeJson("broken"), "broken");

const source = fs.readFileSync(new URL("../src/trace/content-parts.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /viewer\/|node:(fs|http|child_process)|process\.env|fetch\s*\(/);

console.log("content parts contract smoke passed");
