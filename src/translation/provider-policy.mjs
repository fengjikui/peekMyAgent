export const CODEX_TRANSLATION_MODEL_PREFERENCES = Object.freeze([
  "gpt-5.3-codex-spark",
  "gpt-5.6-luna",
]);

const FAST_MODEL_HINTS = Object.freeze([
  "flash",
  "spark",
  "nano",
  "mini",
  "small",
  "lite",
  "fast",
  "haiku",
  "instant",
]);

const EXPENSIVE_MODEL_HINTS = Object.freeze([
  "pro",
  "max",
  "ultra",
  "opus",
  "large",
  "thinking",
  "reasoning",
]);

export function resolveTranslationProtocol({ agent, env = process.env } = {}) {
  const explicit = String(env.PEEKMYAGENT_TRANSLATION_PROTOCOL || "").trim().toLowerCase();
  if (explicit) return normalizeExplicitProtocol(explicit);

  const normalizedAgent = String(agent || "").trim();
  if (/open\s*code/i.test(normalizedAgent)) return "opencode-cli";
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

export function selectOpenCodeTranslationModel({ config, env = process.env } = {}) {
  const explicit = String(
    env.PEEKMYAGENT_TRANSLATION_OPENCODE_MODEL || env.PEEKMYAGENT_TRANSLATION_MODEL || "",
  ).trim();
  if (explicit) {
    return {
      model: explicit,
      source: "explicit",
      fallbackModel: null,
    };
  }

  const defaultModel = stringValue(config?.model);
  const smallModel = stringValue(config?.small_model);
  if (smallModel) {
    return {
      model: smallModel,
      source: "small-model",
      fallbackModel: smallModel === defaultModel ? null : defaultModel,
    };
  }
  if (!defaultModel) {
    throw new Error(
      'Could not resolve an OpenCode translation model. Configure "model" or set PEEKMYAGENT_TRANSLATION_OPENCODE_MODEL.',
    );
  }

  const [providerId, ...modelParts] = defaultModel.split("/");
  const defaultModelId = modelParts.join("/");
  if (!providerId || !defaultModelId) {
    throw new Error(`OpenCode default model "${defaultModel}" must use provider/model format.`);
  }

  const configuredModels = Object.keys(config?.provider?.[providerId]?.models || {});
  const candidates = configuredModels.length
    ? configuredModels.map((modelId, index) => ({
        model: `${providerId}/${modelId}`,
        modelId,
        index,
      }))
    : [{ model: defaultModel, modelId: defaultModelId, index: 0 }];
  candidates.sort((left, right) => {
    const scoreDifference =
      openCodeTranslationModelScore(left.modelId, defaultModelId) -
      openCodeTranslationModelScore(right.modelId, defaultModelId);
    return scoreDifference || left.index - right.index;
  });
  const selected = candidates[0]?.model || defaultModel;
  return {
    model: selected,
    source: selected === defaultModel ? "default-model" : "provider-fast-model",
    fallbackModel: selected === defaultModel ? null : defaultModel,
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
  if (value === "opencode") return "opencode-cli";
  if (["openai", "anthropic", "claude-cli", "codex-cli", "opencode-cli"].includes(value)) return value;
  throw new Error(`Unsupported PEEKMYAGENT_TRANSLATION_PROTOCOL: ${value}`);
}

function openCodeTranslationModelScore(modelId, defaultModelId) {
  const normalized = String(modelId || "").toLowerCase();
  let score = modelId === defaultModelId ? 5 : 0;
  for (const hint of FAST_MODEL_HINTS) {
    if (normalized.includes(hint)) score -= 20;
  }
  for (const hint of EXPENSIVE_MODEL_HINTS) {
    if (normalized.includes(hint)) score += 20;
  }
  return score;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
