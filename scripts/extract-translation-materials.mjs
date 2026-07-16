import fs from "node:fs";
import path from "node:path";
import { translationsDir } from "../src/core/app-paths.mjs";
import { openPersistenceStore, defaultStorePath } from "../src/core/persistence-store.mjs";
import { TranslationMaterialCollector, countTranslationMaterialsByKind } from "../src/translation/materials.mjs";

const args = process.argv.slice(2);
const targetLanguage = optionValue("--target-language") || "zh-CN";
const agentFilter = optionValue("--agent") || "Claude Code";
const storePath = optionValue("--store") || defaultStorePath();
const outDir =
  optionValue("--out-dir") ||
  translationsDir(agentFilter, targetLanguage);
const store = openPersistenceStore(storePath);
try {
  const sources = store.listSources().filter((source) => source.agent === agentFilter);
  const collector = new TranslationMaterialCollector({ targetLanguage, contentText: extractContentText });
  for (const source of sources) {
    const captures = store.loadCaptures(source.store_watch_id);
    for (const capture of captures) collector.collectCapture(capture, source);
  }

  const materials = collector.materials();
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const materialsPath = path.join(outDir, "materials.jsonl");
  fs.writeFileSync(materialsPath, materials.map((item) => JSON.stringify(item)).join("\n") + (materials.length ? "\n" : ""), {
    mode: 0o600,
  });

  const manifest = {
    generated_at: new Date().toISOString(),
    store_path: storePath,
    agent: agentFilter,
    target_language: targetLanguage,
    materials_path: materialsPath,
    item_count: materials.length,
    counts_by_kind: countTranslationMaterialsByKind(materials),
    source_count: sources.length,
    request_occurrence_count: materials.reduce((sum, item) => sum + item.occurrences.length, 0),
    contains_source_text: true,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...manifest, manifest_path: manifestPath }, null, 2));
} finally {
  store.close();
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

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function hasFlag(name) {
  return args.includes(name);
}

function slugify(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
