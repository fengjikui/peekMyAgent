import crypto from "node:crypto";
import net from "node:net";
import {
  createCodexThreadCaptureRouter,
  createWebSocketMessageTransform,
} from "./codex-app-server-protocol.mjs";

const DEFAULT_MAX_HANDSHAKE_BYTES = 32 * 1024;
const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export async function startCodexAppServerRelay({
  targetHost = "127.0.0.1",
  targetPort,
  host = "127.0.0.1",
  port = 0,
  token = crypto.randomBytes(32).toString("hex"),
  targetAuthorizationToken = null,
  maxHandshakeBytes = DEFAULT_MAX_HANDSHAKE_BYTES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  threadCapture = null,
  routerFactory = createCodexThreadCaptureRouter,
  createServer = net.createServer,
  createConnection = net.createConnection,
} = {}) {
  if (host !== "127.0.0.1") throw new Error("Codex App Server relay must bind to 127.0.0.1.");
  if (targetHost !== "127.0.0.1") throw new Error("Codex App Server relay target must be 127.0.0.1.");
  if (!validPort(targetPort)) throw new Error(`Invalid Codex App Server target port: ${targetPort}`);
  const normalizedToken = String(token || "").trim();
  if (!/^[a-f0-9]{64,}$/i.test(normalizedToken)) throw new Error("Codex App Server relay requires a high-entropy hexadecimal token.");
  const normalizedTargetToken = String(targetAuthorizationToken || "").trim();
  if (normalizedTargetToken && !/^[a-f0-9]{64,}$/i.test(normalizedTargetToken)) {
    throw new Error("Codex App Server backend authorization requires a high-entropy hexadecimal token.");
  }
  const tokenPath = `/pma/${normalizedToken}`;
  const router = threadCapture ? routerFactory(threadCapture) : null;
  const sockets = new Set();
  const stats = {
    accepted_connections: 0,
    rejected_connections: 0,
    desktop_to_app_server_bytes: 0,
    app_server_to_desktop_bytes: 0,
    protocol_errors: 0,
    thread_capture: router?.stats || null,
  };

  const server = createServer((client) => {
    if (!isLoopbackAddress(client.remoteAddress) || sockets.size >= maxConnections * 2) {
      stats.rejected_connections += 1;
      rejectHttpUpgrade(client, 403, "Loopback connection required");
      return;
    }
    sockets.add(client);
    configureSocket(client);
    let handshake = Buffer.alloc(0);
    const onHandshakeData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      if (handshake.length > maxHandshakeBytes) {
        stats.rejected_connections += 1;
        rejectHttpUpgrade(client, 431, "WebSocket handshake too large");
        return;
      }
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      client.off("data", onHandshakeData);
      const parsed = parseHandshake(handshake.subarray(0, headerEnd + 4));
      if (!parsed || parsed.path !== tokenPath || !parsed.isWebSocketUpgrade) {
        stats.rejected_connections += 1;
        rejectHttpUpgrade(client, 403, "Invalid relay capability");
        return;
      }
      client.pause();
      const target = createConnection({ host: targetHost, port: targetPort });
      sockets.add(target);
      configureSocket(target);
      const connectionRouter = router?.createConnectionRouter?.() || router;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        connectionRouter?.close?.();
        sockets.delete(client);
        sockets.delete(target);
        if (!client.destroyed) client.destroy();
        if (!target.destroyed) target.destroy();
      };
      client.once("error", cleanup);
      target.once("error", cleanup);
      client.once("close", cleanup);
      target.once("close", cleanup);
      target.once("connect", () => {
        stats.accepted_connections += 1;
        const rewrittenHeader = rewriteHandshakeHeader(handshake, headerEnd, {
          targetHost,
          targetPort,
          targetAuthorizationToken: normalizedTargetToken,
          stripExtensions: Boolean(router),
        });
        stats.desktop_to_app_server_bytes += rewrittenHeader.length;
        target.write(rewrittenHeader);
        const initialClientData = handshake.subarray(headerEnd + 4);
        if (connectionRouter) {
          bridgeProtocolAwareWebSocket({
            client,
            target,
            initialClientData,
            maxHandshakeBytes,
            maxMessageBytes,
            router: connectionRouter,
            stats,
            cleanup,
          });
        } else {
          if (initialClientData.length) {
            stats.desktop_to_app_server_bytes += initialClientData.length;
            target.write(initialClientData);
          }
          client.on("data", (data) => {
            stats.desktop_to_app_server_bytes += data.length;
          });
          target.on("data", (data) => {
            stats.app_server_to_desktop_bytes += data.length;
          });
          client.pipe(target);
          target.pipe(client);
        }
        client.resume();
      });
    };
    client.on("data", onHandshakeData);
    client.once("close", () => sockets.delete(client));
    client.once("error", () => sockets.delete(client));
  });
  server.maxConnections = maxConnections;
  await listen(server, { host, port });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Codex App Server relay did not expose a TCP address.");
  }

  let closed = false;
  return {
    host,
    port: address.port,
    url: `ws://${host}:${address.port}${tokenPath}`,
    stats,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closeServer(server);
    },
  };
}

function bridgeProtocolAwareWebSocket({
  client,
  target,
  initialClientData,
  maxHandshakeBytes,
  maxMessageBytes,
  router,
  stats,
  cleanup,
}) {
  const clientFrames = createWebSocketMessageTransform({
    masked: true,
    maxMessageBytes,
    transformText: router.transformClientText,
  });
  const targetFrames = createWebSocketMessageTransform({
    masked: false,
    maxMessageBytes,
    transformText(text) {
      router.observeServerText(text);
      return text;
    },
  });
  let targetHandshake = Buffer.alloc(0);
  let upgraded = false;
  let passthrough = false;
  const pendingClientChunks = [];
  let pendingClientBytes = 0;

  const protocolFailure = () => {
    stats.protocol_errors += 1;
    cleanup();
  };
  if (initialClientData.length) queueClientData(initialClientData);

  const onClientData = (chunk) => {
    if (passthrough) {
      writeSocket(target, client, chunk, stats, "desktop_to_app_server_bytes");
      return;
    }
    if (!upgraded) {
      queueClientData(chunk);
      return;
    }
    try {
      writeTransformed(target, client, clientFrames.push(chunk), stats, "desktop_to_app_server_bytes");
    } catch {
      protocolFailure();
    }
  };

  const onTargetData = (chunk) => {
    if (passthrough) {
      writeSocket(client, target, chunk, stats, "app_server_to_desktop_bytes");
      return;
    }
    if (upgraded) {
      try {
        writeTransformed(client, target, targetFrames.push(chunk), stats, "app_server_to_desktop_bytes");
      } catch {
        protocolFailure();
      }
      return;
    }

    targetHandshake = targetHandshake.length ? Buffer.concat([targetHandshake, chunk]) : Buffer.from(chunk);
    if (targetHandshake.length > maxHandshakeBytes) {
      protocolFailure();
      return;
    }
    const headerEnd = targetHandshake.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = targetHandshake.subarray(0, headerEnd + 4);
    const response = parseUpgradeResponse(header);
    if (!response) {
      protocolFailure();
      return;
    }
    if (response.hasExtensions) {
      protocolFailure();
      return;
    }
    writeSocket(client, target, header, stats, "app_server_to_desktop_bytes");
    const remainder = targetHandshake.subarray(headerEnd + 4);
    targetHandshake = Buffer.alloc(0);
    if (response.status !== 101) {
      passthrough = true;
      if (remainder.length) writeSocket(client, target, remainder, stats, "app_server_to_desktop_bytes");
      for (const pending of pendingClientChunks.splice(0)) {
        writeSocket(target, client, pending, stats, "desktop_to_app_server_bytes");
      }
      pendingClientBytes = 0;
      return;
    }

    upgraded = true;
    try {
      if (remainder.length) {
        writeTransformed(client, target, targetFrames.push(remainder), stats, "app_server_to_desktop_bytes");
      }
      for (const pending of pendingClientChunks.splice(0)) {
        writeTransformed(target, client, clientFrames.push(pending), stats, "desktop_to_app_server_bytes");
      }
      pendingClientBytes = 0;
    } catch {
      protocolFailure();
    }
  };

  function queueClientData(chunk) {
    pendingClientBytes += chunk.length;
    if (pendingClientBytes > maxMessageBytes + maxHandshakeBytes) {
      protocolFailure();
      return;
    }
    pendingClientChunks.push(Buffer.from(chunk));
  }

  client.on("data", onClientData);
  target.on("data", onTargetData);
}

function parseUpgradeResponse(headerBuffer) {
  const lines = headerBuffer.toString("latin1").split("\r\n");
  const response = lines[0]?.match(/^HTTP\/1\.1\s+(\d{3})(?:\s|$)/i);
  if (!response) return null;
  return {
    status: Number(response[1]),
    hasExtensions: lines.slice(1).some((line) => /^sec-websocket-extensions\s*:/i.test(line)),
  };
}

function writeTransformed(destination, source, buffers, stats, key) {
  for (const buffer of buffers) writeSocket(destination, source, buffer, stats, key);
}

function writeSocket(destination, source, buffer, stats, key) {
  if (!buffer.length || destination.destroyed) return;
  stats[key] += buffer.length;
  if (destination.write(buffer)) return;
  source.pause();
  destination.once("drain", () => source.resume());
}

function parseHandshake(headerBuffer) {
  const lines = headerBuffer.toString("latin1").split("\r\n");
  const request = lines[0]?.match(/^GET\s+(\S+)\s+HTTP\/1\.1$/i);
  if (!request) return null;
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim().toLowerCase());
  }
  return {
    path: request[1],
    isWebSocketUpgrade:
      headers.get("upgrade") === "websocket" &&
      String(headers.get("connection") || "").split(",").map((value) => value.trim()).includes("upgrade"),
  };
}

function rewriteHandshakeHeader(buffer, headerEnd, {
  targetHost,
  targetPort,
  targetAuthorizationToken,
  stripExtensions = false,
}) {
  const headerText = buffer.subarray(0, headerEnd + 4).toString("latin1");
  const lines = headerText.split("\r\n").filter(Boolean);
  lines[0] = "GET / HTTP/1.1";
  const hostIndex = lines.findIndex((line) => /^host\s*:/i.test(line));
  if (hostIndex >= 0) lines[hostIndex] = `Host: ${targetHost}:${targetPort}`;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (/^authorization\s*:/i.test(lines[index]) || (stripExtensions && /^sec-websocket-extensions\s*:/i.test(lines[index]))) {
      lines.splice(index, 1);
    }
  }
  if (targetAuthorizationToken) lines.push(`Authorization: Bearer ${targetAuthorizationToken}`);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

function rejectHttpUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${httpStatusText(status)}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

function httpStatusText(status) {
  if (status === 403) return "Forbidden";
  if (status === 431) return "Request Header Fields Too Large";
  return "Error";
}

function configureSocket(socket) {
  socket.setNoDelay?.(true);
  socket.setKeepAlive?.(true, 10_000);
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(address || "").toLowerCase());
}

function validPort(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535;
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ ...options, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
