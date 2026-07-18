import { joinPlatformPath, userHome } from "./platform.mjs";

export function defaultStateDir({ env = process.env, platform = process.platform } = {}) {
  if (env.PEEKMYAGENT_STATE_DIR) return env.PEEKMYAGENT_STATE_DIR;
  if (env.PEEKMYAGENT_HOME) return env.PEEKMYAGENT_HOME;
  if (platform === "win32" && env.LOCALAPPDATA) return joinPlatformPath(platform, env.LOCALAPPDATA, "peekMyAgent");
  const home = userHome({ env, platform });
  if (!home) throw new Error("Could not resolve the peekMyAgent state directory. Set PEEKMYAGENT_STATE_DIR.");
  return joinPlatformPath(platform, home, ".peekmyagent");
}

export function defaultStorePath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return env.PEEKMYAGENT_STORE_PATH || joinPlatformPath(platform, defaultStateDir(options), "store.sqlite");
}

export function viewerRegistryPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return env.PEEKMYAGENT_VIEWER_REGISTRY_PATH || joinPlatformPath(platform, defaultStateDir(options), "viewer.json");
}

export function ideRegistryPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return env.PEEKMYAGENT_IDE_REGISTRY_PATH || joinPlatformPath(platform, defaultStateDir(options), "ide-integrations.json");
}

export function translationsDir(agent, targetLanguage, options = {}) {
  return joinPlatformPath(options.platform || process.platform, defaultStateDir(options), "translations", slugify(agent), safePathSegment(targetLanguage, "target-language"));
}

export function importedTracesDir(options = {}) {
  return joinPlatformPath(options.platform || process.platform, defaultStateDir(options), "imports");
}

export function codexHomeDir({ env = process.env, platform = process.platform } = {}) {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const home = userHome({ env, platform });
  if (!home) throw new Error("Could not resolve the Codex home directory. Set CODEX_HOME.");
  return joinPlatformPath(platform, home, ".codex");
}

export function codexStateDbPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return env.PEEKMYAGENT_CODEX_STATE_DB || joinPlatformPath(platform, codexHomeDir(options), "state_5.sqlite");
}

export function codexObservationSelectionPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  return env.PEEKMYAGENT_CODEX_SELECTION_PATH || joinPlatformPath(platform, defaultStateDir(options), "codex-observation.json");
}

export function appConfigDir(appName, { env = process.env, platform = process.platform, override } = {}) {
  if (!appName) throw new Error("appConfigDir requires an app name.");
  if (override) return override;
  if (platform === "darwin") {
    const home = userHome({ env, platform });
    if (!home) throw new Error(`Could not resolve the ${appName} config directory. Set an explicit override.`);
    return joinPlatformPath(platform, home, "Library", "Application Support", appName);
  }
  if (platform === "win32") {
    const appData = env.APPDATA || env.LOCALAPPDATA || userHome({ env, platform });
    if (!appData) throw new Error(`Could not resolve the ${appName} config directory. Set an explicit override.`);
    return joinPlatformPath(platform, appData, appName);
  }
  const home = userHome({ env, platform });
  const configHome = env.XDG_CONFIG_HOME || (home ? joinPlatformPath(platform, home, ".config") : null);
  if (!configHome) throw new Error(`Could not resolve the ${appName} config directory. Set an explicit override.`);
  return joinPlatformPath(platform, configHome, appName);
}

export function slugify(value) {
  return safePathSegment(String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-"), "agent");
}

export function safePathSegment(value, fallback = "item") {
  let text = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  text = text.replace(/[.-]+$/g, "");
  if (!text || /^\.+$/.test(text)) return fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) return `${text}-item`;
  return text;
}
