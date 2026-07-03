import { baseNormalizedRequest, collectMessageRedactions, normalizeMessage, requestParams } from "../core/normalize.mjs";
import { redactHeaders, safeJsonShape, sanitizeEndpoint } from "../core/redaction.mjs";

export function normalizeOpenClawProxyCapture(capture) {
  const path = sanitizeEndpoint(capture.path || capture.url || "");
  const body = capture.body || {};
  const { headers, redactions } = redactHeaders(capture.headers || {});
  const endpoint = detectOpenAIEndpoint(path, body);
  const validPayload = isValidPayload(endpoint, body);
  const confidence = endpoint !== "unknown" && validPayload ? "exact" : "partial";
  const messages =
    endpoint === "responses"
      ? normalizeResponsesInput(body.input)
      : endpoint === "chat_completions"
        ? normalizeChatMessages(body.messages)
        : [];
  const allRedactions = [...redactions, ...collectMessageRedactions(messages)];

  return baseNormalizedRequest({
    captureId: capture.captureId || capture.capture_id,
    watchId: capture.watchId || capture.watch_id,
    capturedAt: capture.receivedAt || capture.received_at,
    requestIndex: capture.requestIndex || capture.request_index,
    agentProfile: capture.agentProfile || capture.agent_profile,
    workspace: capture.workspace,
    conversationId: capture.conversationId || capture.conversation_id,
    sourceAgent: "OpenClaw",
    adapterName: "openclaw-openai-proxy",
    captureMethod: "proxy",
    captureConfidence: confidence,
    isFinalRemoteRequest: confidence === "exact",
    providerProtocol:
      endpoint === "responses" ? "openai-responses" : endpoint === "chat_completions" ? "openai-chat-completions" : "unknown",
    endpoint: path,
    method: capture.method || "POST",
    model: body.model,
    messages,
    tools: body.tools,
    requestParams: requestParams(body),
    redactions: allRedactions,
    source: {
      type: "proxy",
      capture_id: capture.captureId || capture.capture_id || null,
      watch_id: capture.watchId || capture.watch_id || null,
      received_at: capture.receivedAt || capture.received_at || null,
      request_index: capture.requestIndex || capture.request_index || null,
      agent_profile: capture.agentProfile || capture.agent_profile || null,
      workspace: capture.workspace || null,
      conversation_id: capture.conversationId || capture.conversation_id || null,
      original_url: capture.originalUrl || capture.original_url || null,
      headers,
    },
    rawBodyShape: safeJsonShape(body),
  });
}

export function detectOpenAIEndpoint(path, body = {}) {
  if (/(^|\/)v1\/responses\/?(?:\?|$)/.test(path)) return "responses";
  if (/(^|\/)v1\/chat\/completions\/?(?:\?|$)/.test(path)) return "chat_completions";
  if (/(^|\/)openai\/deployments\/[^/]+\/chat\/completions\/?(?:\?|$)/.test(path)) return "chat_completions";
  return "unknown";
}

function isValidPayload(endpoint, body = {}) {
  if (!body || typeof body !== "object" || typeof body.model !== "string") return false;
  if (endpoint === "chat_completions") return Array.isArray(body.messages);
  if (endpoint === "responses") return body.input !== undefined || typeof body.instructions === "string";
  return false;
}

function normalizeChatMessages(messages = []) {
  return Array.isArray(messages) ? messages.map((message, index) => normalizeMessage(message, index, "body.messages")) : [];
}

function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    return [
      normalizeMessage(
        {
          role: "user",
          content: input,
        },
        0,
        "body.input",
      ),
    ];
  }
  if (Array.isArray(input)) return input.map((message, index) => normalizeMessage(message, index, "body.input"));
  return [];
}
