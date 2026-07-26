import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyCodexRequestOperation,
  classifyTransportOperation,
  codexSubagentIdentity,
  codexTurnMetadata,
  codexTurnMetadataObservation,
  extractSystemParts,
  extractRequestMessages,
  extractRequestTools,
  inferProtocol,
  inferProtocolProfile,
  inferProvider,
  inferRequestSource,
  isCodexContextCompactionRequest,
  isCodexSearchServiceRequest,
  isCodexSubagentRequest,
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

const responsesBody = {
  instructions: "Codex system contract",
  input: [
    { role: "developer", content: [{ type: "input_text", text: "Harness instruction" }] },
    { role: "user", content: [{ type: "input_text", text: "Inspect disk usage" }] },
    { type: "custom_tool_call", call_id: "call-codex", name: "exec", input: '{"cmd":"df -h"}' },
    { type: "custom_tool_call_output", call_id: "call-codex", output: "disk-ok" },
  ],
  tools: [{ type: "function", name: "read_file", description: "Read a file" }],
  additional_tools: [{ type: "custom", name: "exec", description: "Run a command" }],
};
const responsesMessages = extractRequestMessages(responsesBody);
assert.deepEqual(responsesMessages.map((message) => message.role), ["developer", "user", "assistant", "tool"]);
assert.deepEqual(responsesMessages[2].content[0], {
  type: "tool_use",
  id: "call-codex",
  name: "exec",
  input: { cmd: "df -h" },
});
assert.equal(responsesMessages[3].tool_call_id, "call-codex");
assert.deepEqual(extractRequestTools(responsesBody).map((tool) => tool.name), ["read_file", "exec"]);
assert.deepEqual(extractSystemParts(responsesBody), [{ source: "body.instructions", text: "Codex system contract" }]);

assert.equal(isContextTokenCountingRequest({ path: "/v1/messages/count_tokens?beta=1" }), true);
assert.equal(isContextTokenCountingRequest({ original_url: "https://api.example/v1/messages/count_tokens" }), true);
assert.equal(isContextTokenCountingRequest({ path: "/v1/messages" }), false);

assert.equal(isCodexContextCompactionRequest({ path: "/v1/responses/compact" }), true);
assert.equal(isCodexContextCompactionRequest({ upstream_path: "/backend-api/codex/responses/compact?stream=1" }), true);
assert.equal(isCodexContextCompactionRequest({ path: "/v1/responses" }), false);
assert.equal(isCodexSearchServiceRequest({ path: "/v1/alpha/search" }), true);
assert.equal(isCodexSearchServiceRequest({ upstream_path: "/backend-api/codex/alpha/search?q=trace" }), true);
assert.equal(isCodexSearchServiceRequest({ path: "/v1/responses" }), false);
assert.deepEqual(classifyTransportOperation({ path: "/v1/responses/compact" }), {
  operation: "context_compaction",
  kind: "compact",
  label: "Harness 上下文压缩请求",
  label_key: "contextCompactionRequest",
  evidence: [{ origin: "transport", field: "path", value: "/v1/responses/compact" }],
});

const codexMemoryBody = {
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "memory",
      thread_source: "user",
      thread_id: "thread-main",
      turn_id: "turn-memory",
    }),
  },
};
assert.deepEqual(codexTurnMetadata(codexMemoryBody), {
  request_kind: "memory",
  thread_source: "user",
  thread_id: "thread-main",
  turn_id: "turn-memory",
});
assert.deepEqual(classifyCodexRequestOperation({}, codexMemoryBody), {
  type: "background",
  label: "Codex 后台任务 · 记忆提取",
  label_key: "codexMemoryBackgroundTask",
  note_key: "codexMemoryBackgroundNote",
  actor: "background_service",
  operation: "codex_memory_extraction",
  request_kind: "memory",
  relation: "independent",
  confidence: "high",
  evidence: [
    {
      origin: "request_body",
      field: "client_metadata.x-codex-turn-metadata.request_kind",
      value: "memory",
    },
  ],
});
const codexPrewarmBody = {
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "prewarm",
      thread_source: "user",
      thread_id: "thread-main",
      turn_id: "turn-prewarm",
    }),
  },
};
assert.deepEqual(classifyCodexRequestOperation({}, codexPrewarmBody), {
  type: "metadata",
  label: "Codex 对话预热请求",
  label_key: "codexPrewarmRequest",
  note_key: "codexPrewarmNote",
  actor: "harness",
  operation: "responses_prewarm",
  request_kind: "prewarm",
  turn_placement: "next_turn",
  relation: "current_dialogue",
  confidence: "high",
  evidence: [
    {
      origin: "request_body",
      field: "client_metadata.x-codex-turn-metadata.request_kind",
      value: "prewarm",
    },
  ],
});
assert.deepEqual(codexTurnMetadataObservation(codexMemoryBody), {
  metadata: {
    request_kind: "memory",
    thread_source: "user",
    thread_id: "thread-main",
    turn_id: "turn-memory",
  },
  sources: {
    request_kind: "client_metadata.x-codex-turn-metadata.request_kind",
    thread_source: "client_metadata.x-codex-turn-metadata.thread_source",
    thread_id: "client_metadata.x-codex-turn-metadata.thread_id",
    turn_id: "client_metadata.x-codex-turn-metadata.turn_id",
  },
});
assert.equal(
  codexTurnMetadata({}, { headers: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } }).request_kind,
  "compaction",
  "an unredacted protocol header remains a supported fallback",
);
assert.deepEqual(
  classifyCodexRequestOperation(
    { header_semantics: { codex_turn_metadata: { request_kind: "memory", thread_source: "user" } } },
    {},
  ),
  {
    type: "background",
    label: "Codex 后台任务 · 记忆提取",
    label_key: "codexMemoryBackgroundTask",
    note_key: "codexMemoryBackgroundNote",
    actor: "background_service",
    relation: "independent",
    operation: "codex_memory_extraction",
    request_kind: "memory",
    confidence: "high",
    evidence: [
      {
        origin: "request_header",
        field: "header_semantics.codex_turn_metadata.request_kind",
        value: "memory",
      },
    ],
  },
  "safe pre-redaction header semantics classify background work when the body omits duplicated metadata",
);
assert.equal(codexTurnMetadata({}, { headers: { "x-codex-turn-metadata": "[REDACTED:header]" } }), null);
assert.equal(classifyCodexRequestOperation({}, { client_metadata: { "x-codex-turn-metadata": "not-json" } }), null);
assert.deepEqual(
  classifyCodexRequestOperation({}, { client_metadata: { request_kind: "maintenance" } }),
  {
    type: "background",
    label: "Codex 后台任务",
    label_key: "codexBackgroundTask",
    note_key: "codexBackgroundTaskNote",
    actor: "background_service",
    operation: "codex_maintenance",
    request_kind: "maintenance",
    relation: "independent",
    confidence: "high",
    evidence: [
      { origin: "request_body", field: "client_metadata.request_kind", value: "maintenance" },
    ],
  },
  "unknown explicit non-turn kinds default to an isolated background chain",
);
assert.equal(isCodexSubagentRequest({ headers: { "x-openai-subagent": "true" } }), true);
assert.equal(isCodexSubagentRequest({ headers: { "x-openai-subagent": "false" } }), false);
assert.equal(
  isCodexSubagentRequest({ header_redactions: [{ field_path: "headers.x-codex-parent-thread-id" }] }),
  true,
  "redaction evidence retains safe parent-thread presence without persisting the private identifier",
);
const codexChildBody = {
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      request_kind: "turn",
      thread_source: "subagent",
      thread_id: "child-from-turn-metadata",
      parent_thread_id: "parent-from-turn-metadata",
      subagent_kind: "thread_spawn",
    }),
  },
};
assert.equal(isCodexSubagentRequest({}, codexChildBody), true);
assert.deepEqual(codexSubagentIdentity({}, codexChildBody), {
  agent_id: "child-from-turn-metadata",
  parent_agent_id: "parent-from-turn-metadata",
  source: "client_metadata",
});
assert.equal(
  isCodexSubagentRequest({ header_redactions: [{ field_path: "headers.x-openai-subagent" }] }),
  true,
  "a redacted subagent marker still identifies the actor class",
);
assert.deepEqual(
  codexSubagentIdentity(
    { headers: { "x-openai-subagent": "collab_spawn" } },
    {
      client_metadata: {
        thread_id: "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
      },
    },
  ),
  { agent_id: "child-thread", parent_agent_id: "parent-thread", source: "client_metadata" },
  "Codex exact proxy metadata retains the child identity needed to correlate its independent requests",
);
assert.equal(codexSubagentIdentity({ headers: {} }, { client_metadata: { thread_id: "main-thread" } }), null);

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
  infer({ capture: { path: "/v1/responses/compact", headers: { "x-openai-subagent": "true" } } }),
  {
    type: "metadata",
    label: "Harness 上下文压缩请求",
    label_key: "contextCompactionRequest",
    actor: "harness",
    relation: "current_dialogue",
    operation: "context_compaction",
    confidence: "high",
    evidence: [{ origin: "transport", field: "path", value: "/v1/responses/compact" }],
  },
  "transport operation wins over subagent evidence so compaction is not presented as a model turn",
);
assert.equal(infer({ body: codexMemoryBody }).type, "background");
assert.equal(
  infer({
    body: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) },
      messages: [],
    },
  }).operation,
  "context_compaction",
  "body protocol metadata recognizes compaction even on the generic Responses route",
);

assert.deepEqual(
  infer({ capture: { path: "/v1/messages/count_tokens", headers: { "x-claude-code-agent-id": "child" } } }),
  {
    type: "metadata",
    label: "上下文统计 (/context)",
    actor: "harness",
    relation: "current_dialogue",
    operation: "context_token_count",
    confidence: "high",
    evidence: [{ origin: "transport", field: "path", value: "/v1/messages/count_tokens" }],
  },
  "metadata classification wins over child-agent evidence",
);
assert.equal(infer({ lastUser: user("[SUGGESTION MODE: suggest the next input]") }).type, "metadata");
assert.equal(infer({ lastUser: user("<system-reminder>framework note</system-reminder>") }).type, "metadata");
assert.deepEqual(
  infer({ body: { system: "Generate a concise, sentence-case title", messages: [] } }),
  {
    type: "metadata",
    label: "生成会话标题",
    label_key: "sessionTitleGenerationRequest",
    note_key: "sessionTitleGenerationNote",
    actor: "harness",
    relation: "current_dialogue",
    operation: "session_title_generation",
    turn_placement: "trigger_turn",
    confidence: "high",
    evidence: [{ origin: "request_body", field: "semantic_shape", value: "title_generation" }],
  },
);
assert.equal(
  infer({
    capture: { agent_profile: "Claude Code" },
    body: { system: "Generate a concise, sentence-case title", messages: [] },
  }).turn_placement,
  "next_turn",
  "Claude Code emits title generation between the previous and next visible turns",
);
assert.equal(infer({ body: { tool_choice: { name: "web_search" }, messages: [] } }).label, "WebSearch 内部请求");
assert.deepEqual(
  infer({ capture: { headers: { "X-Claude-Code-Agent-Id": "agent-1" } }, debugSource: { source: "agent:Explore" } }),
  {
    type: "subagent",
    label: "agent:Explore",
    actor: "subagent",
    relation: "child_dialogue",
    operation: "subagent_turn",
    confidence: "high",
    evidence: [{ origin: "request_header", field: "x-claude-code-agent-id", value: "present" }],
  },
);
assert.deepEqual(
  infer({ capture: { headers: { "X-OpenAI-Subagent": "reviewer" } } }),
  {
    type: "subagent",
    label: "Codex 子 Agent",
    actor: "subagent",
    relation: "child_dialogue",
    operation: "subagent_turn",
    confidence: "high",
    evidence: [{ origin: "request_header", field: "x-openai-subagent", value: "present" }],
  },
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
  assert.deepEqual(source, {
    type: "parent_spawn",
    label: "启动子代理",
    actor: "main_agent",
    relation: "current_dialogue",
    operation: "subagent_spawn",
    confidence: "high",
    evidence: [{ origin: "message", field: "tool_call.name", value: toolName }],
  });
}
assert.deepEqual(infer(), {
  type: "main",
  label: "主代理请求",
  actor: "main_agent",
  relation: "current_dialogue",
  operation: "model_turn",
  confidence: "medium",
  evidence: [{ origin: "fallback", field: "classification", value: "main_agent" }],
});

const moduleSource = fs.readFileSync(new URL("../src/trace/request-profile.mjs", import.meta.url), "utf8");
assert.doesNotMatch(moduleSource, /from ["']\.\.\/(?:viewer|server|core|adapters)\//, "request profile stays inside the Trace Domain");

console.log("request profile contract smoke passed");
