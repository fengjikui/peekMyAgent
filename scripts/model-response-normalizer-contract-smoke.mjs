import assert from "node:assert/strict";
import fs from "node:fs";
import { extractContentText, extractToolCalls } from "../src/trace/content-parts.mjs";
import {
  summarizeJsonResponse,
  summarizeModelResponse,
  summarizeSseResponse,
} from "../src/trace/model-response-normalizer.mjs";

assert.equal(summarizeModelResponse(null).captured, false);
assert.equal(
  extractContentText([
    { type: "thinking", thinking: "private" },
    { type: "text", text: "visible" },
    { type: "reasoning", reasoning: "private too" },
  ]),
  "visible",
);

assert.deepEqual(
  extractToolCalls([
    {
      role: "assistant",
      tool_calls: [{ id: "call-openai", function: { name: "Read", arguments: '{"file_path":"README.md"}' } }],
      content: [{ type: "tool_use", id: "call-anthropic", name: "Bash", input: { command: "pwd" } }],
    },
  ]),
  [
    { id: "call-openai", name: "Read", arguments: { file_path: "README.md" } },
    { id: "call-anthropic", name: "Bash", arguments: { command: "pwd" } },
  ],
);

const json = summarizeModelResponse({
  headers: { "content-type": "application/json" },
  body_json: {
    id: "msg-json",
    role: "assistant",
    model: "claude-test",
    content: [
      { type: "thinking", thinking: "inspect first" },
      { type: "text", text: "done" },
      { type: "tool_use", id: "call-json", name: "Read", input: { file_path: "AGENTS.md" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 12, output_tokens: 7 },
  },
  duration_ms: 42,
  status: 200,
  raw_body_length: 640,
  captured_body_length: 640,
  received_at: "2026-07-14T00:00:00.000Z",
});
assert.equal(json.captured, true);
assert.equal(json.stream, false);
assert.equal(json.message_id, "msg-json");
assert.match(json.text, /^done\n/);
assert.match(json.text, /call-json/);
assert.equal(json.thinking, "inspect first");
assert.equal(json.finish_reason, "tool_use");
assert.equal(json.tool_calls[0].arguments.file_path, "AGENTS.md");
assert.deepEqual(json.complete_response.content.map((part) => part.type), ["thinking", "text", "tool_use"]);
assert.equal(json.complete_response.stop_reason, "tool_use");
assert.equal(json.latency_ms, 42);
assert.equal(json.status, 200);

const openAiStream = sse([
  { choices: [{ delta: { role: "assistant", reasoning_content: "plan " } }] },
  { choices: [{ delta: { reasoning_content: "carefully" } }] },
  { choices: [{ delta: { content: "stream " } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-stream", type: "function", function: { name: "Bash", arguments: "" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] } }] },
  { choices: [{ delta: { content: "reply" }, finish_reason: "stop" }], usage: { input_tokens: 5, output_tokens: 3 } },
]);
const openAi = summarizeModelResponse({
  headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  body_text: openAiStream,
  status: 200,
});
assert.equal(openAi.stream, true);
assert.equal(openAi.text, "stream reply");
assert.equal(openAi.thinking, "plan carefully");
assert.equal(openAi.finish_reason, "stop");
assert.deepEqual(openAi.tool_calls[0], { id: "call-stream", name: "Bash", arguments: { command: "pwd" } });
assert.equal(openAi.complete_response.stream, true);
assert.ok(openAi.event_count >= 7);

const responsesStream = sse([
  { type: "response.created", response: { id: "resp-codex", model: "gpt-5-codex", status: "in_progress" } },
  { type: "response.reasoning_summary_text.delta", delta: "inspect " },
  { type: "response.reasoning_summary_text.delta", delta: "carefully" },
  { type: "response.output_text.delta", delta: "intermediate text" },
  { type: "response.output_item.added", output_index: 1, item: { type: "custom_tool_call", id: "item-codex", call_id: "call-codex", name: "exec", input: "" } },
  { type: "response.custom_tool_call_input.delta", output_index: 1, item_id: "item-codex", delta: '{"cmd":' },
  { type: "response.custom_tool_call_input.done", output_index: 1, item_id: "item-codex", input: '{"cmd":"pwd"}' },
  { type: "response.output_item.done", output_index: 1, item: { type: "custom_tool_call", id: "item-codex", call_id: "call-codex", name: "exec", input: '{"cmd":"pwd"}' } },
  {
    type: "response.completed",
    response: {
      id: "resp-codex",
      model: "gpt-5-codex",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "inspect carefully" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "final text" }] },
        { type: "custom_tool_call", id: "item-codex", call_id: "call-codex", name: "exec", input: '{"cmd":"pwd"}' },
      ],
      usage: { input_tokens: 17, output_tokens: 9 },
    },
  },
]);
const responses = summarizeModelResponse({
  headers: { "content-type": "text/event-stream" },
  body_text: responsesStream,
  status: 200,
});
assert.equal(responses.message_id, "resp-codex");
assert.equal(responses.text, "final text", "terminal response is authoritative over streamed deltas");
assert.equal(responses.thinking, "inspect carefully");
assert.equal(responses.response_status, "completed");
assert.equal(responses.finish_reason, "completed");
assert.deepEqual(responses.tool_calls, [{ id: "call-codex", name: "exec", arguments: { cmd: "pwd" } }]);
assert.equal(responses.complete_response.status, "completed");

const toolSearchResponse = summarizeModelResponse({
  headers: { "content-type": "text/event-stream" },
  body_text: sse([
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        type: "tool_search_call",
        call_id: "call-search",
        status: "completed",
        execution: "client",
        arguments: { query: "multi-agent tools", limit: 5 },
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-search",
        model: "gpt-codex",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Searching tools." }] },
          {
            type: "tool_search_call",
            call_id: "call-search",
            status: "completed",
            execution: "client",
            arguments: { query: "multi-agent tools", limit: 5 },
          },
        ],
      },
    },
  ]),
  status: 200,
});
assert.equal(toolSearchResponse.text, "Searching tools.");
assert.deepEqual(toolSearchResponse.tool_calls, [
  { id: "call-search", name: "tool_search", arguments: { query: "multi-agent tools", limit: 5 } },
]);
assert.deepEqual(toolSearchResponse.complete_response.content.map((part) => part.type), ["text", "tool_use"]);

const anthropicStream = sse([
  { type: "message_start", message: { id: "msg-sse", role: "assistant", model: "claude-stream", content: [] } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call-sse", name: "Read", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 8, output_tokens: 4 } },
  { type: "message_stop" },
]);
const anthropic = summarizeSseResponse(anthropicStream);
assert.equal(anthropic.message_id, "msg-sse");
assert.equal(anthropic.model, "claude-stream");
assert.equal(anthropic.text, "answer");
assert.equal(anthropic.thinking, "reason");
assert.equal(anthropic.finish_reason, "tool_use");
assert.deepEqual(anthropic.tool_calls[0].arguments, { file_path: "README.md" });

const malformed = summarizeSseResponse("data: not-json\n\ndata: [DONE]\n\n");
assert.equal(malformed.text, "");
assert.deepEqual(malformed.tool_calls, []);
assert.equal(malformed.event_count, 2);

const parsedJson = summarizeJsonResponse({
  id: "chatcmpl-1",
  choices: [{ message: { role: "assistant", content: "hello", reasoning_content: "think" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1 },
});
assert.equal(parsedJson.text, "hello");
assert.equal(parsedJson.thinking, "think");
assert.equal(parsedJson.finish_reason, "stop");

const moduleSource = fs.readFileSync(new URL("../src/trace/model-response-normalizer.mjs", import.meta.url), "utf8");
assert.doesNotMatch(moduleSource, /viewer\/server|node:(fs|http|child_process)|process\.env|fetch\s*\(/);

console.log("model response normalizer contract smoke passed");

function sse(events) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}
