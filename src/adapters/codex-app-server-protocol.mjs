import crypto from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { CODEX_CAPTURE_PROVIDER_ID } from "./codex-exact-proxy.mjs";

const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const THREAD_CAPTURE_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function createCodexThreadCaptureRouter({
  providerId = CODEX_CAPTURE_PROVIDER_ID,
  providerDefinition = null,
  workspace = null,
  targetThreadId = null,
  captureNextNewThread = !targetThreadId,
  sharedState = null,
} = {}) {
  const normalizedProviderId = String(providerId || "").trim();
  if (!normalizedProviderId) throw new Error("Codex thread capture provider id is required.");
  const normalizedProviderDefinition = normalizeProviderDefinition(providerDefinition);
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const normalizedTargetThreadId = normalizeThreadId(targetThreadId);
  const shared = sharedState || createSharedRoutingState(normalizedTargetThreadId);
  const pending = new Map();
  let pendingNewThreadRequest = null;
  let closed = false;
  const stats = shared.stats;

  return {
    stats,
    transformClientText(text) {
      const parsed = parseJson(text);
      if (parsed == null) return text;
      const { value, changed } = rewriteEnvelope(parsed);
      return changed ? JSON.stringify(value) : text;
    },
    observeServerText(text) {
      const parsed = parseJson(text);
      if (parsed == null) return;
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) observeResponse(message);
    },
    createConnectionRouter() {
      return createCodexThreadCaptureRouter({
        providerId: normalizedProviderId,
        providerDefinition: normalizedProviderDefinition,
        workspace: normalizedWorkspace,
        targetThreadId: normalizedTargetThreadId,
        captureNextNewThread,
        sharedState: shared,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (!pending.size) return;
      stats.abandoned_routes += pending.size;
      if ([...pending.values()].some((route) => route.method === "thread/start") && shared.selectedThreadIds.size === 0) {
        shared.newThreadCaptureClaimed = false;
      }
      pending.clear();
      pendingNewThreadRequest = null;
      stats.capture_state = stats.completed_routes > 0
        ? "selected_thread_ready"
        : shared.selectedThreadIds.size
          ? "waiting_for_resume"
          : "waiting_for_new_thread";
    },
  };

  function rewriteEnvelope(envelope) {
    if (Array.isArray(envelope)) {
      let changed = false;
      const value = envelope.map((message) => {
        const result = rewriteRequest(message);
        changed ||= result.changed;
        return result.value;
      });
      return { value, changed };
    }
    return rewriteRequest(envelope);
  }

  function rewriteRequest(message) {
    if (!isObject(message) || !THREAD_CAPTURE_METHODS.has(message.method) || message.id == null || !isObject(message.params)) {
      return { value: message, changed: false };
    }
    const method = message.method;
    const params = message.params;
    if (!shouldCapture(method, params)) return { value: message, changed: false };

    const key = requestIdKey(message.id);
    if (!key) return { value: message, changed: false };
    const sourceThreadId = normalizeThreadId(params.threadId);
    pending.set(key, { method, sourceThreadId });
    if (method === "thread/start") {
      pendingNewThreadRequest = key;
      shared.newThreadCaptureClaimed = true;
    }
    stats.rewritten_requests += 1;
    stats.capture_state = method === "thread/start" ? "starting_selected_thread" : "resuming_selected_thread";
    return {
      value: {
        ...message,
        params: {
          ...params,
          modelProvider: normalizedProviderId,
          ...(normalizedProviderDefinition
            ? { config: withProviderDefinition(params.config, normalizedProviderId, normalizedProviderDefinition) }
            : {}),
        },
      },
      changed: true,
    };
  }

  function shouldCapture(method, params) {
    if (method === "thread/start") {
      if (!captureNextNewThread || shared.newThreadCaptureClaimed || shared.selectedThreadIds.size || pendingNewThreadRequest) return false;
      if (!workspaceMatches(params.cwd, normalizedWorkspace)) {
        stats.rejected_candidates += 1;
        return false;
      }
      return true;
    }

    const sourceThreadId = normalizeThreadId(params.threadId);
    if (!sourceThreadId || !shared.selectedThreadIds.has(sourceThreadId)) return false;
    return method === "thread/resume" || method === "thread/fork";
  }

  function observeResponse(message) {
    if (!isObject(message) || message.id == null) return;
    const key = requestIdKey(message.id);
    const route = key ? pending.get(key) : null;
    if (!route) return;
    pending.delete(key);
    if (pendingNewThreadRequest === key) pendingNewThreadRequest = null;

    if (message.error) {
      stats.failed_routes += 1;
      if (route.method === "thread/start") shared.newThreadCaptureClaimed = false;
      stats.capture_state = stats.completed_routes > 0
        ? "selected_thread_ready"
        : shared.selectedThreadIds.size
          ? "waiting_for_resume"
          : "waiting_for_new_thread";
      return;
    }

    const responseThreadId = extractThreadId(message.result);
    if (route.method === "thread/start") {
      if (!responseThreadId) {
        stats.capture_state = "route_result_unresolved";
        return;
      }
      addSelectedThread(shared, responseThreadId);
    } else if (route.method === "thread/fork" && responseThreadId) {
      addSelectedThread(shared, responseThreadId);
    } else if (!shared.selectedThreadIds.size && route.sourceThreadId) {
      addSelectedThread(shared, route.sourceThreadId);
    }
    stats.completed_routes += 1;
    stats.capture_state = shared.selectedThreadIds.size ? "selected_thread_ready" : "route_result_unresolved";
  }
}

function createSharedRoutingState(targetThreadId) {
  const selectedThreadIds = new Set(targetThreadId ? [targetThreadId] : []);
  const stats = {
    capture_mode: targetThreadId ? "selected_thread" : "next_new_thread",
    capture_state: targetThreadId ? "waiting_for_resume" : "waiting_for_new_thread",
    selected_thread_id: targetThreadId,
    selected_thread_ids: [...selectedThreadIds],
    rewritten_requests: 0,
    completed_routes: 0,
    rejected_candidates: 0,
    failed_routes: 0,
    abandoned_routes: 0,
  };
  return { selectedThreadIds, newThreadCaptureClaimed: false, stats };
}

function addSelectedThread(shared, threadId) {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) return;
  shared.selectedThreadIds.add(normalized);
  if (!shared.stats.selected_thread_id) shared.stats.selected_thread_id = normalized;
  shared.stats.selected_thread_ids = [...shared.selectedThreadIds];
}

export function createWebSocketMessageTransform({
  masked,
  transformText = (text) => text,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
} = {}) {
  const expectMasked = Boolean(masked);
  const limit = normalizeByteLimit(maxMessageBytes);
  let buffered = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragmentedPayloads = [];
  let fragmentedBytes = 0;

  return {
    push(chunk) {
      if (chunk?.length) buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      const output = [];
      while (buffered.length >= 2) {
        const frame = readFrame(buffered, { expectMasked, maxPayloadBytes: limit });
        if (!frame) break;
        buffered = buffered.subarray(frame.totalLength);
        processFrame(frame, output);
      }
      return output;
    },
    finish() {
      if (buffered.length || fragmentedOpcode != null) throw new Error("WebSocket stream ended with an incomplete frame or message.");
    },
  };

  function processFrame(frame, output) {
    if (frame.opcode >= 0x8) {
      if (!frame.fin || frame.payload.length > 125) throw new Error("Invalid fragmented or oversized WebSocket control frame.");
      output.push(frame.raw);
      return;
    }
    if (![0x0, 0x1, 0x2].includes(frame.opcode)) throw new Error(`Unsupported WebSocket opcode: ${frame.opcode}`);

    if (frame.opcode === 0x0) {
      if (fragmentedOpcode == null) throw new Error("Unexpected WebSocket continuation frame.");
      appendFragment(frame.payload);
      if (!frame.fin) return;
      const opcode = fragmentedOpcode;
      const payload = Buffer.concat(fragmentedPayloads, fragmentedBytes);
      resetFragments();
      output.push(transformMessage(opcode, payload, { original: null }));
      return;
    }

    if (fragmentedOpcode != null) throw new Error("A new WebSocket data message started before the fragmented message completed.");
    if (!frame.fin) {
      fragmentedOpcode = frame.opcode;
      appendFragment(frame.payload);
      return;
    }
    output.push(transformMessage(frame.opcode, frame.payload, { original: frame.raw }));
  }

  function appendFragment(payload) {
    fragmentedBytes += payload.length;
    if (fragmentedBytes > limit) throw new Error(`WebSocket message exceeds the ${limit}-byte safety limit.`);
    fragmentedPayloads.push(payload);
  }

  function resetFragments() {
    fragmentedOpcode = null;
    fragmentedPayloads = [];
    fragmentedBytes = 0;
  }

  function transformMessage(opcode, payload, { original }) {
    if (payload.length > limit) throw new Error(`WebSocket message exceeds the ${limit}-byte safety limit.`);
    if (opcode !== 0x1) return original || encodeWebSocketFrame({ opcode, payload, masked: expectMasked });
    let originalText;
    try {
      originalText = UTF8_DECODER.decode(payload);
    } catch {
      throw new Error("WebSocket text message is not valid UTF-8.");
    }
    const transformedText = String(transformText(originalText));
    if (original && transformedText === originalText) return original;
    return encodeWebSocketFrame({ opcode: 0x1, payload: Buffer.from(transformedText), masked: expectMasked });
  }
}

export function encodeWebSocketFrame({ opcode = 0x1, payload = Buffer.alloc(0), masked = false, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const lengthBytes = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  header[1] = (masked ? 0x80 : 0) | (lengthBytes === 0 ? body.length : lengthBytes === 2 ? 126 : 127);
  let offset = 2;
  if (lengthBytes === 2) {
    header.writeUInt16BE(body.length, offset);
    offset += 2;
  } else if (lengthBytes === 8) {
    header.writeBigUInt64BE(BigInt(body.length), offset);
    offset += 8;
  }
  if (!masked) return Buffer.concat([header, body]);
  const mask = crypto.randomBytes(4);
  mask.copy(header, offset);
  const encoded = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) encoded[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, encoded]);
}

export function decodeWebSocketFrame(buffer, { expectMasked = null, maxPayloadBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  const frame = readFrame(Buffer.from(buffer || ""), {
    expectMasked: expectMasked == null ? null : Boolean(expectMasked),
    maxPayloadBytes: normalizeByteLimit(maxPayloadBytes),
  });
  if (!frame || frame.totalLength !== buffer.length) throw new Error("Expected exactly one complete WebSocket frame.");
  return frame;
}

function readFrame(buffer, { expectMasked, maxPayloadBytes }) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  if ((first & 0x70) !== 0) throw new Error("Compressed or reserved WebSocket frames are not supported by the Codex relay.");
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  if (expectMasked != null && masked !== expectMasked) {
    throw new Error(expectMasked ? "Desktop WebSocket frames must be masked." : "App Server WebSocket frames must not be masked.");
  }
  let payloadLength = second & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const value = buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame length is not safely representable.");
    payloadLength = Number(value);
    offset += 8;
  }
  if (payloadLength > maxPayloadBytes) throw new Error(`WebSocket frame exceeds the ${maxPayloadBytes}-byte safety limit.`);
  const maskOffset = masked ? offset : null;
  if (masked) offset += 4;
  const totalLength = offset + payloadLength;
  if (buffer.length < totalLength) return null;
  const raw = buffer.subarray(0, totalLength);
  const payload = Buffer.from(buffer.subarray(offset, totalLength));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { fin, opcode, masked, payload, raw, totalLength };
}

function extractThreadId(result) {
  if (!isObject(result)) return null;
  return normalizeThreadId(result.thread?.id || result.threadId || result.id);
}

function requestIdKey(id) {
  if (!["string", "number"].includes(typeof id)) return null;
  return `${typeof id}:${String(id)}`;
}

function workspaceMatches(candidate, expected) {
  if (!expected || candidate == null || String(candidate).trim() === "") return true;
  return normalizeWorkspace(candidate) === expected;
}

function normalizeWorkspace(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeThreadId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeByteLimit(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1024) throw new Error(`Invalid WebSocket message byte limit: ${value}`);
  return normalized;
}

function normalizeProviderDefinition(value) {
  if (value == null) return null;
  if (!isObject(value)) throw new Error("Codex thread capture provider definition must be an object.");
  const baseUrl = String(value.base_url || "").trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(baseUrl)) {
    throw new Error("Codex thread capture provider must use a loopback HTTP base URL.");
  }
  return Object.freeze({ ...value, base_url: baseUrl });
}

function withProviderDefinition(config, providerId, providerDefinition) {
  const current = isObject(config) ? config : {};
  const providers = isObject(current.model_providers) ? current.model_providers : {};
  return {
    ...current,
    model_providers: {
      ...providers,
      [providerId]: providerDefinition,
    },
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
