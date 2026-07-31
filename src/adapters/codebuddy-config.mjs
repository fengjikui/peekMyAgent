import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectOpenCodeConfiguration } from "./opencode-config.mjs";
import { childProcessSpawnConfig, joinPlatformPath, safeProcessCwd, userHome } from "../core/platform.mjs";

export const CODEBUDDY_BASE_URL_ENV = "CODEBUDDY_BASE_URL";
export const CODEBUDDY_API_KEY_ENV = "CODEBUDDY_API_KEY";
export const CODEBUDDY_MODEL_ENV = "CODEBUDDY_MODEL";
export const CODEBUDDY_SMALL_MODEL_ENV = "CODEBUDDY_SMALL_FAST_MODEL";
export const CODEBUDDY_REASONING_MODEL_ENV = "CODEBUDDY_BIG_SLOW_MODEL";
export const CODEBUDDY_SUBAGENT_MODEL_ENV = "CODEBUDDY_CODE_SUBAGENT_MODEL";
export const CODEBUDDY_MODEL_CONFIG_PATHS_ENV = "PEEKMYAGENT_CODEBUDDY_MODEL_CONFIG_PATHS";
export const CODEBUDDY_PROXY_MODEL_ENV = "PEEKMYAGENT_CODEBUDDY_PROXY_MODEL";
export const CODEBUDDY_PROXY_URL_ENV = "PEEKMYAGENT_CODEBUDDY_PROXY_URL";

const CODEBUDDY_MODEL_CONFIG_HOOK_PATH = fileURLToPath(new URL("./codebuddy-model-config-hook.cjs", import.meta.url));

export function inspectCodeBuddyConfiguration({
  args = [],
  cwd = safeProcessCwd(),
  env = process.env,
  targetBaseUrl,
  providerId,
  model,
  inspectOpenCode = inspectOpenCodeConfiguration,
} = {}) {
  const explicitModel = cleanModelId(model || codeBuddyModelFromArgs(args));
  if (targetBaseUrl && explicitModel) {
    return {
      model: explicitModel,
      target_base_url: normalizeBaseUrl(targetBaseUrl),
      provider_id: providerId || "custom",
      configuration_source: "explicit",
    };
  }

  const openCode = inspectOpenCode({ cwd, env, targetBaseUrl, providerId });
  const selectedModel = explicitModel || modelIdFromOpenCode(openCode.model, openCode.provider_id);
  if (!selectedModel) {
    throw new Error("Could not derive a CodeBuddy model ID from the effective OpenCode model.");
  }
  if (openCode.provider_npm && !/@ai-sdk\/(?:openai|openai-compatible)$/i.test(openCode.provider_npm)) {
    throw new Error(
      `OpenCode provider "${openCode.provider_id}" uses ${openCode.provider_npm}, which has not been verified for CodeBuddy's OpenAI Chat endpoint. ` +
        "Pass both --target-base-url and --model to use an explicitly verified endpoint.",
    );
  }
  return {
    model: selectedModel,
    target_base_url: normalizeBaseUrl(openCode.target_base_url),
    provider_id: openCode.provider_id,
    configuration_source: "opencode",
  };
}

export function buildCodeBuddyProxyEnv({
  env = process.env,
  proxyBaseUrl,
  model,
  cwd = safeProcessCwd(),
  platform = process.platform,
  systemHome,
} = {}) {
  const selectedModel = cleanModelId(model);
  if (!selectedModel) throw new Error("CodeBuddy model is required.");
  const baseUrl = normalizeBaseUrl(proxyBaseUrl);
  const configPaths = codeBuddyModelConfigPaths({ cwd, env, platform, systemHome });
  return {
    ...env,
    NODE_OPTIONS: appendNodeRequire(env.NODE_OPTIONS, CODEBUDDY_MODEL_CONFIG_HOOK_PATH),
    [CODEBUDDY_MODEL_CONFIG_PATHS_ENV]: JSON.stringify(configPaths),
    [CODEBUDDY_PROXY_MODEL_ENV]: selectedModel,
    [CODEBUDDY_PROXY_URL_ENV]: `${baseUrl}/chat/completions`,
    [CODEBUDDY_BASE_URL_ENV]: baseUrl,
    [CODEBUDDY_MODEL_ENV]: selectedModel,
    [CODEBUDDY_SMALL_MODEL_ENV]: selectedModel,
    [CODEBUDDY_REASONING_MODEL_ENV]: selectedModel,
    [CODEBUDDY_SUBAGENT_MODEL_ENV]: selectedModel,
  };
}

export function codeBuddyModelConfigPaths({
  cwd = safeProcessCwd(),
  env = process.env,
  platform = process.platform,
  systemHome,
} = {}) {
  const configuredDir = firstEnvironmentValue(env, ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"]);
  const home = userHome({ env, platform, ...(systemHome === undefined ? {} : { systemHome }) });
  const userDir = configuredDir || (home ? joinPlatformPath(platform, home, ".codebuddy") : null);
  return [...new Set([
    userDir ? joinPlatformPath(platform, userDir, "models.json") : null,
    joinPlatformPath(platform, cwd, ".codebuddy", "models.json"),
  ].filter(Boolean))];
}

export function inspectCodeBuddyInstallation({ command = "codebuddy", env = process.env } = {}) {
  const spawnConfig = childProcessSpawnConfig(command, ["--version"], { env });
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    env,
    encoding: "utf8",
    ...spawnConfig.options,
  });
  if (result.error) {
    return { installed: false, command, version: null, error: result.error.message };
  }
  return {
    installed: result.status === 0,
    command,
    version: result.status === 0 ? String(result.stdout || "").trim() || null : null,
    error: result.status === 0 ? null : `codebuddy --version exited with ${result.status}`,
  };
}

export function codeBuddyModelFromArgs(args = []) {
  return optionValue(args, ["--model"]);
}

export function codeBuddyConversationFromArgs(args = []) {
  return optionValue(args, ["--session-id"]) || optionValue(args, ["--resume", "-r"]);
}

export function codeBuddyContinuesSession(args = []) {
  return Boolean(optionValue(args, ["--resume", "-r"]) || booleanFlag(args, ["--continue", "-c"]));
}

export function codeBuddyForksSession(args = []) {
  return booleanFlag(args, ["--fork-session"]);
}

export function replaceCodeBuddyContinueWithResume(args = [], conversationId) {
  const session = String(conversationId || "").trim();
  if (!session || !booleanFlag(args, ["--continue", "-c"])) return [...args];
  return ["--resume", session, ...args.filter((value) => !["--continue", "-c"].includes(value))];
}

function modelIdFromOpenCode(model, providerId) {
  const value = String(model || "").trim();
  const prefix = `${String(providerId || "").trim()}/`;
  return cleanModelId(prefix !== "/" && value.startsWith(prefix) ? value.slice(prefix.length) : value);
}

function cleanModelId(value) {
  const model = String(value || "").trim();
  if (!model) return null;
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error("Invalid CodeBuddy model ID.");
  return model;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Invalid CodeBuddy upstream base URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Unsupported CodeBuddy upstream protocol: ${url.protocol}`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The CodeBuddy upstream base URL must not contain credentials, query parameters, or a fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function firstEnvironmentValue(env, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(env || {}, name) && String(env[name] || "").trim()) {
      return String(env[name]).trim();
    }
  }
  return null;
}

function appendNodeRequire(existing, modulePath) {
  const current = String(existing || "").trim();
  const requireOption = `--require=${JSON.stringify(modulePath)}`;
  return current ? `${current} ${requireOption}` : requireOption;
}

function optionValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    for (const name of names) {
      if (value === name) {
        const next = args[index + 1];
        return next && !String(next).startsWith("-") ? String(next) : null;
      }
      if (value.startsWith(`${name}=`)) return value.slice(name.length + 1) || null;
    }
  }
  return null;
}

function booleanFlag(args, names) {
  return args.some((value) => names.includes(String(value || "")));
}
