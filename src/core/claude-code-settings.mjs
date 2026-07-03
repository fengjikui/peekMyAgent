import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { joinPlatformPath, pathForPlatform, safeProcessCwd, userHome } from "./platform.mjs";

const DIRECT_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

export function readClaudeCodeSettingsEnv({ cwd = safeProcessCwd(), env = process.env, platform = process.platform } = {}) {
  const merged = {};
  for (const filePath of claudeCodeSettingsPaths(cwd, env, platform)) {
    const settings = readJsonFile(filePath);
    if (!settings) continue;
    Object.assign(merged, extractClaudeCodeEnv(settings));
  }
  return merged;
}

export function resolveClaudeCodeTargetBaseUrl({ cwd = safeProcessCwd(), env = process.env, platform = process.platform } = {}) {
  if (env.PEEK_CLAUDE_TARGET_BASE_URL) return env.PEEK_CLAUDE_TARGET_BASE_URL;
  if (env.ANTHROPIC_BASE_URL) return env.ANTHROPIC_BASE_URL;
  return readClaudeCodeSettingsEnv({ cwd, env, platform }).ANTHROPIC_BASE_URL || null;
}

export function mergeClaudeCodeProcessEnv({ cwd = safeProcessCwd(), env = process.env, platform = process.platform, overrides = {} } = {}) {
  return {
    ...readClaudeCodeSettingsEnv({ cwd, env, platform }),
    ...env,
    ...overrides,
  };
}

export function claudeCodeProxySettingsArgs({ baseUrl, tmpRoot = os.tmpdir() } = {}) {
  if (!baseUrl) return { args: [], path: null, cleanup() {} };
  const dir = fs.mkdtempSync(path.join(tmpRoot, "peekmyagent-claude-settings-"));
  const filePath = path.join(dir, "settings.json");
  fs.writeFileSync(filePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl } }, null, 2));
  return {
    args: ["--settings", filePath],
    path: filePath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function inspectClaudeCodeSettings({ cwd = safeProcessCwd(), env = process.env, platform = process.platform } = {}) {
  return claudeCodeSettingsPaths(cwd, env, platform).map((filePath) => {
    const read = readJsonFileWithStatus(filePath);
    return {
      path: filePath,
      exists: read.exists,
      valid_json: read.valid,
      error: read.error,
      env_keys: read.settings ? Object.keys(extractClaudeCodeEnv(read.settings)).sort() : [],
    };
  });
}

export function claudeCodeUserDir({ env = process.env, platform = process.platform } = {}) {
  const home = userHome({ env, platform });
  return home ? joinPlatformPath(platform, home, ".claude") : null;
}

export function claudeCodeProjectDir(cwd = safeProcessCwd(), platform = process.platform) {
  return joinPlatformPath(platform, cwd, ".claude");
}

export function claudeCodeSettingsPaths(cwd = safeProcessCwd(), env = process.env, platform = process.platform) {
  const userDir = claudeCodeUserDir({ env, platform });
  const paths = [];
  if (userDir) {
    paths.push(joinPlatformPath(platform, userDir, "settings.json"));
    paths.push(joinPlatformPath(platform, userDir, "settings.local.json"));
  }
  const home = userHome({ env, platform });
  for (const dir of workspaceAncestors(cwd, home, platform)) {
    const projectDir = claudeCodeProjectDir(dir, platform);
    paths.push(joinPlatformPath(platform, projectDir, "settings.json"));
    paths.push(joinPlatformPath(platform, projectDir, "settings.local.json"));
  }
  return [...new Set(paths)];
}

function workspaceAncestors(cwd, home, platform) {
  const pathApi = pathForPlatform(platform);
  const start = pathApi.resolve(cwd || safeProcessCwd());
  const homeResolved = home ? pathApi.resolve(home) : null;
  const ancestors = [];
  let current = start;
  while (current && current !== pathApi.dirname(current)) {
    ancestors.unshift(current);
    if (homeResolved && current === homeResolved) break;
    current = pathApi.dirname(current);
  }
  ancestors.unshift(current);
  return [...new Set(ancestors.filter(Boolean))];
}

function readJsonFile(filePath) {
  const read = readJsonFileWithStatus(filePath);
  return read.valid ? read.settings : null;
}

function readJsonFileWithStatus(filePath) {
  try {
    return { exists: true, valid: true, settings: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { exists: false, valid: false, settings: null, error: null };
    return { exists: true, valid: false, settings: null, error: error.message };
  }
}

function extractClaudeCodeEnv(settings) {
  const result = {};
  mergeEnvObject(result, settings?.env);
  mergeEnvObject(result, settings?.environmentVariables);
  mergeEnvObject(result, settings?.["claude-code.environmentVariables"]);
  for (const key of DIRECT_ENV_KEYS) {
    if (Object.hasOwn(settings || {}, key)) mergeEnvValue(result, key, settings[key]);
  }
  return result;
}

function mergeEnvObject(result, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string" || !key) continue;
    mergeEnvValue(result, key, entry);
  }
}

function mergeEnvValue(result, key, value) {
  if (value == null) return;
  if (!["string", "number", "boolean"].includes(typeof value)) return;
  result[key] = String(value);
}
