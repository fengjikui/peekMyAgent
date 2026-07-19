#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectCodexDesktopInstallation } from "../src/adapters/codex-desktop-installation.mjs";
import { startManagedCodexDesktopInfrastructure } from "../src/adapters/codex-desktop-managed-session.mjs";
import { CODEX_CAPTURE_PROVIDER_ID } from "../src/adapters/codex-exact-proxy.mjs";

const installation = inspectCodexDesktopInstallation();
if (!installation.supported) throw new Error(installation.reason || "Codex Desktop managed App Server is unavailable.");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-real-routing-"));
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "selected-workspace");
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(codexHome, "config.toml"), "[analytics]\nenabled = false\n", { mode: 0o600 });

let infrastructure;
let client;
try {
  infrastructure = await startManagedCodexDesktopInfrastructure({
    installation,
    watchBaseUrl: "http://127.0.0.1:9/agent/codex/isolated-real-routing-probe",
    workspace,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const appServerArgs = infrastructure.app_server_args.join(" ");
  assert.doesNotMatch(appServerArgs, /model_provider/);
  assert.doesNotMatch(appServerArgs, /model_providers\./);
  assert.doesNotMatch(appServerArgs, new RegExp(CODEX_CAPTURE_PROVIDER_ID));
  client = await connectRpc(infrastructure.relay_url);
  const initialized = await client.request("initialize", {
    clientInfo: { name: "peekmyagent-isolated-probe", title: "peekMyAgent isolated probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  assert.match(String(initialized.userAgent || initialized.serverInfo?.version || ""), /0\.144\.2|codex/i);

  const started = await client.request("thread/start", {
    cwd: workspace,
    ephemeral: true,
    modelProvider: "openai",
  });
  assert.ok(started.thread?.id, "real App Server did not return a thread id");
  assert.equal(started.thread.modelProvider, CODEX_CAPTURE_PROVIDER_ID);
  assert.equal(infrastructure.capture_route.selected_thread_id, started.thread.id);
  assert.equal(infrastructure.capture_route.rewritten_requests, 1);
  assert.equal(infrastructure.relay_stats.protocol_errors, 0);
  console.log(JSON.stringify({
    status: "passed",
    app_version: installation.app_version,
    codex_version: installation.codex_version,
    selected_thread_id: started.thread.id,
    selected_model_provider: started.thread.modelProvider,
    process_provider_registration: false,
    rewritten_requests: infrastructure.capture_route.rewritten_requests,
  }, null, 2));
} finally {
  client?.close();
  await infrastructure?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function connectRpc(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    const timer = setTimeout(() => reject(new Error("Timed out connecting to isolated Codex App Server.")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        request(method, params) {
          const id = nextId++;
          return new Promise((requestResolve, requestReject) => {
            const requestTimer = setTimeout(() => {
              pending.delete(id);
              requestReject(new Error(`Codex App Server request timed out: ${method}`));
            }, 8_000);
            pending.set(id, { resolve: requestResolve, reject: requestReject, timer: requestTimer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Isolated Codex App Server WebSocket failed."));
    });
  });
}
