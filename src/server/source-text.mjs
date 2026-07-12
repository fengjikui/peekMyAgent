export const SOURCE_TEXT_LIMITS = Object.freeze({
  title: 80,
  traceTitle: 120,
  agent: 80,
  workspace: 512,
  conversation: 256,
});

export function sanitizeSourceText(value, { fallback = "", limit = SOURCE_TEXT_LIMITS.conversation, clean = identityText } = {}) {
  const cleanText = typeof clean === "function" ? clean : identityText;
  let normalized = normalize(cleanText(value));
  if (!normalized) normalized = normalize(cleanText(fallback));
  if (!normalized) return "";
  const maxChars = Math.max(3, Number(limit) || SOURCE_TEXT_LIMITS.conversation);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalize(value) {
  return String(value || "")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identityText(value) {
  return String(value || "");
}
