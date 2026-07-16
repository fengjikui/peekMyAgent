export const DEFAULT_MESSAGE_TEXT_LIMIT = 5000;

export function messageViewModel(message, index, { textLimit = DEFAULT_MESSAGE_TEXT_LIMIT } = {}) {
  const role = typeof message === "object" && message ? message.role || "unknown" : "unknown";
  return {
    index,
    role: String(role),
    roleClass: safeMessageClassName(role),
    blocks: normalizeMessageBlocks(message).map((block, blockIndex) => blockViewModel(block, blockIndex, textLimit)),
  };
}

export function normalizeMessageBlocks(message) {
  if (message == null) return [{ type: "empty", text: "", raw: message }];
  if (typeof message !== "object") return [{ type: "text", text: String(message), raw: message }];
  const content = message.content;
  if (Array.isArray(content)) {
    return content.length ? content.map((block) => normalizeMessageBlock(block)) : [{ type: "empty", text: "", raw: content }];
  }
  if (typeof content === "string") return [{ type: "text", text: content, raw: content }];
  if (content != null) return [normalizeMessageBlock(content)];
  return [normalizeMessageBlock(message)];
}

export function normalizeMessageBlock(block) {
  if (block == null) return { type: "empty", text: "", raw: block };
  if (typeof block !== "object") return { type: "text", text: String(block), raw: block };
  return {
    type: String(block.type || "object"),
    text: messageBlockText(block),
    raw: block,
  };
}

export function truncateMessageText(text, limit = DEFAULT_MESSAGE_TEXT_LIMIT) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, originalLength: value.length, truncated: false };
  return {
    text: `${value.slice(0, limit).trimEnd()}\n\n...`,
    originalLength: value.length,
    truncated: true,
  };
}

export function hasStructuredMessagePayload(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).some((key) => !["type", "text", "content"].includes(key)));
}

export function safeMessageClassName(value) {
  return (
    String(value || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function blockViewModel(block, index, textLimit) {
  const type = block.type || "unknown";
  const text = block.text || "";
  return {
    index,
    type,
    text,
    textPreview: truncateMessageText(text, textLimit),
    raw: block.raw,
    isText: type === "text" || Boolean(text && !hasStructuredMessagePayload(block.raw)),
  };
}

function messageBlockText(block) {
  if (!block || typeof block !== "object") return String(block ?? "");
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.input === "string") return block.input;
  if (typeof block.name === "string" && block.type === "tool_use") return `${block.name}${block.id ? ` (${block.id})` : ""}`;
  return "";
}
