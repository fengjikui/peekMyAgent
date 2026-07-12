#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { translationsDir } from "../src/core/app-paths.mjs";
import { translationMaterialHash } from "../src/translation/hash.mjs";
import { MAX_TRANSLATION_CONCURRENCY, TranslationService } from "../src/translation/service.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-translation-service-"));
const originalStateDir = process.env.PEEKMYAGENT_STATE_DIR;
process.env.PEEKMYAGENT_STATE_DIR = root;
const fixedDate = new Date("2026-07-12T09:00:00.000Z");
const materialHash = translationMaterialHash("thinking", "Translate this block.");
const materials = [
  {
    id: `thinking:${materialHash.slice(0, 16)}`,
    hash: materialHash,
    kind: "thinking",
    source_language: "en",
    target_language: "ja-JP",
    text_chars: 21,
    source_text: "Translate this block.",
    metadata: {},
    occurrences: [{ source_id: "source-a", request_id: "request-a" }],
    occurrence_count: 1,
  },
];
const calls = [];
const service = new TranslationService({
  projectRoot: process.cwd(),
  materialProvider: {
    fromInput(input) {
      assert.equal(input.targetLanguage, "ja-JP");
      return { materials, sourceCount: 1 };
    },
    fromSource(input) {
      return { materials: materials.map((item) => ({ ...item, target_language: input.targetLanguage })), sourceCount: 1 };
    },
  },
  sanitize: {
    agent: (value) => clean(value || "Claude Code", "Claude Code"),
    targetLanguage(value) {
      const text = clean(value);
      if (!text || /[\/\\]/.test(text) || text.includes("..")) throw Object.assign(new Error("unsafe target_language"), { statusCode: 400 });
      return text;
    },
    sourceId: (value) => clean(value),
    section: (value) => clean(value),
    requestId: (value) => clean(value),
  },
  slugify(value) {
    return clean(value, "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  },
  async runScript(script, args) {
    calls.push({ script, args });
    if (script.endsWith("translate-materials-zh.mjs")) {
      const agent = option(args, "--agent");
      const language = option(args, "--target-language");
      const dir = translationsDir(agent, language);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${language}.json`),
        JSON.stringify({ version: 1, target_language: language, generated_at: fixedDate.toISOString(), provider: { type: "fake" }, entries: { [materialHash]: { translated_text: "翻訳" } } }),
      );
    }
    return { stdout: JSON.stringify({ cache_path: "/private/cache", materials_path: "/private/materials", manifest_path: "/private/manifest", translated: 1 }) };
  },
  clock: () => fixedDate,
});

try {
  const generated = await service.generate({
    agent: "Claude Code",
    target_language: "ja-JP",
    concurrency: 999,
    source_id: "source-a",
    request_id: "request-a",
    force: true,
    materials: [{ kind: "thinking", source_text: "Translate this block." }],
  });
  assert.equal(calls.length, 1, "manual materials skip the offline extraction script");
  assert.equal(calls[0].script, "scripts/translate-materials-zh.mjs");
  assert.equal(option(calls[0].args, "--concurrency"), String(MAX_TRANSLATION_CONCURRENCY));
  assert.equal(option(calls[0].args, "--force-hashes"), materialHash);
  assert.equal(generated.cache.available, true);
  assert.equal(generated.cache.entry_count, 1);
  assert.equal(Object.hasOwn(generated.cache, "entries"), false, "generate response reports cache status without returning all entries");
  assert.equal(JSON.stringify(generated).includes("/private/"), false, "public response hides cache/material/manifest paths");

  const manifestPath = path.join(translationsDir("Claude Code", "ja-JP"), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.generated_at, fixedDate.toISOString());
  assert.equal(manifest.material_hashes[0], materialHash);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(path.dirname(manifestPath), "materials.jsonl")).mode & 0o777, 0o600);
  }

  const aliasDir = translationsDir("claude-code", "zh-CN");
  fs.mkdirSync(aliasDir, { recursive: true });
  fs.writeFileSync(path.join(aliasDir, "zh-CN.json"), JSON.stringify({ target_language: "zh-CN", entries: { cached: { translated_text: "已缓存" } } }));
  const aliasCache = service.loadPublicCache({ agent: "Anthropic CC", targetLanguage: "zh-CN" });
  assert.equal(aliasCache.available, true);
  assert.equal(aliasCache.cache_slug, "claude-code");
  assert.equal(aliasCache.entries.cached.translated_text, "已缓存");
  assert.equal(Object.hasOwn(aliasCache, "cache_path"), false);

  await assert.rejects(() => service.generate({ target_language: "../unsafe", materials: [{ source_text: "unsafe" }] }), (error) => error.statusCode === 400);

  console.log("translation service contract smoke passed");
} finally {
  if (originalStateDir == null) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = originalStateDir;
  fs.rmSync(root, { recursive: true, force: true });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function clean(value, fallback = "") {
  const text = String(value || fallback).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return text || fallback;
}
