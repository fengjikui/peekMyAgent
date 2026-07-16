import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { safePathSegment, translationsDir } from "../core/app-paths.mjs";
import { childProcessSpawnConfig } from "../core/platform.mjs";
import { countTranslationMaterialsByKind } from "./materials.mjs";

export const MAX_TRANSLATION_CONCURRENCY = 100;

export class TranslationService {
  constructor({ projectRoot, materialProvider, sanitize, slugify, runScript, clock } = {}) {
    this.projectRoot = requiredText(projectRoot, "projectRoot");
    this.materialProvider = requiredObject(materialProvider, "materialProvider");
    this.sanitize = requiredObject(sanitize, "sanitize");
    this.slugify = requiredFunction(slugify, "slugify");
    this.runScript = typeof runScript === "function" ? runScript : (script, args) => runNodeScript(this.projectRoot, script, args);
    this.clock = typeof clock === "function" ? clock : () => new Date();
  }

  async generate(input = {}) {
    const options = this.sanitizeInput(input);
    const inputMaterials = Array.isArray(input.materials) ? input.materials : [];
    let extract;
    if (inputMaterials.length) {
      const prepared = this.materialProvider.fromInput({
        materials: inputMaterials,
        sourceId: options.sourceId,
        requestId: options.requestId,
        targetLanguage: options.targetLanguage,
      });
      extract = this.writeMaterials({ ...prepared, sourceId: options.sourceId, agent: options.agent, targetLanguage: options.targetLanguage });
    } else if (options.sourceId) {
      const prepared = this.materialProvider.fromSource({
        sourceId: options.sourceId,
        requestId: options.requestId,
        section: options.section,
        targetLanguage: options.targetLanguage,
      });
      extract = this.writeMaterials({ ...prepared, sourceId: options.sourceId, agent: options.agent, targetLanguage: options.targetLanguage });
    } else {
      const extracted = await this.runScript("scripts/extract-translation-materials.mjs", [
        "--agent",
        options.agent,
        "--target-language",
        options.targetLanguage,
      ]);
      extract = parseJsonCommandOutput(extracted.stdout);
    }

    const translateArgs = [
      "--agent",
      options.agent,
      "--target-language",
      options.targetLanguage,
      "--concurrency",
      String(options.concurrency),
    ];
    if (options.force && extract?.material_hashes?.length) translateArgs.push("--force-hashes", extract.material_hashes.join(","));
    const translated = await this.runScript("scripts/translate-materials-zh.mjs", translateArgs);
    const translateResult = parseJsonCommandOutput(translated.stdout);
    return {
      ok: true,
      agent: options.agent,
      target_language: options.targetLanguage,
      extract: publicTranslationCommandResult(extract),
      translate: publicTranslationCommandResult(translateResult),
      cache: publicTranslationCache(this.loadCache({ agent: options.agent, targetLanguage: options.targetLanguage }), { includeEntries: false }),
    };
  }

  loadPublicCache({ agent, targetLanguage }) {
    const safeAgent = this.sanitize.agent(agent || "Claude Code");
    const safeLanguage = this.sanitize.targetLanguage(targetLanguage || "zh-CN");
    return publicTranslationCache(this.loadCache({ agent: safeAgent, targetLanguage: safeLanguage }));
  }

  loadCache({ agent, targetLanguage }) {
    const candidates = this.cacheCandidates(agent, targetLanguage);
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
    const cache = readJson(cachePath);
    const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
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

  writeMaterials({ materials, sourceId, agent, targetLanguage, sourceCount = 0 }) {
    const dir = translationsDir(agent, targetLanguage);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const materialsPath = path.join(dir, "materials.jsonl");
    fs.writeFileSync(materialsPath, materials.map((item) => JSON.stringify(item)).join("\n") + (materials.length ? "\n" : ""), { mode: 0o600 });
    const manifest = {
      generated_at: this.clock().toISOString(),
      source_id: sourceId,
      agent,
      target_language: targetLanguage,
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

  cacheCandidates(agent, targetLanguage) {
    const slugs = [...new Set([this.slugify(agent), ...translationAliasSlugs(agent)])].filter(Boolean);
    return slugs.map((slug) => {
      const dir = translationsDir(slug, targetLanguage);
      return {
        slug,
        dir,
        cachePath: path.join(dir, `${safePathSegment(targetLanguage, "target-language")}.json`),
        manifestPath: path.join(dir, "manifest.json"),
      };
    });
  }

  sanitizeInput(input) {
    return {
      agent: this.sanitize.agent(input.agent || "Claude Code"),
      targetLanguage: this.sanitize.targetLanguage(input.target_language || "zh-CN"),
      concurrency: Math.min(positiveInt(input.concurrency, 8), MAX_TRANSLATION_CONCURRENCY),
      sourceId: this.sanitize.sourceId(input.source_id || ""),
      section: this.sanitize.section(input.section || ""),
      requestId: this.sanitize.requestId(input.request_id || ""),
      force: input.force === true,
    };
  }
}

export function publicTranslationCache(cache, { includeEntries = true } = {}) {
  const { cache_path: _cachePath, entries, ...rest } = cache || {};
  return { ...rest, ...(includeEntries ? { entries: entries || {} } : {}) };
}

export function publicTranslationCommandResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { cache_path: _cachePath, materials_path: _materialsPath, manifest_path: _manifestPath, ...rest } = result;
  return rest;
}

export function parseJsonCommandOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function runNodeScript(projectRoot, relativeScriptPath, args) {
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

function translationAliasSlugs(agent) {
  const value = String(agent || "");
  const aliases = [];
  if (/claude|anthropic|\bcc\b|claude-code/i.test(value)) aliases.push("claude-code");
  if (/trae/i.test(value)) aliases.push("trae-cn");
  return aliases;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} is required`);
  return value;
}

function requiredText(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} is required`);
  return String(value);
}
