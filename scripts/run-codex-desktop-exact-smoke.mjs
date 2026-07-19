#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(root, "bin", "peekmyagent.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-desktop-exact-"));
const bundlePath = path.join(tmpDir, "ChatGPT.app");
const appExecutable = path.join(bundlePath, "Contents", "MacOS", "ChatGPT");
const embeddedCodexPath = path.join(bundlePath, "Contents", "Resources", "codex");
const asarPath = path.join(bundlePath, "Contents", "Resources", "app.asar");
const launcherPath = path.join(tmpDir, "open");
const codexHome = path.join(tmpDir, "codex-home");
const stateDbPath = path.join(codexHome, "state_5.sqlite");
const existingRolloutPath = path.join(codexHome, "fixture-existing.jsonl");
const modelRequests = [];
const watchRequests = [];

fs.mkdirSync(path.dirname(appExecutable), { recursive: true });
fs.mkdirSync(path.dirname(embeddedCodexPath), { recursive: true });
fs.writeFileSync(asarPath, "fixture CODEX_APP_SERVER_WS_URL fixture");
fs.writeFileSync(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.writeFileSync(embeddedCodexPath, fakeEmbeddedCodexSource(), { mode: 0o755 });
fs.writeFileSync(appExecutable, fakeDesktopSource(), { mode: 0o755 });
fs.chmodSync(launcherPath, 0o755);
fs.chmodSync(embeddedCodexPath, 0o755);
fs.chmodSync(appExecutable, 0o755);
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(existingRolloutPath, "{}\n");
createStateDb(stateDbPath, existingRolloutPath, tmpDir);

const viewer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/sources") {
    writeJson(res, 200, []);
    return;
  }
  if (req.method === "POST" && req.url === "/api/watch/start") {
    watchRequests.push(JSON.parse(await readBody(req)));
    writeJson(res, 200, {
      id: "live-codex-desktop-exact-smoke",
      watch_id: "codex-desktop-exact-smoke",
      base_url: `${viewerUrl(viewer)}/agent/codex/codex-desktop-exact-smoke`,
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/watch/stop") {
    await readBody(req);
    writeJson(res, 200, { id: "live-codex-desktop-exact-smoke", status: "stopped" });
    return;
  }
  if (req.method === "POST" && req.url === "/agent/codex/codex-desktop-exact-smoke/v1/responses") {
    modelRequests.push(JSON.parse(await readBody(req)));
    writeJson(res, 200, {
      id: "resp_fixture",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "captured" }] }],
    });
    return;
  }
  writeJson(res, 404, { error: "not found" });
});

await listen(viewer);
const url = viewerUrl(viewer);
const env = {
  ...process.env,
  PEEKMYAGENT_CODEX_DESKTOP_BUNDLE: bundlePath,
  PEEKMYAGENT_CODEX_DESKTOP_LAUNCHER: launcherPath,
  PEEKMYAGENT_CODEX_DESKTOP_VERSION: "fixture-desktop",
  PEEKMYAGENT_CODEX_DESKTOP_CODEX_VERSION: "codex-cli fixture",
  CODEX_HOME: codexHome,
};

try {
  const result = await runCli(
    ["codex", "desktop", "--restart", "--viewer-url", url, "--no-open"],
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /managed exact Responses API/);
  assert.match(result.stderr, /thread-selective provider injection/);
  assert.match(result.stderr, /captured Codex thread: fixture-thread/);
  assert.equal(modelRequests.length, 1);
  assert.equal(modelRequests[0].instructions, "fixture managed Desktop instructions");
  assert.equal(modelRequests[0].input[0].role, "user");
  assert.equal(modelRequests[0].tools[0].name, "fixture_tool");
  assert.equal(watchRequests[0].conversation_id, null);

  const resumed = await runCli(
    ["codex", "desktop", "--resume", "fixture-existing", "--capture", "exact", "--restart", "--viewer-url", url, "--no-open"],
    { ...env, PEEK_FAKE_CODEX_THREAD_ID: "fixture-existing" },
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stderr, /capture scope: selected thread fixture-existing/);
  assert.match(resumed.stderr, /captured Codex thread: fixture-existing/);
  assert.equal(modelRequests.length, 2);
  assert.equal(watchRequests[1].conversation_id, "fixture-existing");
  console.log("run Codex Desktop managed exact wrapper smoke passed");
} finally {
  await close(viewer);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function fakeEmbeddedCodexSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli fixture");
  process.exit(0);
}
const listenIndex = args.indexOf("--listen");
const listenUrl = new URL(args[listenIndex + 1]);
const tokenFileIndex = args.indexOf("--ws-token-file");
const expectedToken = fs.readFileSync(args[tokenFileIndex + 1], "utf8").trim();
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  let handshakeBuffer = Buffer.alloc(0);
  let frameBuffer = Buffer.alloc(0);
  let upgraded = false;
  socket.on("data", async (chunk) => {
    if (!upgraded) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const headerEnd = handshakeBuffer.indexOf("\\r\\n\\r\\n");
      if (headerEnd === -1) return;
      const handshake = handshakeBuffer.subarray(0, headerEnd + 4).toString("latin1");
      if (!handshake.includes("Authorization: Bearer " + expectedToken)) {
        socket.end("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");
        return;
      }
      upgraded = true;
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
      chunk = handshakeBuffer.subarray(headerEnd + 4);
      handshakeBuffer = Buffer.alloc(0);
    }
    if (!chunk.length) return;
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    const decoded = decodeFrame(frameBuffer, true);
    if (!decoded) return;
    frameBuffer = frameBuffer.subarray(decoded.totalLength);
    const request = JSON.parse(decoded.payload.toString("utf8"));
    const expectedThreadId = process.env.PEEK_FAKE_CODEX_THREAD_ID || null;
    const expectedMethod = expectedThreadId ? "thread/resume" : "thread/start";
    if (request.method !== expectedMethod || request.params.modelProvider !== "peekmyagent_http") {
      socket.write(encodeFrame(JSON.stringify({ id: request.id, error: { message: "capture provider was not selected" } }), false));
      return;
    }
    const provider = request.params.config?.model_providers?.peekmyagent_http;
    if (!provider || provider.wire_api !== "responses" || provider.requires_openai_auth !== true || provider.supports_websockets !== false) {
      socket.write(encodeFrame(JSON.stringify({ id: request.id, error: { message: "thread-scoped capture provider was not defined" } }), false));
      return;
    }
    const baseUrl = provider.base_url;
    const response = await fetch(baseUrl + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture" },
      body: JSON.stringify({
        model: "fixture-model",
        instructions: "fixture managed Desktop instructions",
        input: [{ role: "user", content: [{ type: "input_text", text: "inspect managed Desktop" }] }],
        tools: [{ type: "function", name: "fixture_tool", description: "fixture", parameters: { type: "object" } }],
      }),
    });
    if (!response.ok) throw new Error("fixture model request failed: " + response.status);
    socket.write(encodeFrame(JSON.stringify({ id: request.id, result: { thread: { id: expectedThreadId || "fixture-thread" } } }), false));
  });
});
function decodeFrame(buffer, expectMasked) {
  if (buffer.length < 2) return null;
  const masked = Boolean(buffer[1] & 0x80);
  if (masked !== expectMasked) throw new Error("unexpected WebSocket mask");
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const maskOffset = masked ? offset : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= buffer[maskOffset + (index % 4)];
  return { payload, totalLength: offset + length };
}
function encodeFrame(text, masked) {
  const payload = Buffer.from(text);
  const extended = payload.length >= 126;
  const header = Buffer.alloc(2 + (extended ? 2 : 0) + (masked ? 4 : 0));
  header[0] = 0x81;
  header[1] = (masked ? 0x80 : 0) | (extended ? 126 : payload.length);
  let offset = 2;
  if (extended) { header.writeUInt16BE(payload.length, offset); offset += 2; }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([1, 2, 3, 4]);
  mask.copy(header, offset);
  const encoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) encoded[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, encoded]);
}
server.listen({ host: "127.0.0.1", port: Number(listenUrl.port) });
const stop = () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
}

function fakeDesktopSource() {
  return `#!/usr/bin/env node
import net from "node:net";
const url = new URL(process.env.CODEX_APP_SERVER_WS_URL);
const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
const workspace = process.argv[2];
let handshakeBuffer = Buffer.alloc(0);
let frameBuffer = Buffer.alloc(0);
let upgraded = false;
const timer = setTimeout(() => process.exit(2), 5000);
socket.once("connect", () => socket.write(
  "GET " + url.pathname + " HTTP/1.1\\r\\nHost: " + url.host + "\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Extensions: permessage-deflate\\r\\n\\r\\n"
));
socket.on("data", (chunk) => {
  if (!upgraded) {
    handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
    const headerEnd = handshakeBuffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = handshakeBuffer.subarray(0, headerEnd + 4).toString("latin1");
    if (!header.startsWith("HTTP/1.1 101")) process.exit(4);
    upgraded = true;
    chunk = handshakeBuffer.subarray(headerEnd + 4);
    handshakeBuffer = Buffer.alloc(0);
    const targetThreadId = process.env.PEEK_FAKE_CODEX_THREAD_ID || null;
    socket.write(encodeFrame(JSON.stringify(targetThreadId ? {
      id: 1,
      method: "thread/resume",
      params: { threadId: targetThreadId, modelProvider: "openai" },
    } : {
      id: 1,
      method: "thread/start",
      params: { cwd: workspace, modelProvider: "openai", config: { model: "fixture-model" } },
    }), true));
  }
  if (!chunk.length) return;
  frameBuffer = Buffer.concat([frameBuffer, chunk]);
  const decoded = decodeFrame(frameBuffer, false);
  if (!decoded) return;
  const response = JSON.parse(decoded.payload.toString("utf8"));
  if (response.result?.thread?.id !== (process.env.PEEK_FAKE_CODEX_THREAD_ID || "fixture-thread")) process.exit(5);
  clearTimeout(timer);
  socket.end();
  process.exit(0);
});
socket.once("error", () => process.exit(3));
function decodeFrame(buffer, expectMasked) {
  if (buffer.length < 2) return null;
  const masked = Boolean(buffer[1] & 0x80);
  if (masked !== expectMasked) throw new Error("unexpected WebSocket mask");
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  return { payload: Buffer.from(buffer.subarray(offset, offset + length)), totalLength: offset + length };
}
function encodeFrame(text, masked) {
  const payload = Buffer.from(text);
  const extended = payload.length >= 126;
  const header = Buffer.alloc(2 + (extended ? 2 : 0) + (masked ? 4 : 0));
  header[0] = 0x81;
  header[1] = (masked ? 0x80 : 0) | (extended ? 126 : payload.length);
  let offset = 2;
  if (extended) { header.writeUInt16BE(payload.length, offset); offset += 2; }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = Buffer.from([5, 6, 7, 8]);
  mask.copy(header, offset);
  const encoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) encoded[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, encoded]);
}
`;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: tmpDir, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function viewerUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function createStateDb(filePath, rolloutPath, cwd) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        source TEXT,
        model_provider TEXT,
        cwd TEXT,
        title TEXT,
        tokens_used INTEGER,
        archived INTEGER,
        cli_version TEXT,
        first_user_message TEXT,
        model TEXT,
        thread_source TEXT
      );
    `);
    db.prepare("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, tokens_used, archived, cli_version, first_user_message, model, thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("fixture-existing", rolloutPath, 100, 100, "desktop", "openai", cwd, "Existing exact fixture", 64, 0, "fixture", "existing fixture", "gpt-fixture", "user");
  } finally {
    db.close();
  }
}
