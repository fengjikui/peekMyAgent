import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

// Mirror of the client's lookup-key hashing (translationLookupKey + materialHash)
// and the server's normalizeTranslationSourceText, so we can assert a harness
// block's translation is reachable by the exact key the client computes — the
// parity that makes the original/中文 toggle actually resolve.
function clientHash(kind, sourceText) {
  const normalized = sourceText.replace(/\r\n/g, "\n").trim();
  return crypto.createHash("sha256").update(`${kind}\0${normalized}`).digest("hex");
}

// Smoke for harness-prompt translation: the viewer must extract harness-injected
// prompt fragments (framework reminders, /compact, slash commands, suggestion
// mode) as translation materials under section "harness", translate them via the
// existing pipeline, and surface original/translated like system/tools.
// A mock OpenAI-compatible provider echoes a translation for every source hash.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-translation-smoke-"));
const dumpDir = path.join(tmp, "dump");
fs.mkdirSync(dumpDir, { recursive: true });
const storePath = path.join(tmp, "store.sqlite");
const meta = { user_id: JSON.stringify({ session_id: "sess-harness-tr" }) };

function mockServer() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages[body.messages.length - 1].content;
      const hashes = [...String(prompt).matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((m) => m[1]);
      const content = hashes.map((h) => `@@PEEK_TRANSLATION ${h}\n译文-${h.slice(0, 6)}\n@@PEEK_END_TRANSLATION`).join("\n\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
}

const compactPrompt =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far.\nWrap your analysis in <analysis> tags then provide a <summary> block.";

function dump(name, t, payload) {
  const f = path.join(dumpDir, name);
  fs.writeFileSync(f, JSON.stringify(payload));
  fs.utimesSync(f, t, t);
}

dump("r1.request.json", 1000, {
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "Base system prompt for the agent." }],
  tools: [{ name: "Bash" }],
  metadata: meta,
  messages: [
    { role: "user", content: "<system-reminder>\nThe following deferred tools are now available via ToolSearch.\n</system-reminder>\n请帮我查一下天气。" },
    { role: "assistant", content: "好的" },
    { role: "user", content: "[SUGGESTION MODE: provide a concise next-step suggestion to the user]" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, { type: "text", text: compactPrompt }] },
    { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\nPlease compact now." },
  ],
});

const server = mockServer();
const baseUrl = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
process.env.PEEKMYAGENT_STATE_DIR = tmp;
process.env.PEEKMYAGENT_TRANSLATION_PROTOCOL = "openai";
process.env.PEEKMYAGENT_TRANSLATION_BASE_URL = baseUrl;
process.env.PEEKMYAGENT_TRANSLATION_API_KEY = "mock-key";
process.env.PEEKMYAGENT_TRANSLATION_MODEL = "mock-model";

const store = openPersistenceStore(storePath);
const viewer = await startViewerServer({ cwd: process.cwd(), persistenceStore: store });
let failed = false;
try {
  const ingest = await (await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST", headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-ingest" },
    body: JSON.stringify({ dir: dumpDir, watch_id: "claude-code-harnesstr", agent: "Claude Code", workspace: tmp }),
  })).json();
  assert.equal(ingest.ok, true);

  const gen = await (await fetch(`${viewer.url}/api/translations/generate`, {
    method: "POST", headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
    body: JSON.stringify({ source_id: ingest.source_id, section: "harness", agent: "Claude Code", target_language: "zh-CN", concurrency: 10000 }),
  })).json();

  const kinds = gen.extract?.counts_by_kind || gen.counts_by_kind || {};
  assert.ok(kinds.harness_reminder > 0, "extracts framework reminder");
  assert.ok(kinds.harness_compact > 0, "extracts /compact prompt even bundled with tool_results");
  assert.ok(kinds.harness_command > 0, "extracts slash command body");
  assert.ok(kinds.harness_suggestion > 0, "extracts suggestion-mode text");
  assert.ok((gen.translate?.translated || 0) > 0, "translated at least one harness block");
  assert.equal(gen.translate?.concurrency, 100, "dashboard translation concurrency is capped before invoking the worker");

  const cache = await (await fetch(`${viewer.url}/api/translations?agent=${encodeURIComponent("Claude Code")}&target_language=zh-CN`)).json();
  assert.equal(cache.available, true, "translation cache available after generate");
  const entries = cache.entries || {};
  assert.ok(Object.values(entries).some((e) => /译文-/.test(e.translated_text || "")), "harness translations land in the cache");

  // Lookup parity: the key the client computes for the /compact block must hit a
  // cached translation — guards against harness being absent from the lookup map.
  const compactHash = clientHash("harness_compact", compactPrompt);
  assert.ok(entries[compactHash]?.translated_text, "client-computed hash for the compact prompt resolves to a cached translation");

  const view = await (await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(ingest.source_id)}&compact=1`)).json();
  const requestId = view.requests?.[0]?.id;
  assert.ok(requestId, "ingested request id is available for request-scoped translation refresh");
  const originalLoadCaptures = store.loadCaptures.bind(store);
  store.loadCaptures = () => {
    throw new Error("request-scoped translation must not full-load persisted captures");
  };
  let requestScopedGen;
  try {
    requestScopedGen = await (await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST", headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({ source_id: ingest.source_id, request_id: requestId, section: "harness", agent: "Claude Code", target_language: "zh-CN" }),
    })).json();
  } finally {
    store.loadCaptures = originalLoadCaptures;
  }
  assert.ok(requestScopedGen.extract?.item_count > 0, "request-scoped translation refresh extracts materials");
  assert.equal(requestScopedGen.extract?.source_count, 1, "request-scoped translation refresh reports one source");

  console.log(`harness-translation smoke: OK (reminder/compact/command/suggestion extracted + translated + lookup parity; ${gen.translate?.translated} blocks)`);
} catch (error) {
  failed = true;
  console.error("harness-translation smoke FAILED:", error.message);
} finally {
  await viewer.close();
  store.close();
  await closeServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

function closeServer(server) {
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
