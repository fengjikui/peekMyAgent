import { spawnSync } from "node:child_process";
import path from "node:path";
import { childProcessSpawnConfig, safeProcessCwd } from "../core/platform.mjs";

export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
export const OPENCODE_TRANSLATION_AGENT = "peekmyagent-translation";
export const OPENCODE_COMMAND_EVIDENCE_HEADER = "x-peek-opencode-command";

export function inspectOpenCodeConfiguration({
  args = [],
  cwd = safeProcessCwd(),
  env = process.env,
  command = "opencode",
  targetBaseUrl,
  providerId,
  model,
  runDebugConfig = runOpenCodeDebugConfig,
} = {}) {
  const config = runDebugConfig({ cwd, env, command });
  const selectedModel = model || openCodeModelFromArgs(args) || stringValue(config?.model);
  if (!selectedModel) {
    throw new Error(
      'Could not resolve the OpenCode model. Select one with "opencode --model <provider/model>" or configure a default model.',
    );
  }

  const selectedProviderId = providerId || providerFromOpenCodeModel(selectedModel);
  const provider = config?.provider?.[selectedProviderId];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`Could not resolve OpenCode provider "${selectedProviderId}" from the effective configuration.`);
  }

  const resolvedTargetBaseUrl =
    targetBaseUrl ||
    stringValue(provider?.options?.baseURL) ||
    stringValue(provider?.options?.baseUrl);
  if (!resolvedTargetBaseUrl) {
    throw new Error(
      `OpenCode provider "${selectedProviderId}" does not expose an explicit baseURL. ` +
        "Pass --target-base-url to the advanced peekMyAgent run command.",
    );
  }
  assertHttpUrl(resolvedTargetBaseUrl, "OpenCode upstream baseURL");

  return {
    model: selectedModel,
    provider_id: selectedProviderId,
    target_base_url: stripTrailingSlash(resolvedTargetBaseUrl),
    provider_npm: stringValue(provider.npm) || null,
    conversation_id: openCodeSessionFromArgs(args),
    command_name: openCodeCommandFromArgs(args),
    workspace: openCodeWorkingDirectory(args, cwd),
  };
}

export function runOpenCodeDebugConfig({
  cwd = safeProcessCwd(),
  env = process.env,
  command = "opencode",
} = {}) {
  const debugArgs = ["debug", "config", "--pure"];
  const spawnConfig = childProcessSpawnConfig(command, debugArgs, { env });
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd,
    env,
    encoding: "utf8",
    ...spawnConfig.options,
  });
  if (result.error) {
    throw new Error(`Could not inspect OpenCode configuration: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `OpenCode configuration inspection failed with exit code ${result.status}. ` +
        'Run "opencode debug config --pure" to diagnose the local OpenCode setup.',
    );
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch {
    throw new Error('OpenCode returned invalid JSON from "opencode debug config --pure".');
  }
}

export function listOpenCodeSessions({
  cwd = safeProcessCwd(),
  env = process.env,
  command = "opencode",
  maxCount = 20,
} = {}) {
  const safeMaxCount = Math.max(1, Math.min(100, Number(maxCount) || 20));
  const args = ["session", "list", "--format", "json", "--max-count", String(safeMaxCount)];
  const spawnConfig = childProcessSpawnConfig(command, args, { env });
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd,
    env,
    encoding: "utf8",
    ...spawnConfig.options,
  });
  if (result.error) throw new Error(`Could not list OpenCode sessions: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`OpenCode session listing failed with exit code ${result.status}.`);
  }
  const output = String(result.stdout || "").trim();
  if (!output) return [];
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('OpenCode returned invalid JSON from "session list --format json".');
  }
  if (!Array.isArray(parsed)) throw new Error("OpenCode session listing must be a JSON array.");
  return parsed.map(normalizeOpenCodeSession).filter(Boolean);
}

export function resolveOpenCodeContinuationSession({
  args = [],
  cwd = safeProcessCwd(),
  env = process.env,
  command = "opencode",
  listSessions = listOpenCodeSessions,
} = {}) {
  const explicit = openCodeSessionFromArgs(args);
  if (explicit) return explicit;
  if (!openCodeContinuesSession(args) || openCodeForksSession(args)) return null;
  const workspace = path.resolve(cwd);
  const sessions = listSessions({ cwd: workspace, env, command });
  return sessions.find((session) => !session.directory || path.resolve(session.directory) === workspace)?.id || null;
}

export function buildOpenCodeProxyEnv({
  env = process.env,
  providerId,
  proxyBaseUrl,
  commandName = null,
} = {}) {
  if (!providerId) throw new Error("providerId is required");
  assertHttpUrl(proxyBaseUrl, "peekMyAgent OpenCode proxy base URL");
  const existing = parseInlineConfig(env[OPENCODE_CONFIG_CONTENT_ENV]);
  const provider = objectValue(existing.provider?.[providerId]);
  const options = objectValue(provider.options);
  const command = normalizeOpenCodeCommandName(commandName);
  const headers = command
    ? {
        ...objectValue(options.headers),
        [OPENCODE_COMMAND_EVIDENCE_HEADER]: command,
      }
    : options.headers;
  const merged = {
    ...existing,
    provider: {
      ...objectValue(existing.provider),
      [providerId]: {
        ...provider,
        options: {
          ...options,
          baseURL: stripTrailingSlash(proxyBaseUrl),
          ...(headers ? { headers } : {}),
        },
      },
    },
  };
  return {
    ...env,
    [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify(merged),
  };
}

export function buildOpenCodeTranslationEnv({
  env = process.env,
  model,
  agentName = OPENCODE_TRANSLATION_AGENT,
} = {}) {
  if (!model) throw new Error("OpenCode translation model is required.");
  const existing = parseInlineConfig(env[OPENCODE_CONFIG_CONTENT_ENV]);
  const existingAgent = objectValue(existing.agent?.[agentName]);
  return {
    ...env,
    [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify({
      ...existing,
      share: "disabled",
      tools: {
        ...objectValue(existing.tools),
        "*": false,
      },
      agent: {
        ...objectValue(existing.agent),
        [agentName]: {
          ...existingAgent,
          description: "Translate peekMyAgent trace materials without tools or workspace access.",
          mode: "primary",
          model,
          prompt:
            "Translate only the material supplied by the user. Preserve the requested marker format exactly. " +
            "Do not inspect files, use tools, or add commentary.",
          permission: {
            ...objectValue(existingAgent.permission),
            "*": "deny",
          },
          tools: {
            ...objectValue(existingAgent.tools),
            "*": false,
          },
          temperature: 0.1,
        },
      },
    }),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
  };
}

export function openCodeModelFromArgs(args = []) {
  return optionValue(args, ["--model", "-m"]);
}

export function openCodeSessionFromArgs(args = []) {
  return optionValue(args, ["--session", "-s"]);
}

export function openCodeContinuesSession(args = []) {
  return Boolean(openCodeSessionFromArgs(args) || booleanFlag(args, ["--continue", "-c"]));
}

export function openCodeForksSession(args = []) {
  return booleanFlag(args, ["--fork"]);
}

export function openCodeCommandFromArgs(args = []) {
  return normalizeOpenCodeCommandName(optionValue(args, ["--command"]));
}

export function openCodeWorkingDirectory(args = [], cwd = safeProcessCwd()) {
  const directory = optionValue(args, ["--dir"]);
  return directory ? path.resolve(cwd, directory) : path.resolve(cwd);
}

function normalizeOpenCodeCommandName(value) {
  const command = String(value || "").trim().replace(/^\/+/, "");
  if (!command) return null;
  if (command.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(command)) return null;
  return command;
}

function normalizeOpenCodeSession(value) {
  const id = stringValue(value?.id || value?.sessionID || value?.sessionId);
  if (!id) return null;
  return {
    id,
    directory: stringValue(value?.directory || value?.path),
    created: value?.created ?? value?.time?.created ?? null,
    updated: value?.updated ?? value?.time?.updated ?? null,
  };
}

export function providerFromOpenCodeModel(model) {
  const value = String(model || "").trim();
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Cannot infer the OpenCode provider from model "${value}". Expected provider/model.`);
  }
  return value.slice(0, separator);
}

export function parseInlineConfig(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_ENV} contains invalid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${OPENCODE_CONFIG_CONTENT_ENV} must contain a JSON object.`);
  }
  return parsed;
}

function optionValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    for (const name of names) {
      if (value.startsWith(`${name}=`)) {
        const assignment = value.slice(name.length + 1);
        if (!assignment) throw new Error(`${name} requires a value.`);
        return assignment;
      }
      if (value !== name) continue;
      const next = String(args[index + 1] || "");
      if (!next || /^--?[^-]/.test(next)) throw new Error(`${name} requires a value.`);
      return next;
    }
  }
  return null;
}

function booleanFlag(args, names) {
  return args.some((value) => names.some((name) => value === name || value === `${name}=true`));
}

function assertHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https.`);
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
