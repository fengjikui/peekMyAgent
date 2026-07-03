import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { startCaptureProxy, startSharedCaptureProxy } from "../core/capture-proxy.mjs";
import { importedTracesDir, safePathSegment, translationsDir } from "../core/app-paths.mjs";
import { claudeCodeProxySettingsArgs, mergeClaudeCodeProcessEnv, resolveClaudeCodeTargetBaseUrl } from "../core/claude-code-settings.mjs";
import { childProcessSpawnConfig, isAccessibleDirectory, safeProcessCwd, userHome } from "../core/platform.mjs";
import { openPersistenceStore, sourceIdForWatch, watchIdFromSourceId } from "../core/persistence-store.mjs";
import { redactText } from "../core/redaction.mjs";
import { clearViewerRegistry, writeViewerRegistry } from "../core/viewer-registry.mjs";
import { resolveTraeCnDynamicRoute } from "../adapters/trae-cn-integration.mjs";
import { OTEL_WATCH_KIND, otelDirToCaptures } from "../core/otel-capture.mjs";

const viewerDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(viewerDir, "../..");
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_TRACE_IMPORT_UNZIPPED_BYTES = 256 * 1024 * 1024;
const MAX_TRACE_IMPORT_CAPTURES = 5000;
const VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES = 16 * 1024;
const TIMELINE_RESPONSE_TEXT_CHARS = 1200;
const TIMELINE_RESPONSE_THINKING_CHARS = 800;
const TIMELINE_TOOL_ARGUMENT_CHARS = 600;
const SOURCE_META_FILE = "source-meta.json";
const comparableMessageKeyCache = new WeakMap();

const DEFAULT_SOURCES = [
  {
    id: "openclaw-subagent",
    label: "OpenClaw 子代理",
    agent: "OpenClaw",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/openclaw-subagent/latest",
    note: "provider baseUrl proxy 捕获；包含主代理与子代理请求。",
  },
  {
    id: "openclaw-multiturn",
    label: "OpenClaw 多轮会话",
    agent: "OpenClaw",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/openclaw-multiturn/latest",
    note: "同一个 session-key 的多轮请求与工具结果回传。",
  },
  {
    id: "claude-subagent",
    label: "Claude Code 子代理",
    agent: "Claude Code",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/claude-subagent-proxy/latest",
    note: "ANTHROPIC_BASE_URL proxy 捕获；含主 Agent 与 Explore 子代理请求。",
  },
  {
    id: "claude-proxy-resume",
    label: "Claude Code proxy resume",
    agent: "Claude Code",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/claude-proxy-resume/latest",
    note: "ANTHROPIC_BASE_URL proxy 捕获；同一 session-id/resume 会话，含 Explore 子代理请求。",
  },
];

function readSourceMeta(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return new Map(
      Object.entries(raw.sources || raw || {})
        .filter(([, value]) => value && typeof value === "object")
        .map(([key, value]) => [key, sanitizeSourceMeta(value)]),
    );
  } catch {
    return new Map();
  }
}

function writeSourceMeta(filePath, sourceMeta) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const sources = Object.fromEntries(
    [...sourceMeta.entries()]
      .map(([key, value]) => [key, sanitizeSourceMeta(value)])
      .filter(([, value]) => value.hidden || value.pinned || value.title),
  );
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), sources }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function sanitizeSourceMeta(meta = {}) {
  const title = String(meta.title || "").trim().slice(0, 80);
  return {
    ...(meta.hidden ? { hidden: true } : {}),
    ...(meta.pinned ? { pinned: true } : {}),
    ...(title ? { title } : {}),
  };
}

export async function startViewerServer({ cwd = safeProcessCwd(), host = "127.0.0.1", port = 0, demo, evidencePath, storePath, persistenceStore, capturePort = null, captureHost = host, exitOnShutdown = false, unsafeAllowRemote = false } = {}) {
  assertSafeBindHost(host, { unsafeAllowRemote });
  assertSafeBindHost(captureHost, { unsafeAllowRemote });
  const watches = new Map();
  const store = persistenceStore || openPersistenceStore(storePath);
  const sourceMetaPath = path.join(path.dirname(store.path), SOURCE_META_FILE);
  const sourceMeta = readSourceMeta(sourceMetaPath);
  const importsDir = importedTracesDir();
  const closeStore = !persistenceStore;
  let sharedCaptureProxy = null;
  let url = null;
  let closePromise = null;
  sharedCaptureProxy =
    capturePort == null
      ? null
      : await startSharedCaptureProxy({
          host: captureHost,
          port: capturePort,
          async getWatch(watchId) {
            const active = [...watches.values()].find((watch) => watch.watch_id === watchId && ["watching", "paused"].includes(watch.status));
            if (active) return active;
            return restorePersistedWatchForSharedProxy(watchId, { watches, store, sharedCaptureProxy });
          },
          getWatchForAgentRoute({ route, body }) {
            return resolveDynamicAgentRouteWatch({ route, body, watches, store, sharedCaptureProxy });
          },
          onCapture(capture, watch) {
            touchWatchFromCapture(watch, capture);
            store?.upsertCapture({ watch, capture });
          },
          onCaptureUpdate(capture, watch) {
            touchWatchFromCapture(watch, capture);
            store?.updateCaptureResponse(capture);
          },
          onCaptureSkipped(watch) {
            touchWatchFromSkippedCapture(watch);
            store?.updateWatchStatus(watch.watch_id, watch.status);
          },
        });
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        cwd,
        host,
        unsafeAllowRemote,
        demo,
        evidencePath,
        watches,
        sourceMeta,
        sourceMetaPath,
        store,
        importsDir,
        sharedCaptureProxy,
        requestShutdown() {
          const forceExitTimer = exitOnShutdown
            ? setTimeout(() => {
                process.exit(0);
              }, 1500)
            : null;
          forceExitTimer?.unref?.();
          setImmediate(() => {
            closeViewer()
              .then(() => {
                if (forceExitTimer) clearTimeout(forceExitTimer);
                if (exitOnShutdown) process.exit(0);
              })
              .catch((error) => {
                if (forceExitTimer) clearTimeout(forceExitTimer);
                console.error(`peekMyAgent daemon shutdown failed: ${error.message}`);
                if (exitOnShutdown) process.exit(1);
              });
          });
        },
      });
    } catch (error) {
      writeJson(res, error.statusCode || 500, { error: error.message });
    }
  });
  const address = await listen(server, host, port);
  url = `http://${address.address}:${address.port}`;
  writeViewerRegistry({ url, capture_url: sharedCaptureProxy?.baseUrl || null, cwd, demo: demo || null, evidence_path: evidencePath || null, started_at: new Date().toISOString() });
  function closeViewer() {
    if (closePromise) return closePromise;
    const uniqueProxies = new Set([...watches.values()].filter((watch) => !watch.proxy_shared).map((watch) => watch.proxy).filter(Boolean));
    const closers = [...uniqueProxies].map((proxy) => proxy.close?.());
    if (sharedCaptureProxy) closers.push(sharedCaptureProxy.close());
    closePromise = new Promise((resolve, reject) => {
      Promise.allSettled(closers).finally(() => {
        server.close((error) => {
          clearViewerRegistry(url);
          if (closeStore) store.close();
          return error ? reject(error) : resolve();
        });
        server.closeIdleConnections?.();
      });
    });
    return closePromise;
  }
  return {
    server,
    url,
    captureUrl: sharedCaptureProxy?.baseUrl || null,
    close: closeViewer,
  };
}

async function handleRequest(req, res, options) {
  const url = new URL(req.url || "/", "http://peek.local");
  const guard = validateLocalHttpRequest(req, url, options);
  if (guard) return writeJson(res, guard.status, { error: guard.message });
  if (url.pathname === "/") return serveFile(res, path.join(viewerDir, "index.html"), "text/html; charset=utf-8");
  if (url.pathname === "/styles.css") return serveFile(res, path.join(viewerDir, "styles.css"), "text/css; charset=utf-8");
  if (url.pathname === "/client.js") return serveFile(res, path.join(viewerDir, "client.js"), "text/javascript; charset=utf-8");
  if (url.pathname === "/api/sources") return writeJson(res, 200, listSources(options));
  if (url.pathname === "/api/translations") {
    const agent = url.searchParams.get("agent") || "Claude Code";
    const targetLanguage = url.searchParams.get("target_language") || "zh-CN";
    return writeJson(res, 200, loadTranslationCache({ agent, targetLanguage }));
  }
  if (url.pathname === "/api/translations/generate" && req.method === "POST") return writeJson(res, 200, await generateTranslations(req, options));
  if (url.pathname === "/api/watch/start" && req.method === "POST") return writeJson(res, 200, await startWatch(req, options));
  if (url.pathname === "/api/watch/stop" && req.method === "POST") return writeJson(res, 200, await stopWatch(req, options));
  if (url.pathname === "/api/watch/pause" && req.method === "POST") return writeJson(res, 200, await pauseWatch(req, options));
  if (url.pathname === "/api/agent/send" && req.method === "POST") return writeJson(res, 200, await sendAgentMessage(req, options));
  if (url.pathname === "/api/source/update" && req.method === "POST") return writeJson(res, 200, await updateSource(req, options));
  if (url.pathname === "/api/trace/import" && req.method === "POST") return writeJson(res, 200, await importTraceBundle(req, options));
  if (url.pathname === "/api/trace/export") return exportTraceBundle(res, url.searchParams.get("source") || "", options);
  if (url.pathname === "/api/capture/otel" && req.method === "POST") return writeJson(res, 200, await ingestOtelCaptures(req, options));
  if (url.pathname === "/api/watch/status") return writeJson(res, 200, listWatchStatus(options));
  if (url.pathname === "/api/daemon/ping") return writeJson(res, 200, daemonPing(options));
  if (url.pathname === "/api/daemon/status") return writeJson(res, 200, daemonStatus(options));
  if (url.pathname === "/api/daemon/shutdown" && req.method === "POST") {
    res.once("finish", () => options.requestShutdown?.());
    writeJson(res, 200, { ok: true, action: "shutdown", pid: process.pid });
    return;
  }
  if (url.pathname === "/api/view") {
    const sourceId = url.searchParams.get("source") || options.demo || null;
    const data = loadViewerData(sourceId, options);
    return writeJson(res, 200, url.searchParams.get("compact") === "1" ? compactViewerDataForTimeline(data) : data);
  }
  if (url.pathname === "/api/request") {
    const sourceId = url.searchParams.get("source") || options.demo || null;
    const requestId = url.searchParams.get("request") || "";
    return writeJson(res, 200, loadViewerRequestDetail(sourceId, requestId, options));
  }
  writeJson(res, 404, { error: "Not found" });
}

async function generateTranslations(req, options) {
  const input = await readJsonBody(req);
  const agent = String(input.agent || "Claude Code").trim() || "Claude Code";
  const targetLanguage = normalizePathBackedLabel(input.target_language || "zh-CN", "target_language");
  const concurrency = positiveInt(input.concurrency, 8);
  const sourceId = String(input.source_id || "").trim();
  const section = String(input.section || "").trim();
  const requestId = String(input.request_id || "").trim();
  const force = input.force === true;
  const inputMaterials = Array.isArray(input.materials) ? input.materials : [];
  const extract = inputMaterials.length
    ? writeTranslationMaterialsFromInput({ materials: inputMaterials, sourceId, requestId, agent, targetLanguage })
    : sourceId
    ? writeTranslationMaterialsForViewerSource({ sourceId, agent, targetLanguage, options, section, requestId })
    : parseJsonCommandOutput((await runNodeScript("scripts/extract-translation-materials.mjs", ["--agent", agent, "--target-language", targetLanguage])).stdout);
  const translateArgs = [
    "--agent",
    agent,
    "--target-language",
    targetLanguage,
    "--concurrency",
    String(concurrency),
  ];
  if (force && extract?.material_hashes?.length) translateArgs.push("--force-hashes", extract.material_hashes.join(","));
  const translate = await runNodeScript("scripts/translate-materials-zh.mjs", translateArgs);
  const translations = loadTranslationCache({ agent, targetLanguage });
  return {
    ok: true,
    agent,
    target_language: targetLanguage,
    extract,
    translate: parseJsonCommandOutput(translate.stdout),
    cache: {
      available: translations.available,
      cache_slug: translations.cache_slug,
      cache_path: translations.cache_path,
      entry_count: translations.entry_count,
      generated_at: translations.generated_at,
      manifest: translations.manifest,
    },
  };
}

function writeTranslationMaterialsForViewerSource({ sourceId, agent, targetLanguage, options, section = "", requestId = "" }) {
  const data = loadViewerData(sourceId, options);
  const byHash = new Map();
  for (const request of data.requests || []) {
    if (requestId && request.id !== requestId) continue;
    collectViewerRequestTranslationMaterials(byHash, request, data.source, targetLanguage, { section });
  }
  const materials = [...byHash.values()].sort(compareTranslationMaterial);
  return writeTranslationMaterials({ materials, sourceId, agent, targetLanguage, sourceCount: 1 });
}

function writeTranslationMaterialsFromInput({ materials: inputMaterials, sourceId, requestId, agent, targetLanguage }) {
  const byHash = new Map();
  const occurrence = {
    source_id: sourceId || null,
    watch_id: null,
    request_id: requestId || null,
    request_index: null,
    workspace: null,
    conversation_id: null,
  };
  for (const item of inputMaterials) {
    addTranslationMaterial(byHash, {
      kind: String(item.kind || "manual_text").trim() || "manual_text",
      source_text: item.source_text,
      source_language: String(item.source_language || "en").trim() || "en",
      target_language: targetLanguage,
      metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
      occurrence,
    });
  }
  const materials = [...byHash.values()].sort(compareTranslationMaterial);
  return writeTranslationMaterials({ materials, sourceId, agent, targetLanguage, sourceCount: sourceId ? 1 : 0 });
}

function writeTranslationMaterials({ materials, sourceId, agent, targetLanguage, sourceCount }) {
  const safeTargetLanguage = normalizePathBackedLabel(targetLanguage, "target_language");
  const dir = translationsDir(agent, targetLanguage);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const materialsPath = path.join(dir, "materials.jsonl");
  fs.writeFileSync(materialsPath, materials.map((item) => JSON.stringify(item)).join("\n") + (materials.length ? "\n" : ""), { mode: 0o600 });
  const manifest = {
    generated_at: new Date().toISOString(),
    source_id: sourceId,
    agent,
    target_language: safeTargetLanguage,
    materials_path: materialsPath,
    item_count: materials.length,
    counts_by_kind: countTranslationMaterialsByKind(materials),
    source_count: sourceCount,
    request_occurrence_count: materials.reduce((sum, item) => sum + item.occurrences.length, 0),
    contains_source_text: true,
    material_hashes: materials.map((item) => item.hash),
  };
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { ...manifest, manifest_path: manifestPath };
}

function collectViewerRequestTranslationMaterials(byHash, request, source, targetLanguage, { section = "" } = {}) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const occurrence = {
    source_id: source.id,
    watch_id: request.watch_id || request.raw?.watch_id || null,
    request_id: request.id,
    request_index: request.request_index,
    workspace: request.workspace || source.workspace || null,
    conversation_id: request.conversation_id || source.conversation_id || null,
  };

  if (!section || section === "system") {
    extractTranslationSystemParts(body, messages).forEach((part, index) => {
      addTranslationMaterial(byHash, {
        kind: systemTranslationKind(part.text),
        source_text: part.text,
        source_language: "en",
        target_language: targetLanguage,
        metadata: { source: part.source, index },
        occurrence,
      });
    });
  }

  if (!section || section === "harness") {
    extractHarnessTranslationParts(messages).forEach((part) => {
      addTranslationMaterial(byHash, {
        kind: part.kind,
        source_text: part.text,
        source_language: "en",
        target_language: targetLanguage,
        metadata: { label: part.label, path: part.path },
        occurrence,
      });
    });
  }

  if (!section || section === "tools") {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    tools.forEach((tool, toolIndex) => {
      const toolName = translationToolName(tool);
      const description = normalizeTranslationSourceText(tool?.description || tool?.function?.description || "");
      if (description) {
        addTranslationMaterial(byHash, {
          kind: "tool_description",
          source_text: description,
          source_language: "en",
          target_language: targetLanguage,
          metadata: { tool_name: toolName, path: `tools[${toolIndex}].description` },
          occurrence,
        });
      }
      const schema = tool.input_schema || tool.function?.parameters || tool.parameters || null;
      for (const item of extractTranslationSchemaDescriptions(schema, { rootPath: `tools[${toolIndex}].input_schema` })) {
        addTranslationMaterial(byHash, {
          kind: "tool_parameter_description",
          source_text: item.description,
          source_language: "en",
          target_language: targetLanguage,
          metadata: { tool_name: toolName, path: item.path, field_name: item.field_name },
          occurrence,
        });
      }
    });
  }
}

function addTranslationMaterial(byHash, input) {
  const sourceText = normalizeTranslationSourceText(input.source_text);
  if (isSkippableTranslationMaterial(input.kind, sourceText)) return;
  if (!sourceText || sourceText.length < 2) return;
  const hash = translationMaterialHash(input.kind, sourceText);
  const existing = byHash.get(hash);
  if (existing) {
    existing.occurrences.push(input.occurrence);
    existing.occurrence_count = existing.occurrences.length;
    return;
  }
  byHash.set(hash, {
    id: `${input.kind}:${hash.slice(0, 16)}`,
    hash,
    kind: input.kind,
    source_language: input.source_language,
    target_language: input.target_language,
    text_chars: sourceText.length,
    source_text: sourceText,
    metadata: input.metadata || {},
    occurrences: [input.occurrence],
    occurrence_count: 1,
  });
}

function extractTranslationSystemParts(body, messages) {
  const output = [];
  if (typeof body.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body.system)) {
    body.system.forEach((part) => output.push({ source: "body.system", text: extractContentText(part) }));
  }
  for (const message of messages) {
    if (message.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => part.text);
}

// Extract the harness-injected prompt fragments from the message history so
// they can be translated + shown original/translated like the system prompt.
// Covers framework reminders (<system-reminder> blocks), the /compact prompt,
// slash-command expansions and suggestion-mode text. Task notifications are
// intentionally excluded (mixed-language content, not a prompt to translate).
function extractHarnessTranslationParts(messages) {
  const output = [];
  const reminderRegex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
  (Array.isArray(messages) ? messages : []).forEach((message, messageIndex) => {
    if (!message || message.role !== "user") return;
    const fullText = extractContentText(message.content);

    const compact = compactInjectionText(message);
    if (compact) {
      output.push({ kind: "harness_compact", text: compact, label: "compact 压缩指令", path: `messages[${messageIndex}]` });
    }

    const commandMessage = parseCommandMessage(message);
    if (commandMessage?.body) {
      output.push({ kind: "harness_command", text: commandMessage.body, label: `命令 ${commandMessage.command}`, path: `messages[${messageIndex}]` });
    }

    if (isSuggestionModeMessage(message)) {
      output.push({ kind: "harness_suggestion", text: fullText, label: "Suggestion 模式", path: `messages[${messageIndex}]` });
    }

    let match;
    let reminderIndex = 0;
    while ((match = reminderRegex.exec(fullText))) {
      const inner = (match[1] || "").trim();
      if (inner) {
        output.push({ kind: "harness_reminder", text: inner, label: `框架提醒 #${reminderIndex + 1}`, path: `messages[${messageIndex}].system-reminder[${reminderIndex}]` });
      }
      reminderIndex += 1;
    }
  });
  return output.filter((part) => part.text);
}

function extractTranslationSchemaDescriptions(schema, { rootPath }) {
  const output = [];
  visit(schema, rootPath, "");
  return output;

  function visit(value, currentPath, fieldName) {
    if (!value || typeof value !== "object") return;
    if (typeof value.description === "string" && value.description.trim()) {
      output.push({ field_name: fieldName || null, path: `${currentPath}.description`, description: value.description });
    }
    const properties = value.properties && typeof value.properties === "object" ? value.properties : {};
    for (const [key, child] of Object.entries(properties)) visit(child, `${currentPath}.properties.${key}`, key);
    if (value.items) visit(value.items, `${currentPath}.items`, fieldName);
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(value[key])) value[key].forEach((child, index) => visit(child, `${currentPath}.${key}[${index}]`, fieldName));
    }
  }
}

function translationToolName(tool) {
  return tool?.name || tool?.function?.name || tool?.type || "unknown";
}

function normalizeTranslationSourceText(value) {
  return normalizeVolatileSystemLines(stripVolatileSystemPreamble(String(value || "").replace(/\r\n/g, "\n").trim())).trim();
}

function stripVolatileSystemPreamble(text) {
  return String(text || "")
    .replace(/^The date has changed\. Today's date is now \d{4}-\d{2}-\d{2}\. DO NOT mention this to the user explicitly because they are already aware\.\n\n/, "")
    .replace(/^Today's date is now \d{4}-\d{2}-\d{2}\. DO NOT mention this to the user explicitly because they are already aware\.\n\n/, "");
}

function normalizeVolatileSystemLines(text) {
  return String(text || "")
    .replace(/^(\s*-\s*You are powered by the model\s+).+?(\.?)$/gm, "$1<model>$2")
    .replace(/^(\s*-\s*Primary working directory:\s+).+$/gm, "$1<workspace>")
    .replace(/(You have a persistent file-based memory at\s+)`[^`]+`/g, "$1`<project-memory>`");
}

function isSkippableTranslationMaterial(kind, sourceText) {
  if (kind !== "system_prompt") return false;
  return /^x-anthropic-billing-header:\s*/i.test(sourceText);
}

function systemTranslationKind(text) {
  const value = String(text || "").trim();
  if (/^Called the .+ tool with the following input/i.test(value) && /Result of calling the .+ tool/i.test(value)) return "system_injected_context";
  return "system_prompt";
}

function translationMaterialHash(kind, sourceText) {
  return crypto.createHash("sha256").update(`${kind}\0${sourceText}`).digest("hex");
}

function compareTranslationMaterial(left, right) {
  const kind = left.kind.localeCompare(right.kind);
  if (kind) return kind;
  const count = right.occurrence_count - left.occurrence_count;
  if (count) return count;
  return left.hash.localeCompare(right.hash);
}

function countTranslationMaterialsByKind(materials) {
  return materials.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});
}

function runNodeScript(relativeScriptPath, args) {
  const scriptPath = path.join(projectRoot, relativeScriptPath);
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(process.execPath, [scriptPath, ...args], { env: process.env });
    execFile(spawnConfig.command, spawnConfig.args, { cwd: projectRoot, env: process.env, maxBuffer: 20 * 1024 * 1024, ...spawnConfig.options }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr ? `\n${stderr.trim()}` : ""}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJsonCommandOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function loadTranslationCache({ agent, targetLanguage }) {
  targetLanguage = normalizePathBackedLabel(targetLanguage || "zh-CN", "target_language");
  const candidates = translationCacheCandidates(agent, targetLanguage);
  const found = candidates.find((candidate) => fs.existsSync(candidate.cachePath));
  const { cachePath, manifestPath, slug } = found || candidates[0];
  if (!fs.existsSync(cachePath)) {
    return {
      available: false,
      agent,
      cache_slug: slug,
      target_language: targetLanguage,
      cache_path: cachePath,
      entries: {},
      entry_count: 0,
    };
  }
  const cache = readJsonFile(cachePath);
  const manifest = fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
  const entries = cache?.entries && typeof cache.entries === "object" ? cache.entries : {};
  return {
    available: true,
    agent,
    cache_slug: slug,
    target_language: cache?.target_language || targetLanguage,
    cache_path: cachePath,
    generated_at: cache?.generated_at || null,
    provider: cache?.provider || null,
    manifest: manifest
      ? {
          generated_at: manifest.generated_at || null,
          item_count: manifest.item_count || 0,
          counts_by_kind: manifest.counts_by_kind || {},
          source_count: manifest.source_count || 0,
        }
      : null,
    entries,
    entry_count: Object.keys(entries).length,
  };
}

function translationCacheCandidates(agent, targetLanguage) {
  const safeTargetLanguage = normalizePathBackedLabel(targetLanguage || "zh-CN", "target_language");
  const slugs = [...new Set([slugify(agent), ...translationAliasSlugs(agent)])].filter(Boolean);
  return slugs.map((slug) => {
    const dir = translationsDir(slug, safeTargetLanguage);
    return {
      slug,
      dir,
      cachePath: path.join(dir, `${safePathSegment(safeTargetLanguage, "target-language")}.json`),
      manifestPath: path.join(dir, "manifest.json"),
    };
  });
}

function translationAliasSlugs(agent) {
  const value = String(agent || "");
  const aliases = [];
  if (/claude|anthropic|\bcc\b|claude-code/i.test(value)) aliases.push("claude-code");
  if (/trae/i.test(value)) aliases.push("trae-cn");
  return aliases;
}

function baseSources({ cwd, demo, evidencePath, watches }) {
  if (evidencePath) {
    const absPath = path.resolve(cwd, evidencePath);
    return [
      {
        id: "custom",
        label: path.basename(absPath),
        agent: "Custom",
        confidence: "unknown",
        kind: "proxy_capture",
        path: absPath,
        available: hasCaptureFile(absPath),
        note: "用户指定的证据目录。",
        ...sourceListStats(absPath),
      },
    ];
  }
  const defaultSources = demo
    ? DEFAULT_SOURCES.map((source) => {
        const absPath = path.resolve(cwd, source.path);
        return { ...source, path: absPath, available: hasCaptureFile(absPath), ...sourceListStats(absPath) };
      })
    : [];
  return [...activeWatchSources(watches), ...defaultSources];
}

function listSources(options) {
  return decorateSources([...baseSources(options), ...persistedSources(options), ...importedTraceSources(options)], options.sourceMeta);
}

function persistedSources({ store, watches }) {
  if (!store) return [];
  const activeWatchIds = new Set([...watches.values()].map((watch) => watch.watch_id));
  return store
    .listSources()
    .filter((source) => !activeWatchIds.has(source.store_watch_id))
    .map((source) => decoratePersistedSourceTitle(source, store));
}

function decoratePersistedSourceTitle(source, store) {
  if (source.user_title) return { ...source, label: cleanStoredSourceLabel(source.user_title) || source.user_title };
  const cleaned = cleanStoredSourceLabel(source.label);
  if (cleaned && !isGenericPersistedSourceLabel(cleaned, source)) return { ...source, label: cleaned };
  const captures = store?.loadInitialCaptures?.(source.store_watch_id, { limit: 5 }) || [];
  const inferred = captures.map(inferCaptureTitle).find(Boolean);
  if (inferred) return { ...source, label: inferred };
  return cleaned ? { ...source, label: cleaned } : source;
}

function isGenericPersistedSourceLabel(label, source = {}) {
  const value = String(label || "").trim();
  if (!value) return true;
  const agent = String(source.agent || "").trim();
  const mode = source.mode ? modeLabel(source.mode) : "";
  const genericLabels = new Set(
    [
      agent && mode ? `${agent} · ${mode}` : "",
      agent && source.kind === "otel_raw_body" ? `${agent} · OTel` : "",
      "Claude Code · 监控一个会话",
      "Claude Code · OTel",
      "OpenClaw · 监控一个会话",
    ].filter(Boolean),
  );
  return genericLabels.has(value);
}

function importedTraceSources({ importsDir }) {
  if (!importsDir || !fs.existsSync(importsDir)) return [];
  return fs
    .readdirSync(importsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => importedTraceSourceFromDir(path.join(importsDir, entry.name), entry.name))
    .filter(Boolean);
}

function importedTraceSourceFromDir(dir, idPart = path.basename(dir)) {
  if (!hasCaptureFile(dir)) return null;
  const manifest = readOptionalJson(path.join(dir, "manifest.json")) || {};
  const source = manifest.source || {};
  const stats = traceManifestStats(manifest) || sourceListStats(dir);
  return {
    id: `imported-${idPart}`,
    label: manifest.title || source.label || path.basename(dir),
    original_label: manifest.title || source.label || path.basename(dir),
    agent: source.agent || manifest.agent || "Imported Trace",
    confidence: "imported",
    kind: "imported_trace",
    path: dir,
    available: true,
    readonly: true,
    imported: true,
    note: "导入的 peekMyAgent Trace 包；只读查看，不绑定本机实时监听。",
    created_at: manifest.imported_at || manifest.exported_at || null,
    workspace: source.workspace || stats.workspace || null,
    conversation_id: source.conversation_id || null,
    ...stats,
  };
}

function traceManifestStats(manifest) {
  const requestCount = Number(manifest?.request_count);
  if (!Number.isFinite(requestCount) || requestCount <= 0) return null;
  return {
    request_count: requestCount,
    response_count: Number(manifest.response_count) || 0,
    subagent_count: Number(manifest.subagent_count) || 0,
    raw_body_bytes: Number(manifest.raw_body_bytes) || 0,
  };
}

function loadViewerData(sourceId, options) {
  const sources = listSources(options);
  const source = sources.find((item) => item.id === sourceId) || sources[0];
  if (!source) throw new Error("No viewer sources configured");
  if (!source.available) throw new Error(`Evidence not found: ${source.path}`);
  if (source.live_watch_id) return loadLiveWatchData(source, options);
  if (source.kind === "persisted_capture") return loadPersistedData(source, options);

  const captures = readJson(path.join(source.path, "proxy-captures.json"));
  const debugSources = readOptionalJson(path.join(source.path, "debug-api-sources.json")) || [];
  const command = readOptionalJson(path.join(source.path, "command.json"));
  const requests = captures.map((capture, index) => summarizeCapture(capture, source, index, debugSources[index]));
  annotateRequestChanges(requests);
  annotateSubagentLineage(requests);
  const turns = buildTurnTimeline(requests);
  const agentTrace = buildAgentTrace(requests);
  attachAgentTraceToTurns(turns, agentTrace);
  return {
    generated_at: new Date().toISOString(),
    source: { ...source, command, workbench: buildWorkbenchSummary(source, requests, command) },
    stats: buildStats(requests, agentTrace),
    requests,
    turns,
    agent_trace: agentTrace,
  };
}

function loadViewerRequestDetail(sourceId, requestId, options) {
  if (!requestId) throw new Error("Missing request id");
  const sources = listSources(options);
  const source = sources.find((item) => item.id === sourceId) || sources[0];
  if (!source) throw new Error("No viewer sources configured");
  if (!source.available) throw new Error(`Evidence not found: ${source.path}`);
  if (source.live_watch_id) return loadLiveWatchRequestDetail(source, requestId, options);
  if (source.kind === "persisted_capture") return loadPersistedRequestDetail(source, requestId, options);

  const data = loadViewerData(sourceId, options);
  const request = data.requests.find((item) => item.id === requestId || String(item.request_index) === String(requestId));
  if (!request) throw new Error(`Request not found: ${requestId}`);
  return {
    generated_at: data.generated_at,
    source: data.source,
    request,
  };
}

function loadLiveWatchRequestDetail(source, requestId, { watches }) {
  const watch = [...(watches?.values() || [])].find((item) => item.watch_id === source.live_watch_id || item.id === source.id);
  if (!watch) throw new Error(`Live watch not found: ${source.live_watch_id || source.id}`);
  const captures = capturesForWatch(watch);
  const targetIndex = captures.findIndex((capture) => captureMatchesRequestId(capture, requestId));
  if (targetIndex < 0) throw new Error(`Request not found: ${requestId}`);
  const windowCaptures = captures.slice(Math.max(0, targetIndex - 1), targetIndex + 1);
  const request = summarizeRequestDetailWindow(windowCaptures, source, requestId);
  return {
    generated_at: new Date().toISOString(),
    source,
    request,
    detail_scope: "request_window",
  };
}

function loadPersistedRequestDetail(source, requestId, { store }) {
  const watchId = source.store_watch_id || watchIdFromSourceId(source.id);
  if (!watchId) throw new Error(`Invalid persisted source id: ${source.id}`);
  const captures = store.loadCaptureWindow(watchId, requestId, { previousCount: 1 });
  if (!captures.length) throw new Error(`Request not found: ${requestId}`);
  const request = summarizeRequestDetailWindow(captures, source, requestId);
  return {
    generated_at: new Date().toISOString(),
    source,
    request,
    detail_scope: "request_window",
  };
}

function summarizeRequestDetailWindow(captures, source, requestId) {
  const requests = captures.map((capture, index) => {
    const requestIndex = Number(capture.request_index);
    const sourceIndex = Number.isFinite(requestIndex) && requestIndex > 0 ? requestIndex - 1 : index;
    return summarizeCapture(capture, source, sourceIndex, null);
  });
  annotateRequestChanges(requests);
  const request = requests.find((item) => item.id === requestId || String(item.request_index) === String(requestId)) || requests.at(-1);
  if (!request) throw new Error(`Request not found: ${requestId}`);
  request.detail_scope = "request_window";
  return request;
}

function captureMatchesRequestId(capture, requestId) {
  return capture?.capture_id === requestId || String(capture?.request_index) === String(requestId);
}

function compactViewerDataForTimeline(data) {
  return {
    ...data,
    requests: (data.requests || []).map(compactRequestForTimeline),
  };
}

function compactRequestForTimeline(request) {
  const summary = request.summary || {};
  const historyStack = Array.isArray(summary.history_stack) ? summary.history_stack : [];
  const { history_stack, tool_calls, tool_results, ...summaryWithoutHeavyFields } = summary;
  return {
    ...request,
    summary: {
      ...summaryWithoutHeavyFields,
      history_stack: [],
      history_stack_omitted: {
        count: historyStack.length,
      },
      tool_calls_omitted: Array.isArray(tool_calls) ? { count: tool_calls.length } : undefined,
      tool_results_omitted: Array.isArray(tool_results) ? { count: tool_results.length } : undefined,
      current_tool_calls: (summary.current_tool_calls || []).map(compactToolCallForTimeline),
      current_tool_results: (summary.current_tool_results || []).map(compactToolResultForTimeline),
      response: compactResponseSummaryForTimeline(summary.response),
    },
    raw: compactRawCaptureForTimeline(request.raw),
    detail_omitted: true,
  };
}

function compactResponseSummaryForTimeline(response) {
  if (!response || typeof response !== "object") return response || null;
  const { complete_response, ...rest } = response;
  return {
    ...rest,
    text: textPreview(response.text || "", TIMELINE_RESPONSE_TEXT_CHARS),
    thinking: textPreview(response.thinking || "", TIMELINE_RESPONSE_THINKING_CHARS),
    tool_calls: (response.tool_calls || []).map(compactToolCallForTimeline),
    ...(complete_response ? { complete_response_omitted: true } : {}),
  };
}

function compactToolCallForTimeline(call) {
  if (!call || typeof call !== "object") return call;
  return {
    ...call,
    arguments: compactPreviewValue(call.arguments),
  };
}

function compactToolResultForTimeline(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    content: textPreview(result.content || "", Math.min(800, TIMELINE_TOOL_ARGUMENT_CHARS)),
  };
}

function compactPreviewValue(value) {
  const serialized = stableJson(value ?? null);
  if (serialized.length <= TIMELINE_TOOL_ARGUMENT_CHARS) return value;
  return {
    preview: textPreview(serialized, TIMELINE_TOOL_ARGUMENT_CHARS),
    omitted: {
      reason: "compact_view",
      chars: serialized.length,
    },
  };
}

function compactRawCaptureForTimeline(raw) {
  if (!raw || typeof raw !== "object") return raw || null;
  const body = raw.body && typeof raw.body === "object" ? raw.body : null;
  const response = raw.response && typeof raw.response === "object" ? raw.response : null;
  const { body: _body, response: _response, ...rest } = raw;
  return {
    ...rest,
    body: compactRawBodyMetadata(body),
    body_omitted: body
      ? {
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
          system: Array.isArray(body.system) ? body.system.length : body.system ? 1 : 0,
          raw_body_length: raw.raw_body_length || byteLength(body),
        }
      : null,
    response: compactRawResponseMetadata(response),
    detail_omitted: true,
  };
}

function compactRawBodyMetadata(body) {
  if (!body || typeof body !== "object") return null;
  const output = {};
  for (const key of ["model", "stream", "max_tokens", "temperature", "top_p"]) {
    if (body[key] !== undefined) output[key] = body[key];
  }
  return output;
}

function compactRawResponseMetadata(response) {
  if (!response || typeof response !== "object") return response || null;
  const output = {};
  for (const key of ["status", "headers", "header_redactions", "received_at", "duration_ms", "raw_body_length", "captured_body_length", "truncated", "body_text_omitted"]) {
    if (response[key] !== undefined) output[key] = response[key];
  }
  if (response.body_json !== undefined && response.body_json !== null) output.body_json_omitted = true;
  if (typeof response.body_text === "string") {
    output.body_text_omitted =
      response.body_text_omitted || {
        reason: "compact_view",
        byte_size: Buffer.byteLength(response.body_text, "utf8"),
        raw_body_length: response.raw_body_length || Buffer.byteLength(response.body_text, "utf8"),
        captured_body_length: response.captured_body_length || Buffer.byteLength(response.body_text, "utf8"),
      };
  }
  return output;
}

// Ingest Claude Code OTel raw-body dumps (subscription/OAuth path). The wrapper
// runs `claude` with OTEL_LOG_RAW_API_BODIES so the agent connects directly to
// the official endpoint (no proxy -> no 403) and dumps request/response bodies
// to a local dir. We read that dir and persist captures exactly like the proxy
// path, so listSources/loadViewerData surface it as a normal persisted source.
async function ingestOtelCaptures(req, options) {
  const input = await readJsonBody(req);
  const { store, cwd } = options;
  const dir = String(input.dir || "").trim();
  if (!dir) throw new Error("ingestOtelCaptures requires a dump dir");
  const watchId = String(input.watch_id || "").trim();
  if (!watchId) throw new Error("ingestOtelCaptures requires watch_id");
  const agent = input.agent || "Claude Code";
  const workspace = input.workspace || cwd;
  const conversationId = input.conversation_id || null;
  const captures = otelDirToCaptures(dir, { watchId, workspace, agent, conversationId });
  const watch = {
    watch_id: watchId,
    label: input.label || `${agent} · OTel`,
    agent,
    mode: input.mode || "single_session",
    confidence: "exact",
    kind: OTEL_WATCH_KIND,
    workspace,
    conversation_id: conversationId,
    status: input.status || "stored",
  };
  let ingested = 0;
  let responses = 0;
  for (const capture of captures) {
    const result = store?.upsertCapture({ watch, capture });
    if (result?.inserted) ingested += 1;
    // Always attempt the response update: on incremental re-ingest the request
    // may already exist while its response was dumped only afterwards.
    if (capture.response && store?.updateCaptureResponse(capture)?.updated) responses += 1;
  }
  return {
    ok: true,
    watch_id: watchId,
    source_id: sourceIdForWatch(watchId),
    total: captures.length,
    ingested,
    responses,
  };
}

async function startWatch(req, { cwd, watches, store, sharedCaptureProxy }) {
  const input = await readJsonBody(req);
  const agent = input.agent || "Claude Code";
  const mode = input.mode || "next_request";
  const workspace = input.workspace || cwd;
  const conversationId = input.conversation_id || null;
  if (input.reuse_watch_id) {
    const explicitReusable = findWatch(watches, { id: input.reuse_watch_id, watch_id: input.reuse_watch_id });
    if (explicitReusable) return reuseWatch(explicitReusable, input, { store, sharedCaptureProxy });
    const persistedReusable = findPersistedWatchSource(store, { watch_id: input.reuse_watch_id });
    if (persistedReusable) return restorePersistedWatch(persistedReusable, input, { watches, store, sharedCaptureProxy });
  }
  if (input.reuse !== false) {
    const existing = findReusableWatch(watches, { agent, mode, workspace, conversationId });
    if (existing) return reuseWatch(existing, input, { store, sharedCaptureProxy });
    const persisted = findReusablePersistedWatch(store, { agent, mode, workspace, conversationId });
    if (persisted) return restorePersistedWatch(persisted, input, { watches, store, sharedCaptureProxy });
  }
  const targetBaseUrl = input.target_base_url || resolveTargetBaseUrl(agent, workspace);
  if (!targetBaseUrl) {
    throw new Error(`Missing upstream base URL for ${agent}. Set ANTHROPIC_BASE_URL for Claude Code or OPENAI_BASE_URL/OPENCLAW_BASE_URL for OpenClaw before starting the viewer.`);
  }
  const watchId = `${slugify(agent)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  let watch;
  const proxy =
    sharedCaptureProxy ||
    (await startCaptureProxy({
      targetBaseUrl,
      preserveTargetPathPrefix: true,
      defaultAttribution: {
        watchId,
        agentProfile: agent,
        workspace,
        conversationId,
      },
      shouldCapture() {
        return watch?.status !== "paused";
      },
      onCapture(capture) {
        touchWatchFromCapture(watch, capture);
        store?.upsertCapture({ watch, capture });
      },
      onCaptureUpdate(capture) {
        touchWatchFromCapture(watch, capture);
        store?.updateCaptureResponse(capture);
      },
      onCaptureSkipped() {
        touchWatchFromSkippedCapture(watch);
        store?.updateWatchStatus(watch.watch_id, watch.status);
      },
    }));
  const sourceId = `live-${watchId}`;
  watch = {
    id: sourceId,
    watch_id: watchId,
    label: `${agent} · ${modeLabel(mode)}`,
    agent,
    mode,
    confidence: "exact",
    kind: "proxy_capture",
    note: "实时监听中；将 Agent base URL 临时指向本地代理后开始捕获。",
    target_base_url: targetBaseUrl,
    base_url: proxy.urlForWatch(watchId),
    proxy,
    proxy_shared: Boolean(sharedCaptureProxy),
    created_at: new Date().toISOString(),
    workspace,
    conversation_id: conversationId,
    provider_id: input.provider_id || null,
    config_patched: Boolean(input.config_patched),
    started_by: input.started_by || "viewer",
    status: "watching",
    skipped_while_paused: 0,
  };
  watches.set(sourceId, watch);
  store?.upsertWatch(watch);
  return watchResponse(watch, { reused: false });
}

async function reuseWatch(watch, input, { store, sharedCaptureProxy } = {}) {
  if (watch.status === "watching") return watchResponse(watch, { reused: true });
  const targetBaseUrl = input.target_base_url || watch.target_base_url || resolveTargetBaseUrl(watch.agent, watch.workspace);
  if (!targetBaseUrl) throw new Error(`Missing upstream base URL for ${watch.agent}.`);
  if (sharedCaptureProxy) {
    watch.proxy = sharedCaptureProxy;
    watch.proxy_shared = true;
    watch.base_url = sharedCaptureProxy.urlForWatch(watch.watch_id);
    watch.target_base_url = targetBaseUrl;
    watch.status = "watching";
    watch.proxy_closed = false;
    watch.restarted_at = new Date().toISOString();
    watch.stopped_at = null;
    watch.provider_id = input.provider_id || watch.provider_id || null;
    watch.config_patched = Boolean(input.config_patched || watch.config_patched);
    watch.started_by = input.started_by || watch.started_by;
    if (input.conversation_id && !watch.conversation_id) watch.conversation_id = input.conversation_id;
    store?.upsertWatch(watch);
    return watchResponse(watch, { reused: true });
  }
  const captures = watch.proxy?.captures || [];
  const proxy = await startCaptureProxy({
    targetBaseUrl,
    preserveTargetPathPrefix: true,
    captures,
      defaultAttribution: {
        watchId: watch.watch_id,
        agentProfile: watch.agent,
        workspace: watch.workspace,
        conversationId: input.conversation_id || watch.conversation_id || null,
      },
      shouldCapture() {
        return watch.status !== "paused";
      },
      onCapture(capture) {
        touchWatchFromCapture(watch, capture);
        store?.upsertCapture({ watch, capture });
      },
      onCaptureUpdate(capture) {
        touchWatchFromCapture(watch, capture);
        store?.updateCaptureResponse(capture);
      },
      onCaptureSkipped() {
        touchWatchFromSkippedCapture(watch);
        store?.updateWatchStatus(watch.watch_id, watch.status);
      },
    });
  watch.proxy = proxy;
  watch.base_url = proxy.urlForWatch(watch.watch_id);
  watch.target_base_url = targetBaseUrl;
  watch.status = "watching";
  watch.proxy_closed = false;
  watch.restarted_at = new Date().toISOString();
  watch.stopped_at = null;
  watch.provider_id = input.provider_id || watch.provider_id || null;
  watch.config_patched = Boolean(input.config_patched || watch.config_patched);
  watch.started_by = input.started_by || watch.started_by;
  if (input.conversation_id && !watch.conversation_id) watch.conversation_id = input.conversation_id;
  store?.upsertWatch(watch);
  return watchResponse(watch, { reused: true });
}

async function restorePersistedWatch(source, input, { watches, store, sharedCaptureProxy } = {}) {
  const watchId = source.store_watch_id;
  if (!watchId) throw new Error("Persisted watch is missing store_watch_id");
  const targetBaseUrl = input.target_base_url || resolveTargetBaseUrl(source.agent, source.workspace);
  if (!targetBaseUrl) throw new Error(`Missing upstream base URL for ${source.agent}.`);
  const captures = store?.loadCaptures(watchId) || [];
  let proxy = sharedCaptureProxy;
  if (proxy) {
    proxy.addCaptures?.(captures);
  } else {
    proxy = await startCaptureProxy({
      targetBaseUrl,
      preserveTargetPathPrefix: true,
      captures,
      defaultAttribution: {
        watchId,
        agentProfile: source.agent,
        workspace: source.workspace,
        conversationId: input.conversation_id || source.conversation_id || null,
      },
      shouldCapture() {
        return watch?.status !== "paused";
      },
      onCapture(capture) {
        touchWatchFromCapture(watch, capture);
        store?.upsertCapture({ watch, capture });
      },
      onCaptureUpdate(capture) {
        touchWatchFromCapture(watch, capture);
        store?.updateCaptureResponse(capture);
      },
      onCaptureSkipped() {
        touchWatchFromSkippedCapture(watch);
        store?.updateWatchStatus(watch.watch_id, watch.status);
      },
    });
  }

  const watch = {
    id: `live-${watchId}`,
    watch_id: watchId,
    label: source.original_label || source.label || `${source.agent} · ${modeLabel(source.mode || input.mode || "single_session")}`,
    title: source.user_title || null,
    agent: source.agent,
    mode: source.mode || input.mode || "single_session",
    confidence: source.confidence || "exact",
    kind: "proxy_capture",
    note: "从本地持久化监听恢复；继续写入同一个 watch。",
    target_base_url: targetBaseUrl,
    base_url: proxy.urlForWatch(watchId),
    proxy,
    proxy_shared: Boolean(sharedCaptureProxy),
    created_at: source.created_at || new Date().toISOString(),
    workspace: source.workspace || input.workspace || null,
    conversation_id: input.conversation_id || source.conversation_id || null,
    provider_id: input.provider_id || null,
    config_patched: Boolean(input.config_patched),
    started_by: input.started_by || "viewer",
    status: "watching",
    restarted_at: new Date().toISOString(),
    stopped_at: null,
    paused_at: null,
    skipped_while_paused: Number(source.skipped_while_paused) || 0,
    last_seen: source.last_seen || null,
  };
  watches?.set(watch.id, watch);
  store?.upsertWatch(watch);
  return watchResponse(watch, { reused: true });
}

async function restorePersistedWatchForSharedProxy(watchId, { watches, store, sharedCaptureProxy } = {}) {
  if (!sharedCaptureProxy) return null;
  const source = findPersistedWatchSource(store, { watch_id: watchId });
  if (!source || !["watching", "paused"].includes(source.live_status)) return null;
  const response = await restorePersistedWatch(
    source,
    {
      target_base_url: resolveTargetBaseUrl(source.agent, source.workspace),
      workspace: source.workspace,
      conversation_id: source.conversation_id,
      started_by: "shared-proxy-auto-restore",
    },
    { watches, store, sharedCaptureProxy },
  );
  return watches.get(response.id) || null;
}

function touchWatchFromCapture(watch, capture) {
  if (!watch || !capture) return;
  if (!watch.conversation_id && capture.conversation_id) watch.conversation_id = capture.conversation_id;
  if (!watch.title) watch.title = inferCaptureTitle(capture);
  watch.last_seen = capture.response?.received_at || capture.received_at || new Date().toISOString();
  if (capture.response?.received_at) watch.last_response_seen = capture.response.received_at;
}

function touchWatchFromSkippedCapture(watch) {
  if (!watch) return;
  watch.skipped_while_paused = (Number(watch.skipped_while_paused) || 0) + 1;
  watch.last_seen = new Date().toISOString();
}

async function updateSource(req, options) {
  const input = await readJsonBody(req);
  const id = String(input.id || "");
  if (!id) throw new Error("Missing source id");
  const wantsArchive = Boolean(input.archive || input.remove);
  const wantsDelete = Boolean(input.delete);
  if (wantsArchive && wantsDelete) throw new Error("Choose archive or delete, not both.");

  const liveWatch = options.watches.get(id);
  if (wantsDelete && liveWatch) {
    await closeWatchProxy(liveWatch);
    options.watches.delete(id);
    deleteSourceMeta(options, sourceMetaKeysForSourceId(id, { liveWatch }));
    options.store?.deleteWatch(liveWatch.watch_id);
    return { id, removed: true, sources: listSources(options) };
  }
  if (wantsArchive && liveWatch) {
    await closeWatchProxy(liveWatch);
    liveWatch.status = "stopped";
    options.store?.updateWatchStatus(liveWatch.watch_id, liveWatch.status);
    options.watches.delete(id);
    const archivedMeta = { hidden: true };
    setSourceMeta(options, sourceMetaKeysForSourceId(id, { liveWatch }), archivedMeta);
    return { id, archived: true, sources: listSources(options) };
  }

  const persistedSource = findPersistedWatchSource(options.store, { watch_id: id });
  if (wantsDelete && persistedSource?.store_watch_id) {
    options.store?.deleteWatch(persistedSource.store_watch_id);
    deleteSourceMeta(options, sourceMetaKeysForSourceId(id, { persistedSource }));
    return { id, deleted: true, sources: listSources(options) };
  }

  const importedSource = importedTraceSources(options).find((item) => item.id === id);
  if (wantsDelete && importedSource?.path) {
    fs.rmSync(importedSource.path, { recursive: true, force: true });
    deleteSourceMeta(options, [id]);
    return { id, deleted: true, sources: listSources(options) };
  }

  const liveSource = liveWatch ? activeWatchSources(new Map([[liveWatch.id, liveWatch]])).find((item) => item.id === id) : null;
  const source = liveSource || persistedSource || importedSource || baseSources(options).find((item) => item.id === id);
  if (!source) throw new Error(`Source not found: ${id}`);
  if (wantsDelete) throw new Error("This source has no persisted capture data to delete.");

  const metaKeys = sourceMetaKeysForSourceId(id, { source, liveWatch, persistedSource });
  const meta = mergedSourceMeta(options.sourceMeta, metaKeys);
  if (wantsArchive) meta.hidden = true;
  if (Object.prototype.hasOwnProperty.call(input, "pinned")) meta.pinned = Boolean(input.pinned);
  if (Object.prototype.hasOwnProperty.call(input, "title")) {
    const title = String(input.title || "").trim().slice(0, 80);
    if (title) meta.title = title;
    else delete meta.title;
    if (liveWatch) liveWatch.title = title || null;
    if (liveWatch?.watch_id) options.store?.updateWatchTitle(liveWatch.watch_id, title);
    else if (persistedSource?.store_watch_id) options.store?.updateWatchTitle(persistedSource.store_watch_id, title);
    if (importedSource?.path) updateImportedTraceTitle(importedSource.path, title);
  }
  setSourceMeta(options, metaKeys, meta);
  return { id, source: decorateSource(source, meta), sources: listSources(options) };
}

function updateImportedTraceTitle(dir, title) {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = readOptionalJson(manifestPath);
  if (!manifest) return;
  const value = String(title || "").trim().slice(0, 80);
  if (value) manifest.title = value;
  else delete manifest.title;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function exportTraceBundle(res, sourceId, options) {
  const data = loadViewerData(sourceId, options);
  const bundle = buildTraceBundle(data);
  const fileBase = safeFileName(`peekmyagent-trace-${bundle.manifest.trace_id}-${bundle.manifest.exported_at.slice(0, 10)}`);
  const payload = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  const gzipped = zlib.gzipSync(payload);
  res.writeHead(200, {
    ...viewerSecurityHeaders(),
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${fileBase}.peektrace.json.gz"`,
    "cache-control": "no-store",
    "x-peekmyagent-trace-id": bundle.manifest.trace_id,
  });
  res.end(gzipped);
}

function buildTraceBundle(data) {
  const rawCaptures = (data.requests || []).map((request) => request.raw).filter(Boolean);
  const exportRedaction = redactTraceExportValue(rawCaptures);
  const captures = exportRedaction.value;
  const traceId = crypto.createHash("sha256").update(JSON.stringify(captures.map((capture) => capture.capture_id || capture.request_index || ""))).digest("hex").slice(0, 12);
  return {
    format: "peekmyagent.trace.v1",
    manifest: {
      trace_id: traceId,
      exported_at: new Date().toISOString(),
      title: data.source?.label || data.source?.id || "peekMyAgent Trace",
      source_id: data.source?.id || null,
      request_count: captures.length,
      response_count: data.stats?.response_count || 0,
      subagent_count: data.stats?.subagent_count || 0,
      raw_body_bytes: data.stats?.raw_body_bytes || 0,
      export_kind: "sanitized_share_bundle",
      redaction: {
        applied: true,
        strategy: "secret-patterns-in-string-values",
        count: exportRedaction.redactions.length,
      },
      privacy_notice: "This portable trace is sanitized for common secret/token patterns, but may still contain private prompts, code, file paths, tool results, or business data. Review before sharing.",
      note: "Portable peekMyAgent trace bundle. Import in the dashboard for readonly viewing.",
    },
    source: {
      id: data.source?.id || null,
      label: data.source?.label || null,
      agent: data.source?.agent || null,
      confidence: data.source?.confidence || null,
      kind: data.source?.kind || null,
      workspace: data.source?.workspace || null,
      conversation_id: data.source?.conversation_id || null,
    },
    captures,
  };
}

function redactTraceExportValue(value, pathParts = []) {
  if (typeof value === "string") {
    const fieldPath = pathParts.length ? pathParts.join(".") : "trace";
    return redactText(value, fieldPath);
  }
  if (Array.isArray(value)) {
    const redactions = [];
    const output = value.map((item, index) => {
      const child = redactTraceExportValue(item, [...pathParts, String(index)]);
      redactions.push(...child.redactions);
      return child.value;
    });
    return { value: output, redactions };
  }
  if (value && typeof value === "object") {
    const redactions = [];
    const output = {};
    for (const [key, childValue] of Object.entries(value)) {
      const child = redactTraceExportValue(childValue, [...pathParts, key]);
      redactions.push(...child.redactions);
      output[key] = child.value;
    }
    return { value: output, redactions };
  }
  return { value, redactions: [] };
}

async function importTraceBundle(req, options) {
  const buffer = await readRawBody(req, { maxBytes: MAX_TRACE_IMPORT_BYTES });
  const bundle = parseTraceBundle(buffer);
  const captures = validateTraceBundle(bundle);
  fs.mkdirSync(options.importsDir, { recursive: true, mode: 0o700 });
  const traceId = safeFileName(bundle.manifest?.trace_id || traceIdForCaptures(captures));
  const dir = uniqueImportDir(options.importsDir, traceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const importedAt = new Date().toISOString();
  const manifest = {
    ...(bundle.manifest || {}),
    trace_id: traceId,
    imported_at: importedAt,
    title: bundle.manifest?.title || bundle.source?.label || `Imported trace ${traceId}`,
    source: bundle.source || {},
    format: bundle.format || "peekmyagent.trace.v1",
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "proxy-captures.json"), `${JSON.stringify(captures, null, 2)}\n`, { mode: 0o600 });
  const source = importedTraceSourceFromDir(dir, path.basename(dir));
  return {
    ok: true,
    imported: true,
    source,
    source_id: source?.id || null,
    request_count: captures.length,
    sources: listSources(options),
  };
}

function parseTraceBundle(buffer) {
  if (!buffer?.length) throw new Error("Trace bundle is empty.");
  if (buffer.length > MAX_TRACE_IMPORT_BYTES) throw httpError(413, `Trace bundle is too large. Limit is ${formatBytes(MAX_TRACE_IMPORT_BYTES)}.`);
  let payload;
  try {
    payload = isGzipBuffer(buffer) ? zlib.gunzipSync(buffer, { maxOutputLength: MAX_TRACE_IMPORT_UNZIPPED_BYTES }) : buffer;
  } catch (error) {
    if (/maxOutputLength|too large|buffer/i.test(error?.message || "")) {
      throw httpError(413, `Trace bundle expands beyond ${formatBytes(MAX_TRACE_IMPORT_UNZIPPED_BYTES)}.`);
    }
    throw error;
  }
  if (payload.length > MAX_TRACE_IMPORT_UNZIPPED_BYTES) throw httpError(413, `Trace bundle expands beyond ${formatBytes(MAX_TRACE_IMPORT_UNZIPPED_BYTES)}.`);
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Trace bundle must be a peekMyAgent .peektrace.json.gz or JSON file.");
  }
}

function validateTraceBundle(bundle) {
  if (!bundle || typeof bundle !== "object") throw new Error("Invalid trace bundle.");
  if (bundle.format && bundle.format !== "peekmyagent.trace.v1") throw new Error(`Unsupported trace bundle format: ${bundle.format}`);
  const captures = Array.isArray(bundle.captures) ? bundle.captures : Array.isArray(bundle["proxy-captures"]) ? bundle["proxy-captures"] : null;
  if (!captures?.length) throw new Error("Trace bundle does not contain captures.");
  if (captures.length > MAX_TRACE_IMPORT_CAPTURES) throw httpError(413, `Trace bundle contains too many captures. Limit is ${MAX_TRACE_IMPORT_CAPTURES}.`);
  for (const [index, capture] of captures.entries()) {
    if (!capture || typeof capture !== "object") throw new Error(`Invalid capture at index ${index}.`);
    capture.capture_id ||= crypto.randomUUID();
    capture.watch_id ||= bundle.source?.id || bundle.manifest?.trace_id || "imported-trace";
    capture.request_index ||= index + 1;
  }
  return captures;
}

function traceIdForCaptures(captures) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(captures.map((capture) => [capture.capture_id, capture.request_index, capture.received_at])))
    .digest("hex")
    .slice(0, 12);
}

function uniqueImportDir(root, traceId) {
  let candidate = path.join(root, traceId);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${traceId}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function isGzipBuffer(buffer) {
  return buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function safeFileName(value) {
  return String(value || "trace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "trace";
}

async function stopWatch(req, { watches, sourceMeta, sourceMetaPath, store }) {
  const input = await readJsonBody(req);
  const watch = findWatch(watches, input);
  if (!watch) throw new Error("Watch not found");
  await closeWatchProxy(watch);
  watch.status = "stopped";
  watch.stopped_at = new Date().toISOString();
  if (input.clear) {
    watches.delete(watch.id);
    deleteSourceMeta({ sourceMeta, sourceMetaPath }, sourceMetaKeysForSourceId(watch.id, { liveWatch: watch }));
    store?.deleteWatch(watch.watch_id);
    return watchStopResponse(watch, { status: "cleared", cleared: true });
  }
  store?.updateWatchStatus(watch.watch_id, watch.status);
  return watchStopResponse(watch, { status: watch.status, cleared: false });
}

async function pauseWatch(req, { watches, store }) {
  const input = await readJsonBody(req);
  const watch = findWatch(watches, input);
  if (!watch) throw new Error("Watch not found");
  const status = normalizeWatchControlStatus(input);
  if (status === "paused") {
    if (watch.status === "stopped") throw new Error("Stopped watches cannot be paused. Start or reuse the watch first.");
    watch.status = "paused";
    watch.paused_at = new Date().toISOString();
    watch.resumed_at = null;
  } else {
    if (watch.status === "stopped") throw new Error("Stopped watches cannot be resumed. Start or reuse the watch first.");
    watch.status = "watching";
    watch.resumed_at = new Date().toISOString();
    watch.paused_at = null;
  }
  store?.updateWatchStatus(watch.watch_id, watch.status);
  return watchControlResponse(watch, { action: status === "paused" ? "pause" : "resume" });
}

async function sendAgentMessage(req, { watches, store, sharedCaptureProxy }) {
  const input = await readJsonBody(req);
  const sourceId = String(input.source_id || input.id || "").trim();
  const message = String(input.message || "").trim();
  if (!sourceId) throw new Error("Missing source_id");
  if (!message) throw new Error("Message is empty");
  if (message.length > 12000) throw new Error("Message is too long; please keep it under 12000 characters.");
  const watch = await resolveAgentSendWatch(sourceId, { watches, store, sharedCaptureProxy });
  if (!watch) throw new Error("Live Agent session not found. Start the Agent through peekMyAgent first.");
  if (watch.status === "stopped") throw new Error("This Agent watch has stopped. Restart or create a new captured session before sending.");
  const command = buildAgentSendCommand(watch, message);
  const startedAt = new Date().toISOString();
  const result = await execAgentCommand(command);
  return {
    ok: true,
    source_id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    status: watch.status,
    sent_at: startedAt,
    completed_at: new Date().toISOString(),
    command: {
      name: command.command,
      args: redactCommandArgs(command.args),
      cwd: command.cwd,
    },
    delivery: command.delivery || null,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function resolveAgentSendWatch(sourceId, { watches, store, sharedCaptureProxy }) {
  const active = findWatch(watches, { id: sourceId, watch_id: sourceId });
  if (active) return active;
  const source = findPersistedWatchSource(store, { watch_id: sourceId });
  if (!source || !["watching", "paused"].includes(source.live_status)) return null;
  const restored = await restorePersistedWatch(
    source,
    {
      workspace: source.workspace,
      conversation_id: source.conversation_id,
      started_by: "dashboard-composer",
    },
    { watches, store, sharedCaptureProxy },
  );
  return watches.get(restored.id) || null;
}

function buildAgentSendCommand(watch, message) {
  const cwd = agentCommandCwd(watch.workspace);
  if (/claude/i.test(watch.agent)) {
    const args = ["-p", "--output-format", "text"];
    if (watch.conversation_id) args.push("--resume", watch.conversation_id);
    const proxySettings = claudeCodeProxySettingsArgs({ baseUrl: watch.base_url });
    args.push(...proxySettings.args, message);
    return {
      command: "claude",
      args,
      cwd,
      env: mergeClaudeCodeProcessEnv({
        cwd: watch.workspace,
        env: process.env,
        overrides: { ANTHROPIC_BASE_URL: watch.base_url },
      }),
      cleanup: proxySettings.cleanup,
      delivery: {
        mode: "detached_resume",
        terminal_echo: false,
        inherits_active_terminal_context: false,
      },
    };
  }
  if (/openclaw/i.test(watch.agent)) {
    const args = ["agent", "--local"];
    if (watch.conversation_id) args.push("--session-key", watch.conversation_id);
    args.push("--message", message);
    return {
      command: "openclaw",
      args,
      cwd,
      env: {
        ...process.env,
        OPENAI_BASE_URL: watch.base_url,
        OPENCLAW_BASE_URL: watch.base_url,
        DEEPSEEK_BASE_URL: watch.base_url,
      },
      delivery: {
        mode: "detached_message",
        terminal_echo: false,
        inherits_active_terminal_context: false,
      },
    };
  }
  throw new Error(`Sending messages is not implemented for ${watch.agent}.`);
}

function agentCommandCwd(workspace) {
  if (isAccessibleDirectory(workspace)) return workspace;
  const home = userHome();
  if (isAccessibleDirectory(home)) return home;
  return safeProcessCwd();
}

function execAgentCommand({ command, args, cwd, env, cleanup }) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(command, args, { env });
    execFile(spawnConfig.command, spawnConfig.args, {
      cwd,
      env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      ...spawnConfig.options,
    }, (error, stdout, stderr) => {
      cleanup?.();
      if (error && error.code == null && !error.killed) return reject(error);
      resolve({
        exit_code: Number.isInteger(error?.code) ? error.code : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

function redactCommandArgs(args) {
  return (args || []).map((arg) => {
    const text = String(arg || "");
    return text.length > 160 ? `${text.slice(0, 120)}...${text.slice(-20)}` : text;
  });
}

function normalizeWatchControlStatus(input) {
  const rawStatus = String(input.status || input.action || "").toLowerCase();
  if (rawStatus === "resume" || rawStatus === "resumed" || rawStatus === "watching") return "watching";
  if (rawStatus === "pause" || rawStatus === "paused" || rawStatus === "recording_paused") return "paused";
  if (Object.prototype.hasOwnProperty.call(input, "paused")) return input.paused ? "paused" : "watching";
  return "paused";
}

function watchResponse(watch, { reused }) {
  return {
    id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    mode: watch.mode,
    mode_label: modeLabel(watch.mode),
    base_url: watch.base_url,
    workspace: watch.workspace,
    conversation_id: watch.conversation_id,
    provider_id: watch.provider_id,
    target_base_url: watch.target_base_url,
    config_patched: watch.config_patched,
    status: watch.status,
    paused_at: watch.paused_at || null,
    resumed_at: watch.resumed_at || null,
    skipped_while_paused: Number(watch.skipped_while_paused) || 0,
    reused,
    instructions: watchInstructions(watch),
  };
}

function watchControlResponse(watch, { action }) {
  return {
    ...watchResponse(watch, { reused: true }),
    action,
    request_count: capturesForWatch(watch).length,
  };
}

function watchStopResponse(watch, { status, cleared }) {
  return {
    id: watch.id,
    watch_id: watch.watch_id,
    agent: watch.agent,
    status,
    cleared,
    provider_id: watch.provider_id,
    target_base_url: watch.target_base_url,
    config_patched: watch.config_patched,
    request_count: capturesForWatch(watch).length,
    skipped_while_paused: Number(watch.skipped_while_paused) || 0,
  };
}

async function closeWatchProxy(watch) {
  if (watch.proxy_shared) {
    watch.proxy_closed = true;
    return;
  }
  if (watch.proxy_closed) return;
  await watch.proxy?.close?.();
  watch.proxy_closed = true;
}

function findReusableWatch(watches, { agent, mode, workspace, conversationId }) {
  if (!conversationId) return null;
  return [...watches.values()].find(
    (watch) =>
      watch.agent === agent &&
      watch.mode === mode &&
      watch.workspace === workspace &&
      watch.conversation_id === conversationId,
  );
}

function findPersistedWatchSource(store, { watch_id: watchId }) {
  if (!store || !watchId) return null;
  const normalized = String(watchId).startsWith("live-") ? String(watchId).slice("live-".length) : String(watchId);
  return (
    store
      .listSources()
      .find((source) => source.store_watch_id === normalized || source.store_watch_id === watchId || source.id === watchId || source.id === `stored-${normalized}`) || null
  );
}

function findReusablePersistedWatch(store, { agent, mode, workspace, conversationId }) {
  if (!store) return null;
  const sources = store
    .listSources()
    .filter((source) => source.agent === agent)
    .filter((source) => (mode ? source.mode === mode || !source.mode : true))
    .filter((source) => source.workspace === workspace)
    .filter((source) => (conversationId ? source.conversation_id === conversationId : true))
    .sort((a, b) => Date.parse(b.last_seen || b.created_at || 0) - Date.parse(a.last_seen || a.created_at || 0));
  return sources[0] || null;
}

function findWatch(watches, input) {
  if (input.id && watches.has(input.id)) return watches.get(input.id);
  if (input.watch_id) {
    const byWatchId = [...watches.values()].find((watch) => watch.watch_id === input.watch_id);
    if (byWatchId) return byWatchId;
  }
  if (input.conversation_id) {
    return [...watches.values()].find(
      (watch) =>
        watch.conversation_id === input.conversation_id &&
        (!input.workspace || watch.workspace === input.workspace) &&
        (!input.agent || watch.agent === input.agent),
    );
  }
  return null;
}

function loadLiveWatchData(source, { watches }) {
  const watch = watches.get(source.id);
  if (!watch) throw new Error(`Live watch not found: ${source.id}`);
  const requests = capturesForWatch(watch).map((capture, index) => summarizeCapture(capture, source, index, null));
  annotateRequestChanges(requests);
  annotateSubagentLineage(requests);
  const turns = buildTurnTimeline(requests);
  const agentTrace = buildAgentTrace(requests);
  attachAgentTraceToTurns(turns, agentTrace);
  return {
    generated_at: new Date().toISOString(),
    source: { ...source, command: liveWatchCommand(watch), workbench: buildWorkbenchSummary(source, requests, liveWatchCommand(watch)) },
    stats: buildStats(requests, agentTrace),
    requests,
    turns,
    agent_trace: agentTrace,
  };
}

function daemonPing({ sharedCaptureProxy }) {
  return {
    ok: true,
    api: "viewer",
    pid: process.pid,
    capture_url: sharedCaptureProxy?.baseUrl || null,
    shared_capture_proxy: Boolean(sharedCaptureProxy),
  };
}

function daemonStatus({ watches, sharedCaptureProxy }) {
  return {
    ok: true,
    api: "viewer",
    pid: process.pid,
    capture_url: sharedCaptureProxy?.baseUrl || null,
    shared_capture_proxy: Boolean(sharedCaptureProxy),
    watches: listActiveWatches(watches),
  };
}

function resolveDynamicAgentRouteWatch({ route, body, watches, store, sharedCaptureProxy }) {
  if (!sharedCaptureProxy) throw new Error("Shared capture proxy is not running.");
  const resolved = resolveTraeCnDynamicRoute({ route, body });
  const existing = [...watches.values()].find((watch) => watch.watch_id === resolved.watch_id);
  if (existing) {
    existing.target_base_url = resolved.target_base_url || existing.target_base_url;
    existing.workspace = resolved.workspace || existing.workspace;
    existing.conversation_id = resolved.conversation_id || existing.conversation_id;
    existing.provider_id = resolved.provider_id || existing.provider_id;
    existing.native_workspace_id = resolved.native_workspace_id || existing.native_workspace_id;
    existing.native_agent_type = resolved.native_agent_type || existing.native_agent_type;
    if (existing.status === "stopped") existing.status = "watching";
    store?.upsertWatch(existing);
    return existing;
  }
  const baseUrl = `${sharedCaptureProxy.baseUrl}/agent/${encodeURIComponent(route.agentSlug)}/${encodeURIComponent(route.installId)}/${encodeURIComponent(route.protocol)}`;
  const watch = {
    ...resolved,
    base_url: baseUrl,
    proxy: sharedCaptureProxy,
    proxy_shared: true,
    created_at: new Date().toISOString(),
    status: "watching",
    skipped_while_paused: 0,
  };
  watches.set(watch.id, watch);
  store?.upsertWatch(watch);
  return watch;
}

function capturesForWatch(watch) {
  return (watch.proxy?.captures || []).filter((capture) => capture.watch_id === watch.watch_id);
}

function loadPersistedData(source, { store }) {
  const watchId = source.store_watch_id || watchIdFromSourceId(source.id);
  if (!watchId) throw new Error(`Invalid persisted source id: ${source.id}`);
  const captures = store.loadCaptures(watchId);
  const requests = captures.map((capture, index) => summarizeCapture(capture, source, index, null));
  annotateRequestChanges(requests);
  annotateSubagentLineage(requests);
  const turns = buildTurnTimeline(requests);
  const agentTrace = buildAgentTrace(requests);
  attachAgentTraceToTurns(turns, agentTrace);
  return {
    generated_at: new Date().toISOString(),
    source: { ...source, command: null, workbench: buildWorkbenchSummary(source, requests, null) },
    stats: buildStats(requests, agentTrace),
    requests,
    turns,
    agent_trace: agentTrace,
  };
}

function summarizeCapture(capture, source, index, debugSource) {
  const body = capture.body || {};
  const responseSummary = summarizeModelResponse(capture.response);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = extractSystemParts(body, messages);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const lastUser = lastMessage(messages, "user");
  const currentUser = lastRealUserMessage(messages);
  const currentUserRealText = realUserVisibleText(currentUser);
  const commandMessage = currentUserRealText ? null : parseCommandMessage(currentUser);
  const entry = isContextTokenCountingRequest(capture)
    ? { kind: "context_count", label: "上下文统计 (/context)", text: "Claude Code 为 /context 统计上下文 token 用量发出的内部请求" }
    : classifyCurrentEntry(messages);
  const currentUserText = entry.kind === "compact" || entry.kind === "context_count" ? "" : currentUserRealText || (commandMessage ? commandUserVisibleText(commandMessage) : "");
  const internalRequestText = isSuggestionModeMessage(lastUser) ? extractContentText(lastUser.content) : "";
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolMessages = messages.filter((message) => message.role === "tool");
  const toolCalls = extractToolCalls(messages);
  const toolResults = extractToolResults(messages);
  const sourceHint = inferRequestSource(capture, body, currentUser, debugSource, lastUser);
  const protocolProfile = inferProtocolProfile(capture, body);
  const historyCount = Math.max(0, messages.length - (currentUser ? 1 : 0) - systemParts.length);
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  const claudeSessionId = headerValue(capture.headers, "x-claude-code-session-id");

  return {
    id: capture.capture_id || `request-${index + 1}`,
    request_index: capture.request_index || index + 1,
    captured_at: capture.received_at || capture.captured_at || null,
    method: capture.method || "POST",
    path: capture.path || null,
    model: body.model || null,
    protocol: protocolProfile.protocol,
    provider: protocolProfile.provider,
    upstream_status: capture.upstream_status || null,
    watch_id: capture.watch_id || null,
    conversation_id: capture.conversation_id || null,
    agent_profile: capture.agent_profile || source.agent,
    confidence: source.confidence,
    source_kind: source.kind,
    source_hint: sourceHint,
    debug_source: debugSource?.source || null,
    is_subagent: sourceHint.type === "subagent",
    trace: {
      actor_type: sourceHint.type === "subagent" ? "child" : sourceHint.type === "metadata" ? "side" : "main",
      claude_agent_id: claudeAgentId || null,
      claude_session_id_prefix: claudeSessionId ? claudeSessionId.slice(0, 12) : null,
      debug_source: debugSource?.source || null,
    },
    redaction_count: Array.isArray(capture.header_redactions) ? capture.header_redactions.length : 0,
    fingerprints: {
      system: hashJson(systemParts.map((part) => part.text)),
      tools: hashJson(tools.map((tool) => tool.function?.name || tool.name || tool.type || "unknown")),
      params: hashJson(Object.fromEntries(Object.entries(body).filter(([key]) => !["messages", "system", "tools"].includes(key)))),
    },
    counts: {
      messages: messages.length,
      system: systemParts.length,
      tools: tools.length,
      tool_calls: toolCalls.length,
      tool_results: toolResults.length,
      assistant_messages: assistantMessages.length,
      tool_messages: toolMessages.length,
      history: historyCount,
      raw_body_bytes: capture.raw_body_length || byteLength(body),
      response_body_bytes: capture.response?.raw_body_length || 0,
    },
    summary: {
      current_user: textPreview(currentUserText, 1200),
      entry,
      command_message: commandMessage,
      internal_request_preview: textPreview(internalRequestText, 1200),
      system_preview: textPreview(systemParts.map((part) => part.text).join("\n\n"), 1000),
      assistant_preview: textPreview(assistantMessages.map((message) => extractContentText(message.content)).filter(Boolean).join("\n\n"), 1000),
      tool_calls: toolCalls,
      current_tool_calls: toolCalls,
      tool_results: toolResults.map((result) => ({ ...result, content: textPreview(result.content, 800) })),
      current_tool_results: toolResults.map((result) => ({ ...result, content: textPreview(result.content, 800) })),
      tool_names: tools.map((tool) => tool.function?.name || tool.name || tool.type).filter(Boolean),
      roles: messages.map((message) => message.role || "unknown"),
      history_stack: summarizeHistoryStack(messages, currentUser),
      response: responseSummary,
      protocol: protocolProfile,
      composition: analyzeRequestComposition(body, messages, systemParts, tools, currentUser, responseSummary, capture.raw_body_length),
    },
    raw: compactCaptureForViewer(capture, responseSummary),
  };
}

function compactCaptureForViewer(capture, responseSummary) {
  if (!capture || typeof capture !== "object") return capture;
  const response = compactResponseForViewer(capture.response, responseSummary);
  return response === capture.response ? capture : { ...capture, response };
}

function compactResponseForViewer(response, responseSummary) {
  if (!response || typeof response !== "object") return response || null;
  if (typeof response.body_text !== "string") return response;
  const bodyText = response.body_text;
  const byteSize = Buffer.byteLength(bodyText, "utf8");
  const contentType = headerValue(response.headers, "content-type");
  const stream = Boolean(responseSummary?.stream) || /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(bodyText);
  const hasBodyJson = response.body_json !== undefined && response.body_json !== null;
  const tooLarge = byteSize > VIEWER_RESPONSE_BODY_TEXT_INLINE_BYTES;
  if (!stream && !hasBodyJson && !tooLarge) return response;
  const { body_text, ...rest } = response;
  return {
    ...rest,
    body_text_omitted: {
      reason: stream ? "stream" : hasBodyJson ? "duplicated_body_json" : "large",
      byte_size: byteSize,
      raw_body_length: response.raw_body_length || byteSize,
      captured_body_length: response.captured_body_length || byteSize,
      body_json_available: hasBodyJson,
      stream,
    },
  };
}

function summarizeModelResponse(response) {
  if (!response) {
    return {
      captured: false,
      message_id: null,
      preview: "",
      text: "",
      thinking: "",
      thinking_preview: "",
      usage: null,
      finish_reason: null,
      latency_ms: null,
      status: null,
      stream: false,
      event_count: 0,
      truncated: false,
    };
  }
  const contentType = headerValue(response.headers, "content-type");
  const stream = /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(response.body_text || "");
  const parsed = stream ? summarizeSseResponse(response.body_text || "") : summarizeJsonResponse(response.body_json);
  const completeResponse = assembleCompleteResponse(parsed, { stream, truncated: Boolean(response.truncated) });
  return {
    captured: true,
    message_id: parsed.message_id || null,
    preview: textPreview(parsed.text, 1200),
    text: textPreview(parsed.text, 8000),
    thinking: textPreview(parsed.thinking, 8000),
    thinking_preview: textPreview(parsed.thinking, 240),
    tool_calls: parsed.tool_calls || [],
    usage: parsed.usage,
    finish_reason: parsed.finish_reason || null,
    complete_response: completeResponse,
    latency_ms: response.duration_ms ?? null,
    status: response.status ?? null,
    stream,
    event_count: parsed.event_count || 0,
    truncated: Boolean(response.truncated),
    raw_body_bytes: response.raw_body_length || 0,
    captured_body_bytes: response.captured_body_length || 0,
    received_at: response.received_at || null,
  };
}

function summarizeJsonResponse(body) {
  if (!body || typeof body !== "object") return { message_id: null, role: null, model: null, text: "", thinking: "", tool_calls: [], usage: null, finish_reason: null, event_count: 0 };
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];
  const finishReasons = [];
  if (Array.isArray(body.content)) textParts.push(extractContentText(body.content));
  if (Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (Array.isArray(body.content)) toolCalls.push(...extractToolCallsFromContent(body.content));
  if (body.content && typeof body.content === "object" && !Array.isArray(body.content)) thinkingParts.push(extractThinkingText(body.content));
  if (typeof body.content === "string") textParts.push(body.content);
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (choice?.message?.content) textParts.push(extractContentText(choice.message.content));
      if (choice?.message?.content) thinkingParts.push(extractThinkingText(choice.message.content));
      if (choice?.message?.reasoning_content) thinkingParts.push(choice.message.reasoning_content);
      if (choice?.message?.content) toolCalls.push(...extractToolCallsFromContent(choice.message.content));
      if (Array.isArray(choice?.message?.tool_calls)) toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
      if (choice?.delta?.content) textParts.push(extractContentText(choice.delta.content));
      if (choice?.delta?.reasoning_content) thinkingParts.push(choice.delta.reasoning_content);
      if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...extractToolCalls([{ tool_calls: choice.delta.tool_calls }]));
      if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
    }
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (Array.isArray(item?.content)) textParts.push(extractContentText(item.content));
      if (Array.isArray(item?.content)) thinkingParts.push(extractThinkingText(item.content));
      if (Array.isArray(item?.content)) toolCalls.push(...extractToolCallsFromContent(item.content));
      if (item?.content && typeof item.content === "object" && !Array.isArray(item.content)) thinkingParts.push(extractThinkingText(item.content));
      if (item?.content) textParts.push(extractContentText(item.content));
    }
  }
  if (body.stop_reason) finishReasons.push(body.stop_reason);
  if (body.finish_reason) finishReasons.push(body.finish_reason);
  return {
    message_id: body.id || null,
    role: body.role || null,
    model: body.model || null,
    text: textParts.filter(Boolean).join("\n"),
    thinking: thinkingParts.filter(Boolean).join("\n"),
    tool_calls: dedupeToolCalls(toolCalls),
    usage: body.usage || null,
    finish_reason: uniqueValues(finishReasons).join(", ") || null,
    event_count: 0,
  };
}

function summarizeSseResponse(text) {
  const events = parseSseEvents(text);
  const textParts = [];
  const thinkingParts = [];
  const fallbackTextParts = [];
  const fallbackThinkingParts = [];
  const toolCalls = [];
  const toolCallBlocks = new Map();
  const openAiToolCallBlocks = new Map();
  const finishReasons = [];
  let usage = null;
  let messageId = null;
  let role = null;
  let model = null;
  for (const event of events) {
    if (!event.data || event.data === "[DONE]") continue;
    const data = parseJson(event.data);
    if (!data || typeof data !== "object") continue;
    if (data.model) model = data.model;
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice?.delta?.role) role = choice.delta.role;
        if (choice?.delta?.content) textParts.push(extractContentText(choice.delta.content));
        if (choice?.delta?.reasoning_content) thinkingParts.push(choice.delta.reasoning_content);
        if (choice?.message?.content) fallbackTextParts.push(extractContentText(choice.message.content));
        if (choice?.message?.content) fallbackThinkingParts.push(extractThinkingText(choice.message.content));
        if (choice?.message?.reasoning_content) fallbackThinkingParts.push(choice.message.reasoning_content);
        if (choice?.message?.role) role = choice.message.role;
        if (choice?.message?.content) toolCalls.push(...extractToolCallsFromContent(choice.message.content));
        if (Array.isArray(choice?.message?.tool_calls)) toolCalls.push(...extractToolCalls([{ tool_calls: choice.message.tool_calls }]));
        if (Array.isArray(choice?.delta?.tool_calls)) mergeOpenAiStreamToolCalls(openAiToolCallBlocks, choice.delta.tool_calls);
        if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
      }
    }
    if (data.delta?.type === "text_delta" && data.delta.text) textParts.push(data.delta.text);
    if (data.delta?.type === "thinking_delta" && data.delta.thinking) thinkingParts.push(data.delta.thinking);
    else if (!data.delta?.type && data.delta?.text) textParts.push(data.delta.text);
    if (data.content_block?.type === "text" && data.content_block.text) fallbackTextParts.push(data.content_block.text);
    if (data.content_block?.type === "thinking" && data.content_block.thinking) fallbackThinkingParts.push(data.content_block.thinking);
    if (data.content_block?.type === "tool_use") {
      const call = toolCallFromPart(data.content_block);
      if (call) {
        toolCalls.push(call);
        toolCallBlocks.set(data.index, { call, partialJson: "" });
      }
    }
    if (data.delta?.type === "input_json_delta" && data.index != null) {
      const block = toolCallBlocks.get(data.index);
      if (block) block.partialJson += data.delta.partial_json || "";
    }
    if (data.message?.content) fallbackTextParts.push(extractContentText(data.message.content));
    if (data.message?.content) fallbackThinkingParts.push(extractThinkingText(data.message.content));
    if (data.message?.content) toolCalls.push(...extractToolCallsFromContent(data.message.content));
    if (data.type === "message_start" && data.message?.id) {
      messageId = data.message.id;
      if (data.message.role) role = data.message.role;
      if (data.message.model) model = data.message.model;
    }
    if (data.id && data.type === "message") messageId = data.id;
    if (data.delta?.stop_reason) finishReasons.push(data.delta.stop_reason);
    if (data.stop_reason) finishReasons.push(data.stop_reason);
    if (data.finish_reason) finishReasons.push(data.finish_reason);
    if (data.usage) usage = data.usage;
    if (data.message?.usage) usage = data.message.usage;
  }
  const visibleText = textParts.filter(Boolean).join("") || fallbackTextParts.filter(Boolean).join("\n");
  const thinkingText = thinkingParts.filter(Boolean).join("") || fallbackThinkingParts.filter(Boolean).join("\n");
  return {
    message_id: messageId,
    role,
    model,
    text: visibleText,
    thinking: thinkingText,
    tool_calls: dedupeToolCalls([...mergeStreamToolCallInputs(toolCalls, toolCallBlocks), ...finalizeOpenAiStreamToolCalls(openAiToolCallBlocks)]),
    usage,
    finish_reason: uniqueValues(finishReasons).join(", ") || null,
    event_count: events.length,
  };
}

function assembleCompleteResponse(parsed, { stream = false, truncated = false } = {}) {
  const content = [];
  if (parsed?.thinking) content.push({ type: "thinking", thinking: parsed.thinking });
  if (parsed?.text) content.push({ type: "text", text: parsed.text });
  for (const call of parsed?.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || null,
      name: call.name || "unknown",
      input: call.arguments ?? null,
    });
  }
  return {
    id: parsed?.message_id || null,
    role: parsed?.role || "assistant",
    model: parsed?.model || null,
    content,
    text: parsed?.text || "",
    thinking: parsed?.thinking || "",
    tool_use: parsed?.tool_calls || [],
    stop_reason: parsed?.finish_reason || null,
    finish_reason: parsed?.finish_reason || null,
    usage: parsed?.usage || null,
    stream: Boolean(stream),
    event_count: parsed?.event_count || 0,
    truncated: Boolean(truncated),
  };
}

function mergeOpenAiStreamToolCalls(blocks, chunks) {
  for (const chunk of chunks || []) {
    const key = chunk.index ?? chunk.id ?? blocks.size;
    const current = blocks.get(key) || { id: null, name: null, argumentsText: "", type: null };
    if (chunk.id) current.id = chunk.id;
    if (chunk.type) current.type = chunk.type;
    if (chunk.function?.name) current.name = chunk.function.name;
    if (chunk.name) current.name = chunk.name;
    if (chunk.function?.arguments) current.argumentsText += chunk.function.arguments;
    else if (chunk.arguments) current.argumentsText += chunk.arguments;
    blocks.set(key, current);
  }
}

function finalizeOpenAiStreamToolCalls(blocks) {
  return [...blocks.values()]
    .filter((block) => block.id || block.name || block.argumentsText)
    .map((block) => ({
      name: block.name || "unknown",
      id: block.id || null,
      arguments: parseMaybeJson(block.argumentsText),
    }));
}

function mergeStreamToolCallInputs(toolCalls, blocks) {
  if (!blocks.size) return toolCalls;
  return toolCalls.map((call) => {
    const block = [...blocks.values()].find((item) => item.call === call || (item.call.id && item.call.id === call.id));
    if (!block?.partialJson) return call;
    return { ...call, arguments: parseMaybeJson(block.partialJson) };
  });
}

function parseSseEvents(text) {
  const events = [];
  let current = { event: null, data: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
      current = { event: null, data: [] };
      continue;
    }
    if (line.startsWith("event:")) current.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) current.data.push(line.slice("data:".length).trim());
  }
  if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
  return events;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function annotateRequestChanges(requests) {
  const previousByContextKey = new Map();
  for (const request of requests) {
    const contextKey = requestContextChainKey(request);
    const previous = previousByContextKey.get(contextKey) || null;
    const currentToolMessages = isInternalRequest(request) ? [] : currentToolEventMessages(request, previous);
    request.summary.current_tool_calls = currentToolMessages ? extractToolCalls(currentToolMessages) : request.summary.tool_calls;
    request.summary.current_tool_results = currentToolMessages
      ? extractToolResults(currentToolMessages).map((result) => ({ ...result, content: textPreview(result.content, 800) }))
      : request.summary.tool_results;
    request.trace.context_chain_key = contextKey;
    request.trace.previous_context_request_index = previous?.request_index || null;
    annotateHistoryStackDelta(request, previous);
    request.changes = {
      system_changed: previous ? request.fingerprints.system !== previous.fingerprints.system : false,
      tools_changed: previous ? request.fingerprints.tools !== previous.fingerprints.tools : false,
      params_changed: previous ? request.fingerprints.params !== previous.fingerprints.params : false,
      messages_delta: previous ? request.counts.messages - previous.counts.messages : request.counts.messages,
      tools_delta: previous ? request.counts.tools - previous.counts.tools : request.counts.tools,
      raw_bytes_delta: previous ? request.counts.raw_body_bytes - previous.counts.raw_body_bytes : request.counts.raw_body_bytes,
    };
    request.context_delta = analyzeContextDelta(request, previous, contextKey);
    previousByContextKey.set(contextKey, request);
  }
}

function requestContextChainKey(request) {
  const sessionKey = request.conversation_id || request.watch_id || request.trace?.claude_session_id_prefix || request.agent_profile || "session";
  const agentId = request.trace?.claude_agent_id || "";
  if (agentId) return `agent:${sessionKey}:${agentId}`;
  const actorType = request.trace?.actor_type || request.source_hint?.type || "main";
  if (actorType === "main") return `main:${sessionKey}`;
  const sideKey = request.trace?.debug_source || request.source_hint?.type || "side";
  return `${actorType}:${sessionKey}:${sideKey}`;
}

function annotateHistoryStackDelta(request, previous) {
  const stack = request.summary?.history_stack || [];
  const messages = Array.isArray(request.raw?.body?.messages) ? request.raw.body.messages : [];
  const previousMessages = Array.isArray(previous?.raw?.body?.messages) ? previous.raw.body.messages : [];
  const reusedCount = previous ? commonMessagePrefixLength(previousMessages, messages) : 0;
  for (const item of stack) {
    const index = Math.max(0, Number(item.index || 0) - 1);
    item.context_status = previous ? (index < reusedCount ? "reused" : "new") : "baseline";
  }
}

function buildTurnTimeline(requests) {
  const turns = [];
  let currentTurn = null;
  let currentUserKey = "";
  let pendingInternalRequests = [];
  for (const request of requests) {
    const userText = request.summary?.current_user || "";
    const commandMessage = request.summary?.command_message || null;
    const userKey = normalizeTurnUserKey(userText);
    if (isTimelineInternalRequest(request) && currentTurn && currentUserKey && userKey && userKey !== currentUserKey) {
      pendingInternalRequests.push(request);
      continue;
    }
    const shouldStartTurn =
      !currentTurn ||
      (!isTimelineInternalRequest(request) && userKey && userKey !== currentUserKey) ||
      (!currentUserKey && userKey && currentTurn.request_count > 0 && !isTimelineInternalRequest(request));
    if (shouldStartTurn) {
      currentTurn = createTurn(turns.length + 1, userText, commandMessage);
      turns.push(currentTurn);
      currentUserKey = userKey;
    } else if (currentTurn && !currentUserKey && userKey) {
      currentTurn.title = turnTitle(userText, commandMessage);
      currentTurn.user_input = textPreview(cleanTitleText(userText), 1200);
      if (commandMessage && !currentTurn.command_message) currentTurn.command_message = commandMessage;
      currentUserKey = userKey;
    }
    if (!currentTurn) {
      currentTurn = createTurn(turns.length + 1, userText, commandMessage);
      turns.push(currentTurn);
      currentUserKey = userKey;
    }
    if (pendingInternalRequests.length) {
      for (const pending of pendingInternalRequests) addRequestToTurn(currentTurn, pending);
      pendingInternalRequests = [];
    }
    addRequestToTurn(currentTurn, request);
  }
  if (pendingInternalRequests.length && currentTurn) {
    for (const pending of pendingInternalRequests) addRequestToTurn(currentTurn, pending);
  }
  return turns.map(finalizeTurn);
}

function createTurn(index, userText, commandMessage = null) {
  const cleaned = cleanTitleText(userText);
  return {
    id: `turn-${index}`,
    index,
    title: turnTitle(userText, commandMessage),
    user_input: textPreview(cleaned, 1200),
    command_message: commandMessage,
    request_ids: [],
    request_indexes: [],
    first_request_index: null,
    last_request_index: null,
    started_at: null,
    ended_at: null,
    request_count: 0,
    main_request_count: 0,
    internal_request_count: 0,
    subagent_count: 0,
    parent_spawn_count: 0,
    tool_call_count: 0,
    tool_result_count: 0,
    raw_body_bytes: 0,
    context_delta: {
      new_messages: 0,
      new_tool_calls: 0,
      new_tool_results: 0,
      new_roles: {},
    },
  };
}

function addRequestToTurn(turn, request) {
  request.turn_id = turn.id;
  turn.request_ids.push(request.id);
  turn.request_indexes.push(request.request_index);
  turn.first_request_index ??= request.request_index;
  turn.last_request_index = request.request_index;
  turn.started_at ??= request.captured_at || null;
  turn.ended_at = request.captured_at || turn.ended_at;
  turn.request_count += 1;
  turn.raw_body_bytes += request.counts?.raw_body_bytes || 0;
  if (isTimelineInternalRequest(request)) turn.internal_request_count += 1;
  else turn.main_request_count += 1;
  if (request.is_subagent) turn.subagent_count += 1;
  if (request.source_hint?.type === "parent_spawn") turn.parent_spawn_count += 1;
  turn.tool_call_count += request.summary?.current_tool_calls?.length || 0;
  turn.tool_result_count += request.summary?.current_tool_results?.length || 0;
  mergeContextDelta(turn.context_delta, request.context_delta);
}

function mergeContextDelta(target, delta) {
  if (!delta) return;
  target.new_messages += delta.new_messages || 0;
  target.new_tool_calls += delta.new_tool_calls || 0;
  target.new_tool_results += delta.new_tool_results || 0;
  for (const [role, count] of Object.entries(delta.new_roles || {})) {
    target.new_roles[role] = (target.new_roles[role] || 0) + count;
  }
}

function finalizeTurn(turn) {
  return {
    ...turn,
    request_count: turn.request_ids.length,
    has_internal_requests: turn.internal_request_count > 0,
    has_tool_exchange: turn.tool_call_count > 0 || turn.tool_result_count > 0,
  };
}

// Subagent attribution that survives OTel (subscription) capture. The header
// (x-claude-code-agent-id) and debug source agent:* signals only exist on the
// proxy path; OTel dumps the body only. But the body still links parent↔child:
// a subagent's first user message equals the prompt of a parent `Agent` tool_use,
// and all rounds of one subagent share that same initial prompt. We derive a
// synthetic per-instance id (body:<promptHash>) so buildAgentTrace groups the
// branch, and mark source_hint=subagent so turn grouping nests it under the
// parent turn instead of spawning a phantom turn.
function subagentPromptKey(text) {
  const normalized = normalizeTranslationSourceText(text || "");
  if (!normalized || normalized.length < 8) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function firstUserPromptText(request) {
  const messages = request.raw?.body?.messages;
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (message?.role !== "user") continue;
    if (isToolResultMessage(message)) continue;
    const text = realUserVisibleText(message);
    if (text) return text;
    return "";
  }
  return "";
}

function annotateSubagentLineage(requests) {
  // Collect Agent/Task spawn prompts from both response tool_calls and the
  // assistant tool_use blocks in history (the latter survives even when the
  // OTel response file for the parent request wasn't paired).
  const spawnByPromptKey = new Map();
  for (const request of requests) {
    const responseCalls = request.summary?.response?.tool_calls || [];
    const historyCalls = extractToolCalls(Array.isArray(request.raw?.body?.messages) ? request.raw.body.messages : []);
    for (const call of [...responseCalls, ...historyCalls]) {
      if (!isAgentSpawnTool(call.name)) continue;
      const promptText = call.arguments?.prompt || call.arguments?.task || "";
      const key = subagentPromptKey(promptText);
      if (!key || spawnByPromptKey.has(key)) continue;
      spawnByPromptKey.set(key, {
        subagent_type: call.arguments?.subagent_type || call.arguments?.agentType || call.arguments?.type || null,
        description: call.arguments?.description || call.arguments?.taskName || "",
      });
    }
  }
  if (!spawnByPromptKey.size) return;

  for (const request of requests) {
    if (request.is_subagent) continue; // proxy header path already classified it
    if (request.source_hint?.type === "metadata") continue;
    const key = subagentPromptKey(firstUserPromptText(request));
    if (!key) continue;
    const spawn = spawnByPromptKey.get(key);
    if (!spawn) continue;
    const instanceId = `body:${key.slice(0, 12)}`;
    const typeLabel = spawn.subagent_type || "子 Agent";
    request.is_subagent = true;
    request.subagent_type = spawn.subagent_type || null;
    request.source_hint = { type: "subagent", label: `${typeLabel} 子 Agent`, confidence: "medium" };
    request.trace = {
      ...request.trace,
      actor_type: "child",
      claude_agent_id: request.trace?.claude_agent_id || instanceId,
      subagent_prompt_key: key,
    };
  }
}

function buildAgentTrace(requests) {
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const spawnCalls = [];
  const childGroups = new Map();
  // Pair body-detected branches (claude_agent_id = body:<promptHash>) to their
  // spawn by prompt hash; header-based branches keep the order-based pairing.
  const spawnByPromptKey = new Map();
  for (const request of requests) {
    const agentId = request.trace?.claude_agent_id || null;
    if (agentId) {
      if (!childGroups.has(agentId)) childGroups.set(agentId, []);
      childGroups.get(agentId).push(request);
    }
    for (const call of request.summary?.response?.tool_calls || []) {
      if (isAgentSpawnTool(call.name)) {
        const promptKey = subagentPromptKey(call.arguments?.prompt || call.arguments?.task || "");
        const spawnRecord = {
          id: call.id || `spawn-${request.request_index}-${spawnCalls.length + 1}`,
          name: call.name || "Agent",
          parent_request_id: request.id,
          parent_request_index: request.request_index,
          order: spawnCalls.length,
          label: agentSpawnLabel(call),
          description: textPreview(call.arguments?.description || call.arguments?.taskName || call.arguments?.subagent_type || "", 120),
          prompt_preview: textPreview(call.arguments?.prompt || call.arguments?.task || "", 220),
          subagent_type: call.arguments?.subagent_type || call.arguments?.agentType || call.arguments?.type || null,
          raw_arguments: call.arguments ?? null,
        };
        spawnCalls.push(spawnRecord);
        if (promptKey && !spawnByPromptKey.has(promptKey)) spawnByPromptKey.set(promptKey, spawnRecord);
      }
    }
  }

  const parentReturns = [];
  const spawnById = new Map(spawnCalls.map((call) => [call.id, call]));
  for (const request of requests) {
    for (const result of request.summary?.current_tool_results || []) {
      const spawn = result.id ? spawnById.get(result.id) : null;
      if (!spawn) continue;
      parentReturns.push({
        spawn_id: spawn.id,
        parent_request_id: request.id,
        parent_request_index: request.request_index,
        result_preview: textPreview(result.content, 260),
      });
    }
  }
  const returnBySpawnId = new Map(parentReturns.map((item) => [item.spawn_id, item]));
  const sortedChildGroups = [...childGroups.entries()]
    .map(([agentId, groupRequests]) => [agentId, [...groupRequests].sort(compareRequestsByIndex)])
    .sort((left, right) => compareRequestsByIndex(left[1][0], right[1][0]));

  const branches = sortedChildGroups.map(([agentId, groupRequests], index) => {
    const promptKey = groupRequests[0]?.trace?.subagent_prompt_key || null;
    const spawn = (promptKey && spawnByPromptKey.get(promptKey)) || spawnCalls[index] || null;
    const returned = spawn ? returnBySpawnId.get(spawn.id) || null : null;
    const requestIds = groupRequests.map((request) => request.id);
    const responseToolCallCount = groupRequests.reduce((sum, request) => sum + (request.summary?.response?.tool_calls?.length || 0), 0);
    const requestToolResultCount = groupRequests.reduce((sum, request) => sum + (request.summary?.current_tool_results?.length || 0), 0);
    return {
      id: `branch-${index + 1}-${agentId}`,
      label: spawn?.description || spawn?.subagent_type || `子 Agent ${index + 1}`,
      agent_id: agentId,
      agent_type: childAgentType(groupRequests[0], spawn),
      confidence: spawn ? "high_ordered" : "high_agent_id",
      linkage_note: spawn
        ? "通过子 Agent 实例顺序与父级 Agent tool_use 顺序关联；子分支内部由 x-claude-code-agent-id 强关联。"
        : "通过 x-claude-code-agent-id 强关联；未找到可配对的父级 Agent tool_use。",
      spawn: spawn
        ? {
            id: spawn.id,
            name: spawn.name,
            parent_request_id: spawn.parent_request_id,
            parent_request_index: spawn.parent_request_index,
            label: spawn.label,
            description: spawn.description,
            prompt_preview: spawn.prompt_preview,
            subagent_type: spawn.subagent_type,
          }
        : null,
      return: returned,
      request_ids: requestIds,
      request_indexes: groupRequests.map((request) => request.request_index),
      first_request_index: groupRequests[0]?.request_index || null,
      last_request_index: groupRequests.at(-1)?.request_index || null,
      response_tool_call_count: responseToolCallCount,
      request_tool_result_count: requestToolResultCount,
      status: returned ? "returned" : groupRequests.some((request) => request.summary?.response?.finish_reason === "end_turn") ? "completed" : "running",
      steps: groupRequests.map((request, stepIndex) => ({
        request_id: request.id,
        request_index: request.request_index,
        response_id: request.summary?.response?.message_id || null,
        response_captured: Boolean(request.summary?.response?.captured),
        finish_reason: request.summary?.response?.finish_reason || null,
        response_tool_calls: (request.summary?.response?.tool_calls || []).map((call) => ({
          id: call.id || null,
          name: call.name || "unknown",
          arguments_preview: textPreview(stableJson(call.arguments ?? null), 180),
        })),
        request_tool_results: (request.summary?.current_tool_results || []).map((result) => ({
          id: result.id || null,
          content_preview: textPreview(result.content, 160),
        })),
        response_preview: textPreview(request.summary?.response?.preview || request.summary?.response?.text || "", stepIndex ? 220 : 120),
      })),
    };
  });

  for (const [branchIndex, branch] of branches.entries()) {
    for (const requestId of branch.request_ids) {
      const request = requestById.get(requestId);
      if (request) {
        request.trace.branch_id = branch.id;
        request.trace.agent_branch = {
          id: branch.id,
          index: branchIndex + 1,
          label: branch.label,
          agent_id: branch.agent_id,
          agent_type: branch.agent_type,
          status: branch.status,
        };
      }
    }
    if (branch.spawn?.parent_request_id) {
      const request = requestById.get(branch.spawn.parent_request_id);
      if (request) {
        request.trace.spawn_branch_ids ||= [];
        request.trace.spawn_branch_ids.push(branch.id);
      }
    }
    if (branch.return?.parent_request_id) {
      const request = requestById.get(branch.return.parent_request_id);
      if (request) {
        request.trace.returned_branch_ids ||= [];
        request.trace.returned_branch_ids.push(branch.id);
      }
    }
  }

  return {
    version: 1,
    branch_count: branches.length,
    spawn_count: spawnCalls.length,
    return_count: parentReturns.length,
    confidence: branches.length ? (spawnCalls.length >= branches.length && parentReturns.length ? "high" : "medium") : "none",
    signals: {
      child_instance: "x-claude-code-agent-id",
      child_type: "debug source agent:*",
      request_response_pair: "capture_id/request_index",
      parent_spawn: "response Agent tool_use",
      parent_return: "request Agent tool_result",
    },
    branches,
    spawns: spawnCalls,
    returns: parentReturns,
  };
}

function attachAgentTraceToTurns(turns, agentTrace) {
  if (!agentTrace?.branches?.length) return;
  const turnByRequestId = new Map();
  const turnByRequestIndex = new Map();
  for (const turn of turns) {
    turn.agent_branches = [];
    turn.agent_branch_count = 0;
    for (const requestId of turn.request_ids || []) turnByRequestId.set(requestId, turn);
    for (const requestIndex of turn.request_indexes || []) turnByRequestIndex.set(requestIndex, turn);
  }
  for (const branch of agentTrace.branches) {
    const owner =
      turnByRequestId.get(branch.spawn?.parent_request_id) ||
      turnByRequestIndex.get(branch.spawn?.parent_request_index) ||
      turnByRequestId.get(branch.request_ids?.[0]) ||
      turnByRequestIndex.get(branch.request_indexes?.[0]) ||
      turnByRequestId.get(branch.return?.parent_request_id) ||
      turnByRequestIndex.get(branch.return?.parent_request_index);
    if (!owner) continue;
    owner.agent_branches.push(branch.id);
    owner.agent_branch_count = owner.agent_branches.length;
  }
}

function compareRequestsByIndex(left, right) {
  return Number(left?.request_index || 0) - Number(right?.request_index || 0);
}

function isAgentSpawnTool(name) {
  return /^(Agent|Task|sessions_spawn|subagents)$/i.test(String(name || ""));
}

function agentSpawnLabel(call) {
  const args = call.arguments || {};
  return args.description || args.taskName || args.subagent_type || call.name || "Agent";
}

function childAgentType(request, spawn) {
  if (spawn?.subagent_type) return spawn.subagent_type;
  const debug = request?.debug_source || request?.trace?.debug_source || "";
  if (debug.startsWith("agent:")) return debug.replace(/^agent:/, "");
  return "Subagent";
}

function normalizeTurnUserKey(text) {
  return cleanTitleText(text).replace(/\s+/g, " ").trim();
}

function turnTitle(userText, commandMessage = null) {
  if (commandMessage) {
    const suffix = textPreview(cleanTitleText(commandMessage.body), 72);
    return suffix ? `${commandMessage.command} · ${suffix}` : `Command ${commandMessage.command}`;
  }
  return textPreview(cleanTitleText(userText), 96) || "未识别用户输入";
}

function isInternalRequest(request) {
  return request.source_hint?.type === "metadata";
}

function isTimelineInternalRequest(request) {
  return isInternalRequest(request) || request.source_hint?.type === "subagent";
}

function analyzeContextDelta(request, previous, contextKey = "") {
  const messages = Array.isArray(request.raw?.body?.messages) ? request.raw.body.messages : [];
  const previousMessages = Array.isArray(previous?.raw?.body?.messages) ? previous.raw.body.messages : [];
  const commonPrefixMessages = previous ? commonMessagePrefixLength(previousMessages, messages) : 0;
  const newMessages = messages.slice(commonPrefixMessages);
  const roleCounts = countMessageRoles(newMessages);
  const toolCalls = extractToolCalls(newMessages);
  const toolResults = extractToolResults(newMessages);
  const fixedContext = {
    system: previous ? (request.changes.system_changed ? "changed" : "reused") : "baseline",
    tools: previous ? (request.changes.tools_changed ? "changed" : "reused") : "baseline",
    params: previous ? (request.changes.params_changed ? "changed" : "reused") : "baseline",
  };
  return {
    baseline: !previous,
    comparison_key: contextKey || null,
    previous_request_index: previous?.request_index || null,
    previous_messages: previousMessages.length,
    total_messages: messages.length,
    reused_messages: commonPrefixMessages,
    reused_ratio: messages.length ? Number((commonPrefixMessages / messages.length).toFixed(3)) : 0,
    new_messages: newMessages.length,
    new_roles: roleCounts,
    new_tool_calls: toolCalls.length,
    new_tool_results: toolResults.length,
    fixed_context: fixedContext,
    previews: newMessages.slice(0, 8).map(messageDeltaPreview),
  };
}

function countMessageRoles(messages) {
  const counts = {};
  for (const message of messages) {
    const role = message?.role || "unknown";
    const kind = messageDeltaKind(message);
    const key = kind === "message" ? role : kind;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function messageDeltaPreview(message) {
  const commandMessage = parseCommandMessage(message);
  return {
    role: message?.role || "unknown",
    kind: messageDeltaKind(message),
    text: textPreview(commandMessage ? commandPreviewText(commandMessage) : displayMessageText(message), 220),
    command_message: commandMessage,
  };
}

function messageDeltaKind(message) {
  if (isTaskNotificationMessage(message)) return taskNotificationSummary(message).subagent ? "subagent_result" : "task_notification";
  if (isFrameworkReminderMessage(message)) return "framework_reminder";
  if (isSuggestionModeMessage(message)) return "agent_internal";
  if (isCompactInjectionMessage(message)) return "compact";
  if (message?.role === "user" && realUserVisibleText(message)) return "message";
  if (parseCommandMessage(message)) return "command_message";
  if (isToolResultMessage(message)) return "tool_result";
  const parts = Array.isArray(message?.content) ? message.content : [];
  if (parts.some((part) => part?.type === "tool_use")) return "tool_use";
  return "message";
}

function summarizeHistoryStack(messages, currentUser) {
  const currentUserKey = currentUser ? stableJson(currentUser) : "";
  return (messages || []).map((message, index) => {
    const kind = messageDeltaKind(message);
    const toolCalls = extractToolCalls([message]);
    const toolResults = extractToolResults([message]);
    const fullText = extractContentText(message?.content);
    const commandMessage = parseCommandMessage(message);
    const realText = kind === "compact" ? "" : realUserVisibleText(message);
    const displayText = displayMessageText(message);
    return {
      index: index + 1,
      role: message?.role || "unknown",
      kind,
      label: historyMessageLabel(message, kind),
      is_current_user: Boolean(currentUserKey && stableJson(message) === currentUserKey),
      text: textPreview(realText || (commandMessage ? commandMessage.body || commandPreviewText(commandMessage) : displayText), kind === "framework_reminder" ? 180 : 420),
      command_message: commandMessage,
      full_text: kind === "framework_reminder" ? textPreview(fullText, 4000) : "",
      char_count: charLength(fullText),
      tool_calls: toolCalls.map((call) => ({ name: call.name, id: call.id || null, arguments_preview: textPreview(stableJson(call.arguments), 260) })),
      tool_results: toolResults.map((result) => ({ id: result.id || null, content: textPreview(result.content, 260) })),
    };
  });
}

function historyMessageLabel(message, kind) {
  if (kind === "message" && message?.role === "user") return "User 输入";
  const commandMessage = parseCommandMessage(message);
  if (commandMessage) return `Command ${commandMessage.command}`;
  if (kind === "compact") return "上下文压缩 (/compact)";
  if (kind === "task_notification") return "任务通知";
  if (kind === "framework_reminder") return "框架提醒";
  if (kind === "agent_internal") return "Agent 内部请求";
  if (kind === "tool_result") return "Tool result";
  if (kind === "tool_use") return "Tool use";
  if (message?.role === "user") return "User 输入";
  if (message?.role === "assistant") return "Assistant 回复";
  if (message?.role === "system") return "System";
  if (message?.role === "tool") return "Tool result";
  return message?.role || "Message";
}

function currentToolEventMessages(request, previous) {
  const messages = Array.isArray(request.raw?.body?.messages) ? request.raw.body.messages : null;
  if (!messages) return null;
  const latestTurnMessages = messagesAfterLatestRealUserInput(messages);
  const previousMessages = Array.isArray(previous?.raw?.body?.messages) ? previous.raw.body.messages : null;
  if (!previousMessages) return latestTurnMessages;

  const prefixLength = commonMessagePrefixLength(previousMessages, messages);
  const suffix = messages.slice(prefixLength);
  if (suffix.length) return suffix;
  return latestTurnMessages;
}

function messagesAfterLatestRealUserInput(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && !isToolResultMessage(message) && !isSuggestionModeMessage(message) && !isFrameworkReminderMessage(message)) return messages.slice(index + 1);
  }
  return messages;
}

function isToolResultMessage(message) {
  if (message?.role === "tool") return true;
  const content = message?.content;
  if (Array.isArray(content) && content.length) {
    // A tool-result continuation may carry a trailing harness text block —
    // e.g. ToolSearch returns a tool_result + "Tool loaded.", and tool turns
    // sometimes bundle a compact/reminder block. Any tool_result block makes
    // this a continuation, not a new user turn. (compact / task_notification /
    // command / suggestion are classified ahead of tool_result, so the special
    // cases still get their own label.)
    return content.some((part) => part?.type === "tool_result");
  }
  return content?.type === "tool_result";
}

function commonMessagePrefixLength(previousMessages, currentMessages) {
  const limit = Math.min(previousMessages.length, currentMessages.length);
  let index = 0;
  while (index < limit && comparableMessageKey(previousMessages[index]) === comparableMessageKey(currentMessages[index])) index += 1;
  return index;
}

function comparableMessageKey(message) {
  if (message && typeof message === "object") {
    const cached = comparableMessageKeyCache.get(message);
    if (cached) return cached;
  }
  const normalized = normalizeComparableValue(message);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) normalized.content = normalizeComparableContent(message?.content);
  const key = stableJson(normalized);
  if (message && typeof message === "object") comparableMessageKeyCache.set(message, key);
  return key;
}

function normalizeComparableContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.map(normalizeComparableContentPart);
  if (content && typeof content === "object") return [normalizeComparableContentPart(content)];
  return content ?? null;
}

function normalizeComparableContentPart(part) {
  if (typeof part === "string") return { type: "text", text: part };
  return normalizeComparableValue(part);
}

function normalizeComparableValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeComparableValue).filter((item) => item !== undefined);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, normalizeComparableValue(item)])
      .filter(([, item]) => item !== undefined),
  );
}

function buildWorkbenchSummary(source, requests, command) {
  const first = requests[0] || {};
  const watchIds = uniqueValues([...requests.map((request) => request.watch_id), source.live_watch_id]);
  const conversationIds = uniqueValues([...requests.map((request) => request.conversation_id), source.conversation_id]);
  const workspaces = uniqueValues([...requests.map((request) => request.raw?.workspace || request.raw?.body?.workspace), command?.cwd]);
  const agentProfiles = uniqueValues(requests.map((request) => request.agent_profile || source.agent));
  const sourceKinds = uniqueValues([...requests.map((request) => request.source_kind), source.kind]);
  return {
    agent: agentProfiles[0] || source.agent || "Unknown Agent",
    project: displayProjectName(workspaces[0]),
    workspace: workspaces[0] || null,
    mode: inferWatchMode(source, requests),
    watch_ids: watchIds,
    conversation_ids: conversationIds,
    conversation_label: conversationIds.length ? shortenId(conversationIds[0]) : "按监听任务归档",
    capture_label: captureLabel(source),
    source_kinds: sourceKinds,
    status: liveStatusLabel(source.live_status),
    request_count: requests.length,
    subagent_count: requests.filter((request) => request.is_subagent).length,
    parent_spawn_count: requests.filter((request) => request.source_hint.type === "parent_spawn").length,
    redaction_count: requests.reduce((sum, request) => sum + request.redaction_count, 0),
    first_seen: first.captured_at || null,
    last_seen: requests.at(-1)?.captured_at || null,
  };
}

function inferRequestSource(capture, body, currentUser, debugSource, lastUser = currentUser) {
  if (isContextTokenCountingRequest(capture)) {
    return { type: "metadata", label: "上下文统计 (/context)", confidence: "high" };
  }
  if (isSuggestionModeMessage(lastUser)) {
    return { type: "metadata", label: "Agent 输入建议请求", confidence: "high" };
  }
  if (isFrameworkReminderMessage(lastUser)) {
    return { type: "metadata", label: "Claude Code 框架提醒", confidence: "high" };
  }
  if (isTitleGenerationRequest(body)) {
    return { type: "metadata", label: "生成会话标题", confidence: "high" };
  }
  if (isWebSearchInternalRequest(body)) {
    return { type: "metadata", label: "WebSearch 内部请求", confidence: "high" };
  }
  const userText = userVisibleText(currentUser);
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  if (claudeAgentId) {
    return { type: "subagent", label: debugSource?.source || "Claude Code 子 Agent", confidence: "high" };
  }
  if (debugSource?.source?.startsWith("agent:")) {
    return { type: "subagent", label: debugSource.source, confidence: "high" };
  }
  if (debugSource?.source === "generate_session_title") {
    return { type: "metadata", label: "生成会话标题", confidence: "high" };
  }
  if (/\[Subagent Context\]|\[Subagent Task\]/i.test(userText)) {
    return { type: "subagent", label: "子代理请求", confidence: "high" };
  }
  const apiSource = capture.api_source || body.api_source || body.metadata?.api_source;
  if (typeof apiSource === "string" && apiSource.startsWith("agent:")) {
    return { type: "subagent", label: apiSource, confidence: "high" };
  }
  const calls = extractToolCalls(Array.isArray(body.messages) ? body.messages : []);
  if (calls.some((call) => /^(Agent|sessions_spawn|subagents)$/.test(call.name))) {
    return { type: "parent_spawn", label: "启动子代理", confidence: "high" };
  }
  return { type: "main", label: "主代理请求", confidence: "medium" };
}

function isContextTokenCountingRequest(capture) {
  const requestPath = String(capture?.path || capture?.original_url || "");
  return /\/v1\/messages\/count_tokens(?:$|[?#/])/.test(requestPath);
}

function isTitleGenerationRequest(body) {
  const systemText = extractSystemParts(body, Array.isArray(body?.messages) ? body.messages : [])
    .map((part) => part.text)
    .join("\n");
  const format = body?.output_config?.format;
  return (
    /Generate a concise, sentence-case title/i.test(systemText) ||
    (format?.type === "json_schema" && format?.schema?.properties?.title && Array.isArray(body?.tools) && body.tools.length === 0)
  );
}

function isWebSearchInternalRequest(body) {
  const systemText = extractSystemParts(body, Array.isArray(body?.messages) ? body.messages : [])
    .map((part) => part.text)
    .join("\n");
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return (
    body?.tool_choice?.name === "web_search" ||
    tools.some((tool) => tool?.name === "web_search" || tool?.type === "web_search_20250305") ||
    /assistant for performing a web search tool use/i.test(systemText)
  );
}

function inferProtocolProfile(capture, body) {
  const path = String(capture?.path || "");
  const model = String(body?.model || "");
  const protocol = inferProtocol(path, body);
  const provider = inferProvider(model, capture);
  const extensions = [];
  if (hasReasoningContent(body)) extensions.push("reasoning_content");
  if (body?.thinking != null) extensions.push("thinking");
  return {
    protocol,
    protocol_label: protocolLabel(protocol),
    provider,
    provider_label: providerLabel(provider),
    model: model || null,
    extensions,
  };
}

function inferProtocol(path, body) {
  if (/\/v1\/messages(?:$|[?#/])/.test(path) && Array.isArray(body?.messages)) return "anthropic_messages";
  if (/\/v1\/chat\/completions(?:$|[?#/])/.test(path)) return "openai_chat_completions";
  if (/\/v1\/responses(?:$|[?#/])/.test(path)) return "openai_responses";
  if (/(generateContent|streamGenerateContent)/.test(path) || Array.isArray(body?.contents)) return "gemini_generate_content";
  if (Array.isArray(body?.input)) return "openai_responses";
  if (Array.isArray(body?.messages) && Array.isArray(body?.tools) && body?.stream != null && body?.system == null) return "openai_chat_completions";
  return "unknown";
}

function inferProvider(model, capture) {
  const lowerModel = String(model || "").toLowerCase();
  const hostHint = String(capture?.headers?.host || capture?.target_base_url || "").toLowerCase();
  if (/^mimo(?:-|_)/.test(lowerModel) || /xiaomimimo|mimo/.test(hostHint)) return "xiaomi_mimo";
  if (/^gpt-|^o[134]|openai/.test(lowerModel)) return "openai";
  if (/claude/.test(lowerModel)) return "anthropic";
  if (/gemini/.test(lowerModel)) return "google_gemini";
  if (/deepseek/.test(lowerModel)) return "deepseek";
  if (/qwen|qwq/.test(lowerModel)) return "qwen";
  if (/kimi|moonshot/.test(lowerModel)) return "moonshot";
  return "unknown";
}

function protocolLabel(protocol) {
  const labels = {
    openai_chat_completions: "OpenAI Chat",
    openai_responses: "OpenAI Responses",
    anthropic_messages: "Anthropic",
    gemini_generate_content: "Gemini",
    unknown: "未知协议",
  };
  return labels[protocol] || protocol;
}

function providerLabel(provider) {
  const labels = {
    xiaomi_mimo: "MiMo",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google_gemini: "Google Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    moonshot: "Moonshot",
    unknown: "未知厂商",
  };
  return labels[provider] || provider;
}

function hasReasoningContent(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasReasoningContent);
  if (typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "reasoning_content")) return true;
  return Object.values(value).some(hasReasoningContent);
}

function extractSystemParts(body, messages) {
  const output = [];
  if (typeof body.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body.system)) {
    for (const part of body.system) output.push({ source: "body.system", text: extractContentText(part) });
  }
  for (const message of messages) {
    if (message.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => part.text);
}

function extractToolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        calls.push({
          name: call.function?.name || call.name || "unknown",
          id: call.id || null,
          arguments: parseMaybeJson(call.function?.arguments || call.arguments),
        });
      }
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    calls.push(...extractToolCallsFromContent(parts));
  }
  return calls;
}

function extractToolCallsFromContent(content) {
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  return parts.map(toolCallFromPart).filter(Boolean);
}

function toolCallFromPart(part) {
  if (!part || typeof part !== "object" || part.type !== "tool_use") return null;
  return { name: part.name || "unknown", id: part.id || null, arguments: part.input ?? null };
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const output = [];
  for (const call of calls.filter(Boolean)) {
    const key = `${call.id || ""}:${call.name || ""}:${stableJson(call.arguments ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function extractToolResults(messages) {
  const results = [];
  for (const message of messages) {
    if (message.role === "tool") {
      results.push({ id: message.tool_call_id || null, content: extractContentText(message.content) });
    }
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part?.type === "tool_result") {
        results.push({ id: part.tool_use_id || null, content: extractContentText(part.content) });
      }
    }
  }
  return results;
}

function analyzeRequestComposition(body, messages, systemParts, tools, currentUser, responseSummary, rawBodyLength = 0) {
  const params = Object.fromEntries(Object.entries(body || {}).filter(([key]) => !["messages", "system", "tools"].includes(key)));
  const messageParts = analyzeMessageComposition(messages || [], currentUser);
  const totalPayloadChars = Number(rawBodyLength) || jsonCharLength(body || {});
  const messagesChars = messageParts.total_chars;
  const systemChars = (systemParts || []).reduce((sum, part) => sum + charLength(part.text), 0);
  const toolsChars = jsonCharLength(tools || []);
  const paramsChars = jsonCharLength(params);
  const currentUserChars = messageParts.current_user_chars || charLength(userVisibleText(currentUser));
  const responseTextChars = charLength(responseSummary?.text || "");
  const responseThinkingChars = charLength(responseSummary?.thinking || "");
  const fixedContextChars = systemChars + toolsChars + paramsChars;
  const historyContextChars = Math.max(0, messageParts.total_chars - currentUserChars);
  return {
    unit: "chars",
    total_payload_chars: totalPayloadChars,
    input_chars: totalPayloadChars,
    fixed_context_chars: fixedContextChars,
    history_context_chars: historyContextChars,
    current_user_chars: currentUserChars,
    human_user_chars: messageParts.human_user_chars,
    assistant_history_chars: messageParts.assistant_chars,
    tool_use_chars: messageParts.tool_use_chars,
    tool_result_chars: messageParts.tool_result_chars,
    agent_internal_chars: messageParts.agent_internal_chars,
    response_text_chars: responseTextChars,
    response_thinking_chars: responseThinkingChars,
    sections: {
      system: compositionItem(systemChars, totalPayloadChars),
      tools: compositionItem(toolsChars, totalPayloadChars),
      params: compositionItem(paramsChars, totalPayloadChars),
      messages: compositionItem(messagesChars, totalPayloadChars),
      current_user: compositionItem(currentUserChars, totalPayloadChars),
      history_context: compositionItem(historyContextChars, totalPayloadChars),
      assistant_history: compositionItem(messageParts.assistant_chars, totalPayloadChars),
      tool_use: compositionItem(messageParts.tool_use_chars, totalPayloadChars),
      tool_result: compositionItem(messageParts.tool_result_chars, totalPayloadChars),
      agent_internal: compositionItem(messageParts.agent_internal_chars, totalPayloadChars),
      response_text: compositionItem(responseTextChars, totalPayloadChars),
      response_thinking: compositionItem(responseThinkingChars, totalPayloadChars),
    },
    ratios: {
      current_user_to_input: ratio(currentUserChars, totalPayloadChars),
      human_user_to_input: ratio(messageParts.human_user_chars, totalPayloadChars),
      fixed_context_to_input: ratio(fixedContextChars, totalPayloadChars),
      history_context_to_input: ratio(historyContextChars, totalPayloadChars),
      tools_to_input: ratio(toolsChars, totalPayloadChars),
      system_to_input: ratio(systemChars, totalPayloadChars),
      tool_result_to_input: ratio(messageParts.tool_result_chars, totalPayloadChars),
      output_to_input: ratio(responseTextChars, totalPayloadChars),
    },
    note: "本统计使用字符数近似，后续可升级为 tokenizer 估算。",
  };
}

function analyzeMessageComposition(messages, currentUser) {
  const stats = {
    total_chars: 0,
    human_user_chars: 0,
    assistant_chars: 0,
    tool_use_chars: 0,
    tool_result_chars: 0,
    agent_internal_chars: 0,
    other_chars: 0,
  };
  for (const message of messages) {
    const chars = messageCompositionChars(message);
    stats.total_chars += chars;
    if (isFrameworkReminderMessage(message)) stats.agent_internal_chars += chars;
    else if (isSuggestionModeMessage(message)) stats.agent_internal_chars += chars;
    else if (isToolResultMessage(message)) stats.tool_result_chars += chars;
    else if (messageDeltaKind(message) === "tool_use") stats.tool_use_chars += chars;
    else if (message?.role === "user") stats.human_user_chars += chars;
    else if (message?.role === "assistant") stats.assistant_chars += chars;
    else stats.other_chars += chars;
  }
  stats.current_user_chars = charLength(userVisibleText(currentUser));
  return stats;
}

function messageCompositionChars(message) {
  if (!message || typeof message !== "object") return 0;
  if (messageDeltaKind(message) === "tool_use") return charLength(stableJson(extractToolCalls([message])));
  if (isToolResultMessage(message)) return charLength(extractContentText(message.content));
  return charLength(extractContentText(message.content));
}

function compositionItem(chars, total) {
  return {
    chars,
    ratio: ratio(chars, total),
  };
}

function ratio(value, total) {
  if (!total) return 0;
  return Number((Number(value || 0) / Number(total)).toFixed(4));
}

function charLength(value) {
  return String(value || "").length;
}

function jsonCharLength(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return charLength(stableJson(value ?? null));
  }
}

function buildStats(requests, agentTrace = null) {
  const subagentCount = requests.filter((request) => request.is_subagent).length;
  return {
    request_count: requests.length,
    response_count: requests.filter((request) => request.summary.response?.captured).length,
    subagent_count: subagentCount,
    subagent_instance_count: agentTrace?.branch_count || new Set(requests.map((request) => request.trace?.claude_agent_id).filter(Boolean)).size || subagentCount,
    main_count: requests.length - subagentCount,
    tool_call_count: requests.reduce((sum, request) => sum + request.counts.tool_calls, 0),
    tool_result_count: requests.reduce((sum, request) => sum + request.counts.tool_results, 0),
    raw_body_bytes: requests.reduce((sum, request) => sum + request.counts.raw_body_bytes, 0),
  };
}

function lastMessage(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return messages[index];
  }
  return null;
}

function lastRealUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (isSuggestionModeMessage(message) || isFrameworkReminderMessage(message) || isTaskNotificationMessage(message)) continue;
    if (realUserVisibleText(message) || parseCommandMessage(message)) return message;
  }
  return null;
}

function isFrameworkReminderMessage(message) {
  if (!message || message.role !== "user") return false;
  const text = extractContentText(message.content);
  return (hasFrameworkReminderBlock(text) && !stripFrameworkReminderBlocks(text)) || isKnownFrameworkReminderText(text);
}

function isSuggestionModeMessage(message) {
  if (!message) return false;
  return /^\[SUGGESTION MODE:/i.test(extractContentText(message.content).trim());
}

// Background-task completion notices the harness injects as a role:"user"
// message wrapped in <task-notification>. They are not real user input — the
// model treats them as a system event — so they must not be mistaken for the
// turn's user prompt.
function isTaskNotificationMessage(message) {
  if (!message || message.role !== "user") return false;
  return /^\s*<task-notification[\s>]/i.test(extractContentText(message.content));
}

function taskNotificationSummary(message) {
  const text = extractContentText(message?.content);
  const tag = (name) => (text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i")) || [])[1]?.trim() || "";
  const taskId = tag("task-id");
  const status = tag("status");
  const summary = tag("summary");
  const result = tag("result").replace(/\s+/g, " ").trim();
  const subagent = subagentResultFromTaskNotification({ summary, status, result });
  const headline = [summary, status && `(${status})`].filter(Boolean).join(" ");
  const preview = textPreview([headline, result].filter(Boolean).join(" — "), 420)
    || textPreview(
      text.replace(/<\/?[a-z-]+>/gi, " ").replace(/\s+/g, " ").trim(),
      420,
    );
  return { taskId, status, summary, result, preview, subagent };
}

function subagentResultFromTaskNotification({ summary, status, result }) {
  const match = String(summary || "").match(/^Agent\s+"([^"]+)"\s+finished/i);
  if (!match) return null;
  return {
    name: match[1],
    status: status || null,
    result: result || "",
    preview: textPreview(`子 Agent「${match[1]}」${status ? ` ${status}` : "完成"} — ${result || summary}`, 420),
  };
}

// Context-compaction (/compact) prompt the harness injects as bare text — no
// XML markers — asking the model to summarize the conversation. It frequently
// rides in the SAME role:"user" message as the prior turn's tool_results (a
// separate text block), so detection must look per-block, not at the flattened
// message, and must run before the tool_result check.
function isCompactInjectionText(text) {
  const t = String(text || "");
  return (
    /create a detailed summary of the conversation so far/i.test(t) ||
    (/Respond with TEXT ONLY/i.test(t) && /<analysis>[\s\S]*<summary>/i.test(t))
  );
}

function compactInjectionText(message) {
  if (!message) return "";
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: extractContentText(message?.content) }];
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "";
    if (isCompactInjectionText(text)) return text;
  }
  return "";
}

function isCompactInjectionMessage(message) {
  return Boolean(compactInjectionText(message));
}

// Classify the most recent salient message of a request so the card header can
// say what this upstream turn actually is — real user input, a task
// notification, a tool-result return, etc. — instead of always "User input".
// Skips appended framework/system reminders and scans back to the message that
// defines the turn.
function classifyCurrentEntry(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message) continue;
    if (isFrameworkReminderMessage(message)) continue;
    if (message.role === "system") continue;
    if (isTaskNotificationMessage(message)) {
      const { taskId, preview, subagent } = taskNotificationSummary(message);
      if (subagent) {
        return {
          kind: "subagent_result",
          label: "子 Agent 结果回流",
          text: subagent.preview || preview,
          task_id: taskId,
          subagent,
        };
      }
      return { kind: "task_notification", label: "任务通知", text: preview, task_id: taskId };
    }
    if (isCompactInjectionMessage(message)) {
      return { kind: "compact", label: "上下文压缩 (/compact)", text: "请求模型把前文压缩成 <analysis> + <summary> 结构化总结（注入提示词，非用户真话）" };
    }
    if (message.role === "user") {
      const real = realUserVisibleText(message);
      if (real) return { kind: "user_input", label: "User input", text: textPreview(real, 1200) };
    }
    if (isToolResultMessage(message)) return { kind: "tool_result", label: "Tool result 回传", text: "" };
    const parts = Array.isArray(message.content) ? message.content : [];
    if (parts.some((part) => part?.type === "tool_use")) return { kind: "tool_use", label: "Tool use 上行", text: "" };
    if (isSuggestionModeMessage(message)) return { kind: "agent_internal", label: "Agent 内部建议", text: "" };
    const commandMessage = parseCommandMessage(message);
    if (commandMessage) return { kind: "command", label: `Command ${commandMessage.command}`, text: commandMessage.preview || "" };
    if (message.role === "user") continue;
    // assistant / other roles: keep scanning back for the user-side entry.
  }
  return { kind: "unknown", label: "未识别输入", text: "" };
}

function extractContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "thinking" || part?.type === "reasoning") return "";
        if (part?.type === "text") return part.text || "";
        if (part?.text) return part.text;
        if (part?.content) return extractContentText(part.content);
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content.type === "thinking" || content.type === "reasoning") return "";
  if (content.text) return content.text;
  if (content.content) return extractContentText(content.content);
  return JSON.stringify(content);
}

function extractThinkingText(content) {
  if (content == null) return "";
  if (typeof content === "string") return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if (part.type === "thinking") return part.thinking || part.text || "";
        if (part.type === "reasoning") return part.reasoning || part.text || "";
        if (part.thinking) return part.thinking;
        if (part.reasoning) return part.reasoning;
        if (part.content) return extractThinkingText(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (content.type === "thinking") return content.thinking || content.text || "";
    if (content.type === "reasoning") return content.reasoning || content.text || "";
    if (content.thinking) return content.thinking;
    if (content.reasoning) return content.reasoning;
    if (content.content) return extractThinkingText(content.content);
  }
  return "";
}

function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function displayMessageText(message) {
  const text = extractContentText(message?.content);
  if (isCompactInjectionMessage(message)) return "上下文压缩指令：请求模型把前文压缩成 <analysis> + <summary> 总结（harness 注入）";
  if (isFrameworkReminderMessage(message)) return "Claude Code 框架自动补充提醒";
  if (isTaskNotificationMessage(message)) {
    const { taskId, preview, subagent } = taskNotificationSummary(message);
    if (subagent) return taskId ? `子 Agent 结果回流 · ${taskId}\n${subagent.preview || preview}` : `子 Agent 结果回流\n${subagent.preview || preview}`;
    return taskId ? `后台任务通知 · ${taskId}\n${preview}` : `后台任务通知\n${preview}`;
  }
  return text;
}

function userVisibleText(message) {
  const realText = realUserVisibleText(message);
  if (realText) return realText;
  const commandMessage = parseCommandMessage(message);
  if (commandMessage) return commandUserVisibleText(commandMessage);
  return "";
}

function realUserVisibleText(message) {
  if (!message) return "";
  const rawText = extractContentText(message.content);
  const textAfterLocalCommands = userTextAfterLocalCommandBlocks(rawText);
  if (textAfterLocalCommands) return textAfterLocalCommands;
  const text = realUserVisibleTextFromContent(message.content);
  if (parseCommandMessage(message)) return "";
  return stripDisplayWrapperTags(stripFrameworkReminderBlocks(text));
}

function realUserVisibleTextFromContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: extractContentText(content) }];
  return parts
    .map((part) => realUserVisibleTextPart(part))
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function realUserVisibleTextPart(part) {
  if (part == null) return "";
  if (typeof part === "string") return cleanRealUserTextPart(part);
  if (part.type === "tool_result" || part.type === "tool_use" || part.type === "thinking" || part.type === "reasoning") return "";
  const text = part.type === "text" ? part.text || "" : part.text || extractContentText(part.content);
  return cleanRealUserTextPart(text);
}

function cleanRealUserTextPart(text) {
  let value = stripFrameworkReminderBlocks(String(text || ""));
  if (/<local-command-|<command-(?:name|message|args)\b/i.test(value)) value = userTextAfterLocalCommandBlocks(value);
  else value = stripDisplayWrapperTags(value);
  if (!value) return "";
  if (isCompactInjectionText(value)) return "";
  if (isLocalCommandOnlyText(value)) return "";
  if (/^Tool loaded\.\s*$/i.test(value)) return "";
  return value;
}

function inferCaptureTitle(capture) {
  const body = capture?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((message) => message?.role === "user" && !isToolResultMessage(message) && !isSuggestionModeMessage(message) && !isFrameworkReminderMessage(message) && !isTaskNotificationMessage(message) && !isCompactInjectionMessage(message));
  const title = textPreview(cleanTitleText(userVisibleText(user)), 48);
  return title || null;
}

function cleanTitleText(text) {
  return String(text || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(commandMessageRegex(), "$1")
    .replace(commandNameRegex(), "$1")
    .replace(frameworkReminderRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanStoredSourceLabel(text) {
  const value = String(text || "").trim();
  if (!value || /<system-reminder/i.test(value) || isKnownFrameworkReminderText(value)) return "";
  return textPreview(cleanTitleText(value), 48);
}

function stripFrameworkReminderBlocks(text) {
  return String(text || "").replace(frameworkReminderRegex(), "").trim();
}

function stripDisplayWrapperTags(text) {
  return String(text || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(commandMessageRegex(), "$1")
    .replace(commandNameRegex(), "$1")
    .trim();
}

function userTextAfterLocalCommandBlocks(text) {
  const value = String(text || "");
  if (!/<local-command-|<command-(?:name|message|args)\b/i.test(value)) return "";
  const cleaned = stripFrameworkReminderBlocks(stripLocalCommandGeneratedMarkdown(value))
    .replace(localCommandCaveatRegex(), "")
    .replace(localCommandStdoutRegex(), "")
    .replace(localCommandStderrRegex(), "")
    .replace(commandArgsRegex(), "")
    .replace(commandMessageRegex(), "")
    .replace(commandNameRegex(), "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(stripAnsiRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

function stripLocalCommandGeneratedMarkdown(text) {
  let value = String(text || "");
  if (/<command-name\b[^>]*>\s*\/?context\s*<\/command-name>/i.test(value)) {
    value = value.replace(/(^|\n)## Context Usage[\s\S]*?(?=\n\s*<local-command-caveat\b|\n\s*<command-name\b|$)/gi, "\n");
  }
  return value;
}

function isLocalCommandOnlyText(text) {
  const value = String(text || "");
  if (!/<local-command-|<command-(?:name|message|args)\b/i.test(value)) return false;
  return !userTextAfterLocalCommandBlocks(value);
}

function hasFrameworkReminderBlock(text) {
  return frameworkReminderRegex().test(String(text || ""));
}

function frameworkReminderRegex() {
  return /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
}

function parseCommandMessage(messageOrText) {
  const text =
    typeof messageOrText === "string"
      ? messageOrText
      : messageOrText?.role === "user"
        ? extractContentText(messageOrText.content)
        : "";
  if (!text || !/<command-(?:message|name)\b/i.test(text)) return null;
  const commandName = firstTagValue(text, commandNameRegex());
  const commandMessage = firstTagValue(text, commandMessageRegex());
  const command = normalizeSlashCommand(commandName || commandMessage);
  if (!command) return null;
  const body = text
    .replace(commandMessageRegex(), "")
    .replace(commandNameRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    type: "claude_command",
    command,
    name: commandName ? normalizeSlashCommand(commandName) : command,
    message: commandMessage || command.replace(/^\//, ""),
    body,
    preview: textPreview(body || `Claude Code command ${command}`, 1200),
  };
}

function firstTagValue(text, regex) {
  const match = regex.exec(String(text || ""));
  return match?.[1]?.trim() || "";
}

function commandMessageRegex() {
  return /<command-message\b[^>]*>([\s\S]*?)<\/command-message>/gi;
}

function commandNameRegex() {
  return /<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi;
}

function commandArgsRegex() {
  return /<command-args\b[^>]*>[\s\S]*?<\/command-args>/gi;
}

function localCommandCaveatRegex() {
  return /<local-command-caveat\b[^>]*>[\s\S]*?<\/local-command-caveat>/gi;
}

function localCommandStdoutRegex() {
  return /<local-command-stdout\b[^>]*>[\s\S]*?<\/local-command-stdout>/gi;
}

function localCommandStderrRegex() {
  return /<local-command-stderr\b[^>]*>[\s\S]*?<\/local-command-stderr>/gi;
}

function stripAnsiRegex() {
  return /\x1B\[[0-?]*[ -/]*[@-~]/g;
}

function normalizeSlashCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+/)[0].replace(/^\/+/, "");
  if (!first) return "";
  return `/${first}`;
}

function commandUserVisibleText(commandMessage) {
  const prefix = `Command ${commandMessage.command}`;
  return commandMessage.body ? `${prefix}\n${commandMessage.body}` : prefix;
}

function commandPreviewText(commandMessage) {
  return commandMessage.body ? `${commandMessage.command} · ${commandMessage.body}` : commandMessage.command;
}

function isKnownFrameworkReminderText(text) {
  const value = String(text || "").trimStart();
  if (!/^The user stepped away and is coming back\./i.test(value.slice(0, 80))) return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  return /^The user stepped away and is coming back\. Recap in under 40 words,\s*1-2 plain sentences,\s*no markdown\./i.test(normalized);
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOptionalJson(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function hasCaptureFile(dir) {
  return fs.existsSync(path.join(dir, "proxy-captures.json"));
}

function sourceListStats(dir) {
  if (!hasCaptureFile(dir)) return { request_count: 0, subagent_count: 0, raw_body_bytes: 0 };
  try {
    const captures = readJson(path.join(dir, "proxy-captures.json"));
    const debugSources = readOptionalJson(path.join(dir, "debug-api-sources.json")) || [];
    const requests = captures.map((capture, index) => summarizeCapture(capture, { agent: "", confidence: "unknown", kind: "proxy_capture" }, index, debugSources[index]));
    const workspaces = uniqueValues(captures.map((capture) => capture.workspace || capture.body?.workspace));
    const workspace = workspaces[0] || null;
    return {
      request_count: captures.length,
      subagent_count: requests.filter((request) => request.is_subagent).length,
      raw_body_bytes: requests.reduce((sum, request) => sum + request.counts.raw_body_bytes, 0),
      workspace,
      project: displayProjectName(workspace),
    };
  } catch {
    return { request_count: 0, subagent_count: 0, raw_body_bytes: 0 };
  }
}

function activeWatchSources(watches) {
  if (!watches) return [];
  return [...watches.values()].map((watch) => {
    const captures = capturesForWatch(watch);
    const inferredTitle = captures.map(inferCaptureTitle).find(Boolean);
    const label = cleanStoredSourceLabel(watch.title || watch.label) || textPreview(cleanTitleText(inferredTitle), 48) || watch.label;
    return {
      id: watch.id,
      label,
      user_title: watch.title || null,
      original_label: watch.label,
      agent: watch.agent,
      mode: watch.mode,
      confidence: watch.confidence,
      kind: watch.kind,
      path: watch.base_url,
      available: true,
      live_watch_id: watch.watch_id,
      live_status: watch.status,
      conversation_id: watch.conversation_id,
      provider_id: watch.provider_id,
      config_patched: watch.config_patched,
      note: watch.note,
      request_count: captures.length,
      workspace: watch.workspace,
      created_at: watch.created_at,
      restarted_at: watch.restarted_at || null,
      paused_at: watch.paused_at || null,
      resumed_at: watch.resumed_at || null,
      stopped_at: watch.stopped_at || null,
      last_seen: watch.last_seen || captures.at(-1)?.received_at || watch.restarted_at || watch.created_at,
      skipped_while_paused: Number(watch.skipped_while_paused) || 0,
      response_count: captures.filter((capture) => capture.response).length,
      last_response_seen: watch.last_response_seen || latestCaptureResponseSeen(captures),
      subagent_count: captures.filter((capture) => headerValue(capture.headers, "x-claude-code-agent-id")).length,
      raw_body_bytes: captures.reduce((sum, capture) => sum + (Number(capture.raw_body_length) || byteLength(capture.body)), 0),
    };
  });
}

function latestCaptureResponseSeen(captures) {
  return captures
    .map((capture) => capture.response?.received_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function decorateSources(sources, sourceMeta) {
  return sources
    .map((source, order) => ({ ...decorateSource(source, sourceMetaForSource(sourceMeta, source)), source_order: order }))
    .filter((source) => !source.hidden)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.source_order - b.source_order)
    .map(({ source_order, ...source }) => source);
}

function sourceMetaForSource(sourceMeta, source) {
  return mergedSourceMeta(sourceMeta, sourceMetaKeysForSource(source));
}

function mergedSourceMeta(sourceMeta, keys) {
  return keys.reduce((merged, key) => ({ ...merged, ...(sourceMeta.get(key) || {}) }), {});
}

function setSourceMeta(options, keys, meta) {
  const sanitized = sanitizeSourceMeta(meta);
  for (const key of keys) {
    if (sanitized.hidden || sanitized.pinned || sanitized.title) options.sourceMeta.set(key, sanitized);
    else options.sourceMeta.delete(key);
  }
  if (options.sourceMetaPath) writeSourceMeta(options.sourceMetaPath, options.sourceMeta);
}

function deleteSourceMeta(options, keys) {
  for (const key of keys) options.sourceMeta?.delete(key);
  if (options.sourceMetaPath && options.sourceMeta) writeSourceMeta(options.sourceMetaPath, options.sourceMeta);
}

function sourceMetaKeysForSource(source) {
  const keys = new Set([source?.id].filter(Boolean));
  const watchId = source?.live_watch_id || source?.store_watch_id;
  if (watchId) {
    keys.add(`live-${watchId}`);
    keys.add(sourceIdForWatch(watchId));
  }
  for (const key of stableSourceMetaKeys(source)) keys.add(key);
  return [...keys];
}

function sourceMetaKeysForSourceId(id, { source, liveWatch, persistedSource } = {}) {
  const keys = new Set([id].filter(Boolean));
  const watchId = liveWatch?.watch_id || persistedSource?.store_watch_id || source?.live_watch_id || source?.store_watch_id || watchIdFromSourceId(id) || (String(id || "").startsWith("live-") ? String(id).slice("live-".length) : null);
  if (watchId) {
    keys.add(`live-${watchId}`);
    keys.add(sourceIdForWatch(watchId));
  }
  for (const key of stableSourceMetaKeys(liveWatch || persistedSource || source)) keys.add(key);
  return [...keys];
}

function stableSourceMetaKeys(source) {
  const agent = safePathSegment(source?.agent || "");
  const conversationId = safePathSegment(source?.conversation_id || "");
  if (!agent || !conversationId) return [];
  return [`conversation-${agent}-${conversationId}`];
}

function decorateSource(source, meta = {}) {
  const originalLabel = source.original_label || source.label;
  const workspace = source.workspace || null;
  const userTitle = meta?.title || source.user_title || null;
  const label = userTitle || cleanStoredSourceLabel(source.label) || source.label;
  return {
    ...source,
    original_label: originalLabel,
    label,
    user_title: userTitle,
    pinned: Boolean(meta?.pinned),
    hidden: Boolean(meta?.hidden),
    workspace,
    project: source.project || displayProjectName(workspace),
  };
}

function listActiveWatches(watches) {
  return activeWatchSources(watches).map((source) => ({
    id: source.id,
    watch_id: source.live_watch_id,
    agent: source.agent,
    status: source.live_status,
    base_url: source.path,
    mode: source.mode,
    workspace: source.workspace,
    conversation_id: source.conversation_id,
    provider_id: source.provider_id,
    config_patched: source.config_patched,
    request_count: source.request_count,
    created_at: source.created_at,
    restarted_at: source.restarted_at,
    paused_at: source.paused_at,
    resumed_at: source.resumed_at,
    stopped_at: source.stopped_at,
    last_seen: source.last_seen,
    skipped_while_paused: source.skipped_while_paused,
  }));
}

function listWatchStatus({ watches, store }) {
  const active = listActiveWatches(watches);
  const activeWatchIds = new Set(active.map((watch) => watch.watch_id));
  const persisted = store
    ? store
        .listSources()
        .filter((source) => !activeWatchIds.has(source.store_watch_id))
        .map((source) => ({
          id: `live-${source.store_watch_id}`,
          watch_id: source.store_watch_id,
          agent: source.agent,
          status: source.live_status || "stored",
          base_url: null,
          mode: source.mode,
          workspace: source.workspace,
          conversation_id: source.conversation_id,
          provider_id: null,
          config_patched: false,
          request_count: source.request_count,
          created_at: source.created_at,
          restarted_at: null,
          paused_at: null,
          resumed_at: null,
          stopped_at: null,
          last_seen: source.last_seen,
          skipped_while_paused: Number(source.skipped_while_paused) || 0,
          persisted: true,
        }))
    : [];
  return [...active, ...persisted];
}

function liveStatusLabel(status) {
  if (status === "watching") return "监听中";
  if (status === "paused") return "已暂停";
  if (status === "stopped") return "已停止";
  return status || "历史记录";
}

function liveWatchCommand(watch) {
  return {
    generated_at: watch.created_at,
    cwd: watch.workspace,
    watch_id: watch.watch_id,
    conversation_id: watch.conversation_id,
    provider_id: watch.provider_id,
    config_patched: watch.config_patched,
    started_by: watch.started_by,
    mode: watch.mode,
    agent: watch.agent,
    proxy_base_url: watch.base_url,
    target_base_url: watch.target_base_url,
  };
}

function resolveTargetBaseUrl(agent, cwd = defaultWorkspace()) {
  if (/claude/i.test(agent)) return resolveClaudeCodeTargetBaseUrl({ cwd, env: process.env });
  if (/openclaw/i.test(agent)) {
    return process.env.PEEK_OPENCLAW_TARGET_BASE_URL || process.env.OPENCLAW_BASE_URL || process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || null;
  }
  return process.env.PEEK_AGENT_TARGET_BASE_URL || process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || null;
}

function modeLabel(mode) {
  const labels = {
    next_request: "看下一次请求",
    single_session: "监控一个会话",
    privacy_guard: "检查敏感信息",
  };
  return labels[mode] || mode;
}

function watchInstructions(watch) {
  if (/claude/i.test(watch.agent)) {
    return [
      `ANTHROPIC_BASE_URL=${watch.base_url}`,
      "然后在同一个项目目录里运行 Claude Code。捕获到请求后，左侧实时 watch 会出现请求数量。",
    ];
  }
  return [
    `把 ${watch.agent} 的 provider/base URL 临时设置为：${watch.base_url}`,
    "之后运行一次 Agent 任务。捕获到请求后，左侧实时 watch 会出现请求数量。",
  ];
}

function slugify(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "agent";
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonBody(req, { maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  const contentType = headerValue(req.headers || {}, "content-type");
  if (contentType && !/^application\/(?:json|[^;]+\+json)\b/i.test(contentType)) {
    throw httpError(415, "Expected application/json request body.");
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(httpError(413, `JSON request body is too large. Limit is ${formatBytes(maxBytes)}.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, { maxBytes = MAX_TRACE_IMPORT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(httpError(413, `Request body is too large. Limit is ${formatBytes(maxBytes)}.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validateLocalHttpRequest(req, url, { unsafeAllowRemote = false } = {}) {
  if (!url.pathname.startsWith("/api/")) return null;
  const hostHeader = headerValue(req.headers || {}, "host");
  const host = hostNameFromHeader(hostHeader);
  if (host && !unsafeAllowRemote && !isLoopbackHost(host)) {
    return { status: 403, message: "peekMyAgent dashboard only accepts loopback Host headers by default." };
  }
  const origin = headerValue(req.headers || {}, "origin");
  if (origin) {
    const originGuard = validateBrowserSourceHeader(origin, hostHeader, { unsafeAllowRemote, headerName: "Origin" });
    if (originGuard) return originGuard;
  }
  const referer = headerValue(req.headers || {}, "referer");
  if (referer) {
    const refererGuard = validateBrowserSourceHeader(referer, hostHeader, { unsafeAllowRemote, headerName: "Referer" });
    if (refererGuard) return refererGuard;
  }
  const secFetchSite = headerValue(req.headers || {}, "sec-fetch-site").toLowerCase();
  if (secFetchSite === "cross-site") {
    return { status: 403, message: "Cross-site browser requests are not allowed." };
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(String(req.method || "").toUpperCase())) {
    const contentType = headerValue(req.headers || {}, "content-type");
    const acceptsBodylessJson = url.pathname === "/api/daemon/shutdown" && !contentType;
    const isJson = /^application\/(?:json|[^;]+\+json)\b/i.test(contentType);
    const isTraceImport = url.pathname === "/api/trace/import" && /^(application\/(?:octet-stream|gzip|json)|[^;]+\/[^;]+\+json)\b/i.test(contentType);
    if (!acceptsBodylessJson && !isJson && !isTraceImport) {
      return { status: 415, message: "State-changing API calls require application/json or an accepted trace import content type." };
    }
  }
  return null;
}

function validateBrowserSourceHeader(value, hostHeader, { unsafeAllowRemote = false, headerName = "Origin" } = {}) {
  if (unsafeAllowRemote) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { status: 403, message: `Invalid ${headerName} header.` };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { status: 403, message: "Cross-site browser requests are not allowed." };
  }
  if (!browserSourceMatchesHost(parsed, hostHeader)) {
    return { status: 403, message: "Browser API requests must come from the active peekMyAgent dashboard origin." };
  }
  return null;
}

function browserSourceMatchesHost(parsedSource, hostHeader) {
  const request = hostParts(hostHeader);
  if (!request.hostname) return false;
  if (parsedSource.protocol !== "http:") return false;
  if (!isLoopbackHost(request.hostname) || !isLoopbackHost(parsedSource.hostname)) return false;
  return normalizedPort(parsedSource.protocol, parsedSource.port) === request.port;
}

function hostParts(value) {
  const text = String(value || "").trim();
  if (!text) return { hostname: "", port: "" };
  try {
    const parsed = new URL(`http://${text}`);
    return { hostname: parsed.hostname, port: normalizedPort(parsed.protocol, parsed.port) };
  } catch {
    return { hostname: hostNameFromHeader(text), port: "" };
  }
}

function normalizedPort(protocol, port) {
  if (port) return String(port);
  if (protocol === "https:") return "443";
  return "80";
}

function assertSafeBindHost(host, { unsafeAllowRemote = false } = {}) {
  const normalized = String(host || "").trim();
  if (!normalized || isLoopbackHost(normalized) || unsafeAllowRemote || process.env.PEEKMYAGENT_UNSAFE_ALLOW_REMOTE === "1") return;
  throw new Error(`Refusing to bind peekMyAgent to non-loopback host ${normalized}. Use PEEKMYAGENT_UNSAFE_ALLOW_REMOTE=1 only on trusted networks.`);
}

function hostNameFromHeader(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("[")) return text.slice(1, text.indexOf("]"));
  return text.split(":")[0];
}

function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase();
  if (!value) return false;
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "0:0:0:0:0:0:0:1";
}

function normalizePathBackedLabel(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, `${fieldName} is required.`);
  if (/[\/\\\x00-\x1F]/.test(text) || text.includes("..")) {
    throw httpError(400, `${fieldName} contains unsafe path characters.`);
  }
  return text.slice(0, 80);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function displayProjectName(workspace) {
  if (!workspace) return "未归属项目";
  const normalized = String(workspace).replace(/\/$/, "");
  return path.basename(normalized) || normalized;
}

function shortenId(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function captureLabel(source) {
  if (source.confidence === "exact" && source.kind === "proxy_capture") return "exact proxy capture";
  if (source.kind === "otel_raw_body") return "otel raw body";
  if (source.kind === "official_debug") return "official debug timeline";
  if (source.kind === "imported_history") return "imported history";
  if (source.kind === "imported_trace") return "imported trace";
  return source.confidence || "unknown";
}

function inferWatchMode(source, requests) {
  if (source.mode) return modeLabel(source.mode);
  if (source.id?.includes("resume") || source.id?.includes("multiturn")) return "监控一个会话";
  if (source.id?.includes("subagent")) return "监控一个会话";
  if (requests.length <= 1) return "看下一次请求";
  return "打开证据包";
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address());
    });
  });
}

function serveFile(res, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { ...viewerSecurityHeaders(), "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function writeJson(res, status, value) {
  res.writeHead(status, { ...viewerSecurityHeaders(), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function viewerSecurityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

export function defaultWorkspace() {
  return safeProcessCwd({ fallback: userHome() || os.tmpdir() });
}
