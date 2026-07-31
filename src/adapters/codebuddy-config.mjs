import { spawnSync } from "node:child_process";
import { inspectOpenCodeConfiguration } from "./opencode-config.mjs";
import { childProcessSpawnConfig, safeProcessCwd } from "../core/platform.mjs";

export const CODEBUDDY_BASE_URL_ENV = "CODEBUDDY_BASE_URL";
export const CODEBUDDY_API_KEY_ENV = "CODEBUDDY_API_KEY";
export const CODEBUDDY_MODEL_ENV = "CODEBUDDY_MODEL";
export const CODEBUDDY_SMALL_MODEL_ENV = "CODEBUDDY_SMALL_FAST_MODEL";
export const CODEBUDDY_REASONING_MODEL_ENV = "CODEBUDDY_BIG_SLOW_MODEL";
export const CODEBUDDY_SUBAGENT_MODEL_ENV = "CODEBUDDY_CODE_SUBAGENT_MODEL";

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

export function buildCodeBuddyProxyEnv({ env = process.env, proxyBaseUrl, model } = {}) {
  assertCodeBuddyCredentialEnv(env);
  const selectedModel = cleanModelId(model);
  if (!selectedModel) throw new Error("CodeBuddy model is required.");
  return {
    ...env,
    [CODEBUDDY_BASE_URL_ENV]: normalizeBaseUrl(proxyBaseUrl),
    [CODEBUDDY_MODEL_ENV]: selectedModel,
    [CODEBUDDY_SMALL_MODEL_ENV]: selectedModel,
    [CODEBUDDY_REASONING_MODEL_ENV]: selectedModel,
    [CODEBUDDY_SUBAGENT_MODEL_ENV]: selectedModel,
  };
}

export function assertCodeBuddyCredentialEnv(env = process.env) {
  if (hasEnvironmentValue(env, CODEBUDDY_API_KEY_ENV)) return;
  throw new Error(
    `Missing ${CODEBUDDY_API_KEY_ENV}. Export the upstream credential for CodeBuddy before running this command. ` +
      "peekMyAgent deliberately does not read or copy OpenCode authentication.",
  );
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

function hasEnvironmentValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env || {}, name) && String(env[name] || "").length > 0;
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
