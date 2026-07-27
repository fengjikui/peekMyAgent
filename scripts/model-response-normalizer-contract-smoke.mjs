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
  decoded_body_length: 960,
  response_content_encoding: "gzip",
  content_decoding: { status: "decoded", encodings: ["gzip"] },
  received_at: "2026-07-14T00:00:00.000Z",
});
assert.equal(json.captured, true);
assert.equal(json.stream, false);
assert.equal(json.message_id, "msg-json");
assert.equal(json.text, "done");
assert.equal(json.thinking, "inspect first");
assert.equal(json.finish_reason, "tool_use");
assert.equal(json.tool_calls[0].arguments.file_path, "AGENTS.md");
assert.deepEqual(json.complete_response.content.map((part) => part.type), ["thinking", "text", "tool_use"]);
assert.equal(json.complete_response.stop_reason, "tool_use");
assert.equal(json.response_protocol, "anthropic_messages");
assert.equal(json.complete_response_source, "captured_body_json");
assert.equal("text" in json.complete_response, false, "provider JSON is preserved without PMA aggregate duplicates");
assert.equal("tool_use" in json.complete_response, false);
assert.equal(json.latency_ms, 42);
assert.equal(json.status, 200);
assert.equal(json.raw_body_bytes, 640);
assert.equal(json.captured_body_bytes, 640);
assert.equal(json.decoded_body_bytes, 960);
assert.equal(json.response_content_encoding, "gzip");
assert.deepEqual(json.content_decoding, { status: "decoded", encodings: ["gzip"] });

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
assert.equal(openAi.response_protocol, "openai_chat_completions");
assert.equal(openAi.complete_response_source, "stream_reconstruction");
assert.equal(openAi.complete_response.object, "chat.completion");
assert.equal(openAi.complete_response.choices[0].message.content, "stream reply");
assert.equal(openAi.complete_response.choices[0].message.reasoning_content, "plan carefully");
assert.equal(openAi.complete_response.choices[0].message.tool_calls[0].type, "function");
assert.equal(openAi.complete_response.choices[0].message.tool_calls[0].function.name, "Bash");
assert.equal(openAi.complete_response.choices[0].message.tool_calls[0].function.arguments, '{"command":"pwd"}');
assert.equal("content" in openAi.complete_response, false, "Chat Completions Raw must not use Anthropic content blocks");
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
assert.equal(responses.response_protocol, "openai_responses");
assert.equal(responses.complete_response_source, "protocol_terminal_event");
assert.deepEqual(
  responses.complete_response.output.map((item) => item.type),
  ["reasoning", "message", "custom_tool_call"],
  "Responses API terminal field names remain protocol-native",
);
assert.equal("content" in responses.complete_response, false);

const codexSparseTerminal = summarizeModelResponse({
  headers: { "content-type": "text/plain" },
  body_text: sse([
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "reasoning-sparse",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "inspect" }],
      },
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "message-sparse",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will inspect." }],
      },
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: {
        id: "function-sparse",
        type: "function_call",
        call_id: "call-sparse",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-sparse",
        object: "response",
        status: "completed",
        instructions: "system contract",
        tools: [{ type: "function", name: "exec_command" }],
        output: [],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    },
  ]),
  status: 200,
});
assert.equal(codexSparseTerminal.response_protocol, "openai_responses");
assert.equal(codexSparseTerminal.complete_response_source, "stream_reconstruction");
assert.equal(codexSparseTerminal.complete_response.instructions, "system contract");
assert.deepEqual(codexSparseTerminal.complete_response.output.map((item) => item.type), [
  "reasoning",
  "message",
  "function_call",
]);
assert.equal(codexSparseTerminal.complete_response.output[2].arguments, '{"cmd":"pwd"}');

const opaqueResponses = summarizeModelResponse({
  headers: { "content-type": "text/event-stream" },
  body_text: sse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "reasoning-opaque",
        type: "reasoning",
        content: [],
        encrypted_content: "opaque-ciphertext-fixture",
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-opaque",
        model: "gpt-codex",
        status: "completed",
        output: [
          {
            id: "reasoning-opaque",
            type: "reasoning",
            content: [],
            encrypted_content: "opaque-ciphertext-fixture",
          },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible answer" }] },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
  ]),
  status: 200,
});
assert.equal(opaqueResponses.thinking, "", "encrypted reasoning must not be represented as readable thinking");
assert.equal(opaqueResponses.opaque_reasoning.length, 1);
assert.equal(opaqueResponses.complete_response.output[0].type, "reasoning");
assert.equal(opaqueResponses.complete_response.output[0].encrypted_content, undefined);
assert.equal(
  opaqueResponses.complete_response.output[0].encrypted_content_omitted.reason,
  "opaque_encrypted_reasoning",
);
assert.equal(opaqueResponses.complete_response.output[1].content[0].text, "visible answer");

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
assert.deepEqual(toolSearchResponse.complete_response.output.map((part) => part.type), ["message", "tool_search_call"]);

const anthropicStream = sse([
  { type: "message_start", message: { id: "msg-sse", role: "assistant", model: "claude-stream", content: [] } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
  { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "char_location", cited_text: "source", document_index: 0, document_title: "README", start_char_index: 0, end_char_index: 6 } } },
  { type: "content_block_start", index: 2, content_block: { type: "server_tool_use", id: "call-sse", name: "web_search", input: {} } },
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
assert.equal(anthropic.response_protocol, "anthropic_messages");
assert.equal(anthropic.complete_response_source, "stream_reconstruction");
assert.deepEqual(anthropic.complete_response.content.map((part) => part.type), ["thinking", "text", "server_tool_use"]);
assert.equal(anthropic.complete_response.content[0].thinking, "reason");
assert.equal(anthropic.complete_response.content[1].text, "answer");
assert.equal(anthropic.complete_response.content[1].citations[0].document_title, "README");
assert.deepEqual(anthropic.complete_response.content[2].input, { file_path: "README.md" });
assert.deepEqual(anthropic.complete_response.usage, { input_tokens: 8, output_tokens: 4 });

const malformed = summarizeSseResponse("data: not-json\n\ndata: [DONE]\n\n");
assert.equal(malformed.text, "");
assert.deepEqual(malformed.tool_calls, []);
assert.equal(malformed.event_count, 2);
assert.equal(malformed.complete_response, null);

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
