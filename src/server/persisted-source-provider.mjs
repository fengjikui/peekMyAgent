export function listPersistedSources({ store, watches, titlePolicy = {} } = {}) {
  if (!store) return [];
  const activeWatchIds = new Set([...(watches?.values?.() || [])].map((watch) => watch.watch_id).filter(Boolean));
  return store
    .listSources()
    .filter((source) => !activeWatchIds.has(source.store_watch_id))
    .map((source) => decoratePersistedSourceTitle(source, { store, titlePolicy }));
}

export function decoratePersistedSourceTitle(source, { store, titlePolicy = {} } = {}) {
  const sanitizeTitle = functionOr(titlePolicy.sanitizeTitle, identityTitle);
  const cleanLabel = functionOr(titlePolicy.cleanLabel, identityTitle);
  const manualTitle = sanitizeTitle(call(titlePolicy.manualTitle, source));
  if (manualTitle) return { ...source, label: cleanLabel(manualTitle) || manualTitle, user_title: manualTitle };

  const storedTitle = sanitizeTitle(source.user_title);
  if (storedTitle) return { ...source, label: cleanLabel(storedTitle) || storedTitle, user_title: storedTitle };

  const conversationTitle = sanitizeTitle(call(titlePolicy.conversationTitle, source));
  if (conversationTitle) return { ...source, label: cleanLabel(conversationTitle) || conversationTitle, user_title: conversationTitle };

  const cleaned = cleanLabel(source.label);
  if (cleaned && !isGenericPersistedSourceLabel(cleaned, source, { modeLabel: titlePolicy.modeLabel })) {
    return { ...source, label: cleaned };
  }

  const captures = store?.loadInitialCaptures?.(source.store_watch_id, { limit: 5 }) || [];
  const inferTitle = functionOr(titlePolicy.inferCaptureTitle, () => null);
  const inferred = captures.map((capture) => sanitizeTitle(inferTitle(capture))).find(Boolean);
  if (inferred) return { ...source, label: inferred };
  return cleaned ? { ...source, label: cleaned } : source;
}

export function isGenericPersistedSourceLabel(label, source = {}, { modeLabel } = {}) {
  const value = String(label || "").trim();
  if (!value) return true;
  const agent = String(source.agent || "").trim();
  const mode = source.mode && typeof modeLabel === "function" ? modeLabel(source.mode) : "";
  const genericLabels = new Set(
    [
      agent && mode ? `${agent} · ${mode}` : "",
      agent && source.kind === "otel_raw_body" ? `${agent} · OTel` : "",
      "Claude Code · 监控一个会话",
      "Claude Code · OTel",
      "OpenClaw · 监控一个会话",
    ].filter(Boolean),
  );
  return genericLabels.has(value);
}

function call(value, source) {
  return typeof value === "function" ? value(source) : null;
}

function functionOr(value, fallback) {
  return typeof value === "function" ? value : fallback;
}

function identityTitle(value) {
  return String(value || "").trim();
}
