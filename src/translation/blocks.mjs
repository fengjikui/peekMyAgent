const TRANSLATION_START_MARKER = "@@PEEK_TRANSLATION";
const TRANSLATION_END_MARKER = "@@PEEK_END_TRANSLATION";

export function normalizeTranslationSourceText(value) {
  const normalizedNewlines = String(value || "").replace(/\r\n/g, "\n").trim();
  return normalizeVolatileSystemLines(stripVolatileSystemPreamble(normalizedNewlines)).trim();
}

export function translationLookupKey(kind, sourceText) {
  return `${String(kind || "").trim()}\0${normalizeTranslationSourceText(sourceText)}`;
}

export function isSkippableTranslationMaterial(kind, sourceText) {
  if (kind !== "system_prompt") return false;
  return /^x-anthropic-billing-header:\s*/i.test(normalizeTranslationSourceText(sourceText));
}

export function systemTranslationKind(text) {
  const value = String(text || "").trim();
  if (/^Called the .+ tool with the following input/i.test(value) && /Result of calling the .+ tool/i.test(value)) {
    return "system_injected_context";
  }
  return "system_prompt";
}

export function extractTranslationSchemaDescriptions(schema, { rootPath }) {
  const output = [];
  visit(schema, rootPath, "");
  return output;

  function visit(value, currentPath, fieldName) {
    if (!value || typeof value !== "object") return;
    if (typeof value.description === "string" && value.description.trim()) {
      output.push({
        field_name: fieldName || null,
        path: `${currentPath}.description`,
        description: value.description,
      });
    }
    const properties = value.properties && typeof value.properties === "object" ? value.properties : {};
    for (const [key, child] of Object.entries(properties)) visit(child, `${currentPath}.properties.${key}`, key);
    if (value.items) visit(value.items, `${currentPath}.items`, fieldName);
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(value[key])) {
        value[key].forEach((child, index) => visit(child, `${currentPath}.${key}[${index}]`, fieldName));
      }
    }
  }
}

export function translationToolName(tool) {
  return tool?.name || tool?.function?.name || tool?.type || "unknown";
}

export function translationToolDescription(tool) {
  return normalizeTranslationSourceText(tool?.description || tool?.function?.description || "");
}

export function parseTranslationMarkerBlocks(text, { required = false } = {}) {
  const output = [];
  const pattern = /@@PEEK_TRANSLATION\s+([a-f0-9]{64})\s*\r?\n([\s\S]*?)\r?\n@@PEEK_END_TRANSLATION/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    output.push({ hash: match[1], translated_text: match[2].trim() });
  }
  if (required && !output.length) {
    throw new Error(`Translation response did not contain marker blocks: ${String(text || "").slice(0, 500)}`);
  }
  return output;
}

export function sanitizeTranslationOutput(kind, value) {
  const text = String(value || "").trim();
  const expectedKind = String(kind || "").trim();
  if (!expectedKind) return text;
  return text
    .replace(/(^|\r?\n)kind:\s*([^\r\n]+)\r?\nmetadata:\s*\{[^\r\n]*\}\r?\n/g, (match, prefix, routedKind) =>
      routedKind.trim() === expectedKind ? prefix : match,
    )
    .trim();
}

export function formatTranslationSourceBlock(item) {
  return `@@PEEK_SOURCE ${item.hash}\nkind: ${item.kind}\nmetadata: ${JSON.stringify(item.metadata || {})}\n${item.source_text}\n@@PEEK_END_SOURCE`;
}

export function translationResponseFormatInstruction() {
  return `${TRANSLATION_START_MARKER} <hash>\n<translated text>\n${TRANSLATION_END_MARKER}`;
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
