import crypto from "node:crypto";
import { startCaptureProxy } from "../core/capture-proxy.mjs";
import { sourceIdForWatch } from "../core/source-identifiers.mjs";

const ACTIVE_STATUSES = new Set(["watching", "paused"]);

export class WatchRuntimeService {
  constructor({
    cwd,
    store,
    startProxy = startCaptureProxy,
    resolveTargetBaseUrl,
    labelFor = (agent, mode) => `${agent} · ${mode}`,
    resolveDynamicRoute,
    inferCaptureTitle,
    metadata,
    now = () => new Date().toISOString(),
    createWatchId = defaultWatchId,
    conflict = (message) => Object.assign(new Error(message), { statusCode: 409 }),
    logger = console,
  } = {}) {
    if (typeof resolveTargetBaseUrl !== "function") throw new Error("resolveTargetBaseUrl is required");
    this.cwd = cwd || null;
    this.store = store || null;
    this.startProxy = startProxy;
    this.resolveTargetBaseUrl = resolveTargetBaseUrl;
    this.labelFor = labelFor;
    this.resolveDynamicRoute = resolveDynamicRoute || null;
    this.inferCaptureTitle = typeof inferCaptureTitle === "function" ? inferCaptureTitle : () => null;
    this.metadata = metadata || {};
    this.now = now;
    this.createWatchId = createWatchId;
    this.conflict = conflict;
    this.logger = logger || console;
    this.sharedProxy = null;
    this.active = new Map();
    this.operationLocks = new Map();
    this.closePromise = null;
  }

  attachSharedProxy(proxy) {
    this.sharedProxy = proxy || null;
    return this;
  }

  get(id) {
    return this.find({ id, watch_id: id });
  }

  has(id) {
    return Boolean(this.get(id));
  }

  values() {
    return this.active.values();
  }

  listActive() {
    return [...this.active.values()];
  }

  find(input = {}) {
    if (input.id && this.active.has(input.id)) return this.active.get(input.id);
    if (input.watch_id) {
      const watchId = normalizeWatchId(input.watch_id);
      const byWatchId = [...this.active.values()].find((watch) => watch.watch_id === watchId);
      if (byWatchId) return byWatchId;
    }
    if (input.conversation_id) {
      return [...this.active.values()].find(
        (watch) =>
          watch.conversation_id === input.conversation_id &&
          (!input.workspace || watch.workspace === input.workspace) &&
          (!input.agent || watch.agent === input.agent),
      );
    }
    return null;
  }

  remove(id) {
    const watch = typeof id === "object" ? id : this.get(id);
    if (!watch) return false;
    return this.active.delete(watch.id);
  }

  async start(input = {}) {
    const agent = input.agent || "Claude Code";
    const mode = input.mode || "next_request";
    const workspace = input.workspace || this.cwd;
    const conversationId = input.conversation_id || null;
    if (!input.reuse_watch_id && input.reuse === false) {
      return this.createNew({ ...input, agent, mode, workspace, conversation_id: conversationId });
    }
    const lockKey = input.reuse_watch_id
      ? `watch:${normalizeWatchId(input.reuse_watch_id)}`
      : `start:${agent}\u0000${mode}\u0000${workspace || ""}\u0000${conversationId || ""}`;
    return this.withLock(lockKey, async () => {
      if (input.reuse_watch_id) {
        const explicitActive = this.find({ id: input.reuse_watch_id, watch_id: input.reuse_watch_id });
        if (explicitActive) return this.reuseActive(explicitActive, input);
        const explicitStored = this.loadStoredWatch(input.reuse_watch_id);
        if (explicitStored) return this.restoreStored(explicitStored, input, { preserveStatus: false });
        throw this.conflict(`Requested watch is no longer available for reuse: ${input.reuse_watch_id}`);
      }
      if (input.reuse !== false) {
        const active = this.findReusableActive({ agent, mode, workspace, conversationId });
        if (active) return this.reuseActive(active, input);
        const stored = this.findReusableStored({ agent, mode, workspace, conversationId });
        if (stored) return this.restoreStored(stored, input, { preserveStatus: false });
      }
      return this.createNew({ ...input, agent, mode, workspace, conversation_id: conversationId });
    });
  }

  async createNew(input) {
    const targetBaseUrl = input.target_base_url || this.resolveTargetBaseUrl(input.agent, input.workspace);
    if (!targetBaseUrl) throw missingTargetError(input.agent);
    const watchId = input.watch_id || this.createWatchId(input.agent);
    const watch = this.buildWatch({
      id: `live-${watchId}`,
      watch_id: watchId,
      label: input.label || this.labelFor(input.agent, input.mode),
      title: this.preferredTitle({ agent: input.agent, conversation_id: input.conversation_id }),
      agent: input.agent,
      mode: input.mode,
      confidence: input.confidence || "exact",
      kind: input.kind || "proxy_capture",
      note: input.note || "实时监听中；将 Agent base URL 临时指向本地代理后开始捕获。",
      target_base_url: targetBaseUrl,
      created_at: this.now(),
      workspace: input.workspace,
      conversation_id: input.conversation_id || null,
      provider_id: input.provider_id || null,
      config_patched: Boolean(input.config_patched),
      started_by: input.started_by || "viewer",
      status: "watching",
      skipped_while_paused: 0,
    });
    await this.attachProxy(watch, []);
    await this.register(watch);
    return { watch, disposition: "new" };
  }

  async reuseActive(watch, input = {}) {
    const targetBaseUrl = input.target_base_url || watch.target_base_url || this.resolveTargetBaseUrl(watch.agent, watch.workspace);
    if (!targetBaseUrl) throw missingTargetError(watch.agent);
    const proxyReady = watch.proxy && !watch.proxy_closed;
    if (this.sharedProxy) {
      watch.proxy = this.sharedProxy;
      watch.proxy_shared = true;
      watch.proxy_closed = false;
      watch.base_url = this.sharedProxy.urlForWatch(watch.watch_id);
    } else if (!proxyReady) {
      await this.attachProxy(watch, this.capturesFor(watch));
    }
    this.applyRestart(watch, input, targetBaseUrl);
    this.persistWatch(watch);
    return { watch, disposition: "reused" };
  }

  async restoreStored(stored, input = {}, { preserveStatus = false } = {}) {
    const watchId = stored.watch_id || stored.store_watch_id;
    if (!watchId) throw new Error("Persisted watch is missing watch_id");
    const agent = stored.agent || input.agent || "Claude Code";
    const workspace = input.workspace || stored.workspace || this.cwd;
    const targetBaseUrl = input.target_base_url || this.resolveTargetBaseUrl(agent, workspace);
    if (!targetBaseUrl) throw missingTargetError(agent);
    const captures = this.store?.loadCaptures?.(watchId) || [];
    const restoredStatus = preserveStatus && ACTIVE_STATUSES.has(stored.status || stored.live_status)
      ? stored.status || stored.live_status
      : "watching";
    const watch = this.buildWatch({
      id: `live-${watchId}`,
      watch_id: watchId,
      label: stored.label || stored.original_label || this.labelFor(agent, stored.mode || input.mode || "single_session"),
      title:
        stored.title ||
        stored.user_title ||
        this.preferredTitle({ agent, conversation_id: input.conversation_id || stored.conversation_id }) ||
        null,
      agent,
      mode: stored.mode || input.mode || "single_session",
      confidence: stored.confidence || "exact",
      kind: stored.kind === "persisted_capture" ? "proxy_capture" : stored.kind || "proxy_capture",
      note: "从本地持久化监听恢复；继续写入同一个 watch。",
      target_base_url: targetBaseUrl,
      created_at: stored.created_at || this.now(),
      workspace,
      conversation_id: input.conversation_id || stored.conversation_id || null,
      provider_id: input.provider_id || stored.provider_id || null,
      config_patched: Boolean(input.config_patched || stored.config_patched),
      started_by: input.started_by || stored.started_by || "viewer",
      status: restoredStatus,
      restarted_at: this.now(),
      stopped_at: null,
      paused_at: restoredStatus === "paused" ? stored.paused_at || this.now() : null,
      skipped_while_paused: Number(stored.skipped_while_paused) || 0,
      last_seen: stored.last_seen || null,
    });
    await this.attachProxy(watch, captures);
    await this.register(watch);
    return { watch, disposition: "restored" };
  }

  async resolveForCapture(watchId) {
    const active = this.find({ watch_id: watchId });
    if (active && ACTIVE_STATUSES.has(active.status)) return active;
    if (!this.sharedProxy) return null;
    return this.withLock(`capture:${normalizeWatchId(watchId)}`, async () => {
      const current = this.find({ watch_id: watchId });
      if (current && ACTIVE_STATUSES.has(current.status)) return current;
      const stored = this.loadStoredWatch(watchId);
      if (!stored || !ACTIVE_STATUSES.has(stored.status || stored.live_status)) return null;
      const result = await this.restoreStored(
        stored,
        {
          workspace: stored.workspace,
          conversation_id: stored.conversation_id,
          started_by: "shared-proxy-auto-restore",
        },
        { preserveStatus: true },
      );
      return result.watch;
    });
  }

  async resolveForSend(sourceId) {
    const active = this.find({ id: sourceId, watch_id: sourceId });
    if (active) return active;
    const stored = this.loadStoredWatch(sourceId);
    if (!stored || !ACTIVE_STATUSES.has(stored.status || stored.live_status)) return null;
    return this.withLock(`send:${stored.watch_id || stored.store_watch_id}`, async () => {
      const current = this.find({ id: sourceId, watch_id: sourceId });
      if (current) return current;
      const result = await this.restoreStored(
        stored,
        {
          workspace: stored.workspace,
          conversation_id: stored.conversation_id,
          started_by: "dashboard-composer",
        },
        { preserveStatus: true },
      );
      return result.watch;
    });
  }

  async resolveForAgentRoute(context = {}) {
    if (!this.sharedProxy) throw new Error("Shared capture proxy is not running.");
    if (typeof this.resolveDynamicRoute !== "function") throw new Error("Dynamic Agent route resolver is not configured.");
    const resolved = this.resolveDynamicRoute(context);
    if (!resolved) return null;
    return this.withLock(`agent-route:${resolved.watch_id}`, async () => {
      const existing = this.find({ watch_id: resolved.watch_id });
      if (existing) {
        Object.assign(existing, compactObject({
          target_base_url: resolved.target_base_url,
          workspace: resolved.workspace,
          conversation_id: resolved.conversation_id,
          provider_id: resolved.provider_id,
          native_workspace_id: resolved.native_workspace_id,
          native_agent_type: resolved.native_agent_type,
        }));
        if (existing.status === "stopped") existing.status = "watching";
        existing.proxy = this.sharedProxy;
        existing.proxy_shared = true;
        existing.proxy_closed = false;
        this.persistWatch(existing);
        return existing;
      }
      const stored = this.loadStoredWatch(resolved.watch_id);
      const captures = stored ? this.store?.loadCaptures?.(resolved.watch_id) || [] : [];
      if (captures.length) this.sharedProxy.addCaptures?.(captures);
      const baseUrl = `${this.sharedProxy.baseUrl}/agent/${encodeURIComponent(context.route.agentSlug)}/${encodeURIComponent(context.route.installId)}/${encodeURIComponent(context.route.protocol)}`;
      const watch = this.buildWatch({
        ...(stored || {}),
        ...resolved,
        base_url: baseUrl,
        proxy: this.sharedProxy,
        proxy_shared: true,
        proxy_closed: false,
        created_at: stored?.created_at || this.now(),
        status: "watching",
        skipped_while_paused: Number(stored?.skipped_while_paused) || 0,
      });
      await this.register(watch);
      return watch;
    });
  }

  onCapture(capture, watch) {
    this.touchFromCapture(watch, capture);
    this.safePersistence("insert capture", () => this.store?.upsertCapture?.({ watch, capture }));
  }

  onCaptureUpdate(capture, watch) {
    this.touchFromCapture(watch, capture);
    this.safePersistence("update capture response", () => this.store?.updateCaptureResponse?.(capture));
  }

  onCaptureSkipped(watch) {
    if (!watch) return;
    watch.skipped_while_paused = (Number(watch.skipped_while_paused) || 0) + 1;
    watch.last_seen = this.now();
    this.safePersistence("update skipped watch", () => this.store?.updateWatchStatus?.(watch.watch_id, watch.status));
  }

  async setPaused(input = {}, paused = true) {
    const watch = this.find(input);
    if (!watch) throw new Error("Watch not found");
    if (watch.status === "stopped") {
      throw new Error(`Stopped watches cannot be ${paused ? "paused" : "resumed"}. Start or reuse the watch first.`);
    }
    if (paused) {
      watch.status = "paused";
      watch.paused_at = this.now();
      watch.resumed_at = null;
    } else {
      watch.status = "watching";
      watch.resumed_at = this.now();
      watch.paused_at = null;
    }
    this.store?.updateWatchStatus?.(watch.watch_id, watch.status);
    return { watch, action: paused ? "pause" : "resume" };
  }

  async stop(input = {}) {
    const watch = this.find(input);
    if (!watch) throw new Error("Watch not found");
    const requestCount = this.capturesFor(watch).length;
    await this.closeWatch(watch);
    watch.status = "stopped";
    watch.stopped_at = this.now();
    if (input.clear) {
      this.active.delete(watch.id);
      this.metadata.deleteWatch?.(watch);
      this.store?.deleteWatch?.(watch.watch_id);
      return { watch, status: "cleared", cleared: true, requestCount };
    }
    this.store?.updateWatchStatus?.(watch.watch_id, watch.status);
    return { watch, status: watch.status, cleared: false, requestCount };
  }

  async closeWatch(watch) {
    if (!watch) return;
    if (watch.proxy_shared) {
      watch.proxy_closed = true;
      return;
    }
    if (watch.proxy_closed) return;
    await watch.proxy?.close?.();
    watch.proxy_closed = true;
  }

  capturesFor(input) {
    const watch = input?.watch_id ? input : this.find(typeof input === "object" ? input : { id: input, watch_id: input });
    if (!watch) return [];
    return (watch.proxy?.captures || []).filter((capture) => capture.watch_id === watch.watch_id);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    const proxies = new Set(
      [...this.active.values()]
        .filter((watch) => !watch.proxy_shared)
        .map((watch) => watch.proxy)
        .filter(Boolean),
    );
    if (this.sharedProxy) proxies.add(this.sharedProxy);
    this.closePromise = Promise.allSettled([...proxies].map((proxy) => proxy.close?.())).then(() => undefined);
    return this.closePromise;
  }

  async register(watch) {
    this.active.set(watch.id, watch);
    try {
      this.persistWatch(watch);
      return watch;
    } catch (error) {
      this.active.delete(watch.id);
      await this.closeWatch(watch);
      throw error;
    }
  }

  persistWatch(watch) {
    this.store?.upsertWatch?.(watch);
  }

  buildWatch(input) {
    return {
      paused_at: null,
      resumed_at: null,
      stopped_at: null,
      last_seen: null,
      last_response_seen: null,
      proxy_closed: false,
      ...input,
    };
  }

  async attachProxy(watch, captures) {
    if (this.sharedProxy) {
      this.sharedProxy.addCaptures?.(captures);
      watch.proxy = this.sharedProxy;
      watch.proxy_shared = true;
      watch.proxy_closed = false;
      watch.base_url = this.sharedProxy.urlForWatch(watch.watch_id);
      return;
    }
    const proxy = await this.startProxy({
      targetBaseUrl: watch.target_base_url,
      preserveTargetPathPrefix: true,
      captures,
      defaultAttribution: {
        watchId: watch.watch_id,
        agentProfile: watch.agent,
        workspace: watch.workspace,
        conversationId: watch.conversation_id,
      },
      shouldCapture: () => watch.status !== "paused",
      onCapture: (capture) => this.onCapture(capture, watch),
      onCaptureUpdate: (capture) => this.onCaptureUpdate(capture, watch),
      onCaptureSkipped: () => this.onCaptureSkipped(watch),
    });
    watch.proxy = proxy;
    watch.proxy_shared = false;
    watch.proxy_closed = false;
    watch.base_url = proxy.urlForWatch(watch.watch_id);
  }

  applyRestart(watch, input, targetBaseUrl) {
    watch.target_base_url = targetBaseUrl;
    watch.status = "watching";
    watch.proxy_closed = false;
    watch.restarted_at = this.now();
    watch.stopped_at = null;
    watch.paused_at = null;
    watch.provider_id = input.provider_id || watch.provider_id || null;
    watch.config_patched = Boolean(input.config_patched || watch.config_patched);
    watch.started_by = input.started_by || watch.started_by;
    if (input.conversation_id && !watch.conversation_id) watch.conversation_id = input.conversation_id;
  }

  touchFromCapture(watch, capture) {
    if (!watch || !capture) return;
    if (!watch.conversation_id && capture.conversation_id) {
      watch.conversation_id = capture.conversation_id;
      this.safePersistence("promote conversation metadata", () => this.metadata.promoteConversation?.(watch));
    }
    if (!watch.title) watch.title = this.inferCaptureTitle(capture) || null;
    watch.last_seen = capture.response?.received_at || capture.received_at || this.now();
    if (capture.response?.received_at) watch.last_response_seen = capture.response.received_at;
  }

  preferredTitle(source) {
    return this.metadata.preferredTitle?.(source) || null;
  }

  findReusableActive({ agent, mode, workspace, conversationId }) {
    if (!conversationId) return null;
    return [...this.active.values()].find(
      (watch) =>
        watch.agent === agent &&
        watch.mode === mode &&
        watch.workspace === workspace &&
        watch.conversation_id === conversationId,
    );
  }

  loadStoredWatch(id) {
    const watchId = normalizeWatchId(id);
    if (!watchId || !this.store) return null;
    if (typeof this.store.loadWatch === "function") return this.store.loadWatch(watchId);
    return this.store.listSources?.().find((source) => source.store_watch_id === watchId || source.id === id) || null;
  }

  findReusableStored(criteria) {
    if (!this.store) return null;
    if (typeof this.store.findReusableWatch === "function") return this.store.findReusableWatch(criteria);
    return (this.store.listSources?.() || [])
      .filter((source) => source.agent === criteria.agent)
      .filter((source) => (criteria.mode ? source.mode === criteria.mode || !source.mode : true))
      .filter((source) => source.workspace === criteria.workspace)
      .filter((source) => (criteria.conversationId ? source.conversation_id === criteria.conversationId : true))
      .sort((a, b) => Date.parse(b.last_seen || b.created_at || 0) - Date.parse(a.last_seen || a.created_at || 0))[0] || null;
  }

  safePersistence(action, fn) {
    try {
      return fn();
    } catch (error) {
      this.logger?.error?.(`peekMyAgent watch runtime failed to ${action}: ${error.message}`);
      return null;
    }
  }

  withLock(key, operation) {
    const current = this.operationLocks.get(key);
    if (current) return current;
    const promise = Promise.resolve().then(operation);
    this.operationLocks.set(key, promise);
    return promise.finally(() => {
      if (this.operationLocks.get(key) === promise) this.operationLocks.delete(key);
    });
  }
}

function normalizeWatchId(value) {
  const text = String(value || "");
  if (text.startsWith("stored-")) return text.slice("stored-".length);
  if (text.startsWith("live-")) return text.slice("live-".length);
  return text;
}

function defaultWatchId(agent) {
  return `${slugify(agent)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function slugify(value) {
  return String(value || "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "agent";
}

function missingTargetError(agent) {
  return new Error(
    `Missing upstream base URL for ${agent}. Set ANTHROPIC_BASE_URL for Claude Code or OPENAI_BASE_URL/OPENCLAW_BASE_URL for OpenClaw before starting the viewer.`,
  );
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== ""));
}
