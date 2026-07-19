export const TIMELINE_WINDOW_THRESHOLD = 180;
export const TIMELINE_WINDOW_SIZE = 120;
export const TRACE_RESULT_PAGE_SIZE = 24;

const traceSearchTextCache = new WeakMap();

export function buildTraceTimelineView({
  turns,
  requests,
  query = "",
  filter = "all",
  resultLimit = TRACE_RESULT_PAGE_SIZE,
  latestOnly = false,
  activeId = null,
  requestExcerpt = defaultRequestExcerpt,
  windowThreshold = TIMELINE_WINDOW_THRESHOLD,
  windowSize = TIMELINE_WINDOW_SIZE,
} = {}) {
  const requestList = Array.isArray(requests) ? requests : [];
  const normalizedTurns = normalizeTimelineTurns(turns, requestList, requestExcerpt);
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const normalizedFilter = normalizeTraceFilter(filter);
  const queryActive = normalizedFilter !== "all" || Boolean(normalizedQuery);
  const filterCounts = traceFilterCounts(requestList);
  const matchCount = queryActive
    ? traceMatchingRequestCount({
        turns: normalizedTurns,
        requests: requestList,
        filter: normalizedFilter,
        query: normalizedQuery,
      })
    : filterCounts.all;
  const filteredTurns = queryActive
    ? filterTraceTurns({
        turns: normalizedTurns,
        requests: requestList,
        filter: normalizedFilter,
        query: normalizedQuery,
        resultLimit,
      })
    : normalizedTurns;
  const railTurns = queryActive || !latestOnly || filteredTurns.length <= 1 ? filteredTurns : [filteredTurns.at(-1)];

  return {
    query: normalizedQuery,
    filter: normalizedFilter,
    queryActive,
    filterCounts,
    matchCount,
    shownCount: queryActive ? Math.min(matchCount, Math.max(0, Number(resultLimit) || 0)) : matchCount,
    filteredTurns,
    railTurns,
    turnWindow: timelineWindow({
      turns: railTurns,
      activeId,
      latestOnly,
      threshold: windowThreshold,
      size: windowSize,
    }),
  };
}

export function normalizeTimelineTurns(turns, requests, requestExcerpt = defaultRequestExcerpt) {
  if (Array.isArray(turns) && turns.length) return turns;
  return fallbackTimelineTurns(requests, { requestExcerpt });
}

export function fallbackTimelineTurns(requests, { requestExcerpt = defaultRequestExcerpt } = {}) {
  return (Array.isArray(requests) ? requests : []).map((request, index) => ({
    id: `turn-${index + 1}`,
    index: index + 1,
    title: requestExcerpt(request),
    user_input: requestExcerpt(request),
    request_ids: [request.id],
    request_indexes: [request.request_index],
    first_request_index: request.request_index,
    last_request_index: request.request_index,
    request_count: 1,
    main_request_count: request.source_hint?.type === "metadata" ? 0 : 1,
    internal_request_count: request.source_hint?.type === "metadata" ? 1 : 0,
    subagent_count: traceRequestHasSubagentActivity(request) ? 1 : 0,
    parent_spawn_count: request.source_hint?.type === "parent_spawn" ? 1 : 0,
    tool_call_count: request.summary?.current_tool_calls?.length || 0,
    tool_result_count: request.summary?.current_tool_results?.length || 0,
    raw_body_bytes: request.counts?.raw_body_bytes || 0,
  }));
}

export function filterTraceTurns({ turns, requests, filter = "all", query = "", resultLimit = TRACE_RESULT_PAGE_SIZE } = {}) {
  const normalizedTurns = Array.isArray(turns) ? turns : [];
  const requestMap = new Map((Array.isArray(requests) ? requests : []).map((request) => [request.id, request]));
  const normalizedFilter = normalizeTraceFilter(filter);
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  let remaining = Math.max(0, Math.floor(Number(resultLimit) || 0));
  const matchedTurns = [];
  for (const turn of normalizedTurns) {
    const turnRequests = (turn.request_ids || []).map((id) => requestMap.get(id)).filter(Boolean);
    const matchedRequestIds = traceMatchingRequestIdsForTurn(turn, turnRequests, normalizedFilter, normalizedQuery);
    if (!matchedRequestIds.length || remaining <= 0) continue;
    const visibleRequestIds = matchedRequestIds.slice(0, remaining);
    remaining -= visibleRequestIds.length;
    matchedTurns.push({
      ...turn,
      all_request_ids: turn.request_ids,
      request_ids: visibleRequestIds,
      request_count: visibleRequestIds.length,
      trace_filter_active: true,
      trace_filter: normalizedFilter,
      trace_match_count: matchedRequestIds.length,
    });
  }
  return matchedTurns;
}

export function traceMatchingRequestCount({ turns, requests, filter = "all", query = "" } = {}) {
  const requestMap = new Map((Array.isArray(requests) ? requests : []).map((request) => [request.id, request]));
  const normalizedFilter = normalizeTraceFilter(filter);
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  let count = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    const turnRequests = (turn.request_ids || []).map((id) => requestMap.get(id)).filter(Boolean);
    count += traceMatchingRequestIdsForTurn(turn, turnRequests, normalizedFilter, normalizedQuery).length;
  }
  return count;
}

export function traceFilterCounts(requests) {
  const list = Array.isArray(requests) ? requests : [];
  return {
    all: list.length,
    issues: list.filter(traceRequestHasIssue).length,
    slow: list.filter(traceRequestIsSlow).length,
    tools: list.filter(traceRequestHasTools).length,
    subagents: list.filter(traceRequestHasSubagentActivity).length,
  };
}

export function traceFilterShowsMechanismStory(filter) {
  return filter === "tools" || filter === "subagents";
}

export function traceRequestHasSubagentActivity(request) {
  return Boolean(
    request?.is_subagent ||
      request?.summary?.entry?.kind === "subagent_result" ||
      request?.trace?.agent_branch ||
      request?.trace?.spawn_branch_ids?.length ||
      request?.trace?.launch_branch_ids?.length ||
      request?.trace?.returned_branch_ids?.length,
  );
}

export function traceRequestHasIssue(request) {
  const status = Number(request?.upstream_status ?? request?.summary?.response?.status ?? 0);
  if (status >= 400) return true;
  const evidence = [
    request?.summary?.entry?.text,
    request?.summary?.response?.preview,
    ...(request?.summary?.current_tool_results || []).map((result) => result.content),
  ]
    .filter(Boolean)
    .join("\n");
  return /(?:api error|\berror\b|exception|permission denied|timed? out|timeout|失败|报错|不可用)/i.test(evidence);
}

export function traceRequestIsSlow(request) {
  return Number(request?.summary?.response?.latency_ms || 0) >= 5000;
}

export function traceRequestHasTools(request) {
  return Boolean((request?.summary?.response?.tool_calls?.length || 0) + (request?.summary?.current_tool_results?.length || 0));
}

export function timelineWindow({ turns, activeId = null, latestOnly = false, threshold = TIMELINE_WINDOW_THRESHOLD, size = TIMELINE_WINDOW_SIZE } = {}) {
  const allTurns = Array.isArray(turns) ? turns : [];
  if (latestOnly || allTurns.length <= threshold) {
    return {
      turns: allTurns,
      allTurns,
      start: 0,
      end: allTurns.length,
      total: allTurns.length,
      windowed: false,
    };
  }
  const rawActiveIndex = allTurns.findIndex((turn) => turn.id === activeId);
  const activeIndex = rawActiveIndex >= 0 ? rawActiveIndex : 0;
  const normalizedSize = Math.max(1, Math.floor(Number(size) || TIMELINE_WINDOW_SIZE));
  const halfWindow = Math.floor(normalizedSize / 2);
  const maxStart = Math.max(0, allTurns.length - normalizedSize);
  const start = Math.min(Math.max(0, activeIndex - halfWindow), maxStart);
  const end = Math.min(allTurns.length, start + normalizedSize);
  return {
    turns: allTurns.slice(start, end),
    allTurns,
    start,
    end,
    total: allTurns.length,
    windowed: true,
  };
}

export function findTurnLeadRequest(requests, turn) {
  const turnKey = normalizeTurnDisplayText(turn?.user_input || turn?.title || "");
  return (
    (Array.isArray(requests) ? requests : []).find(
      (request) =>
        request?.source_hint?.type !== "metadata" &&
        !request?.is_subagent &&
        (Boolean(request?.summary?.command_message) ||
          (turnKey && normalizeTurnDisplayText(request?.summary?.current_user || "") === turnKey)),
    ) || null
  );
}

function traceMatchingRequestIdsForTurn(turn, turnRequests, filter, query) {
  const requestNumber = parseTraceRequestNumberQuery(query);
  const directMatches = turnRequests.filter(
    (request) =>
      traceRequestMatchesFilter(request, filter) &&
      (requestNumber != null
        ? Number(request?.request_index) === requestNumber
        : !query || traceSearchTextForRequest(request).includes(query)),
  );
  if (
    directMatches.length ||
    requestNumber != null ||
    !query ||
    filter !== "all" ||
    !traceSearchTextForTurn(turn).includes(query)
  ) {
    return directMatches.map((request) => request.id);
  }
  const lead = findTurnLeadRequest(turnRequests, turn) || turnRequests[0];
  return lead ? [lead.id] : [];
}

function parseTraceRequestNumberQuery(query) {
  const match = String(query || "").trim().match(/^#?(\d+)$/);
  if (!match) return null;
  const requestNumber = Number(match[1]);
  return Number.isSafeInteger(requestNumber) && requestNumber > 0 ? requestNumber : null;
}

function traceRequestMatchesFilter(request, filter) {
  if (filter === "issues") return traceRequestHasIssue(request);
  if (filter === "slow") return traceRequestIsSlow(request);
  if (filter === "tools") return traceRequestHasTools(request);
  if (filter === "subagents") return traceRequestHasSubagentActivity(request);
  return true;
}

function traceSearchTextForTurn(turn) {
  return [turn?.index, turn?.title, turn?.user_input, turn?.command_message?.command, turn?.command_message?.body]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function traceSearchTextForRequest(request) {
  if (!request || typeof request !== "object") return "";
  const cached = traceSearchTextCache.get(request);
  if (cached) return cached;
  const text = [
    request.request_index,
    request.summary?.entry?.label,
    request.summary?.entry?.text,
    request.summary?.assistant_preview,
    request.summary?.response?.text,
    request.summary?.response?.thinking_preview,
    ...(request.summary?.tool_names || []),
    ...(request.summary?.response?.tool_calls || []).flatMap((call) => [call.name, shortPreview(safeJson(call.arguments), 1000)]),
    ...(request.summary?.current_tool_results || []).map((result) => result.content),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  traceSearchTextCache.set(request, text);
  return text;
}

function normalizeTraceFilter(filter) {
  return ["all", "issues", "slow", "tools", "subagents"].includes(filter) ? filter : "all";
}

function normalizeTurnDisplayText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function defaultRequestExcerpt(request) {
  return (
    request?.summary?.current_user ||
    request?.summary?.entry?.text ||
    request?.summary?.assistant_preview ||
    `Request ${request?.request_index || ""}`
  );
}

function shortPreview(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
}
