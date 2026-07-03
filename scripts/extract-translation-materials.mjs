import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translationsDir } from "../src/core/app-paths.mjs";
import { openPersistenceStore, defaultStorePath } from "../src/core/persistence-store.mjs";

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

function extractSchemaDescriptions(schema, { toolName, rootPath }) {
  const output = [];
  visit(schema, rootPath, "");
  return output;

  function visit(value, currentPath, fieldName) {
    if (!value || typeof value !== "object") return;
    if (typeof value.description === "string" && value.description.trim()) {
      output.push({
        tool_name: toolName,
        field_name: fieldName || null,
        path: `${currentPath}.description`,
        description: value.description,
      });
    }
    const properties = value.properties && typeof value.properties === "object" ? value.properties : {};
    for (const [key, child] of Object.entries(properties)) visit(child, `${currentPath}.properties.${key}`, key);
    if (value.items) visit(value.items, `${currentPath}.items`, fieldName);
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(value[key])) value[key].forEach((child, index) => visit(child, `${currentPath}.${key}[${index}]`, fieldName));
    }
  }
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

function toolNameOf(tool) {
  return tool?.name || tool?.function?.name || tool?.type || "unknown";
}

function toolDescriptionOf(tool) {
  return normalizeText(tool?.description || tool?.function?.description || "");
}

function normalizeText(value) {
  return normalizeVolatileSystemLines(stripVolatileSystemPreamble(String(value || "").replace(/\r\n/g, "\n").trim())).trim();
}

function stripVolatileSystemPreamble(text) {
  return String(text || "")
    .replace(/^The date has changed\. Today's date is now \d{4}-\d{2}-\d{2}\. DO NOT mention this to the user explicitly because they are already aware\.\n\n/, "")
    .replace(/^Today's date is now \d{4}-\d{2}-\d{2}\. DO NOT mention this to the user explicitly because they are already aware\.\n\n/, "");
}

function isSkippableTranslationMaterial(kind, sourceText) {
  if (kind !== "system_prompt") return false;
  return /^x-anthropic-billing-header:\s*/i.test(sourceText);
}

function normalizeVolatileSystemLines(text) {
  return String(text || "")
    .replace(/^(\s*-\s*You are powered by the model\s+).+?(\.?)$/gm, "$1<model>$2")
    .replace(/^(\s*-\s*Primary working directory:\s+).+$/gm, "$1<workspace>")
    .replace(/(You have a persistent file-based memory at\s+)`[^`]+`/g, "$1`<project-memory>`");
}

function systemTranslationKind(text) {
  const value = String(text || "").trim();
  if (/^Called the .+ tool with the following input/i.test(value) && /Result of calling the .+ tool/i.test(value)) {
    return "system_injected_context";
  }
  return "system_prompt";
}

function materialHash(kind, sourceText) {
  return crypto.createHash("sha256").update(`${kind}\0${sourceText}`).digest("hex");
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
