const SENSITIVE_HEADER = /authorization|api[-_]?key|x-api-key|cookie|token|secret|session/i;
const SENSITIVE_IDENTITY_HEADERS = new Set([
  "chatgpt-account-id",
  "openai-organization",
  "openai-project",
  "thread-id",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-openai-subagent",
]);
const SECRET_TEXT =
  /(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;

export function redactHeaders(headers = {}) {
  const redacted = {};
  const redactions = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (isSensitiveHeader(key)) {
      redacted[key] = "[REDACTED:header]";
      redactions.push({ field_path: `headers.${key}`, reason: "sensitive_header" });
    } else {
      redacted[key] = value;
    }
  }
  return { headers: redacted, redactions };
}

function isSensitiveHeader(key) {
  const normalized = String(key || "").toLowerCase();
  return SENSITIVE_HEADER.test(normalized) || SENSITIVE_IDENTITY_HEADERS.has(normalized);
}

export function redactText(value, fieldPath = "content") {
  if (typeof value !== "string") return { value, redactions: [] };
  const redactions = [];
  const replaced = value.replace(SECRET_TEXT, (match) => {
    redactions.push({ field_path: fieldPath, reason: "secret_pattern" });
    return match.startsWith("Bearer ") ? "Bearer [REDACTED:token]" : "[REDACTED:secret]";
  });
  return { value: replaced, redactions };
}

export function sanitizeEndpoint(endpoint = "") {
  const raw = String(endpoint || "");
  try {
    const url = raw.startsWith("http://") || raw.startsWith("https://") ? new URL(raw) : new URL(raw, "http://local");
    url.username = "";
    url.password = "";
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (SENSITIVE_HEADER.test(key) || SECRET_TEXT.test(value)) {
        url.searchParams.set(key, "[REDACTED]");
      }
      SECRET_TEXT.lastIndex = 0;
    }
    const pathAndQuery = `${url.pathname}${url.search}`;
    return raw.startsWith("http://") || raw.startsWith("https://") ? `${url.protocol}//${url.host}${pathAndQuery}` : pathAndQuery;
  } catch {
    const { value } = redactText(raw, "endpoint");
    return value;
  }
}

export function safeJsonShape(value, depth = 0) {
  if (depth > 4) return "[MaxDepth]";
  if (value == null) return value;
  if (typeof value === "string") return `[string:${value.length}]`;
  if (typeof value === "number" || typeof value === "boolean") return typeof value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeJsonShape(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
      out[key] = safeJsonShape(child, depth + 1);
    }
    return out;
  }
  return typeof value;
}
