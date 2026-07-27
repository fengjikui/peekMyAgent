export {
  extractHarnessTranslationParts,
  translationMaterialsForRequest,
} from "../translation/request-materials.mjs";
export { extractContentText } from "../trace/content-parts.mjs";

const TRANSLATION_KIND_ALIASES = Object.freeze({
  assistant_reasoning: ["assistant_reasoning", "assistant_thinking"],
  assistant_thinking: ["assistant_thinking", "assistant_reasoning"],
});

export function translatedTextForKind(translatedTextFor, kind, sourceText) {
  if (typeof translatedTextFor !== "function") return "";
  const candidates = TRANSLATION_KIND_ALIASES[kind] || [kind];
  for (const candidate of candidates) {
    const translated = translatedTextFor(candidate, sourceText);
    if (translated) return translated;
  }
  return "";
}
