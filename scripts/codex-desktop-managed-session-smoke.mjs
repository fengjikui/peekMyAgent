import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  codexDesktopAppServerArgs,
  sanitizeManagedCodexDiagnostic,
  startManagedCodexDesktopInfrastructure,
} from "../src/adapters/codex-desktop-managed-session.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-managed-codex-"));
const fakeCodexPath = path.join(tmpDir, "fake-codex.mjs");
const argsLogPath = path.join(tmpDir, "args.json");
const fakeServerSource = `#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
const args = process.argv.slice(2);
fs.writeFileSync(process.env.PMA_FAKE_ARGS_LOG, JSON.stringify(args));
const listenIndex = args.indexOf("--listen");
const listenUrl = new URL(args[listenIndex + 1]);
const tokenFileIndex = args.indexOf("--ws-token-file");
const expectedToken = fs.readFileSync(args[tokenFileIndex + 1], "utf8").trim();
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\\r\\n\\r\\n");
    if (end === -1) return;
    socket.off("data", onData);
    const handshake = buffered.subarray(0, end + 4).toString("latin1");
    if (!handshake.includes("Authorization: Bearer " + expectedToken)) {
      socket.end("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");
      return;
    }
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n");
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("READY")]));
  };
  socket.on("data", onData);
});
server.listen({ host: "127.0.0.1", port: Number(listenUrl.port) });
const stop = () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
fs.writeFileSync(fakeCodexPath, fakeServerSource, { mode: 0o755 });
fs.chmodSync(fakeCodexPath, 0o755);

const installation = {
  supported: true,
  supports_app_server_override: true,
  embedded_codex_path: fakeCodexPath,
};
const watchBaseUrl = "http://127.0.0.1:43111/agent/codex/watch-smoke";
const diagnosticToken = "d".repeat(64);
const sanitizedDiagnostic = sanitizeManagedCodexDiagnostic(
  `Authorization: Bearer ${diagnosticToken} capability_token=${diagnosticToken} api-key=${diagnosticToken}`,
);
assert.equal(sanitizedDiagnostic.includes(diagnosticToken), false);
assert.match(sanitizedDiagnostic, /Authorization: \[REDACTED\]/);
assert.match(sanitizedDiagnostic, /capability_token=\[REDACTED\]/);
const infrastructure = await startManagedCodexDesktopInfrastructure({
  installation,
  watchBaseUrl,
  workspace: tmpDir,
  env: { ...process.env, PMA_FAKE_ARGS_LOG: argsLogPath },
});
let backendTokenPath = null;

try {
  const response = await websocketHandshake(infrastructure.relay_url);
  assert.match(response, /101 Switching Protocols/);
  assert.match(response, /READY/);
  const actualArgs = JSON.parse(fs.readFileSync(argsLogPath, "utf8"));
  const tokenFileIndex = actualArgs.indexOf("--ws-token-file");
  backendTokenPath = actualArgs[tokenFileIndex + 1];
  const expectedArgs = codexDesktopAppServerArgs({
    listenUrl: infrastructure.app_server_url,
    wsTokenFile: backendTokenPath,
  });
  assert.deepEqual(actualArgs, expectedArgs);
  assert.equal(actualArgs.includes('model_provider="peekmyagent_http"'), false);
  assert.equal(actualArgs.some((value) => value.startsWith("model_providers.peekmyagent_http.")), false);
  assert.ok(actualArgs.includes("features.code_mode_host=true"));
  assert.ok(actualArgs.includes("capability-token"));
  assert.ok(path.isAbsolute(backendTokenPath));
  assert.equal(fs.statSync(backendTokenPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(backendTokenPath)).mode & 0o777, 0o700);
  assert.equal(infrastructure.relay_stats.accepted_connections, 1);
  assert.equal(infrastructure.capture_route.capture_mode, "next_new_thread");
  assert.equal(infrastructure.capture_route.capture_state, "waiting_for_new_thread");
  console.log("Codex managed Desktop infrastructure smoke passed");
} finally {
  await infrastructure.close();
  if (backendTokenPath) assert.equal(fs.existsSync(backendTokenPath), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function websocketHandshake(url) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("managed Desktop handshake timed out"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write(
        `GET ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      output += chunk.toString("latin1");
      if (!output.includes("READY")) return;
      clearTimeout(timer);
      socket.end();
      resolve(output);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
