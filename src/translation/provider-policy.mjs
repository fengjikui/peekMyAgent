export const CODEX_TRANSLATION_MODEL_PREFERENCES = Object.freeze([
  "gpt-5.3-codex-spark",
  "gpt-5.6-luna",
]);

export function resolveTranslationProtocol({ agent, env = process.env } = {}) {
  const explicit = String(env.PEEKMYAGENT_TRANSLATION_PROTOCOL || "").trim().toLowerCase();
  if (explicit) return normalizeExplicitProtocol(explicit);

  const normalizedAgent = String(agent || "").trim();
  if (/\bcodex\b/i.test(normalizedAgent)) return "codex-cli";
  if (/claude|anthropic|\bcc\b/i.test(normalizedAgent)) return "claude-cli";

  // Preserve the legacy fallback for adapters that do not yet expose a safe,
  // ephemeral CLI translation path. Known Agents above never cross this
  // boundary, so ambient provider variables cannot redirect Codex to Claude.
  if (env.PEEKMYAGENT_TRANSLATION_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY) return "openai";
  return "claude-cli";
}

export function selectCodexTranslationModel({ modelCatalog, env = process.env } = {}) {
  const explicit = String(
    env.PEEKMYAGENT_TRANSLATION_CODEX_MODEL || env.PEEKMYAGENT_TRANSLATION_MODEL || "",
  ).trim();
  if (explicit) {
    return {
      model: explicit,
      source: "explicit",
      allowDefaultFallback: false,
    };
  }

  const available = new Set(codexVisibleModelSlugs(modelCatalog));
  const cachedPreference = CODEX_TRANSLATION_MODEL_PREFERENCES.find((model) => available.has(model));
  if (cachedPreference) {
    return {
      model: cachedPreference,
      source: "models-cache",
      allowDefaultFallback: true,
    };
  }

  return {
    model: CODEX_TRANSLATION_MODEL_PREFERENCES[0],
    source: "preferred-default",
    allowDefaultFallback: true,
  };
}

export function codexVisibleModelSlugs(modelCatalog) {
  const models = Array.isArray(modelCatalog?.models)
    ? modelCatalog.models
    : Array.isArray(modelCatalog?.data)
      ? modelCatalog.data
      : [];
  return [...new Set(models
    .filter((model) => model && model.visibility !== "hide")
    .map((model) => String(model.slug || model.id || model.model || "").trim())
    .filter(Boolean))];
}

function normalizeExplicitProtocol(value) {
  if (value === "claude") return "claude-cli";
  if (value === "codex") return "codex-cli";
  if (["openai", "anthropic", "claude-cli", "codex-cli"].includes(value)) return value;
  throw new Error(`Unsupported PEEKMYAGENT_TRANSLATION_PROTOCOL: ${value}`);
}
