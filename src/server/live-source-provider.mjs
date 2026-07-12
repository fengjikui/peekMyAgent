export function listLiveSources({ watches, capturesForWatch, resolveLabel } = {}) {
  if (!watches) return [];
  if (typeof capturesForWatch !== "function") throw new Error("capturesForWatch is required");
  return [...watches.values()].map((watch) => liveSourceSummary(watch, { capturesForWatch, resolveLabel }));
}

export function liveSourceSummary(watch, { capturesForWatch, resolveLabel } = {}) {
  if (!watch || typeof watch !== "object") throw new Error("watch is required");
  if (typeof capturesForWatch !== "function") throw new Error("capturesForWatch is required");
  const captures = capturesForWatch(watch) || [];
  const resolvedLabel = typeof resolveLabel === "function" ? resolveLabel(watch, captures) : null;
  return {
    id: watch.id,
    label: resolvedLabel || watch.label,
    user_title: watch.title || null,
    original_label: watch.label,
    agent: watch.agent,
    mode: watch.mode,
    confidence: watch.confidence,
    kind: watch.kind,
    path: watch.base_url,
    available: true,
    live_watch_id: watch.watch_id,
    live_status: watch.status,
    conversation_id: watch.conversation_id,
    provider_id: watch.provider_id,
    config_patched: watch.config_patched,
    note: watch.note,
    request_count: captures.length,
    workspace: watch.workspace,
    created_at: watch.created_at,
    restarted_at: watch.restarted_at || null,
    paused_at: watch.paused_at || null,
    resumed_at: watch.resumed_at || null,
    stopped_at: watch.stopped_at || null,
    last_seen: watch.last_seen || captures.at(-1)?.received_at || watch.restarted_at || watch.created_at,
    skipped_while_paused: Number(watch.skipped_while_paused) || 0,
    response_count: captures.filter((capture) => capture.response).length,
    last_response_seen: watch.last_response_seen || latestResponseSeen(captures),
    subagent_count: captures.filter((capture) => headerValue(capture.headers, "x-claude-code-agent-id")).length,
    raw_body_bytes: captures.reduce((sum, capture) => sum + (Number(capture.raw_body_length) || jsonByteLength(capture.body)), 0),
  };
}

function latestResponseSeen(captures) {
  return captures
    .map((capture) => capture.response?.received_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === String(name).toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}
