import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { startCodexAppServerRelay } from "../src/adapters/codex-app-server-relay.mjs";
import {
  createCodexThreadCaptureRouter,
  createWebSocketMessageTransform,
  decodeWebSocketFrame,
  encodeWebSocketFrame,
} from "../src/adapters/codex-app-server-protocol.mjs";
import { CODEX_CAPTURE_PROVIDER_ID } from "../src/adapters/codex-exact-proxy.mjs";

const workspace = path.resolve("codex-thread-routing-workspace");
const providerDefinition = {
  name: "peekMyAgent test capture",
  base_url: "http://127.0.0.1:43111/agent/codex/test/v1",
  wire_api: "responses",
  requires_openai_auth: true,
  supports_websockets: false,
};
verifyThreadRouter();
verifyFrameTransform();
await verifyRelayIntegration();
console.log("Codex App Server thread-selective routing smoke passed");

function verifyThreadRouter() {
  const router = createRouter();
  const unrelated = route(router, {
    id: 1,
    method: "thread/start",
    params: { cwd: path.resolve("another-workspace"), modelProvider: "openai" },
  });
  assert.equal(unrelated.params.modelProvider, "openai");

  const selected = route(router, {
    id: 2,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai", config: { model: "fixture" } },
  });
  assert.equal(selected.params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  assert.equal(selected.params.config.model, "fixture");
  assert.deepEqual(selected.params.config.model_providers[CODEX_CAPTURE_PROVIDER_ID], providerDefinition);

  const pendingSecond = route(router, {
    id: 3,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  });
  assert.equal(pendingSecond.params.modelProvider, "openai");
  router.observeServerText(JSON.stringify({ id: 2, result: { thread: { id: "thread-selected" } } }));
  assert.equal(router.stats.selected_thread_id, "thread-selected");
  assert.equal(router.stats.capture_state, "selected_thread_ready");

  const otherResume = route(router, {
    id: 4,
    method: "thread/resume",
    params: { threadId: "thread-other", modelProvider: "openai" },
  });
  assert.equal(otherResume.params.modelProvider, "openai");
  const selectedResume = route(router, {
    id: 5,
    method: "thread/resume",
    params: { threadId: "thread-selected", modelProvider: "openai" },
  });
  assert.equal(selectedResume.params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);

  const selectedFork = route(router, {
    id: 6,
    method: "thread/fork",
    params: { threadId: "thread-selected", modelProvider: "openai" },
  });
  assert.equal(selectedFork.params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  router.observeServerText(JSON.stringify({ id: 6, result: { thread: { id: "thread-fork" } } }));
  assert.equal(router.stats.selected_thread_id, "thread-selected");
  assert.deepEqual(router.stats.selected_thread_ids, ["thread-selected", "thread-fork"]);

  const parentAfterFork = route(router, {
    id: 61,
    method: "thread/resume",
    params: { threadId: "thread-selected", modelProvider: "openai" },
  });
  assert.equal(parentAfterFork.params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);

  const unknown = JSON.stringify({ id: 7, method: "turn/start", params: { threadId: "thread-fork" } });
  assert.equal(router.transformClientText(unknown), unknown);
  assert.equal(router.stats.rewritten_requests, 4);
  assert.equal(router.stats.rejected_candidates, 1);

  const explicit = createRouter({ targetThreadId: "existing-thread" });
  const explicitResume = route(explicit, {
    id: "resume",
    method: "thread/resume",
    params: { threadId: "existing-thread", modelProvider: "openai" },
  });
  assert.equal(explicitResume.params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  const explicitStart = route(explicit, {
    id: "start",
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  });
  assert.equal(explicitStart.params.modelProvider, "openai");

  const unresolved = createRouter();
  assert.equal(route(unresolved, {
    id: 8,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  }).params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  unresolved.observeServerText(JSON.stringify({ id: 8, result: {} }));
  assert.equal(route(unresolved, {
    id: 9,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  }).params.modelProvider, "openai");
  assert.equal(unresolved.stats.capture_state, "route_result_unresolved");

  const retry = createRouter();
  route(retry, { id: 10, method: "thread/start", params: { cwd: workspace } });
  retry.observeServerText(JSON.stringify({ id: 10, error: { message: "fixture" } }));
  assert.equal(route(retry, {
    id: 11,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  }).params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);

  const reconnectRoot = createRouter();
  const disconnected = reconnectRoot.createConnectionRouter();
  assert.equal(route(disconnected, {
    id: 1,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  }).params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  disconnected.close();
  assert.equal(reconnectRoot.stats.abandoned_routes, 1);
  const reconnected = reconnectRoot.createConnectionRouter();
  assert.equal(route(reconnected, {
    id: 1,
    method: "thread/start",
    params: { cwd: workspace, modelProvider: "openai" },
  }).params.modelProvider, CODEX_CAPTURE_PROVIDER_ID, "a disconnected pending start must not permanently claim capture");
  reconnected.observeServerText(JSON.stringify({ id: 1, result: { thread: { id: "thread-reconnected" } } }));
  assert.equal(reconnectRoot.stats.selected_thread_id, "thread-reconnected");

  const concurrentRoot = createRouter({ targetThreadId: "thread-concurrent" });
  const connectionA = concurrentRoot.createConnectionRouter();
  const connectionB = concurrentRoot.createConnectionRouter();
  assert.equal(route(connectionA, {
    id: 1,
    method: "thread/resume",
    params: { threadId: "thread-concurrent", modelProvider: "openai" },
  }).params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  assert.equal(route(connectionB, {
    id: 1,
    method: "thread/resume",
    params: { threadId: "thread-concurrent", modelProvider: "openai" },
  }).params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  connectionA.observeServerText(JSON.stringify({ id: 1, result: { thread: { id: "thread-concurrent" } } }));
  connectionB.observeServerText(JSON.stringify({ id: 1, result: { thread: { id: "thread-concurrent" } } }));
  assert.equal(concurrentRoot.stats.completed_routes, 2, "JSON-RPC ids are scoped per WebSocket connection");
}

function verifyFrameTransform() {
  const transformedTexts = [];
  const transform = createWebSocketMessageTransform({
    masked: true,
    transformText(text) {
      transformedTexts.push(text);
      return `${text}:changed`;
    },
  });
  const frame = encodeWebSocketFrame({ payload: Buffer.from("hello"), masked: true });
  const first = transform.push(frame.subarray(0, 3));
  assert.equal(first.length, 0);
  const second = transform.push(frame.subarray(3));
  assert.equal(second.length, 1);
  const decoded = decodeWebSocketFrame(second[0], { expectMasked: true });
  assert.equal(decoded.payload.toString("utf8"), "hello:changed");
  assert.deepEqual(transformedTexts, ["hello"]);

  const fragmented = createWebSocketMessageTransform({ masked: true, transformText: (text) => text.toUpperCase() });
  const start = encodeWebSocketFrame({ opcode: 0x1, payload: Buffer.from("frag"), masked: true, fin: false });
  const ping = encodeWebSocketFrame({ opcode: 0x9, payload: Buffer.from("p"), masked: true });
  const end = encodeWebSocketFrame({ opcode: 0x0, payload: Buffer.from("ment"), masked: true });
  const fragmentedOutput = fragmented.push(Buffer.concat([start, ping, end]));
  assert.equal(fragmentedOutput.length, 2);
  assert.equal(decodeWebSocketFrame(fragmentedOutput[0], { expectMasked: true }).opcode, 0x9);
  assert.equal(decodeWebSocketFrame(fragmentedOutput[1], { expectMasked: true }).payload.toString("utf8"), "FRAGMENT");

  const compressed = Buffer.from(frame);
  compressed[0] |= 0x40;
  assert.throws(
    () => createWebSocketMessageTransform({ masked: true }).push(compressed),
    /Compressed or reserved/,
  );
  const oversized = encodeWebSocketFrame({ payload: Buffer.alloc(2_048), masked: true });
  assert.throws(
    () => createWebSocketMessageTransform({ masked: true, maxMessageBytes: 1_024 }).push(oversized),
    /safety limit/,
  );
}

async function verifyRelayIntegration() {
  const backendMessages = [];
  let backendHandshake = "";
  const backend = net.createServer((socket) => {
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    const frames = createWebSocketMessageTransform({
      masked: true,
      transformText(text) {
        const request = JSON.parse(text);
        backendMessages.push(request);
        const result = request.method === "thread/start" ? { thread: { id: "relay-selected" } } : {};
        socket.write(encodeWebSocketFrame({
          masked: false,
          payload: Buffer.from(JSON.stringify({ id: request.id, result })),
        }));
        return text;
      },
    });
    socket.on("data", (chunk) => {
      if (upgraded) {
        frames.push(chunk);
        return;
      }
      handshake = handshake.length ? Buffer.concat([handshake, chunk]) : Buffer.from(chunk);
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      backendHandshake = handshake.subarray(0, headerEnd + 4).toString("latin1");
      upgraded = true;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      const remainder = handshake.subarray(headerEnd + 4);
      if (remainder.length) frames.push(remainder);
    });
  });
  await listen(backend);
  const relay = await startCodexAppServerRelay({
    targetPort: backend.address().port,
    token: "a".repeat(64),
    targetAuthorizationToken: "b".repeat(64),
    threadCapture: { workspace, providerDefinition },
  });
  let client;
  try {
    client = await openWebSocket(relay.url);
    await client.request({ id: 1, method: "thread/start", params: { cwd: workspace, modelProvider: "openai" } });
    await client.request({ id: 2, method: "thread/start", params: { cwd: workspace, modelProvider: "openai" } });
    await client.request({ id: 3, method: "thread/resume", params: { threadId: "relay-selected", modelProvider: "openai" } });
    assert.equal(backendMessages[0].params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
    assert.deepEqual(backendMessages[0].params.config.model_providers[CODEX_CAPTURE_PROVIDER_ID], providerDefinition);
    assert.equal(backendMessages[1].params.modelProvider, "openai");
    assert.equal(backendMessages[2].params.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
    assert.equal(backendHandshake.includes("Sec-WebSocket-Extensions"), false);
    assert.match(backendHandshake, /Authorization: Bearer b{64}/);
    assert.equal(relay.stats.thread_capture.selected_thread_id, "relay-selected");
    assert.equal(relay.stats.thread_capture.rewritten_requests, 2);
    assert.equal(relay.stats.protocol_errors, 0);
  } finally {
    client?.close();
    await relay.close();
    await close(backend);
  }
}

function route(router, payload) {
  return JSON.parse(router.transformClientText(JSON.stringify(payload)));
}

function createRouter(options = {}) {
  return createCodexThreadCaptureRouter({ workspace, providerDefinition, ...options });
}

function openWebSocket(url) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    const pending = new Map();
    const responseFrames = createWebSocketMessageTransform({
      masked: false,
      transformText(text) {
        const response = JSON.parse(text);
        pending.get(response.id)?.(response);
        pending.delete(response.id);
        return text;
      },
    });
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => reject(new Error("WebSocket client handshake timed out")), 2_000);
    socket.once("connect", () => {
      socket.write(
        `GET ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      if (upgraded) {
        responseFrames.push(chunk);
        return;
      }
      handshake = handshake.length ? Buffer.concat([handshake, chunk]) : Buffer.from(chunk);
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = handshake.subarray(0, headerEnd + 4).toString("latin1");
      if (!/^HTTP\/1\.1 101/m.test(header)) {
        clearTimeout(timer);
        reject(new Error(`WebSocket client upgrade failed: ${header.split("\r\n")[0]}`));
        return;
      }
      upgraded = true;
      clearTimeout(timer);
      const remainder = handshake.subarray(headerEnd + 4);
      if (remainder.length) responseFrames.push(remainder);
      resolve({
        request(payload) {
          return new Promise((requestResolve, requestReject) => {
            const requestTimer = setTimeout(() => {
              pending.delete(payload.id);
              requestReject(new Error(`WebSocket request ${payload.id} timed out`));
            }, 2_000);
            pending.set(payload.id, (response) => {
              clearTimeout(requestTimer);
              requestResolve(response);
            });
            socket.write(encodeWebSocketFrame({ masked: true, payload: Buffer.from(JSON.stringify(payload)) }));
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
