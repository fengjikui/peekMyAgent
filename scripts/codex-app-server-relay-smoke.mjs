import assert from "node:assert/strict";
import net from "node:net";
import { startCodexAppServerRelay } from "../src/adapters/codex-app-server-relay.mjs";

let backendHandshake = "";
const backend = net.createServer((socket) => {
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    socket.off("data", onData);
    backendHandshake = buffered.subarray(0, headerEnd + 4).toString("latin1");
    const remainder = buffered.subarray(headerEnd + 4);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (remainder.length) socket.write(remainder);
    socket.on("data", (data) => socket.write(data));
  };
  socket.on("data", onData);
});

await listen(backend);
const backendPort = backend.address().port;
const backendToken = "b".repeat(64);
const forgedClientToken = "c".repeat(64);
const relay = await startCodexAppServerRelay({
  targetPort: backendPort,
  token: "a".repeat(64),
  targetAuthorizationToken: backendToken,
});

try {
  const rejected = await exchange({
    port: relay.port,
    payload: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  });
  assert.match(rejected, /403 Forbidden/);

  const tokenPath = new URL(relay.url).pathname;
  const accepted = await exchange({
    port: relay.port,
    payload: `GET ${tokenPath} HTTP/1.1\r\nHost: 127.0.0.1:${relay.port}\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${forgedClientToken}\r\n\r\nPING`,
    waitFor: "PING",
  });
  assert.match(accepted, /101 Switching Protocols/);
  assert.match(accepted, /PING/);
  assert.match(backendHandshake, /^GET \/ HTTP\/1\.1/m);
  assert.match(backendHandshake, new RegExp(`Host: 127\\.0\\.0\\.1:${backendPort}`));
  assert.match(backendHandshake, new RegExp(`Authorization: Bearer ${backendToken}`));
  assert.equal(backendHandshake.includes(forgedClientToken), false);
  assert.equal((backendHandshake.match(/^Authorization:/gim) || []).length, 1);
  assert.equal(relay.stats.rejected_connections, 1);
  assert.equal(relay.stats.accepted_connections, 1);
  assert.ok(relay.stats.desktop_to_app_server_bytes > 0);
  assert.ok(relay.stats.app_server_to_desktop_bytes > 0);
  console.log("Codex App Server relay smoke passed");
} finally {
  await relay.close();
  await close(backend);
}

function exchange({ port, payload, waitFor = null }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("relay exchange timed out"));
    }, 2_000);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      output += chunk.toString("latin1");
      if ((waitFor && output.includes(waitFor)) || (!waitFor && output.includes("\r\n\r\n"))) {
        clearTimeout(timer);
        socket.end();
        resolve(output);
      }
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
