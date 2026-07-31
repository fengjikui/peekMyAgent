const SENSITIVE_HEADER = /authorization|api[-_]?key|x-api-key|cookie|token|secret|session/i;
const SENSITIVE_IDENTITY_HEADERS = new Set([
  "chatgpt-account-id",
  "openai-organization",
  "openai-project",
  "thread-id",
  "x-client-request-id",
  "x-agent-purpose",
  "x-conversation-id",
  "x-conversation-message-id",
  "x-conversation-request-id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-openai-subagent",
  "x-request-id",
  "x-user-id",
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

export function extractSafeHeaderSemantics(headers = {}, { agentProfile } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [String(key || "").toLowerCase(), value]),
  );
  const codexTurnMetadata = parseJsonObject(normalized["x-codex-turn-metadata"]);
  const safeCodexTurnMetadata = {};
  for (const key of ["request_kind", "thread_source", "subagent_kind", "sandbox"]) {
    const value = safeHeaderEnum(codexTurnMetadata?.[key]);
    if (value) safeCodexTurnMetadata[key] = value;
  }
  const semantics = {};
  if (Object.keys(safeCodexTurnMetadata).length) semantics.codex_turn_metadata = safeCodexTurnMetadata;
  if (hasMeaningfulHeader(normalized["x-codex-parent-thread-id"])) semantics.codex_parent_thread = true;
  if (truthyMarker(normalized["x-openai-subagent"])) semantics.codex_subagent = true;
  const codeBuddyRequest =
    truthyMarker(normalized["x-codebuddy-request"]) || /^codebuddy(?:\s+code)?$/i.test(String(agentProfile || "").trim());
  if (codeBuddyRequest) {
    const codebuddy = {};
    const purpose = safeCodeBuddyPurpose(normalized["x-agent-purpose"]);
    const intent = safeHeaderEnum(normalized["x-agent-intent"]);
    const ideType = safeHeaderEnum(normalized["x-ide-type"]);
    const ideName = safeHeaderEnum(normalized["x-ide-name"]);
    const ideVersion = safeHeaderToken(normalized["x-ide-version"]);
    if (purpose) codebuddy.agent_purpose = purpose;
    if (intent) codebuddy.agent_intent = intent;
    if (ideType) codebuddy.ide_type = ideType;
    if (ideName) codebuddy.ide_name = ideName;
    if (ideVersion) codebuddy.ide_version = ideVersion;
    if (hasMeaningfulHeader(normalized["x-conversation-request-id"])) codebuddy.conversation_request_id_present = true;
    if (Object.keys(codebuddy).length) semantics.codebuddy = codebuddy;
  }
  return Object.keys(semantics).length ? semantics : undefined;
}

function safeCodeBuddyPurpose(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^subagent(?::|\/)[^\s]{1,128}$/.test(text)) return "subagent";
  if (/^custom_agent(?::|\/)[^\s]{1,128}$/.test(text)) return "custom_agent";
  return safeHeaderEnum(text);
}

function isSensitiveHeader(key) {
  const normalized = String(key || "").toLowerCase();
  return SENSITIVE_HEADER.test(normalized) || SENSITIVE_IDENTITY_HEADERS.has(normalized);
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeHeaderEnum(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(text) ? text : null;
}

function safeHeaderToken(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text) ? text : null;
}

function hasMeaningfulHeader(value) {
  return value != null && String(value).trim() !== "";
}

function truthyMarker(value) {
  if (!hasMeaningfulHeader(value)) return false;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
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
