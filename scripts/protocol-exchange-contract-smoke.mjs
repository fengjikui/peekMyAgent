#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  compactProtocolExchange,
  projectProtocolExchange,
} from "../src/trace/protocol-exchange.mjs";

const codexRequest = {
  model: "gpt-5.6-terra",
  tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
  input: [
    {
      type: "additional_tools",
      role: "developer",
      tools: [
        { type: "custom", name: "exec", description: "Run a command" },
        { type: "custom", name: "wait", description: "Wait for a command" },
        { type: "function", name: "request_user_input", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "collaboration",
          description: "Tools for spawning and managing sub-agents.",
          tools: [
            { type: "function", name: "followup_task", parameters: { type: "object" } },
            {
              type: "namespace",
              name: "mailbox",
              tools: [{ type: "function", name: "send_message", defer_loading: true }],
            },
          ],
        },
      ],
    },
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "You are Codex." }],
    },
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<model_switch>Use the current model.</model_switch>" }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Inspect request 65." }],
    },
    {
      type: "tool_search_output",
      tools: [
        {
          type: "namespace",
          name: "web",
          tools: [{ type: "function", name: "open", defer_loading: true }],
        },
      ],
    },
    { type: "custom_tool_call", call_id: "call-prior", name: "exec", input: "status" },
    { type: "custom_tool_call_output", call_id: "call-prior", output: "ok" },
  ],
};
const codexResponse = {
  id: "resp-65",
  status: "completed",
  output: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "Check the trace." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect it." }] },
    { type: "custom_tool_call", call_id: "call-current", name: "exec", input: "inspect" },
  ],
};

const codex = projectProtocolExchange({
  protocol: "openai_responses",
  request: codexRequest,
  response: codexResponse,
});

assert.equal(codex.schema_version, 1);
assert.equal(codex.protocol_label, "OpenAI Responses");
assert.equal(codex.request.counts.instruction_blocks, 2, "additional_tools is not an empty Developer instruction");
assert.equal(codex.request.counts.input_items, 7);
assert.equal(codex.request.counts.tool_stages, 3);
assert.equal(codex.request.counts.tools, 7);
assert.deepEqual(
  codex.request.tool_stages.map((stage) => [stage.kind, stage.source_path, stage.effective_tool_count]),
  [
    ["declared", "$.tools", 1],
    ["added", "$.input[0].tools", 6],
    ["loaded", "$.input[4].tools", 7],
  ],
);
assert.deepEqual(codex.request.instruction_blocks.map((item) => item.source_path), ["$.input[1]", "$.input[2]"]);
assert.deepEqual(
  codex.request.input_items.map((item) => item.semantic),
  ["tools_added", "instruction", "instruction", "user_message", "tools_loaded", "tool_call", "tool_result"],
);
assert.deepEqual(codex.request.input_items[0].tool_names, [
  "exec",
  "wait",
  "request_user_input",
  "collaboration.followup_task",
  "collaboration.mailbox.send_message",
]);
assert.equal(codex.request.input_items[0].tool_count, 5, "namespace containers are not callable tools");
assert.equal(codex.request.tool_stages[1].namespace_count, 2);
assert.deepEqual(
  codex.request.tool_stages[1].namespaces.map((namespace) => [namespace.qualified_name, namespace.source_path, namespace.tool_count]),
  [
    ["collaboration", "$.input[0].tools[3]", 2],
    ["collaboration.mailbox", "$.input[0].tools[3].tools[1]", 1],
  ],
);
assert.deepEqual(
  codex.request.tool_stages[1].tools.slice(3).map((tool) => [tool.qualified_name, tool.source_path, tool.deferred]),
  [
    ["collaboration.followup_task", "$.input[0].tools[3].tools[0]", false],
    ["collaboration.mailbox.send_message", "$.input[0].tools[3].tools[1].tools[0]", true],
  ],
);
assert.equal(codex.request.input_items[4].source_path, "$.input[4]");
assert.equal(codex.request.tool_stages[2].tools[0].namespace, "web");
assert.equal(codex.request.tool_stages[2].tools[0].deferred, true);
assert.deepEqual(codex.response.output_items.map((item) => item.semantic), ["reasoning", "assistant_message", "tool_call"]);
assert.equal(codex.response.output_items[2].call_id, "call-current");
assert.equal(codex.response.output_items[2].name, "exec");
assert.equal(codex.response.counts.tool_calls, 1);

const compact = compactProtocolExchange(codex);
assert.deepEqual(compact.request.counts, {
  instruction_blocks: 2,
  input_items: 7,
  tool_stages: 3,
  tools: 7,
});
assert.equal("tool_stages" in compact.request, false, "timeline DTO does not repeat tool catalogs for every request");
assert.equal("input_items" in compact.request, false, "timeline DTO does not carry the full protocol sequence");
assert.equal("output_items" in compact.response, false, "timeline DTO does not carry the full downstream sequence");
assert.deepEqual(
  compactProtocolExchange(compact),
  compact,
  "compact protocol projection is idempotent across cursor assembly",
);

const anthropic = projectProtocolExchange({
  protocol: "anthropic_messages",
  request: {
    system: "You are Claude.",
    tools: [{ name: "Bash", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Run pwd" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu-prior", name: "Bash", input: { command: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-prior", content: "/tmp" }] },
    ],
  },
  response: {
    type: "message",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "pwd" } }],
  },
});
assert.equal(anthropic.protocol_label, "Anthropic Messages");
assert.equal(anthropic.request.counts.instruction_blocks, 1);
assert.equal(anthropic.request.tool_stages[0].kind, "declared");
assert.deepEqual(
  anthropic.request.input_items.map((item) => item.semantic),
  ["user_message", "tool_call", "tool_result"],
  "Anthropic content blocks retain tool lifecycle semantics inside message roles",
);
assert.equal(anthropic.request.input_items[2].source_path, "$.messages[2].content[0]");
assert.equal(anthropic.response.output_items[0].semantic, "tool_call");

const chat = projectProtocolExchange({
  protocol: "openai_chat_completions",
  request: {
    messages: [
      { role: "developer", content: "Follow repository rules." },
      { role: "user", content: "Hello" },
    ],
  },
  response: {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [{ id: "chat-call-1", type: "function", function: { name: "inspect", arguments: "{\"path\":\"README.md\"}" } }],
      },
    }],
  },
});
assert.equal(chat.request.instruction_blocks[0].source_path, "$.messages[0]");
assert.equal(chat.response.output_items[0].source_path, "$.choices[0].message");
assert.deepEqual(chat.response.output_items.map((item) => item.semantic), ["assistant_message", "tool_call"]);
assert.equal(chat.response.output_items[1].source_path, "$.choices[0].message.tool_calls[0]");
assert.equal(chat.response.output_items[1].call_id, "chat-call-1");
assert.equal(chat.response.output_items[1].name, "inspect");
assert.equal(chat.response.counts.tool_calls, 1);
assert.equal(chat.response.status, "tool_calls");

const gemini = projectProtocolExchange({
  protocol: "gemini_generate_content",
  request: {
    systemInstruction: { parts: [{ text: "Follow the tool contract." }] },
    tools: [
      { functionDeclarations: [{ name: "get_weather", description: "Get weather." }] },
      { googleSearch: {} },
    ],
    contents: [
      { role: "user", parts: [{ text: "Weather in Shanghai?" }] },
      { role: "model", parts: [{ functionCall: { id: "gemini-call-1", name: "get_weather", args: { city: "Shanghai" } } }] },
      { role: "function", parts: [{ functionResponse: { id: "gemini-call-1", name: "get_weather", response: { temperature: 31 } } }] },
    ],
  },
  response: {
    candidates: [{
      finishReason: "STOP",
      content: { role: "model", parts: [{ text: "It is 31 degrees." }] },
    }],
  },
});
assert.equal(gemini.protocol_label, "Google GenerateContent");
assert.equal(gemini.request.instruction_blocks[0].chars, 25);
assert.deepEqual(gemini.request.tool_stages[0].tools.map((tool) => tool.name), ["get_weather", "googleSearch"]);
assert.deepEqual(gemini.request.input_items.map((item) => item.semantic), ["user_message", "tool_call", "tool_result"]);
assert.equal(gemini.request.input_items[1].source_path, "$.contents[1].parts[0]");
assert.equal(gemini.request.input_items[1].role, "assistant");
assert.equal(gemini.response.output_items[0].source_path, "$.candidates[0].content.parts[0]");
assert.equal(gemini.response.output_items[0].semantic, "assistant_message");
assert.equal(gemini.response.status, "STOP");

console.log("protocol exchange contract smoke passed");
