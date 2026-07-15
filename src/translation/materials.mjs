import {
  isSkippableTranslationMaterial,
  normalizeTranslationSourceText,
} from "./blocks.mjs";
import { translationMaterialHash } from "./hash.mjs";
import { projectTranslationBodyMaterials } from "./request-materials.mjs";

export { extractTranslationSystemParts } from "./request-materials.mjs";

export const TRANSLATION_MATERIAL_LIMITS = Object.freeze({
  materials: 1500,
  blockChars: 200000,
  totalChars: 2000000,
  metadataKeys: 32,
  metadataStringChars: 512,
});

export class TranslationMaterialCollector {
  constructor({ targetLanguage, contentText, extractHarnessParts, tooLarge, limits } = {}) {
    this.targetLanguage = String(targetLanguage || "zh-CN");
    this.contentText = requiredFunction(contentText, "contentText");
    this.extractHarnessParts = typeof extractHarnessParts === "function" ? extractHarnessParts : () => [];
    this.tooLarge = typeof tooLarge === "function" ? tooLarge : (message) => new Error(message);
    this.limits = { ...TRANSLATION_MATERIAL_LIMITS, ...(limits || {}) };
    this.byHash = new Map();
  }

  collectRequest(request, source, { section = "" } = {}) {
    const body = request.raw?.body || {};
    return this.collectBody(body, requestOccurrence(request, source), { section });
  }

  collectCapture(capture, source, { section = "" } = {}) {
    return this.collectBody(capture?.body || {}, captureOccurrence(capture, source), { section });
  }

  collectInput(inputMaterials, occurrence = {}) {
    for (const item of inputMaterials || []) {
      this.add({
        kind: String(item?.kind || "manual_text").trim() || "manual_text",
        source_text: item?.source_text,
        source_language: String(item?.source_language || "en").trim() || "en",
        metadata: item?.metadata && typeof item.metadata === "object" ? item.metadata : {},
        occurrence,
      });
    }
    return this;
  }

  collectBody(body, occurrence, { section = "" } = {}) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (!section || section === "system") this.collectSystem(body || {}, messages, occurrence);
    if (!section || section === "harness") this.collectHarness(messages, occurrence);
    if (!section || section === "tools") this.collectTools(body || {}, occurrence);
    return this;
  }

  collectSystem(body, messages, occurrence) {
    this.collectProjected(
      projectTranslationBodyMaterials({ ...body, messages }, { section: "system", contentText: this.contentText }),
      occurrence,
    );
  }

  collectHarness(messages, occurrence) {
    this.collectProjected(
      projectTranslationBodyMaterials(
        { messages },
        { section: "harness", contentText: this.contentText, extractHarnessParts: this.extractHarnessParts },
      ),
      occurrence,
    );
  }

  collectTools(body, occurrence) {
    this.collectProjected(
      projectTranslationBodyMaterials(body, { section: "tools", contentText: this.contentText }),
      occurrence,
    );
  }

  collectProjected(materials, occurrence) {
    for (const item of materials || []) this.add({ ...item, occurrence });
    return this;
  }

  add(input) {
    const sourceText = normalizeTranslationSourceText(input.source_text);
    if (isSkippableTranslationMaterial(input.kind, sourceText) || !sourceText || sourceText.length < 2) return this;
    const hash = translationMaterialHash(input.kind, sourceText);
    const existing = this.byHash.get(hash);
    if (existing) {
      existing.occurrences.push(input.occurrence);
      existing.occurrence_count = existing.occurrences.length;
      return this;
    }
    this.byHash.set(hash, {
      id: `${input.kind}:${hash.slice(0, 16)}`,
      hash,
      kind: input.kind,
      source_language: input.source_language || "en",
      target_language: this.targetLanguage,
      text_chars: sourceText.length,
      source_text: sourceText,
      metadata: sanitizeTranslationMaterialMetadata(input.metadata || {}, this.limits),
      occurrences: [input.occurrence],
      occurrence_count: 1,
    });
    return this;
  }

  materials() {
    const materials = [...this.byHash.values()].sort(compareTranslationMaterial);
    assertTranslationMaterialsWithinLimits(materials, { limits: this.limits, tooLarge: this.tooLarge });
    return materials;
  }
}

export function assertTranslationMaterialsWithinLimits(materials, { limits = TRANSLATION_MATERIAL_LIMITS, tooLarge = (message) => new Error(message) } = {}) {
  if (materials.length > limits.materials) {
    throw tooLarge(`Translation material count is too large. Limit is ${limits.materials}.`);
  }
  let totalChars = 0;
  for (const item of materials) {
    const textChars = Number.isFinite(item.text_chars) ? item.text_chars : String(item.source_text || "").length;
    if (textChars > limits.blockChars) {
      throw tooLarge(`Translation material is too large. Limit is ${limits.blockChars} chars per block.`);
    }
    totalChars += textChars;
    if (totalChars > limits.totalChars) {
      throw tooLarge(`Translation materials are too large. Limit is ${limits.totalChars} total chars.`);
    }
  }
  return materials;
}

export function compareTranslationMaterial(left, right) {
  const kind = left.kind.localeCompare(right.kind);
  if (kind) return kind;
  const count = right.occurrence_count - left.occurrence_count;
  if (count) return count;
  return left.hash.localeCompare(right.hash);
}

export function countTranslationMaterialsByKind(materials) {
  return (materials || []).reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});
}

export function sanitizeTranslationMaterialMetadata(value, limits = TRANSLATION_MATERIAL_LIMITS, depth = 0) {
  if (value == null) return {};
  if (typeof value === "string") return sanitizeMetadataText(value, limits.metadataStringChars);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return [];
    return value.slice(0, limits.metadataKeys).map((item) => sanitizeTranslationMaterialMetadata(item, limits, depth + 1));
  }
  if (typeof value !== "object") return null;
  if (depth >= 2) return {};
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, limits.metadataKeys)) {
    const cleanKey = sanitizeMetadataText(key, limits.metadataStringChars);
    if (cleanKey) output[cleanKey] = sanitizeTranslationMaterialMetadata(child, limits, depth + 1);
  }
  return output;
}

function requestOccurrence(request, source) {
  return {
    source_id: source.id,
    watch_id: request.watch_id || request.raw?.watch_id || null,
    request_id: request.id,
    request_index: request.request_index,
    workspace: request.workspace || source.workspace || null,
    conversation_id: request.conversation_id || source.conversation_id || null,
  };
}

function captureOccurrence(capture, source) {
  return {
    source_id: source.id,
    watch_id: capture.watch_id || null,
    request_id: capture.capture_id || null,
    request_index: capture.request_index || null,
    workspace: capture.workspace || source.workspace || null,
    conversation_id: capture.conversation_id || source.conversation_id || null,
  };
}

function sanitizeMetadataText(value, limit) {
  const normalized = String(value || "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
