import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appConfigDir, ideRegistryPath } from "../core/app-paths.mjs";

const require = createRequire(import.meta.url);

export const TRAE_CN_ID = "trae-cn";
export const TRAE_CN_LABEL = "Trae CN";
const MODEL_LIST_KEY_RE = /_AI\.agent\.model\.model_list_map$/;
const GLOBAL_MODEL_MAP_KEY_RE = /_ai-chat:sessionRelation:globalModelMap$/;
const CURRENT_SESSION_KEY_RE = /currentSessionId$/i;
const SESSION_AGENT_MAP_KEY_RE = /icube_session_agent_map$/i;
const STABLE_ROUTE_VERSION = 1;

export function defaultIdeRegistryPath(options = {}) {
  return ideRegistryPath(options);
}

export function traeCnAppDataRoot({ env = process.env, platform = process.platform } = {}) {
  return appConfigDir("Trae CN", { env, platform, override: env.PEEKMYAGENT_TRAE_CN_APPDATA });
}

export function readIdeRegistry(registryPath = defaultIdeRegistryPath()) {
  if (!fs.existsSync(registryPath)) return { version: 1, integrations: {} };
  const data = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  return {
    version: data.version || 1,
    integrations: data.integrations && typeof data.integrations === "object" ? data.integrations : {},
  };
}

export function writeIdeRegistry(registry, registryPath = defaultIdeRegistryPath()) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

export function inspectTraeCn({ registryPath = defaultIdeRegistryPath(), appDataRoot = traeCnAppDataRoot() } = {}) {
  const config = readTraeCnModelConfig(appDataRoot);
  const registry = readIdeRegistry(registryPath);
  const integration = registry.integrations[TRAE_CN_ID] || null;
  return {
    id: TRAE_CN_ID,
    label: TRAE_CN_LABEL,
    available: config.available,
    enabled: Boolean(integration?.enabled),
    install_id: integration?.install_id || null,
    stable_url: integration?.stable_url || null,
    app_data_root: appDataRoot,
    registry_path: registryPath,
    selected_models: config.selected_models,
    patched_models: config.model_entries.filter((entry) => isPeekProxyUrl(entry.base_url)).length,
    custom_model_count: config.model_entries.length,
    workspace_count: listTraeCnWorkspaces({ appDataRoot }).length,
    warnings: [
      ...config.warnings,
      ...(integration?.warnings || []),
    ],
    model_entries: config.model_entries.map((entry) => ({
      identifier: entry.identifier,
      provider: entry.provider,
      model: entry.model,
      base_url: entry.base_url,
      base_url_is_peek_proxy: isPeekProxyUrl(entry.base_url),
      selected: entry.selected,
    })),
  };
}

export function enableTraeCn({
  captureBaseUrl,
  registryPath = defaultIdeRegistryPath(),
  appDataRoot = traeCnAppDataRoot(),
} = {}) {
  if (!captureBaseUrl) throw new Error("captureBaseUrl is required");
  const config = readTraeCnModelConfig(appDataRoot);
  if (!config.available) throw new Error(`Trae CN config not found: ${config.state_db_path}`);
  if (!config.model_list_key) throw new Error("Trae CN model list key was not found in global state.");

  const registry = readIdeRegistry(registryPath);
  const previous = registry.integrations[TRAE_CN_ID] || {};
  const installId = previous.install_id || `trae-cn-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const stableUrl = buildStableUrl(captureBaseUrl, installId);
  const modelsToPatch = config.model_entries.filter((entry) => shouldPatchModel(entry));
  if (!modelsToPatch.length) throw new Error("No selected custom OpenAI-compatible Trae CN model was found to patch.");

  const existingOriginals = new Map((previous.models || []).map((entry) => [entry.identifier, entry.original_base_url]));
  const patched = [];
  const warnings = [];
  for (const entry of modelsToPatch) {
    const original = existingOriginals.get(entry.identifier) || entry.base_url;
    if (isPeekProxyUrl(original) && !process.env.PEEKMYAGENT_TRAE_CN_TARGET_BASE_URL) {
      warnings.push(`Model ${entry.identifier} already points to a peekMyAgent proxy; set PEEKMYAGENT_TRAE_CN_TARGET_BASE_URL or disable/restore before forwarding real traffic.`);
    }
    entry.object.base_url = stableUrl;
    patched.push({
      identifier: entry.identifier,
      provider: entry.provider,
      model: entry.model,
      original_base_url: original,
      patched_base_url: stableUrl,
      upstream_base_url: inferOpenAiUpstreamBaseUrl(original),
      was_already_peek_proxy: isPeekProxyUrl(original),
    });
  }
  writeItemValue(config.state_db_path, config.model_list_key, config.model_list);

  registry.integrations[TRAE_CN_ID] = {
    id: TRAE_CN_ID,
    label: TRAE_CN_LABEL,
    enabled: true,
    route_schema_version: STABLE_ROUTE_VERSION,
    install_id: installId,
    stable_url: stableUrl,
    capture_base_url: trimSlash(captureBaseUrl),
    app_data_root: appDataRoot,
    model_list_key: config.model_list_key,
    global_model_map_key: config.global_model_map_key,
    models: patched,
    warnings,
    enabled_at: new Date().toISOString(),
  };
  writeIdeRegistry(registry, registryPath);
  return {
    action: "enable",
    id: TRAE_CN_ID,
    enabled: true,
    install_id: installId,
    stable_url: stableUrl,
    patched_count: patched.length,
    patched_models: patched,
    warnings,
    registry_path: registryPath,
  };
}

export function disableTraeCn({ registryPath = defaultIdeRegistryPath(), appDataRoot = traeCnAppDataRoot() } = {}) {
  const registry = readIdeRegistry(registryPath);
  const integration = registry.integrations[TRAE_CN_ID] || null;
  if (!integration) return { action: "disable", id: TRAE_CN_ID, enabled: false, restored_count: 0, missing: true };
  const config = readTraeCnModelConfig(appDataRoot || integration.app_data_root);
  if (!config.available || !config.model_list_key) {
    integration.enabled = false;
    integration.disabled_at = new Date().toISOString();
    registry.integrations[TRAE_CN_ID] = integration;
    writeIdeRegistry(registry, registryPath);
    return { action: "disable", id: TRAE_CN_ID, enabled: false, restored_count: 0, warnings: ["Trae CN model config was not found; registry was disabled only."] };
  }

  const originals = new Map((integration.models || []).map((entry) => [entry.identifier, entry.original_base_url]));
  let restoredCount = 0;
  for (const entry of config.model_entries) {
    const original = originals.get(entry.identifier);
    if (!original) continue;
    if (entry.base_url === integration.stable_url || isPeekProxyUrl(entry.base_url)) {
      entry.object.base_url = original;
      restoredCount += 1;
    }
  }
  writeItemValue(config.state_db_path, config.model_list_key, config.model_list);
  integration.enabled = false;
  integration.disabled_at = new Date().toISOString();
  registry.integrations[TRAE_CN_ID] = integration;
  writeIdeRegistry(registry, registryPath);
  return {
    action: "disable",
    id: TRAE_CN_ID,
    enabled: false,
    restored_count: restoredCount,
    registry_path: registryPath,
  };
}

export function syncTraeCn(options = {}) {
  const registry = readIdeRegistry(options.registryPath || defaultIdeRegistryPath());
  const integration = registry.integrations[TRAE_CN_ID] || null;
  if (!integration?.enabled) return inspectTraeCn(options);
  return enableTraeCn({ ...options, captureBaseUrl: options.captureBaseUrl || integration.capture_base_url });
}

export function resolveTraeCnDynamicRoute({ route, body, registryPath = defaultIdeRegistryPath(), appDataRoot = traeCnAppDataRoot() } = {}) {
  if (!route || route.agentSlug !== TRAE_CN_ID) return null;
  const registry = readIdeRegistry(registryPath);
  const integration = registry.integrations[TRAE_CN_ID] || null;
  if (!integration?.enabled) throw new Error("Trae CN integration is not enabled. Run `peekmyagent enable trae-cn` first.");
  if (integration.install_id !== route.installId) throw new Error(`Unknown Trae CN install id: ${route.installId}`);

  const attribution = resolveTraeCnAttribution({ body, appDataRoot: appDataRoot || integration.app_data_root });
  const model = body?.model || null;
  const upstream = chooseUpstreamForModel(integration, model);
  const sessionId = attribution.session_id || stableHash(JSON.stringify({ install: route.installId, workspace: attribution.workspace || null, model })).slice(0, 16);
  const watchId = `trae-cn-${slug(sessionId, 28)}`;
  return {
    id: `live-${watchId}`,
    watch_id: watchId,
    label: `${TRAE_CN_LABEL} · ${attribution.project || "自动归属"}`,
    agent: TRAE_CN_LABEL,
    mode: "single_session",
    confidence: attribution.session_id ? "exact" : "inferred",
    kind: "proxy_capture",
    note: "Trae CN 稳定代理入口自动归属；配置层始终走同一个 URL，运行时按项目/会话写入对应 watch。",
    target_base_url: upstream.target_base_url,
    workspace: attribution.workspace || null,
    conversation_id: attribution.session_id || null,
    provider_id: upstream.provider_id,
    config_patched: true,
    started_by: "trae-cn-stable-route",
    native_workspace_id: attribution.workspace_id || null,
    native_agent_type: attribution.agent_type || null,
    route,
  };
}

export function resolveTraeCnAttribution({ body, appDataRoot = traeCnAppDataRoot() } = {}) {
  const workspaces = listTraeCnWorkspaces({ appDataRoot });
  const bodyText = JSON.stringify(body || {});
  const matched = workspaces
    .filter((workspace) => workspace.folder && bodyText.includes(workspace.folder))
    .sort((a, b) => b.folder.length - a.folder.length)[0] || null;
  const workspace = matched || workspaces.find((item) => item.folder && bodyText.includes(path.basename(item.folder))) || null;
  const state = workspace ? readTraeCnWorkspaceState(workspace) : null;
  return {
    workspace: workspace?.folder || null,
    workspace_id: workspace?.id || null,
    project: workspace?.folder ? path.basename(workspace.folder) : null,
    session_id: state?.current_session_id || null,
    agent_type: state?.agent_type || null,
    session_count: state?.session_count || 0,
  };
}

export function listTraeCnWorkspaces({ appDataRoot = traeCnAppDataRoot() } = {}) {
  const root = path.join(appDataRoot, "User", "workspaceStorage");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const id = entry.name;
      const dir = path.join(root, id);
      const workspaceJson = readJsonFileSafe(path.join(dir, "workspace.json"));
      const folderUri = workspaceJson?.folder || workspaceJson?.workspace || workspaceJson?.configuration || "";
      return {
        id,
        dir,
        folder: fileUriToPath(folderUri),
        workspace_json_path: path.join(dir, "workspace.json"),
        state_db_path: path.join(dir, "state.vscdb"),
      };
    })
    .filter((workspace) => workspace.folder || fs.existsSync(workspace.state_db_path));
}

export function readTraeCnWorkspaceState(workspace) {
  if (!workspace?.state_db_path || !fs.existsSync(workspace.state_db_path)) return null;
  const rows = readItemRows(workspace.state_db_path);
  const currentRow = rows.find((row) => CURRENT_SESSION_KEY_RE.test(row.key) || /currentSessionId/i.test(row.key));
  const currentSessionId = parseStateString(currentRow?.value);
  const agentMapRow = rows.find((row) => SESSION_AGENT_MAP_KEY_RE.test(row.key));
  const agentMap = parseJsonSafe(agentMapRow?.value) || {};
  return {
    current_session_id: currentSessionId,
    agent_type: currentSessionId ? agentMap[currentSessionId] || null : null,
    session_count: Object.keys(agentMap).length,
    agent_map: agentMap,
  };
}

function readTraeCnModelConfig(appDataRoot) {
  const stateDbPath = path.join(appDataRoot, "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(stateDbPath)) {
    return {
      available: false,
      state_db_path: stateDbPath,
      warnings: [`Trae CN global state DB not found: ${stateDbPath}`],
      selected_models: [],
      model_entries: [],
    };
  }
  const rows = readItemRows(stateDbPath);
  const modelListRow = rows.find((row) => MODEL_LIST_KEY_RE.test(row.key)) || rows.find((row) => /model_list_map/i.test(row.key));
  const modelMapRow = rows.find((row) => GLOBAL_MODEL_MAP_KEY_RE.test(row.key)) || rows.find((row) => /globalModelMap/i.test(row.key));
  const modelList = parseJsonSafe(modelListRow?.value) || {};
  const globalModelMap = parseJsonSafe(modelMapRow?.value) || {};
  const selectedModels = collectSelectedModelIds(globalModelMap);
  const selectedSet = new Set(selectedModels);
  const modelEntries = collectModelEntries(modelList, selectedSet);
  return {
    available: true,
    state_db_path: stateDbPath,
    model_list_key: modelListRow?.key || null,
    global_model_map_key: modelMapRow?.key || null,
    model_list: modelList,
    global_model_map: globalModelMap,
    selected_models: selectedModels,
    model_entries: modelEntries,
    warnings: [],
  };
}

function collectSelectedModelIds(value) {
  const output = new Set();
  walk(value, (item) => {
    if (typeof item === "string" && /custom_openai_compatible\/\//.test(item)) output.add(item);
  });
  return [...output];
}

function collectModelEntries(modelList, selectedSet) {
  const entries = [];
  walk(modelList, (item, pointer) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    if (!Object.prototype.hasOwnProperty.call(item, "base_url")) return;
    const provider = item.provider || item.model_provider || inferProviderFromPointer(pointer);
    const model = item.model || item.name || item.model_name || item.id || null;
    const identifier = item.identifier || item.full_name || item.model_id || buildModelIdentifier(provider, model, pointer);
    if (!/custom_openai_compatible/i.test(String(provider || identifier))) return;
    entries.push({
      identifier,
      provider,
      model,
      base_url: item.base_url,
      selected: selectedSet.size ? isSelectedModel({ selectedSet, identifier, provider, model }) : true,
      object: item,
      pointer,
    });
  });
  return entries;
}

function buildModelIdentifier(provider, model, pointer) {
  if (model && String(model).includes("//")) return String(model);
  if (provider && model) return `${provider}//${model}`;
  return pointer.join(".");
}

function isSelectedModel({ selectedSet, identifier, provider, model }) {
  const candidates = [identifier, provider && model ? `${provider}//${model}` : null, model, leafModelName(model), leafModelName(identifier)].filter(Boolean).map(String);
  for (const selected of selectedSet) {
    const text = String(selected);
    if (candidates.some((candidate) => text === candidate || text.includes(candidate) || candidate.includes(text))) return true;
  }
  return false;
}

function leafModelName(value) {
  return String(value || "").split("//").at(-1);
}

function shouldPatchModel(entry) {
  return entry.selected && /custom_openai_compatible/i.test(String(entry.provider || entry.identifier));
}

function chooseUpstreamForModel(integration, model) {
  const models = integration.models || [];
  const selected =
    models.find((entry) => model && [entry.model, entry.identifier].some((value) => String(value || "").includes(model))) ||
    models[0] ||
    null;
  if (!selected?.upstream_base_url) throw new Error("Trae CN upstream base URL is missing from the integration registry.");
  return {
    target_base_url: selected.upstream_base_url,
    provider_id: selected.identifier || "custom_openai_compatible",
  };
}

function inferOpenAiUpstreamBaseUrl(baseUrl) {
  const override = process.env.PEEKMYAGENT_TRAE_CN_TARGET_BASE_URL;
  if (override) return trimSlash(override);
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/chat\/completions\/?$/, "").replace(/\/chat\/completions\/?$/, "");
  url.search = "";
  return trimSlash(url.toString());
}

function buildStableUrl(captureBaseUrl, installId) {
  return `${trimSlash(captureBaseUrl)}/agent/${TRAE_CN_ID}/${encodeURIComponent(installId)}/openai/v1/chat/completions`;
}

function readItemRows(dbPath) {
  const db = openSqlite(dbPath);
  try {
    return db.prepare("SELECT key, value FROM ItemTable").all();
  } finally {
    db.close();
  }
}

function writeItemValue(dbPath, key, value) {
  const db = openSqlite(dbPath);
  try {
    db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(JSON.stringify(value), key);
  } finally {
    db.close();
  }
}

function openSqlite(dbPath) {
  const { DatabaseSync } = loadNodeSqlite();
  return new DatabaseSync(dbPath);
}

function loadNodeSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredSqliteWarning(warning, ...args) {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (String(message || "").includes("SQLite is an experimental feature")) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseJsonSafe(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseStateString(value) {
  const parsed = parseJsonSafe(value);
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") return parsed.currentSessionId || parsed.current_session_id || null;
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : null;
}

function walk(value, visitor, pointer = []) {
  visitor(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, [...pointer, String(index)]));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walk(item, visitor, [...pointer, key]);
  }
}

function inferProviderFromPointer(pointer) {
  return pointer.find((part) => /custom_openai_compatible/i.test(part)) || null;
}

function fileUriToPath(value) {
  if (!value) return null;
  const text = String(value);
  if (!text.startsWith("file://")) return text;
  try {
    return fileURLToPath(text);
  } catch {
    return text.replace(/^file:\/\//, "");
  }
}

function isPeekProxyUrl(value) {
  return /\/watch\/|\/agent\/trae-cn\//.test(String(value || ""));
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function slug(value, max = 32) {
  return String(value || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max) || "session";
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function workspaceJsonForFolder(folder) {
  return { folder: pathToFileURL(folder).href };
}
