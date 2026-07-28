import { rawUpstreamComposition, rawUpstreamRequestMetadata } from "./raw-view-model.js";
import { providerUsageForRequest } from "./upstream-detail-model.js";

const COMPOSITION_KEYS = [
  "system",
  "tools",
  "history_context",
  "current_user",
  "tool_result",
  "params",
];

const PARAMETER_GROUPS = ["model", "reasoning", "sampling", "output", "tools", "execution"];
const SHORT_STRING_LIMIT = 160;
const SHORT_ARRAY_ITEM_LIMIT = 6;
const SHORT_ARRAY_CHARS_LIMIT = 240;

const COMMON_PARAMETER_SPECS = [
  parameterSpec("model", "model", ["model"]),
  parameterSpec("sampling", "temperature", ["temperature"]),
  parameterSpec("sampling", "top_p", ["top_p"]),
  parameterSpec("execution", "stream", ["stream"]),
  parameterSpec("execution", "service_tier", ["service_tier"]),
];

const PROTOCOL_PARAMETER_SPECS = Object.freeze({
  openai_responses: [
    parameterSpec("reasoning", "reasoning_effort", ["reasoning", "effort"]),
    parameterSpec("reasoning", "reasoning_summary", ["reasoning", "summary"]),
    parameterSpec("output", "max_output_tokens", ["max_output_tokens"]),
    parameterSpec("output", "output_verbosity", ["text", "verbosity"]),
    parameterSpec("output", "response_format", ["text", "format", "type"]),
    parameterSpec("output", "response_schema", ["text", "format", "name"]),
    parameterSpec("output", "top_logprobs", ["top_logprobs"]),
    ...toolChoiceSpecs(),
    parameterSpec("tools", "parallel_tool_calls", ["parallel_tool_calls"]),
    parameterSpec("execution", "background", ["background"]),
    parameterSpec("execution", "store", ["store"]),
    parameterSpec("execution", "truncation", ["truncation"]),
  ],
  openai_chat_completions: [
    parameterSpec("reasoning", "reasoning_effort", ["reasoning_effort"]),
    parameterSpec("output", "output_verbosity", ["verbosity"]),
    parameterSpec("output", "max_completion_tokens", ["max_completion_tokens"]),
    parameterSpec("output", "max_tokens", ["max_tokens"]),
    parameterSpec("output", "response_format", ["response_format", "type"]),
    parameterSpec("output", "response_schema", ["response_format", "json_schema", "name"]),
    parameterSpec("output", "modalities", ["modalities"]),
    parameterSpec("output", "audio_format", ["audio", "format"]),
    parameterSpec("output", "audio_voice", ["audio", "voice"]),
    parameterSpec("output", "choice_count", ["n"]),
    parameterSpec("output", "stop", ["stop"]),
    parameterSpec("output", "logprobs", ["logprobs"]),
    parameterSpec("output", "top_logprobs", ["top_logprobs"]),
    parameterSpec("sampling", "seed", ["seed"]),
    parameterSpec("sampling", "frequency_penalty", ["frequency_penalty"]),
    parameterSpec("sampling", "presence_penalty", ["presence_penalty"]),
    ...toolChoiceSpecs(),
    parameterSpec("tools", "parallel_tool_calls", ["parallel_tool_calls"]),
  ],
  anthropic_messages: [
    parameterSpec("reasoning", "thinking_type", ["thinking", "type"]),
    parameterSpec("reasoning", "thinking_budget_tokens", ["thinking", "budget_tokens"]),
    parameterSpec("reasoning", "reasoning_effort", ["output_config", "effort"]),
    parameterSpec("sampling", "top_k", ["top_k"]),
    parameterSpec("output", "max_tokens", ["max_tokens"]),
    parameterSpec("output", "stop_sequences", ["stop_sequences"]),
    parameterSpec("output", "response_format", ["output_config", "format", "type"]),
    ...toolChoiceSpecs(),
  ],
  unknown: [
    parameterSpec("reasoning", "reasoning_effort", ["reasoning_effort"]),
    parameterSpec("reasoning", "reasoning_effort", ["reasoning", "effort"]),
    parameterSpec("reasoning", "thinking_type", ["thinking", "type"]),
    parameterSpec("reasoning", "thinking_budget_tokens", ["thinking", "budget_tokens"]),
    parameterSpec("sampling", "top_k", ["top_k"]),
    parameterSpec("sampling", "seed", ["seed"]),
    parameterSpec("output", "max_output_tokens", ["max_output_tokens"]),
    parameterSpec("output", "max_completion_tokens", ["max_completion_tokens"]),
    parameterSpec("output", "max_tokens", ["max_tokens"]),
    parameterSpec("output", "stop", ["stop"]),
    parameterSpec("output", "stop_sequences", ["stop_sequences"]),
    ...toolChoiceSpecs(),
    parameterSpec("tools", "parallel_tool_calls", ["parallel_tool_calls"]),
  ],
});

export function buildMetadataView(request = {}) {
  const metadata = rawUpstreamRequestMetadata(request);
  const usage = providerUsageForRequest(request);
  const composition = rawUpstreamComposition(request) || {};
  const responseUsage = request?.summary?.response?.usage || request?.response?.usage || null;
  const attribution = metadata.request_attribution;

  return {
    identity: compactFacts({
      request_index: metadata.request_index,
      capture_id: metadata.capture_id,
      conversation_id: metadata.conversation_id,
      watch_id: metadata.watch_id,
      agent_profile: metadata.agent_profile,
      workspace: metadata.workspace,
    }),
    transport: compactFacts({
      received_at: metadata.received_at,
      method: metadata.method,
      path: metadata.path,
      original_url: metadata.original_url,
      raw_body_length: metadata.raw_body_length,
      body_source: metadata.body_source,
    }),
    providerUsage: responseUsage
      ? {
          input: usage.input,
          cache: usage.cache,
          actualInput: usage.actualInput,
          output: usage.output,
          totalInput: usage.total,
          cacheRatio: usage.total ? usage.cache / usage.total : 0,
          actualRatio: usage.total ? usage.actualInput / usage.total : 0,
        }
      : null,
    generationParameters: extractRequestGenerationParameters({
      protocol: request?.protocol || request?.summary?.protocol?.protocol,
      body: request?.raw?.body,
    }),
    composition: {
      unit: composition.unit || "chars",
      total: Number(composition.total_payload_chars || composition.input_chars || 0),
      sections: COMPOSITION_KEYS.map((key) => ({
        key,
        chars: Number(composition.sections?.[key]?.chars || 0),
        ratio: Number(composition.sections?.[key]?.ratio || 0),
      })).filter((item) => item.chars > 0),
    },
    attribution: attribution
      ? {
          facts: compactFacts({
            actor: attribution.actor,
            relation: attribution.relation,
            operation: attribution.operation,
            request_kind: attribution.request_kind,
            confidence: attribution.confidence,
          }),
          evidence: Array.isArray(attribution.evidence) ? attribution.evidence : [],
        }
      : null,
    evidence: {
      transport: metadata.upstream_evidence?.transport || null,
      request: metadata.upstream_evidence?.request || null,
      sections: metadata.upstream_evidence?.sections || null,
      headerRedactions: metadata.header_redactions || null,
      contextDelta: metadata.context_delta || null,
    },
  };
}

export function extractRequestGenerationParameters({ protocol = "unknown", body = {} } = {}) {
  const normalizedProtocol = PROTOCOL_PARAMETER_SPECS[protocol] ? protocol : "unknown";
  const specs = [...COMMON_PARAMETER_SPECS, ...PROTOCOL_PARAMETER_SPECS[normalizedProtocol]];
  const seenPaths = new Set();
  const groupedFacts = new Map(PARAMETER_GROUPS.map((group) => [group, []]));

  for (const spec of specs) {
    const sourcePath = jsonPath(spec.path);
    if (seenPaths.has(sourcePath)) continue;
    seenPaths.add(sourcePath);
    const compacted = compactParameterValue(readPath(body, spec.path));
    if (!compacted) continue;
    groupedFacts.get(spec.group).push({
      key: spec.key,
      native_key: spec.path.join("."),
      source_path: sourcePath,
      ...compacted,
    });
  }

  const groups = PARAMETER_GROUPS
    .map((key) => ({ key, facts: groupedFacts.get(key) }))
    .filter((group) => group.facts.length > 0);
  return {
    protocol: normalizedProtocol,
    count: groups.reduce((total, group) => total + group.facts.length, 0),
    groups,
  };
}

function compactFacts(value) {
  return Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .map(([key, item]) => ({ key, value: item }));
}

function parameterSpec(group, key, path) {
  return { group, key, path };
}

function toolChoiceSpecs() {
  return [
    parameterSpec("tools", "tool_choice", ["tool_choice"]),
    parameterSpec("tools", "tool_choice_type", ["tool_choice", "type"]),
    parameterSpec("tools", "tool_choice_name", ["tool_choice", "name"]),
    parameterSpec("tools", "tool_choice_name", ["tool_choice", "function", "name"]),
    parameterSpec("tools", "tool_choice_mode", ["tool_choice", "mode"]),
    parameterSpec("tools", "disable_parallel_tool_use", ["tool_choice", "disable_parallel_tool_use"]),
  ];
}

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function compactParameterValue(value) {
  if (value === undefined || value === null) return null;
  if (["number", "boolean"].includes(typeof value)) return { value };
  if (typeof value === "string") {
    if (!value) return null;
    if (value.length <= SHORT_STRING_LIMIT) return { value };
    return {
      value: `${value.slice(0, SHORT_STRING_LIMIT - 1)}…`,
      truncated_chars: value.length - (SHORT_STRING_LIMIT - 1),
      original_chars: value.length,
    };
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const preview = [];
  let chars = 0;
  for (const item of value) {
    if (!["string", "number", "boolean"].includes(typeof item)) break;
    const itemChars = JSON.stringify(item).length;
    if (preview.length >= SHORT_ARRAY_ITEM_LIMIT || chars + itemChars > SHORT_ARRAY_CHARS_LIMIT) break;
    preview.push(item);
    chars += itemChars;
  }
  if (!preview.length) return null;
  return {
    value: preview,
    ...(preview.length < value.length ? { omitted_items: value.length - preview.length, original_items: value.length } : {}),
  };
}

function jsonPath(path) {
  return `$.${path.join(".")}`;
}
