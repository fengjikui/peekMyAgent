import assert from "node:assert/strict";
import fs from "node:fs";
import {
  extractSystemParts,
  inferProtocol,
  inferProtocolProfile,
  inferProvider,
  inferRequestSource,
  isContextTokenCountingRequest,
  isTitleGenerationRequest,
  isWebSearchInternalRequest,
} from "../src/trace/request-profile.mjs";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

assert.deepEqual(
  extractSystemParts({
    system: [{ type: "text", text: "body system" }],
    messages: [{ role: "system", content: "message system" }, user("hello")],
  }),
  [
    { source: "body.system", text: "body system" },
    { source: "messages.system", text: "message system" },
  ],
  "system blocks retain their request location",
);

assert.equal(isContextTokenCountingRequest({ path: "/v1/messages/count_tokens?beta=1" }), true);
assert.equal(isContextTokenCountingRequest({ original_url: "https://api.example/v1/messages/count_tokens" }), true);
assert.equal(isContextTokenCountingRequest({ path: "/v1/messages" }), false);

assert.equal(isTitleGenerationRequest({ system: "Generate a concise, sentence-case title for this chat." }), true);
assert.equal(
  isTitleGenerationRequest({
    messages: [],
    tools: [],
    output_config: { format: { type: "json_schema", schema: { properties: { title: { type: "string" } } } } },
  }),
  true,
);
assert.equal(isTitleGenerationRequest({ system: "Answer the user", tools: [] }), false);

assert.equal(isWebSearchInternalRequest({ tool_choice: { name: "web_search" } }), true);
assert.equal(isWebSearchInternalRequest({ tools: [{ type: "web_search_20250305" }] }), true);
assert.equal(isWebSearchInternalRequest({ system: "You are an assistant for performing a web search tool use." }), true);
assert.equal(isWebSearchInternalRequest({ tools: [{ name: "Bash" }] }), false);

assert.equal(inferProtocol("/v1/messages", { messages: [] }), "anthropic_messages");
assert.equal(inferProtocol("/v1/chat/completions", {}), "openai_chat_completions");
assert.equal(inferProtocol("/v1/responses", {}), "openai_responses");
assert.equal(inferProtocol("/models/gemini:streamGenerateContent", {}), "gemini_generate_content");
assert.equal(inferProtocol("/custom", { contents: [] }), "gemini_generate_content");
assert.equal(inferProtocol("/custom", { input: [] }), "openai_responses");
assert.equal(inferProtocol("/custom", { messages: [], tools: [], stream: true }), "openai_chat_completions");
assert.equal(inferProtocol("/custom", { messages: [] }), "unknown");

assert.equal(inferProvider("mimo-v2.5-pro", {}), "xiaomi_mimo");
assert.equal(inferProvider("custom", { headers: { host: "api.xiaomimimo.com" } }), "xiaomi_mimo");
assert.equal(inferProvider("gpt-5", {}), "openai");
assert.equal(inferProvider("claude-sonnet-4-6", {}), "anthropic");
assert.equal(inferProvider("gemini-2.5-pro", {}), "google_gemini");
assert.equal(inferProvider("deepseek-v4-pro", {}), "deepseek");
assert.equal(inferProvider("qwen3-coder", {}), "qwen");
assert.equal(inferProvider("kimi-k2", {}), "moonshot");
assert.equal(inferProvider("local-model", {}), "unknown");

assert.deepEqual(
  inferProtocolProfile(
    { path: "/v1/messages" },
    {
      model: "claude-sonnet-4-6",
      messages: [{ role: "assistant", reasoning_content: "keep provider extension" }],
      thinking: { type: "enabled" },
    },
  ),
  {
    protocol: "anthropic_messages",
    protocol_label: "Anthropic",
    provider: "anthropic",
    provider_label: "Anthropic",
    model: "claude-sonnet-4-6",
    extensions: ["reasoning_content", "thinking"],
  },
  "protocol profile preserves labels and detected extensions",
);

const infer = (overrides = {}) => inferRequestSource({
  capture: {},
  body: { messages: [] },
  currentUser: user("hello"),
  lastUser: user("hello"),
  debugSource: null,
  ...overrides,
});

assert.deepEqual(
  infer({ capture: { path: "/v1/messages/count_tokens", headers: { "x-claude-code-agent-id": "child" } } }),
  { type: "metadata", label: "上下文统计 (/context)", confidence: "high" },
  "metadata classification wins over child-agent evidence",
);
assert.equal(infer({ lastUser: user("[SUGGESTION MODE: suggest the next input]") }).type, "metadata");
assert.equal(infer({ lastUser: user("<system-reminder>framework note</system-reminder>") }).type, "metadata");
assert.equal(infer({ body: { system: "Generate a concise, sentence-case title", messages: [] } }).label, "生成会话标题");
assert.equal(infer({ body: { tool_choice: { name: "web_search" }, messages: [] } }).label, "WebSearch 内部请求");
assert.deepEqual(
  infer({ capture: { headers: { "X-Claude-Code-Agent-Id": "agent-1" } }, debugSource: { source: "agent:Explore" } }),
  { type: "subagent", label: "agent:Explore", confidence: "high" },
);
assert.equal(infer({ debugSource: { source: "agent:Plan" } }).type, "subagent");
assert.equal(infer({ debugSource: { source: "generate_session_title" } }).type, "metadata");
assert.equal(infer({ currentUser: user("[Subagent Context]\nInspect files") }).type, "subagent");
assert.equal(infer({ body: { metadata: { api_source: "agent:worker-2" }, messages: [] } }).label, "agent:worker-2");

for (const toolName of ["Agent", "sessions_spawn", "subagents"]) {
  const source = infer({
    body: {
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: `call-${toolName}`, name: toolName, input: {} }] }],
    },
  });
  assert.deepEqual(source, { type: "parent_spawn", label: "启动子代理", confidence: "high" });
}
assert.deepEqual(infer(), { type: "main", label: "主代理请求", confidence: "medium" });

const moduleSource = fs.readFileSync(new URL("../src/trace/request-profile.mjs", import.meta.url), "utf8");
assert.doesNotMatch(moduleSource, /from ["']\.\.\/(?:viewer|server|core|adapters)\//, "request profile stays inside the Trace Domain");

console.log("request profile contract smoke passed");
