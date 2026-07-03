import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { disableTraeCn, enableTraeCn, inspectTraeCn } from "../src/adapters/trae-cn-integration.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-trae-cn-"));
const appDataRoot = path.join(tmp, "Trae CN");
const registryPath = path.join(tmp, "registry.json");
const storePath = path.join(tmp, "store.sqlite");
const projectDir = path.join(tmp, "projects", "writellm");
fs.mkdirSync(projectDir, { recursive: true });

process.env.PEEKMYAGENT_TRAE_CN_APPDATA = appDataRoot;
process.env.PEEKMYAGENT_IDE_REGISTRY_PATH = registryPath;
process.env.PEEKMYAGENT_STORE_PATH = storePath;

let upstream;
let viewer;
try {
  upstream = await startMockOpenAiUpstream();
  createTraeFixture({ appDataRoot, projectDir, upstreamBaseUrl: upstream.baseUrl });
  viewer = await startViewerServer({ cwd: tmp, storePath, capturePort: 0 });

  const enabled = enableTraeCn({ captureBaseUrl: viewer.captureUrl, registryPath, appDataRoot });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.patched_count, 1);
  assert.match(enabled.stable_url, /\/agent\/trae-cn\/.+\/openai\/v1\/chat\/completions$/);

  const response = await fetch(enabled.stable_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fake-trae-token",
      "user-agent": "hertz",
      "x-model-provider": "custom_openai_compatible",
    },
    body: JSON.stringify({
      model: "mimo-v2.5-pro",
      stream: true,
      messages: [
        { role: "system", content: "You are Trae CN." },
        { role: "user", content: `请阅读项目 ${projectDir} 并总结。` },
      ],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, "/v1/chat/completions");
  assert.equal(upstream.requests[0].headers.host, upstream.hostHeader);

  const sources = await fetchJson(`${viewer.url}/api/sources`);
  const source = sources.find((item) => item.live_watch_id === "trae-cn-session-abc");
  assert.ok(source, "expected live Trae CN source");
  assert.equal(source.agent, "Trae CN");
  assert.equal(source.workspace, projectDir);
  assert.equal(source.conversation_id, "session-abc");
  assert.equal(source.request_count, 1);

  const view = await fetchJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].provider, "xiaomi_mimo");
  assert.equal(view.requests[0].protocol, "openai_chat_completions");
  assert.equal(view.requests[0].summary.response.captured, true);
  assert.equal(view.requests[0].summary.response.thinking, "Thinking from Trae stream.");
  assert.equal(view.requests[0].summary.response.preview, "Hello from Trae stream.");

  const disabled = disableTraeCn({ registryPath, appDataRoot });
  assert.equal(disabled.restored_count, 1);
  const status = inspectTraeCn({ registryPath, appDataRoot });
  assert.equal(status.enabled, false);
  assert.equal(status.model_entries[0].base_url, `${upstream.baseUrl}/v1/chat/completions`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        stable_url: enabled.stable_url,
        source_id: source.id,
        watch_id: source.live_watch_id,
        workspace: source.workspace,
        conversation_id: source.conversation_id,
        upstream_path: upstream.requests[0].url,
      },
      null,
      2,
    ),
  );
} finally {
  await viewer?.close?.();
  await upstream?.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}

function createTraeFixture({ appDataRoot, projectDir, upstreamBaseUrl }) {
  const globalStorage = path.join(appDataRoot, "User", "globalStorage");
  const workspaceStorage = path.join(appDataRoot, "User", "workspaceStorage", "workspace-hash");
  fs.mkdirSync(globalStorage, { recursive: true });
  fs.mkdirSync(workspaceStorage, { recursive: true });

  const modelList = {
    custom_openai_compatible: {
      models: [
        {
          provider: "custom_openai_compatible",
          model: "mimo-v2.5-pro",
          name: "mimo-v2.5-pro",
          base_url: `${upstreamBaseUrl}/v1/chat/completions`,
          ak: "fake-secret",
        },
      ],
    },
  };
  const globalModelMap = {
    default: "custom_openai_compatible//mimo-v2.5-pro",
  };
  createItemDb(path.join(globalStorage, "state.vscdb"), [
    ["1493568356615036_AI.agent.model.model_list_map", JSON.stringify(modelList)],
    ["1493568356615036_ai-chat:sessionRelation:globalModelMap", JSON.stringify(globalModelMap)],
  ]);

  fs.writeFileSync(path.join(workspaceStorage, "workspace.json"), JSON.stringify({ folder: pathToFileURL(projectDir).href }, null, 2));
  createItemDb(path.join(workspaceStorage, "state.vscdb"), [
    ["memento/icube-ai-agent-storage.currentSessionId", JSON.stringify("session-abc")],
    ["icube_session_agent_map", JSON.stringify({ "session-abc": "dev_agent" })],
  ]);
}

function createItemDb(dbPath, rows) {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const row of rows) insert.run(row[0], row[1]);
  } finally {
    db.close();
  }
}

function startMockOpenAiUpstream() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking from Trae stream." } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from Trae stream." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const baseUrl = `http://${address.address}:${address.port}`;
      resolve({
        baseUrl,
        requests,
        hostHeader: `${address.address}:${address.port}`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function loadNodeSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredSqliteWarning(warning, ...args) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (String(message || "").includes("SQLite is an experimental feature")) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
