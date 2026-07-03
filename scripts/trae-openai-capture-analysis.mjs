import fs from "node:fs";

const args = process.argv.slice(2);
const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || "http://127.0.0.1:43110";
const sourceId = optionValue("--source") || "live-trae-cn-mpy3o9r1-66aede";
const limit = Number(optionValue("--limit") || 2);
const outPath = optionValue("--out");
const includeRaw = args.includes("--include-raw");

const view = await getJson(`${trimSlash(viewerUrl)}/api/view?source=${encodeURIComponent(sourceId)}`);
const requests = (view.requests || []).slice(Number.isFinite(limit) && limit > 0 ? -limit : -2);
const report = {
  generated_at: new Date().toISOString(),
  source: {
    id: view.source?.id,
    label: view.source?.label,
    agent: view.source?.agent,
    request_count: view.stats?.request_count,
    response_count: view.stats?.response_count,
  },
  requests: requests.map(analyzeRequest),
};

const output = JSON.stringify(report, null, 2);
if (outPath) fs.writeFileSync(outPath, `${output}\n`);
else console.log(output);

function analyzeRequest(request) {
  const body = request.raw?.body || {};
  const response = request.raw?.response || {};
  const responseText = response.body_text || "";
  const events = parseSseEvents(responseText);
  const sse = analyzeSseEvents(events);
  const analyzed = {
    request_index: request.request_index,
    captured_at: request.captured_at,
    path: request.path,
    model: body.model || request.model || null,
    stream: Boolean(body.stream),
    body_keys: Object.keys(body),
    messages: {
      count: Array.isArray(body.messages) ? body.messages.length : 0,
      roles: Array.isArray(body.messages) ? summarizeRoles(body.messages) : {},
      first: summarizeMessage(body.messages?.[0]),
      last: Array.isArray(body.messages) ? body.messages.slice(-5).map(summarizeMessage) : [],
    },
    tools: {
      count: Array.isArray(body.tools) ? body.tools.length : 0,
      names: Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name || tool.name || tool.type).filter(Boolean) : [],
    },
    response: {
      status: response.status,
      content_type: headerValue(response.headers, "content-type"),
      raw_body_length: response.raw_body_length,
      captured_body_length: response.captured_body_length,
      stream_event_count: events.length,
      summary_preview: request.summary?.response?.preview || "",
      summary_thinking_preview: request.summary?.response?.thinking_preview || "",
      summary_tool_calls: request.summary?.response?.tool_calls || [],
      sse,
      first_events: events.slice(0, 6).map((event) => event.data.slice(0, 360)),
    },
  };
  if (includeRaw) {
    analyzed.raw = {
      request_body: body,
      response_body_text: responseText,
      response_headers: response.headers || {},
    };
  }
  return analyzed;
}

function analyzeSseEvents(events) {
  const textParts = [];
  const reasoningParts = [];
  let textChars = 0;
  let reasoningChars = 0;
  let toolCallChunks = 0;
  let done = false;
  const finishReasons = [];
  const usageSamples = [];
  const toolBlocks = new Map();
  for (const event of events) {
    if (!event.data) continue;
    if (event.data === "[DONE]") {
      done = true;
      continue;
    }
    const data = parseJson(event.data);
    if (!data) continue;
    if (data.usage) usageSamples.push(data.usage);
    if (!Array.isArray(data.choices)) continue;
    for (const choice of data.choices) {
      if (choice.finish_reason) finishReasons.push(choice.finish_reason);
      const delta = choice.delta || {};
      if (delta.content) {
        const content = String(delta.content);
        textParts.push(content);
        textChars += content.length;
      }
      if (delta.reasoning_content) {
        const reasoning = String(delta.reasoning_content);
        reasoningParts.push(reasoning);
        reasoningChars += reasoning.length;
      }
      if (Array.isArray(delta.tool_calls)) {
        toolCallChunks += delta.tool_calls.length;
        mergeToolBlocks(toolBlocks, delta.tool_calls);
      }
    }
  }
  return {
    done,
    text_chars: textChars,
    reasoning_chars: reasoningChars,
    text_preview: textParts.join("").slice(0, 500),
    reasoning_preview: reasoningParts.join("").slice(0, 500),
    tool_call_chunk_count: toolCallChunks,
    reconstructed_tool_calls: [...toolBlocks.values()].map((block) => ({
      id: block.id || null,
      name: block.name || "unknown",
      arguments: parseMaybeJson(block.argumentsText),
      arguments_preview: block.argumentsText.slice(0, 500),
    })),
    finish_reasons: unique(finishReasons),
    usage: usageSamples.at(-1) || null,
  };
}

function mergeToolBlocks(blocks, chunks) {
  for (const chunk of chunks || []) {
    const key = chunk.index ?? chunk.id ?? blocks.size;
    const current = blocks.get(key) || { id: null, name: null, argumentsText: "" };
    if (chunk.id) current.id = chunk.id;
    if (chunk.function?.name) current.name = chunk.function.name;
    if (chunk.name) current.name = chunk.name;
    if (chunk.function?.arguments) current.argumentsText += chunk.function.arguments;
    if (chunk.arguments) current.argumentsText += chunk.arguments;
    blocks.set(key, current);
  }
}

function parseMaybeJson(text) {
  if (!text) return null;
  const parsed = parseJson(text);
  return parsed ?? text;
}

function summarizeMessage(message) {
  if (!message) return null;
  return {
    role: message.role,
    keys: Object.keys(message),
    content_type: Array.isArray(message.content) ? "array" : typeof message.content,
    content_chars: extractContentText(message.content).length,
    content_preview: extractContentText(message.content).slice(0, 240),
    reasoning_chars: String(message.reasoning_content || "").length,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id || null,
          name: call.function?.name || call.name || "unknown",
          arguments_preview: String(call.function?.arguments || call.arguments || "").slice(0, 240),
        }))
      : [],
    tool_call_id: message.tool_call_id || null,
  };
}

function summarizeRoles(messages) {
  const counts = {};
  for (const message of messages) counts[message.role || "unknown"] = (counts[message.role || "unknown"] || 0) + 1;
  return counts;
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractContentText).filter(Boolean).join("\n");
  if (content && typeof content === "object") return content.text || content.content || JSON.stringify(content);
  return "";
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

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
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
