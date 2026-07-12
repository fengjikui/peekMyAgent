import fs from "node:fs";
import path from "node:path";
import { translationsDir } from "../src/core/app-paths.mjs";
import { openPersistenceStore, defaultStorePath } from "../src/core/persistence-store.mjs";
import {
  extractTranslationSchemaDescriptions as extractSchemaDescriptions,
  isSkippableTranslationMaterial,
  normalizeTranslationSourceText as normalizeText,
  systemTranslationKind,
  translationToolDescription as toolDescriptionOf,
  translationToolName as toolNameOf,
} from "../src/translation/blocks.mjs";
import { translationMaterialHash as materialHash } from "../src/translation/hash.mjs";

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
  const byHash = new Map();
  for (const source of sources) {
    const captures = store.loadCaptures(source.store_watch_id);
    for (const capture of captures) collectCaptureMaterials(byHash, capture, source);
  }

  const materials = [...byHash.values()].sort(compareMaterial);
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
    counts_by_kind: countBy(materials, "kind"),
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

function collectCaptureMaterials(byHash, capture, source) {
  const body = capture.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const occurrence = {
    source_id: source.id,
    watch_id: capture.watch_id,
    request_id: capture.capture_id,
    request_index: capture.request_index,
    workspace: capture.workspace || source.workspace || null,
    conversation_id: capture.conversation_id || source.conversation_id || null,
  };

  extractSystemParts(body, messages).forEach((part, index) => {
    const kind = systemTranslationKind(part.text);
    addMaterial(byHash, {
      kind,
      source_text: part.text,
      source_language: "en",
      target_language: targetLanguage,
      metadata: {
        source: part.source,
        index,
      },
      occurrence,
    });
  });

  const tools = Array.isArray(body.tools) ? body.tools : [];
  tools.forEach((tool, toolIndex) => {
    const toolName = toolNameOf(tool);
    const description = toolDescriptionOf(tool);
    if (description) {
      addMaterial(byHash, {
        kind: "tool_description",
        source_text: description,
        source_language: "en",
        target_language: targetLanguage,
        metadata: {
          tool_name: toolName,
          path: `tools[${toolIndex}].description`,
        },
        occurrence,
      });
    }
    const schema = tool.input_schema || tool.function?.parameters || tool.parameters || null;
    for (const item of extractSchemaDescriptions(schema, { toolName, rootPath: `tools[${toolIndex}].input_schema` })) {
      addMaterial(byHash, {
        kind: "tool_parameter_description",
        source_text: item.description,
        source_language: "en",
        target_language: targetLanguage,
        metadata: {
          tool_name: toolName,
          path: item.path,
          field_name: item.field_name,
        },
        occurrence,
      });
    }
  });
}

function addMaterial(byHash, input) {
  const sourceText = normalizeText(input.source_text);
  if (isSkippableTranslationMaterial(input.kind, sourceText)) return;
  if (!sourceText || sourceText.length < 2) return;
  const hash = materialHash(input.kind, sourceText);
  const existing = byHash.get(hash);
  if (existing) {
    existing.occurrences.push(input.occurrence);
    existing.occurrence_count = existing.occurrences.length;
    return;
  }
  const item = {
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
  };
  byHash.set(hash, item);
}

function extractSystemParts(body, messages) {
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

function compareMaterial(left, right) {
  const kind = left.kind.localeCompare(right.kind);
  if (kind) return kind;
  const count = right.occurrence_count - left.occurrence_count;
  if (count) return count;
  return left.hash.localeCompare(right.hash);
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
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
