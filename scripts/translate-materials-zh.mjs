import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  codexCliCandidates,
  codexModelsCachePath,
  translationsDir,
} from "../src/core/app-paths.mjs";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import {
  formatTranslationSourceBlock,
  parseTranslationMarkerBlocks as parseMarkerTranslations,
  sanitizeTranslationOutput,
  translationResponseFormatInstruction,
} from "../src/translation/blocks.mjs";
import { sha256Text } from "../src/translation/hash.mjs";
import {
  resolveTranslationProtocol,
  selectCodexTranslationModel,
} from "../src/translation/provider-policy.mjs";

const args = process.argv.slice(2);
const MAX_TRANSLATION_CONCURRENCY = 100;
const targetLanguage = optionValue("--target-language") || "zh-CN";
const agent = optionValue("--agent") || "Claude Code";
const materialsPath =
  optionValue("--materials") ||
  path.join(translationsDir(agent, targetLanguage), "materials.jsonl");
const cachePath =
  optionValue("--cache") ||
  path.join(path.dirname(materialsPath), `${targetLanguage}.json`);
const limit = nonNegativeNumber(optionValue("--limit"), 0);
const batchChars = positiveNumber(optionValue("--batch-chars"), 9000);
const chunkChars = positiveNumber(optionValue("--chunk-chars"), 6000);
const splitChars = positiveNumber(optionValue("--split-chars"), 12000);
const maxTokens = positiveNumber(optionValue("--max-tokens"), 8192);
const requestTimeoutMs = positiveNumber(optionValue("--request-timeout-ms"), 300000);
const requestedConcurrency = boundedPositiveInteger(optionValue("--concurrency"), 8, MAX_TRANSLATION_CONCURRENCY);
const retries = nonNegativeNumber(optionValue("--retries"), 2);
const dryRun = hasFlag("--dry-run");
const noSplit = hasFlag("--no-split");
const kinds = new Set((optionValue("--kind") || "").split(",").map((item) => item.trim()).filter(Boolean));
const forceHashes = new Set((optionValue("--force-hashes") || "").split(",").map((item) => item.trim()).filter(Boolean));

const materials = readJsonl(materialsPath);
const cache = readJson(cachePath) || {
  version: 1,
  target_language: targetLanguage,
  generated_at: null,
  provider: null,
  entries: {},
};

const pending = materials
  .filter((item) => !kinds.size || kinds.has(item.kind))
  .filter((item) => item.source_text && (forceHashes.has(item.hash) || !cache.entries[item.hash]))
  .slice(0, limit > 0 ? limit : undefined);
const jobs = createTranslationJobs(pending);

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        materials_path: materialsPath,
        cache_path: cachePath,
        total_materials: materials.length,
        cached: Object.keys(cache.entries || {}).length,
        pending: pending.length,
        pending_chars: pending.reduce((sum, item) => sum + item.source_text.length, 0),
        jobs: jobs.length,
        split_jobs: jobs.filter((job) => job.type === "split").length,
        force_hashes: forceHashes.size,
        concurrency: requestedConcurrency,
        split_chars: noSplit ? null : splitChars,
        chunk_chars: noSplit ? null : chunkChars,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!pending.length) {
  console.log(JSON.stringify({ materials_path: materialsPath, cache_path: cachePath, translated: 0, pending: 0, concurrency: requestedConcurrency }, null, 2));
  process.exit(0);
}

const client = createTranslationClient();
const concurrency = Math.min(requestedConcurrency, client.maxConcurrency || requestedConcurrency);
cache.provider = translationProviderMetadata(client);

let translated = 0;
let completedJobs = 0;
const failures = [];
await runPool(jobs, concurrency, async (job) => {
  const entries = await withRetries(() => translateJob(client, job, targetLanguage), retries, jobLabel(job));
  for (const entry of entries) {
    cache.entries[entry.hash] = entry;
    translated += 1;
  }
  completedJobs += 1;
  cache.provider = translationProviderMetadata(client);
  writeCache(cachePath, cache);
  console.error(`[translations] ${completedJobs}/${jobs.length} jobs complete, ${translated} material(s) cached`);
}, failures);

const remaining = materials.filter((item) => !cache.entries[item.hash]).length;
const output = {
  materials_path: materialsPath,
  cache_path: cachePath,
  translated,
  cached: Object.keys(cache.entries || {}).length,
  remaining,
  failed_jobs: failures.length,
  concurrency,
  requested_concurrency: requestedConcurrency,
};
console.log(JSON.stringify(output, null, 2));
if (failures.length) {
  for (const failure of failures) console.error(`[translations] failed ${failure.label}: ${failure.error}`);
  // Only a total failure (nothing translated at all) is fatal. Partial progress
  // is success: the cache holds what worked and `remaining`/`failed_jobs` report
  // the rest, so the dashboard shows Chinese for everything that translated and
  // simply leaves the unfinished blocks in their source language.
  if (translated === 0) process.exitCode = 1;
}

async function translateJob(client, job, language) {
  if (job.type === "split") return [await translateSplitMaterial(client, job.item, language)];
  const result = await translateBatch(client, job.items, language);
  return result.map((item) => {
    const original = job.items.find((entry) => entry.hash === item.hash);
    return cacheEntryForMaterial(original, item.translated_text, { provider: client.protocol });
  });
}

async function translateSplitMaterial(client, item, language) {
  const chunks = splitMaterialIntoChunks(item, chunkChars);
  const translations = [];
  for (const chunkBatch of chunkByChars(chunks, Math.max(chunkChars + 800, batchChars))) {
    const batchResult = await translateBatch(client, chunkBatch, language);
    translations.push(...batchResult);
  }
  const translatedByHash = new Map(translations.map((entry) => [entry.hash, entry.translated_text]));
  const missing = chunks.filter((chunk) => !translatedByHash.has(chunk.hash));
  if (missing.length) throw new Error(`Split material ${item.hash} missed ${missing.length} chunk(s).`);
  const translatedText = chunks.map((chunk) => translatedByHash.get(chunk.hash)).join("\n\n").trim();
  return cacheEntryForMaterial(item, translatedText, {
    provider: client.protocol,
    chunked: true,
    splitter_version: "markdown-boundary-v1",
    chunk_count: chunks.length,
    chunks: chunks.map((chunk) => ({
      hash: chunk.hash,
      index: chunk.metadata.chunk_index,
      source_chars: chunk.source_text.length,
      translated_chars: String(translatedByHash.get(chunk.hash) || "").length,
    })),
  });
}

async function translateBatch(client, batch, language) {
  const requestItems = batch.map((item) => ({
    hash: item.hash,
    kind: item.kind,
    metadata: item.metadata,
    source_text: item.source_text,
  }));
  const targetLanguageName = targetLanguageDisplayName(language);
  const prompt = `Translate the following agent system prompt and tool-description materials into ${targetLanguageName} (${language}).

Requirements:
- Preserve code blocks, XML/HTML tags, placeholders, command names, option names, JSON keys, tool names, file paths, and environment variable names exactly.
- Preserve Markdown structure exactly where practical: headings stay headings, bullet/numbered list items stay list items, blank-line paragraph breaks stay paragraph breaks, and code fences keep their opening/closing fences.
- Before returning, self-check the translated text for formatting damage. In particular, never turn a line-start list marker like "- item" into "n- item", "\\n- item", "。- item", or inline prose; keep it as a proper list line.
- Translate explanatory prose naturally for a technical reader of ${targetLanguageName}.
- Do not summarize or omit constraints.
- If the material is a chunk, translate only that chunk and do not add continuity notes.
- The \`kind:\` and \`metadata:\` lines inside each @@PEEK_SOURCE block are routing context only. Do not translate, copy, or mention them.
- Each translated block body must contain only the translation of that source block's \`source_text\`; never prefix it with \`kind:\`, \`metadata:\`, the hash, or commentary.
- Return one translated block for each input item, using exactly this format:
${translationResponseFormatInstruction()}
- Do not include markdown fences, comments, JSON, or extra prose outside those blocks.

Materials:
${requestItems.map(formatTranslationSourceBlock).join("\n\n")}`;

  const data = await client.request({ prompt, maxTokens });
  const contentText = extractText(data);
  const translations = parseMarkerTranslations(contentText, { required: true });
  return reconcileBatchTranslations(batch, translations);
}

function targetLanguageDisplayName(language) {
  const normalized = String(language || "").trim();
  const names = {
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    "zh-Hans": "Simplified Chinese",
    "zh-Hant": "Traditional Chinese",
    "en-US": "English",
    "en-GB": "English",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "fr-FR": "French",
    "de-DE": "German",
    "es-ES": "Spanish",
    "pt-BR": "Brazilian Portuguese",
  };
  if (names[normalized]) return names[normalized];
  try {
    const displayName = new Intl.DisplayNames(["en"], { type: "language" }).of(normalized);
    if (displayName && displayName !== normalized) return displayName;
  } catch {}
  try {
    const primary = normalized.split("-")[0];
    const displayName = primary ? new Intl.DisplayNames(["en"], { type: "language" }).of(primary) : "";
    if (displayName && displayName !== primary) return displayName;
  } catch {}
  return normalized || "the target language";
}

function createTranslationJobs(items) {
  const output = [];
  let current = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    output.push({ type: "batch", items: current });
    current = [];
    size = 0;
  };
  for (const item of items) {
    if (shouldSplitMaterial(item)) {
      flush();
      output.push({ type: "split", item });
      continue;
    }
    const itemSize = item.source_text.length + JSON.stringify(item.metadata || {}).length + 200;
    if (current.length && size + itemSize > batchChars) flush();
    current.push(item);
    size += itemSize;
  }
  flush();
  return output;
}

function shouldSplitMaterial(item) {
  return !noSplit && item?.source_text && item.source_text.length >= splitChars;
}

function splitMaterialIntoChunks(item, maxChars) {
  const chunks = splitMarkdownLikeText(item.source_text, maxChars);
  return chunks.map((sourceText, index) => ({
    ...item,
    id: `${item.id || item.hash}:chunk:${index + 1}`,
    hash: sha256Text(`${item.hash}\0chunk\0${index + 1}\0${sourceText}`),
    source_text: sourceText,
    text_chars: sourceText.length,
    metadata: {
      ...(item.metadata || {}),
      parent_hash: item.hash,
      chunk_index: index + 1,
      chunk_count: chunks.length,
      splitter_version: "markdown-boundary-v1",
    },
  }));
}

function splitMarkdownLikeText(text, maxChars) {
  const units = markdownUnits(text);
  const chunks = [];
  let current = "";
  for (const unit of units.flatMap((entry) => (entry.length > maxChars ? splitLargeUnit(entry, maxChars) : [entry]))) {
    if (current && current.length + unit.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    current = current ? `${current}\n\n${unit}` : unit;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

function markdownUnits(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const units = [];
  let current = [];
  let inFence = false;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) units.push(value);
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const fence = /^(```|~~~)/.test(trimmed);
    if (!inFence && /^#{1,6}\s+/.test(trimmed) && current.length) flush();
    current.push(line);
    if (fence) inFence = !inFence;
    if (!inFence && !trimmed) flush();
  }
  flush();
  return units;
}

function splitLargeUnit(text, maxChars) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    if (line.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      for (let index = 0; index < line.length; index += maxChars) chunks.push(line.slice(index, index + maxChars));
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function cacheEntryForMaterial(original, translatedText, extra = {}) {
  return {
    hash: original.hash,
    kind: original.kind,
    source_language: original.source_language,
    target_language: targetLanguage,
    translated_text: sanitizeTranslationOutput(original.kind, translatedText),
    notes: "",
    source_chars: original.source_text.length,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

function createTranslationClient() {
  const protocol = resolveTranslationProtocol({ agent, env: process.env });
  if (protocol === "openai") return createOpenAiCompatibleClient();
  if (protocol === "anthropic") return createAnthropicCompatibleClient();
  if (protocol === "claude-cli") return createClaudeCliClient();
  if (protocol === "codex-cli") return createCodexCliClient();
  throw new Error(`Unsupported translation protocol: ${protocol}`);
}

function createClaudeCliClient() {
  const command = process.env.PEEKMYAGENT_TRANSLATION_CLAUDE_BIN || "claude";
  const model = process.env.PEEKMYAGENT_TRANSLATION_CLAUDE_MODEL || process.env.PEEKMYAGENT_TRANSLATION_MODEL || null;
  const reasoningEffort = process.env.PEEKMYAGENT_TRANSLATION_CLAUDE_EFFORT || "low";
  return {
    protocol: "claude-cli",
    baseUrl: `local:${command}`,
    model: model || "subscription-default-low",
    modelSource: model ? "explicit" : "claude-default",
    reasoningEffort,
    maxConcurrency: 2,
    async request({ prompt }) {
      return withTemporaryDirectory("peek-translation-claude-", async (workingDirectory) => {
        const args = [
          "-p",
          "--output-format",
          "text",
          "--no-session-persistence",
          "--tools",
          "",
          "--permission-mode",
          "dontAsk",
          "--effort",
          reasoningEffort,
          "--disable-slash-commands",
          "--no-chrome",
        ];
        if (model) args.push("--model", model);
        const result = await runCliCommand(command, args, {
          input: prompt,
          cwd: workingDirectory,
          label: "claude CLI",
        });
        return { content: result.stdout };
      });
    },
  };
}

function createCodexCliClient() {
  const command = resolveCodexCommand();
  const modelCatalog = readJsonSafely(codexModelsCachePath());
  const modelChoice = selectCodexTranslationModel({ modelCatalog, env: process.env });
  const reasoningEffort = normalizeCodexReasoningEffort(process.env.PEEKMYAGENT_TRANSLATION_CODEX_REASONING_EFFORT);
  let selectedModel = modelChoice.model;
  const client = {
    protocol: "codex-cli",
    baseUrl: `local:${command}`,
    model: selectedModel,
    modelSource: modelChoice.source,
    reasoningEffort,
    maxConcurrency: 2,
    async request({ prompt }) {
      const attemptedModel = selectedModel;
      try {
        const content = await runCodexCli(command, prompt, {
          model: attemptedModel,
          reasoningEffort,
        });
        return { content };
      } catch (error) {
        if (!attemptedModel || !modelChoice.allowDefaultFallback || !isCodexModelSelectionError(error)) throw error;
        console.error(`[translations] Codex fast model ${attemptedModel} is unavailable; retrying with the Codex built-in default at ${reasoningEffort} effort.`);
        selectedModel = null;
        client.model = "codex-default-low";
        client.modelSource = "codex-default-fallback";
        const content = await runCodexCli(command, prompt, {
          model: null,
          reasoningEffort,
        });
        return { content };
      }
    },
  };
  return client;
}

async function runCodexCli(command, prompt, { model, reasoningEffort }) {
  return withTemporaryDirectory("peek-translation-codex-", async (workingDirectory) => {
    const outputPath = path.join(workingDirectory, "last-message.txt");
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-C",
      workingDirectory,
      "-c",
      `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      "--output-last-message",
      outputPath,
    ];
    if (model) args.push("--model", model);
    args.push("-");
    await runCliCommand(command, args, {
      input: prompt,
      cwd: workingDirectory,
      label: "codex CLI",
    });
    const output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
    if (!output) throw new Error("codex CLI translation completed without a final response.");
    return output;
  });
}

function runCliCommand(command, args, { input = "", cwd, label }) {
  return new Promise((resolve, reject) => {
    const spawnConfig = childProcessSpawnConfig(command, args, { env: process.env });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      ...spawnConfig.options,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error(`${label} translation timed out after ${requestTimeoutMs}ms`));
    }, requestTimeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      fail(new Error(`${label} failed to start (${command}): ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${label} translation exited ${code}: ${stderr.slice(0, 1000)}`));
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") fail(new Error(`${label} input failed: ${error.message}`));
    });
    child.stdin.end(input);
  });
}

function resolveCodexCommand() {
  const candidates = codexCliCandidates({ env: process.env, platform: process.platform });
  for (const candidate of candidates) {
    if (!isPathLike(candidate) || fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || "codex";
}

function isPathLike(value) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function normalizeCodexReasoningEffort(value) {
  const normalized = String(value || "low").trim().toLowerCase();
  return ["low", "medium", "high", "xhigh", "max", "ultra"].includes(normalized) ? normalized : "low";
}

function isCodexModelSelectionError(error) {
  return /model[\s\S]{0,160}(?:not exist|not available|not found|no access|have access|requires a newer|unsupported|unknown|invalid)/i.test(String(error?.message || error));
}

async function withTemporaryDirectory(prefix, operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function translationProviderMetadata(client) {
  return Object.fromEntries(Object.entries({
    type: client.protocol,
    base_url: client.baseUrl,
    model: client.model,
    model_source: client.modelSource,
    reasoning_effort: client.reasoningEffort,
  }).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function readJsonSafely(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function createAnthropicCompatibleClient() {
  const baseUrl = process.env.PEEKMYAGENT_TRANSLATION_BASE_URL || process.env.ANTHROPIC_BASE_URL;
  const token = process.env.PEEKMYAGENT_TRANSLATION_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const model = normalizeModelName(process.env.PEEKMYAGENT_TRANSLATION_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929");
  if (!baseUrl) throw new Error("PEEKMYAGENT_TRANSLATION_BASE_URL or ANTHROPIC_BASE_URL is required for translation.");
  if (!token) throw new Error("PEEKMYAGENT_TRANSLATION_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY is required for translation.");
  const trimmed = baseUrl.replace(/\/$/, "");
  const messagesUrl = /\/v1\/messages$/.test(trimmed) ? trimmed : `${trimmed}/v1/messages`;
  return {
    protocol: "anthropic",
    baseUrl: trimmed,
    model,
    async request({ prompt, maxTokens: requestMaxTokens }) {
      const response = await requestJson(messagesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": token,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: requestMaxTokens,
          temperature: 0.1,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      return response;
    },
  };
}

function createOpenAiCompatibleClient() {
  const baseUrl = process.env.PEEKMYAGENT_TRANSLATION_BASE_URL || process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL;
  const token = process.env.PEEKMYAGENT_TRANSLATION_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
  const model = normalizeModelName(process.env.PEEKMYAGENT_TRANSLATION_MODEL || process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat");
  if (!baseUrl) throw new Error("PEEKMYAGENT_TRANSLATION_BASE_URL, OPENAI_BASE_URL, or DEEPSEEK_BASE_URL is required for OpenAI-compatible translation.");
  if (!token) throw new Error("PEEKMYAGENT_TRANSLATION_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY is required for OpenAI-compatible translation.");
  const trimmed = baseUrl.replace(/\/$/, "");
  const chatUrl = /\/v1\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/v1/chat/completions`;
  return {
    protocol: "openai",
    baseUrl: trimmed,
    model,
    async request({ prompt, maxTokens: requestMaxTokens }) {
      return requestJson(chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: requestMaxTokens,
          temperature: 0.1,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    },
  };
}

async function requestJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`Translation request failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function extractText(data) {
  if (typeof data?.content === "string") return data.content;
  if (Array.isArray(data?.content)) return data.content.map((part) => part?.text || "").join("\n").trim();
  if (typeof data?.choices?.[0]?.message?.content === "string") return data.choices[0].message.content;
  throw new Error("Could not find text content in translation response.");
}

// Tolerant reconciliation: keep every block the model translated cleanly and
// drop the ones it missed or left empty, instead of throwing away the whole
// batch. Dropped blocks stay untranslated (the display layer falls back to the
// source text), so a single bad block can't sink a large system-prompt batch.
// If the batch produced nothing usable at all we still throw, so retries can
// kick in; once retries are exhausted that job fails in isolation and its blocks
// fall back to source — the rest of the translation is unaffected.
function reconcileBatchTranslations(batch, translations) {
  const translatedByHash = new Map(translations.map((item) => [item.hash, item]));
  const valid = [];
  const missing = [];
  const empty = [];
  for (const item of batch) {
    const translated = translatedByHash.get(item.hash);
    if (!translated) {
      missing.push(item.hash);
      continue;
    }
    if (!String(translated.translated_text || "").trim()) {
      empty.push(item.hash);
      continue;
    }
    valid.push(translated);
  }
  if (!valid.length && batch.length) {
    throw new Error(`Translation batch produced no usable blocks (${missing.length} missing, ${empty.length} empty).`);
  }
  if (missing.length || empty.length) {
    console.error(`[translations] partial batch: ${valid.length} ok, ${missing.length} missing, ${empty.length} empty (left as source text)`);
  }
  return valid;
}

function chunkByChars(items, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const itemSize = item.source_text.length + JSON.stringify(item.metadata || {}).length + 200;
    if (current.length && size + itemSize > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function runPool(items, size, worker, failures) {
  let next = 0;
  const workerCount = Math.max(1, Math.min(size, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        try {
          await worker(item);
        } catch (error) {
          failures.push({ label: jobLabel(item), error: error?.message || String(error) });
        }
      }
    }),
  );
}

async function withRetries(operation, retryCount, label) {
  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) break;
      const delayMs = 500 * 2 ** attempt;
      console.error(`[translations] retry ${attempt + 1}/${retryCount} for ${label}: ${error.message}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function writeCache(filePath, value) {
  value.generated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function jobLabel(job) {
  if (job.type === "split") return `split:${job.item.kind}:${job.item.hash.slice(0, 12)}`;
  return `batch:${job.items.length}:${job.items[0]?.hash?.slice(0, 12) || "empty"}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Materials file not found: ${filePath}`);
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function hasFlag(name) {
  return args.includes(name);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boundedPositiveInteger(value, fallback, max) {
  const number = Number(value);
  const normalized = Number.isInteger(number) && number > 0 ? number : fallback;
  return Math.min(normalized, max);
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function slugify(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeModelName(value) {
  return String(value || "").replace(/\[[^\]]+\]$/, "");
}
