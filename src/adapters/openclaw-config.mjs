import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childProcessSpawnConfig, expandHomePath, safeProcessCwd } from "../core/platform.mjs";

export const DEFAULT_OPENCLAW_PROFILE = "peekmyagent";

export function prepareOpenClawProfilePatch({
  profile = DEFAULT_OPENCLAW_PROFILE,
  refresh = false,
  model,
  providerId,
  targetBaseUrl,
  env = process.env,
} = {}) {
  ensureOpenClawProfile(profile, { refresh, env });
  const resolvedModel = model || runOpenClawConfig(["config", "get", "agents.defaults.model.primary"], { profile, env }).trim();
  const resolvedProviderId = providerId || providerFromModel(resolvedModel);
  const resolvedTargetBaseUrl =
    targetBaseUrl || runOpenClawConfig(["config", "get", `models.providers.${resolvedProviderId}.baseUrl`], { profile, env }).trim();
  if (!resolvedTargetBaseUrl) throw new Error(`Could not resolve OpenClaw provider baseUrl for provider ${resolvedProviderId} in profile ${profile}`);
  return {
    profile,
    provider_id: resolvedProviderId,
    target_base_url: resolvedTargetBaseUrl,
  };
}

export function ensureOpenClawProfile(profile, { refresh = false, env = process.env } = {}) {
  const defaultConfigPath = expandHomePath(runOpenClawConfig(["config", "file"], { profile: null, env }).trim(), { env });
  const profileConfigPath = expandHomePath(runOpenClawConfig(["config", "file"], { profile, env }).trim(), { env });
  if (!fs.existsSync(defaultConfigPath)) throw new Error(`OpenClaw default config not found: ${defaultConfigPath}`);
  if (!refresh && fs.existsSync(profileConfigPath)) return { profile, config_path: profileConfigPath, refreshed: false };
  fs.mkdirSync(path.dirname(profileConfigPath), { recursive: true });
  fs.copyFileSync(defaultConfigPath, profileConfigPath);
  return { profile, config_path: profileConfigPath, refreshed: true };
}

export function patchOpenClawProviderBaseUrl(profile, providerId, baseUrl, { env = process.env } = {}) {
  runOpenClawConfig(["config", "patch", "--stdin"], {
    profile,
    env,
    stdin: JSON.stringify({ models: { providers: { [providerId]: { baseUrl } } } }),
  });
}

export function runOpenClawConfig(args, { profile, stdin, env = process.env } = {}) {
  const finalArgs = profile ? ["--profile", profile, ...args] : args;
  const spawnConfig = childProcessSpawnConfig("openclaw", finalArgs, { env });
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd: safeProcessCwd(),
    env,
    input: stdin || "",
    encoding: "utf8",
    ...spawnConfig.options,
  });
  if (result.status !== 0) {
    throw new Error(`openclaw ${finalArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return cleanOpenClawConfigOutput(result.stdout);
}

export function cleanOpenClawConfigOutput(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || "";
}

export function providerFromModel(model) {
  const provider = String(model || "").split("/")[0];
  if (!provider || provider === String(model || "")) throw new Error(`Cannot infer OpenClaw provider from model: ${model}`);
  return provider;
}
