#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-trace-bundle-"));
const storePath = path.join(tmpDir, "store.sqlite");
const cwd = process.cwd();
const originalStateDir = process.env.PEEKMYAGENT_STATE_DIR;
const originalTarget = process.env.PEEK_CLAUDE_TARGET_BASE_URL;
const exportSecret = "sk-exportsecret123456";

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_trace_bundle", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

try {
  process.env.PEEKMYAGENT_STATE_DIR = tmpDir;
  const upstreamUrl = await listen(upstream);
  process.env.PEEK_CLAUDE_TARGET_BASE_URL = upstreamUrl;

  const viewer = await startViewerServer({ cwd, storePath });
  try {
    const watch = await postJson(`${viewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: cwd,
      conversation_id: "trace-bundle-session",
      target_base_url: upstreamUrl,
    });

    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [{ role: "user", content: "export this trace" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      metadata: { smoke_secret: exportSecret },
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      messages: [
        { role: "user", content: "export this trace" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second request" },
      ],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    });

    const exported = await fetchBuffer(`${viewer.url}/api/trace/export?source=${encodeURIComponent(watch.id)}`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") || "", /\.peektrace\.json\.gz/);
    const bundle = JSON.parse(zlib.gunzipSync(exported.buffer).toString("utf8"));
    const bundleText = JSON.stringify(bundle);
    assert.equal(bundle.format, "peekmyagent.trace.v1");
    assert.equal(bundle.captures.length, 2);
    assert.equal(bundle.manifest.request_count, 2);
    assert.equal(bundleText.includes(exportSecret), false, "exported trace should not contain common secret patterns");
    assert.equal(bundleText.includes("[REDACTED:secret]"), true, "exported trace should mark redacted secret patterns");
    assert.equal(bundle.manifest.export_kind, "sanitized_share_bundle");
    assert.equal(bundle.manifest.redaction.applied, true);
    assert.ok(bundle.manifest.redaction.count >= 1);
    assert.match(bundle.manifest.privacy_notice, /Review before sharing/);

    const imported = await postBuffer(`${viewer.url}/api/trace/import`, exported.buffer);
    assert.equal(imported.ok, true);
    assert.equal(imported.request_count, 2);
    assert.ok(imported.source_id?.startsWith("imported-"));

    const sources = await getJson(`${viewer.url}/api/sources`);
    const importedSource = sources.find((source) => source.id === imported.source_id);
    assert.ok(importedSource, "imported source should appear in sidebar sources");
    assert.equal(importedSource.kind, "imported_trace");
    assert.equal(importedSource.readonly, true);
    assert.ok(fs.existsSync(importedSource.path), "imported trace directory exists before deletion");

    const importedView = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(imported.source_id)}`);
    assert.equal(importedView.stats.request_count, 2);
    assert.equal(importedView.source.kind, "imported_trace");
    assert.equal(importedView.requests[0].summary.current_user, "export this trace");
    assert.equal(importedView.requests[1].summary.current_user, "second request");

    const importedDetail = await getJson(`${viewer.url}/api/request?source=${encodeURIComponent(imported.source_id)}&request=${encodeURIComponent(importedView.requests[1].id)}`);
    assert.equal(importedDetail.detail_scope, "request_window", "imported trace request detail should use a request window");
    assert.equal(importedDetail.request.id, importedView.requests[1].id);
    assert.equal(importedDetail.request.summary.current_user, "second request");

    const deletedImport = await postJson(`${viewer.url}/api/source/update`, {
      id: imported.source_id,
      delete: true,
    });
    assert.equal(deletedImport.deleted, true, "delete removes imported trace source");
    assert.equal(deletedImport.sources.some((source) => source.id === imported.source_id), false, "deleted imported trace leaves source list");
    assert.equal(fs.existsSync(importedSource.path), false, "delete removes imported trace directory");

    await assertFileExportUsesRawCaptureFastPath(tmpDir);

    console.log("trace-bundle smoke passed");
  } finally {
    await viewer.close();
  }
} finally {
  await closeServer(upstream);
  if (originalStateDir == null) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = originalStateDir;
  if (originalTarget == null) delete process.env.PEEK_CLAUDE_TARGET_BASE_URL;
  else process.env.PEEK_CLAUDE_TARGET_BASE_URL = originalTarget;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postModelRequest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postBuffer(url, buffer) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: buffer,
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function assertFileExportUsesRawCaptureFastPath(rootDir) {
  const evidenceDir = path.join(rootDir, "export-fast-path-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "proxy-captures.json"),
    JSON.stringify([
      {
        capture_id: "fast-export-capture",
        watch_id: "fast-export",
        request_index: 1,
        received_at: "2026-07-04T00:00:00.000Z",
        method: "POST",
        path: "/v1/messages",
        headers: {},
        body: {
          model: "mock",
          messages: [{ role: "user", content: "export fast path" }],
        },
        response: {
          status: 200,
          body_json: { content: [{ type: "text", text: "ok" }] },
        },
      },
    ]),
  );
  fs.writeFileSync(path.join(evidenceDir, "debug-api-sources.json"), JSON.stringify([{ source: "should-not-be-read-for-export" }]));
  fs.writeFileSync(path.join(evidenceDir, "command.json"), JSON.stringify({ command: "should-not-be-read-for-export" }));

  const originalReadFileSync = fs.readFileSync;
  const companionReads = [];
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    const text = String(filePath);
    if (text.endsWith("debug-api-sources.json") || text.endsWith("command.json")) companionReads.push(text);
    return originalReadFileSync.call(this, filePath, ...args);
  };
  let fastViewer = null;
  try {
    fastViewer = await startViewerServer({
      cwd: rootDir,
      evidencePath: path.relative(rootDir, evidenceDir),
      storePath: path.join(rootDir, "export-fast-path-store.sqlite"),
    });
    const exported = await fetchBuffer(`${fastViewer.url}/api/trace/export?source=custom`);
    assert.equal(exported.status, 200, "file evidence trace export succeeds");
    const bundle = JSON.parse(zlib.gunzipSync(exported.buffer).toString("utf8"));
    assert.equal(bundle.captures.length, 1);
    assert.equal(bundle.manifest.request_count, 1);
    assert.equal(bundle.manifest.response_count, 1);
    assert.deepEqual(companionReads, [], "trace export should not build full timeline companion data");
  } finally {
    if (fastViewer) await fastViewer.close();
    fs.readFileSync = originalReadFileSync;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
