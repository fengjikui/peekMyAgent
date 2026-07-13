export function buildAgentComposerView({
  source = null,
  sendState = {},
  translate,
  projectNameFromWorkspace = defaultProjectNameFromWorkspace,
  shortId = defaultShortId,
  cleanText = defaultCleanText,
  shortPreview = defaultShortPreview,
} = {}) {
  if (!source) return null;
  if (typeof translate !== "function") throw new Error("translate is required");

  const canSend = canSendToAgentSource(source);
  const watching = source.live_status === "watching";
  const supported = /claude|openclaw/i.test(source.agent || "");
  const loading = Boolean(sendState.loading);
  const enabled = canSend && watching && supported && !loading;
  const result = sendState.result || null;
  const statusText = composerTargetText(source, {
    canSend,
    watching,
    supported,
    translate,
    projectNameFromWorkspace,
    shortId,
  });
  const resultText = result
    ? agentSendResultText(result, { translate, cleanText, shortPreview })
    : "";
  const statusMessage = sendState.error || sendState.message || resultText;

  return {
    sourceId: source.id || "",
    agentLabel: source.agent || "Agent",
    enabled,
    loading,
    targetText: statusText,
    showResumeNote: supported && canSend,
    resumeNote: translate("sendViaResumeNote"),
    placeholder: enabled ? translate("composerPlaceholder") : statusText,
    buttonLabel: loading ? translate("sending") : translate("send"),
    statusMessage,
    statusError: Boolean(sendState.error || Number(result?.exit_code || 0)),
    draft: String(sendState.draft || ""),
  };
}

export function canSendToAgentSource(source) {
  if (!source) return false;
  if (source.live_watch_id) return true;
  return Boolean(
    source.store_watch_id &&
      source.conversation_id &&
      ["watching", "paused"].includes(source.live_status || ""),
  );
}

export function composerTargetText(
  source,
  { canSend, watching, supported, translate, projectNameFromWorkspace, shortId },
) {
  if (!canSend) return translate("sendUnavailable");
  if (!supported) return translate("sendUnsupported");
  if (!watching) return source?.live_status === "paused" ? translate("watchPaused") : translate("watchStopped");
  const project = source.project || projectNameFromWorkspace(source.workspace) || translate("currentProject");
  const conversation = source.conversation_id ? ` · ${shortId(source.conversation_id)}` : "";
  return `${project}${conversation}`;
}

export function agentSendResultText(result, { translate, cleanText, shortPreview }) {
  const code = Number(result?.exit_code || 0);
  if (!code) return translate("sent");
  const output = cleanText(result?.stderr || result?.stdout || "");
  const preview = output ? ` · ${shortPreview(output, 120)}` : "";
  return translate("sendFailed", { code, preview });
}

function defaultProjectNameFromWorkspace(workspace) {
  return String(workspace || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function defaultShortId(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function defaultCleanText(value) {
  return String(value || "").trim();
}

function defaultShortPreview(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}
