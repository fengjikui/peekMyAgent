const comparableMessageKeyCache = new WeakMap();

export function commonMessagePrefixLength(
  previousMessages,
  currentMessages,
  { ignoreLeadingContextContent = false } = {},
) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const limit = Math.min(previous.length, current.length);
  let index = 0;
  let withinLeadingContext = ignoreLeadingContextContent;
  while (index < limit) {
    const previousMessage = previous[index];
    const currentMessage = current[index];
    if (
      withinLeadingContext &&
      isLeadingContextMessage(previousMessage) &&
      isLeadingContextMessage(currentMessage) &&
      previousMessage.role === currentMessage.role
    ) {
      index += 1;
      continue;
    }
    withinLeadingContext = false;
    if (comparableMessageKey(previousMessage) !== comparableMessageKey(currentMessage)) break;
    index += 1;
  }
  return index;
}

export function comparableMessageKey(message) {
  if (message && typeof message === "object") {
    const cached = comparableMessageKeyCache.get(message);
    if (cached) return cached;
  }
  const normalized = normalizeComparableValue(message);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    normalized.content = normalizeComparableContent(message?.content);
  }
  const key = stableJson(normalized);
  if (message && typeof message === "object") comparableMessageKeyCache.set(message, key);
  return key;
}

export function normalizeComparableValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeComparableValue).filter((item) => item !== undefined);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, normalizeComparableValue(item)])
      .filter(([, item]) => item !== undefined),
  );
}

function normalizeComparableContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.map(normalizeComparableContentPart);
  if (content && typeof content === "object") return [normalizeComparableContentPart(content)];
  return content ?? null;
}

function normalizeComparableContentPart(part) {
  if (typeof part === "string") return { type: "text", text: part };
  return normalizeComparableValue(part);
}

function isLeadingContextMessage(message) {
  return ["system", "developer"].includes(String(message?.role || "").toLowerCase());
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
