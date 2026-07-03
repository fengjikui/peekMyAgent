import fs from "node:fs";

const args = process.argv.slice(2);
const inputPath = optionValue("--input") || "tmp/trae-openai-last2-raw-analysis.json";
const outPath = optionValue("--out");

const reportInput = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const requests = Array.isArray(reportInput.requests) ? reportInput.requests : [];
const report = {
  generated_at: new Date().toISOString(),
  input: inputPath,
  spec_basis: [
    {
      protocol: "openai_chat_completions",
      source: "https://developers.openai.com/api/reference/resources/chat",
      key_points: [
        "POST /v1/chat/completions",
        "request messages array with roles such as system/user/assistant/tool",
        "tools use type:function with function name/arguments",
        "stream chunks use choices[].delta with content and optional tool_calls",
      ],
    },
    {
      protocol: "anthropic_messages",
      source: "https://platform.claude.com/docs/en/build-with-claude/streaming",
      key_points: [
        "POST /v1/messages",
        "stream events include message_start, content_block_delta, message_delta, message_stop",
        "tool_use parameters stream as input_json_delta.partial_json",
      ],
    },
    {
      protocol: "gemini_generate_content",
      source: "https://ai.google.dev/api",
      key_points: [
        "generateContent / streamGenerateContent endpoints",
        "request uses contents rather than OpenAI messages",
        "stream responses use Gemini candidates/parts shape",
      ],
    },
  ],
  provider_profiles: [
    {
      provider: "xiaomi_mimo",
      official_docs: {
        openai_compatible: "https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api",
        anthropic_compatible: "https://platform.xiaomimimo.com/docs/zh-CN/api/chat/anthropic-api",
        reasoning_content_notice: "https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/passing-back-reasoning_content",
      },
      model_patterns: ["mimo-*"],
      known_extensions: ["thinking request parameter", "reasoning_content in assistant history and streaming deltas", "reasoning_tokens", "cached_tokens"],
    },
  ],
  requests: requests.map(checkRequest),
};

const output = JSON.stringify(report, null, 2);
if (outPath) fs.writeFileSync(outPath, `${output}\n`);
else console.log(output);

function checkRequest(request) {
  const raw = request.raw || {};
  const body = raw.request_body || {};
  const responseText = raw.response_body_text || "";
  const responseHeaders = raw.response_headers || {};
  const events = parseSseEvents(responseText);
  const parsedEvents = events.map((event) => ({ event: event.event, data: event.data, json: event.data === "[DONE]" ? "[DONE]" : parseJson(event.data) }));
  const inferred = inferProtocol(request, body, parsedEvents);
  const provider = inferProvider(request, body, parsedEvents);
  const openAi = checkOpenAiChatCompletions(request, body, responseHeaders, parsedEvents);
  const anthropic = checkAnthropicMessages(request, body, parsedEvents);
  const gemini = checkGeminiGenerateContent(request, body, parsedEvents);

  return {
    request_index: request.request_index,
    path: request.path,
    model: body.model || request.model || null,
    inferred_protocol: inferred.protocol,
    confidence: inferred.confidence,
    provider_hint: provider,
    conclusion: openAi.score >= 8 ? "matches OpenAI-compatible Chat Completions with extensions" : inferred.reason,
    checks: {
      openai_chat_completions: openAi,
      anthropic_messages: anthropic,
      gemini_generate_content: gemini,
    },
  };
}

function inferProtocol(request, body, parsedEvents) {
  const path = request.path || "";
  if (/\/v1\/chat\/completions(?:$|[?#/])/.test(path) && Array.isArray(body.messages)) {
    return { protocol: "openai_chat_completions", confidence: "high", reason: "path and request body match OpenAI-compatible chat completions" };
  }
  if (/\/v1\/messages(?:$|[?#/])/.test(path) && Array.isArray(body.messages)) {
    return { protocol: "anthropic_messages", confidence: "high", reason: "path and request body match Anthropic Messages" };
  }
  if (/(generateContent|streamGenerateContent)/.test(path) || Array.isArray(body.contents)) {
    return { protocol: "gemini_generate_content", confidence: "high", reason: "path or request body match Gemini content generation" };
  }
  if (parsedEvents.some((event) => Array.isArray(event.json?.choices))) {
    return { protocol: "openai_chat_completions", confidence: "medium", reason: "response stream uses OpenAI-compatible choices chunks" };
  }
  return { protocol: "unknown", confidence: "low", reason: "no public protocol shape matched" };
}

function inferProvider(request, body, parsedEvents) {
  const model = String(body.model || request.model || firstResponseModel(parsedEvents) || "");
  if (/^mimo(?:-|_)/i.test(model)) {
    return {
      provider: "xiaomi_mimo",
      confidence: "high",
      evidence: [`model=${model}`],
      official_docs: {
        openai_compatible: "https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api",
        anthropic_compatible: "https://platform.xiaomimimo.com/docs/zh-CN/api/chat/anthropic-api",
        reasoning_content_notice: "https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/passing-back-reasoning_content",
      },
      expected_extensions: [
        "thinking parameter in request body",
        "reasoning_content must be preserved in agent multi-turn history when thinking/tool calls are involved",
        "usage.completion_tokens_details.reasoning_tokens",
        "usage.prompt_tokens_details.cached_tokens",
      ],
    };
  }
  return { provider: "unknown", confidence: "low", evidence: model ? [`model=${model}`] : [] };
}

function firstResponseModel(parsedEvents) {
  for (const event of parsedEvents) {
    if (event.json && typeof event.json === "object" && typeof event.json.model === "string") return event.json.model;
  }
  return null;
}

function checkOpenAiChatCompletions(request, body, headers, parsedEvents) {
  const matches = [];
  const optionals = [];
  const extensions = [];
  const warnings = [];
  const mismatches = [];

  add(matches, mismatches, /\/v1\/chat\/completions(?:$|[?#/])/.test(request.path || ""), "path is /v1/chat/completions", "path is not /v1/chat/completions");
  add(matches, mismatches, typeof body.model === "string", "body.model is a string", "body.model is missing or not a string");
  add(matches, mismatches, Array.isArray(body.messages), "body.messages is an array", "body.messages is missing or not an array");
  add(matches, mismatches, body.stream === true || body.stream === false || body.stream == null, "body.stream is boolean or omitted", "body.stream has unexpected type");

  if (Array.isArray(body.messages)) {
    const roles = unique(body.messages.map((message) => message?.role).filter(Boolean));
    const allowedRoles = new Set(["developer", "system", "user", "assistant", "tool"]);
    add(matches, mismatches, roles.every((role) => allowedRoles.has(role)), `message roles are OpenAI-compatible: ${roles.join(", ")}`, `unknown OpenAI message role found: ${roles.join(", ")}`);
    const toolResults = body.messages.filter((message) => message?.role === "tool");
    if (toolResults.length) add(matches, mismatches, toolResults.every((message) => typeof message.tool_call_id === "string"), "tool result messages include tool_call_id", "some tool messages miss tool_call_id");
    const assistantToolCalls = body.messages.flatMap((message) => (Array.isArray(message?.tool_calls) ? message.tool_calls : []));
    if (assistantToolCalls.length) add(matches, mismatches, assistantToolCalls.every(isOpenAiToolCall), "assistant.tool_calls use OpenAI-compatible function tool call shape", "some assistant.tool_calls do not match function tool call shape");
    const messageReasoning = body.messages.filter((message) => typeof message?.reasoning_content === "string");
    if (messageReasoning.length) extensions.push(`assistant/history messages include reasoning_content (${messageReasoning.length} messages)`);
  }

  if (Array.isArray(body.tools)) {
    add(matches, mismatches, body.tools.every(isOpenAiToolDefinition), `tools use OpenAI-compatible function definitions (${body.tools.length})`, "some tools do not match OpenAI function definition shape");
  } else {
    optionals.push("tools omitted");
  }

  if (body.max_tokens != null) optionals.push("max_tokens present; accepted by many OpenAI-compatible chat providers, but newer official OpenAI models may prefer max_completion_tokens");
  const contentType = headerValue(headers, "content-type");
  if (body.stream === true) add(matches, mismatches, /event-stream/i.test(contentType), "stream response content-type is text/event-stream", "stream request did not return event-stream content-type");

  const dataEvents = parsedEvents.filter((event) => event.json && event.json !== "[DONE]");
  if (dataEvents.length) add(matches, mismatches, dataEvents.every((event) => Array.isArray(event.json?.choices)), "SSE data events use choices[] chunks", "some SSE data events do not use choices[] chunks");

  let sawDelta = false;
  let sawContent = false;
  let sawToolCalls = false;
  let sawDone = false;
  let sawReasoning = false;
  let sawUsage = false;
  for (const event of parsedEvents) {
    if (event.json === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (!event.json || typeof event.json !== "object") continue;
    if (event.json.usage) sawUsage = true;
    for (const choice of event.json.choices || []) {
      if (choice.delta && typeof choice.delta === "object") sawDelta = true;
      if (typeof choice.delta?.content === "string") sawContent = true;
      if (Array.isArray(choice.delta?.tool_calls)) {
        sawToolCalls = true;
        const ok = choice.delta.tool_calls.every((call) => typeof call.index === "number" && (!call.function || typeof call.function === "object"));
        add(matches, mismatches, ok, "streaming delta.tool_calls include index and function fragments", "streaming delta.tool_calls have unexpected shape");
      }
      if (typeof choice.delta?.reasoning_content === "string") sawReasoning = true;
      if (choice.finish_reason) optionals.push(`finish_reason observed: ${choice.finish_reason}`);
    }
  }
  add(matches, mismatches, sawDelta, "stream chunks include choices[].delta", "stream chunks do not include choices[].delta");
  if (sawContent) matches.push("stream chunks include delta.content");
  if (sawToolCalls) matches.push("stream chunks include delta.tool_calls");
  if (sawDone) matches.push("stream ends with data: [DONE]");
  if (sawUsage) optionals.push("stream includes usage object");
  if (sawReasoning) extensions.push("choices[].delta.reasoning_content is present; treat as provider extension, not official OpenAI core field");

  return summarizeCheck(matches, optionals, extensions, warnings, mismatches);
}

function checkAnthropicMessages(request, body, parsedEvents) {
  const matches = [];
  const mismatches = [];
  const observedAnthropicEvents = parsedEvents
    .map((event) => event.json?.type)
    .filter((type) => typeof type === "string" && /^(message_|content_block_|ping|error)/.test(type));
  if (/\/v1\/messages(?:$|[?#/])/.test(request.path || "")) matches.push("path is /v1/messages");
  else mismatches.push("path is not /v1/messages");
  if (Array.isArray(body.messages) && Array.isArray(body.system)) matches.push("body has Anthropic-style top-level system plus messages");
  else mismatches.push("body does not have Anthropic-style top-level system array");
  if (observedAnthropicEvents.length) matches.push(`SSE includes Anthropic event types: ${unique(observedAnthropicEvents).join(", ")}`);
  else mismatches.push("SSE does not include Anthropic message_start/content_block_delta/message_stop events");
  return { score: matches.length, matches, mismatches };
}

function checkGeminiGenerateContent(request, body, parsedEvents) {
  const matches = [];
  const mismatches = [];
  if (/(generateContent|streamGenerateContent)/.test(request.path || "")) matches.push("path contains generateContent or streamGenerateContent");
  else mismatches.push("path does not contain generateContent or streamGenerateContent");
  if (Array.isArray(body.contents)) matches.push("body.contents is present");
  else mismatches.push("body.contents is absent");
  if (parsedEvents.some((event) => Array.isArray(event.json?.candidates))) matches.push("response chunks include candidates[]");
  else mismatches.push("response chunks do not include Gemini candidates[]");
  return { score: matches.length, matches, mismatches };
}

function summarizeCheck(matches, optionals, extensions, warnings, mismatches) {
  const uniqueMatches = unique(matches);
  return {
    score: uniqueMatches.length,
    matches: uniqueMatches,
    optional_or_legacy_fields: unique(optionals),
    extensions: unique(extensions),
    warnings: unique(warnings),
    mismatches: unique(mismatches),
  };
}

function isOpenAiToolDefinition(tool) {
  return tool?.type === "function" && typeof tool.function?.name === "string" && (tool.function.parameters == null || typeof tool.function.parameters === "object");
}

function isOpenAiToolCall(call) {
  return typeof call?.id === "string" && call.type === "function" && typeof call.function?.name === "string" && typeof call.function?.arguments === "string";
}

function add(matches, mismatches, condition, ok, fail) {
  if (condition) matches.push(ok);
  else mismatches.push(fail);
}

function parseSseEvents(text) {
  const events = [];
  let current = { event: null, data: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
      current = { event: null, data: [] };
      continue;
    }
    if (line.startsWith("event:")) current.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) current.data.push(line.slice("data:".length).trim());
  }
  if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
  return events;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}
