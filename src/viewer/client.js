import { renderMarkdownPreview, renderSafeMarkdown } from "./markdown.js";
import { AgentComposerController } from "./agent-composer-controller.js";
import { buildRawSectionEvidenceView, buildRequestEvidenceView } from "./evidence-view-model.js";
import {
  renderMessagesControls as renderMessagesControlsView,
  renderMessagesSection as renderMessagesSectionView,
} from "./messages-renderer.js";
import { messageTimelineRequestIndexes, responseConversationMessages } from "./message-view-model.js";
import { ViewerApiClient } from "./api-client.js";
import { ViewerClientStore } from "./client-store.js";
import { AGENT_BRANCH_PAGE_SIZE, buildAgentGraphView } from "./agent-graph-model.js";
import { renderAgentGraph as renderAgentGraphView } from "./agent-graph-renderer.js";
import { RequestDetailCache, requestNeedsDetail } from "./request-detail-cache.js";
import { SourceTimelineController } from "./source-timeline-controller.js";
import { ActiveSourceController } from "./active-source-controller.js";
import {
  buildTranslationLookup as buildTranslationLookupView,
  TranslationCacheController,
  translationAgentCandidatesForData,
} from "./translation-cache-controller.js";
import { TranslationActionController } from "./translation-action-controller.js";
import {
  renderTimelineAssistantResponse as renderTimelineAssistantResponseView,
  renderTimelineRequestCard as renderTimelineRequestCardView,
  renderTimelineToolExchange as renderTimelineToolExchangeView,
  renderTimelineUpstreamEntry as renderTimelineUpstreamEntryView,
  renderTimelineUpstreamQuickActions as renderTimelineUpstreamQuickActionsView,
} from "./request-card-renderer.js";
import {
  buildTimelineAssistantResponseView,
  buildTimelineRequestIdentity,
  buildTimelineToolExchangeView,
  buildTimelineTurnInputView,
  buildTimelineUpstreamView,
  commandMessageLabel as timelineCommandMessageLabel,
  commandMessagePreview as timelineCommandMessagePreview,
  isPrimaryTimelineRequest,
  isTimelineSemanticEvent,
  isTimelineResponseRequest,
  shouldShowTimelineAssistantResponse,
  shouldShowTimelineRequestContent as requestShowsTimelineContent,
  timelineMessageKindLabel,
  timelineUpstreamQuickSections,
} from "./request-card-model.js";
import {
  requestHasSemanticEvent,
  requestUsesReconstructedUpstream,
  responseUsesReconstructedDownstream,
  rawResponseSectionValue,
  rawSectionData as buildRawSectionData,
} from "./raw-view-model.js";
import {
  collectRawSearchEntries,
  filterRawSearchEntries,
  rawSearchSnippetSegments,
} from "./raw-search-model.js";
import { RawSearchController } from "./raw-search-controller.js";
import { RawInspectorController } from "./raw-inspector-controller.js";
import { buildSystemDiffModel } from "./system-diff-model.js";
import { renderSystemDiffView } from "./system-diff-renderer.js";
import { SessionNavigatorController } from "./session-navigator-controller.js";
import { PaneLayoutController } from "./pane-layout-controller.js";
import { LanguagePreferencesController } from "./language-preferences-controller.js";
import {
  renderRawDetail as renderRawDetailView,
  renderRawSearchControls as renderRawSearchControlsView,
  renderRawSearchResults as renderRawSearchResultsView,
  renderRawSectionEvidence as renderRawSectionEvidenceView,
  renderRawSourceNotice,
  renderRawStickyControls as renderRawStickyControlsView,
  renderRequestDetailError as renderRequestDetailErrorView,
  renderRequestDetailLoading as renderRequestDetailLoadingView,
  renderRequestRawNavigation,
  renderResponseRawNavigation,
} from "./raw-inspector-renderer.js";
import {
  renderTranslationControls as renderTranslationControlsView,
  renderTranslationSection as renderTranslationSectionView,
} from "./translation-renderer.js";
import {
  buildTranslationSectionView,
  translationSectionStats as summarizeTranslationSection,
} from "./translation-view-model.js";
import { TurnRailController } from "./turn-rail.js";
import { buildTurnStoryView } from "./turn-story-model.js";
import { renderTurnStory as renderTurnStoryView } from "./turn-story-renderer.js";
import {
  buildTraceTimelineView,
  findTurnLeadRequest,
  TRACE_RESULT_PAGE_SIZE,
  traceFilterShowsMechanismStory,
} from "./trace-timeline-model.js";
import { TraceTimelineController } from "./trace-timeline-controller.js";
import {
  renderEmptyTimeline as renderEmptyTimelineView,
  renderTraceNoResults as renderTraceNoResultsView,
  renderTraceQueryBar as renderTraceQueryBarView,
  renderTurnTimeline as renderTurnTimelineView,
} from "./trace-timeline-renderer.js";
import { buildUpstreamDetailView } from "./upstream-detail-model.js";
import { renderUpstreamDetail as renderUpstreamDetailView } from "./upstream-detail-renderer.js";
import {
  normalizeTranslationSourceText as normalizeTranslationText,
  sanitizeTranslationOutput,
  translationLookupKey,
} from "./translation-blocks.js";
import { extractRequestMessages } from "../shared/request-payload.mjs";
import {
  extractContentText,
  extractHarnessTranslationParts,
  translationMaterialsForRequest,
} from "./translation-materials.js";

const api = new ViewerApiClient();
const clientStore = new ViewerClientStore();
const state = Object.assign(clientStore.state, {
  sources: [],
  data: null,
  sessionInfoControlsBound: false,
  responseExpanded: new Set(),
  upstreamExpanded: new Set(),
  translationGenerate: { loading: false, error: "", message: "" },
  expandedAgentBranches: new Set(),
  openAgentDashboards: new Set(),
  openSupportingTimelines: new Set(),
  agentBranchLimits: new Map(),
  agentBranchFilters: new Map(),
  traceQuery: "",
  traceFilter: "all",
  traceResultLimit: 24,
});

const LIVE_REFRESH_MS = 1200;
const LATEST_ONLY_KEY = "peekmyagent.latestOnly";
const RAW_MESSAGES_MODE_KEY = "peekmyagent.rawMessagesMode";
const INITIAL_SOURCE_REQUEST_LIMIT = 32;
const CURSOR_PAGE_REQUEST_LIMIT = 100;
const PROGRESSIVE_SOURCE_MIN_REQUESTS = 72;
const els = {
  appShell: document.querySelector(".app-shell"),
  toggleSidebar: document.querySelector("#toggleSidebar"),
  rawToggle: document.querySelector("#rawToggle"),
  traceImportButton: document.querySelector("#traceImportButton"),
  traceImportInput: document.querySelector("#traceImportInput"),
  uiLanguageSelect: document.querySelector("#uiLanguageSelect"),
  translationLanguageSelect: document.querySelector("#translationLanguageSelect"),
  sessionNav: document.querySelector("#sessionNav"),
  pageTitle: document.querySelector("#pageTitle"),
  stats: document.querySelector("#stats"),
  viewControls: document.querySelector("#viewControls"),
  mainPanel: document.querySelector(".main-panel"),
  sidebarResizer: document.querySelector("#sidebarResizer"),
  watchSummary: document.querySelector("#watchSummary"),
  traceQueryBar: document.querySelector("#traceQuery"),
  timeline: document.querySelector("#timeline"),
  agentComposer: document.querySelector("#agentComposer"),
  turnRail: document.querySelector("#turnRail"),
  sessionInfoModal: document.querySelector("#sessionInfoModal"),
  sessionInfoBody: document.querySelector("#sessionInfoBody"),
  rawPanel: document.querySelector("#rawPanel"),
  rawResizer: document.querySelector("#rawResizer"),
  rawTitle: document.querySelector("#rawTitle"),
  rawTree: document.querySelector("#rawTree"),
};

const languagePreferencesController = new LanguagePreferencesController({
  store: clientStore,
  storage: localStorage,
  documentTarget: document,
  navigatorTarget: navigator,
  uiSelect: els.uiLanguageSelect,
  translationSelect: els.translationLanguageSelect,
  escapeHtml,
  async onUiLanguageChanged() {
    paneLayoutController.refreshLabels();
    if (state.data) renderAll();
    if (state.activeRequestId) rawInspectorController.refresh();
  },
  onTargetLanguageChanging() {
    translationActionController.invalidate();
    translationCacheController.clearAutoRefreshAttempts();
  },
  async onTargetLanguageChanged() {
    await loadTranslationsForActiveSource();
    if (state.data) renderAll();
    if (state.activeRequestId) rawInspectorController.refresh();
  },
  onWarning: (message, error) => console.warn(`peekMyAgent ${message}`, error),
});

const turnRailController = new TurnRailController({
  element: els.turnRail,
  mainPanel: els.mainPanel,
  getTurns: () => railTurnUniverse(),
  getActiveId: () => state.activeId,
  hasData: () => Boolean(state.data?.requests?.length),
  titleFor: turnTitleText,
  excerptFor: turnExcerptText,
  translate: t,
  escapeHtml,
  onJump: jumpToTurn,
  onActiveChange: markActiveTurn,
});
const traceTimelineController = new TraceTimelineController({
  queryElement: els.traceQueryBar,
  timelineElement: els.timeline,
  onQueryChange(value) {
    state.traceQuery = value;
    state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
  },
  onRenderRequested() {
    renderTimelineSurface();
  },
  onFilter(filter) {
    state.traceFilter = filter;
    state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
    const filteredTurns = currentTimelineView().filteredTurns;
    if (!filteredTurns.some((turn) => turn.id === state.activeId)) {
      clientStore.setSelection({ activeId: filteredTurns[0]?.id || null }, { reason: "filter-trace" });
    }
    renderTimelineSurface();
  },
  onShowMore() {
    state.traceResultLimit += TRACE_RESULT_PAGE_SIZE;
    renderTimelineSurface();
  },
  onResponseToggle: toggleResponseExpansion,
  onUpstreamToggle: toggleUpstreamDetails,
  onUpstreamPanelToggle: syncUpstreamDetailsState,
  onTurnWindowJump(turnId) {
    jumpToTurn(turnId, true);
  },
  onRaw({ requestId, section, mode }) {
    rawInspectorController.show(requestId, section, { mode });
  },
  onRequestJump: jumpToRequest,
  onAgentBranchJump: jumpToAgentBranch,
  onAgentBranchToggle: toggleAgentBranch,
  onSupportingTimelineToggle(turnId) {
    if (state.openSupportingTimelines.has(turnId)) state.openSupportingTimelines.delete(turnId);
    else state.openSupportingTimelines.add(turnId);
    renderTimelineSurface();
  },
  onAgentDashboardToggle(turnId) {
    if (state.openAgentDashboards.has(turnId)) state.openAgentDashboards.delete(turnId);
    else state.openAgentDashboards.add(turnId);
    renderTimelineSurface();
  },
  onAgentBranchMore(turnId) {
    const current = state.agentBranchLimits.get(turnId) || AGENT_BRANCH_PAGE_SIZE;
    state.agentBranchLimits.set(turnId, current + AGENT_BRANCH_PAGE_SIZE);
    renderTimelineSurface();
  },
  onAgentStatusFilter({ turnId, filter }) {
    state.agentBranchFilters.set(turnId, filter);
    state.agentBranchLimits.set(turnId, AGENT_BRANCH_PAGE_SIZE);
    renderTimelineSurface();
  },
  onSystemDiff: showSystemDiff,
});
let requestDetailCache;
let translationActionController;
const sourceTimelineController = new SourceTimelineController({
  loadView: (sourceId, options) => api.viewSource(sourceId, options),
  detailFor: (requestId) => requestDetailCache?.detailFor(requestId) || null,
  yieldControl: () => new Promise((resolve) => window.setTimeout(resolve, 24)),
  initialLimit: INITIAL_SOURCE_REQUEST_LIMIT,
  cursorLimit: CURSOR_PAGE_REQUEST_LIMIT,
  progressiveThreshold: PROGRESSIVE_SOURCE_MIN_REQUESTS,
  onWarning: (message, error) => console.warn(`peekMyAgent ${message}`, error),
});
const translationCacheController = new TranslationCacheController({
  loadCache: (agent, targetLanguage) => api.translations(agent, targetLanguage),
  buildLookup: (requests, translations) =>
    buildTranslationLookupView({
      requests,
      translations,
      collectMaterials: collectTranslationMaterials,
      hashMaterial: window.crypto?.subtle ? materialHash : null,
      lookupKey: translationLookupKey,
      normalizeText: normalizeTranslationText,
    }),
  schedule: (callback) => window.setTimeout(callback, 0),
  onAutoRefresh: (context) => {
    translationActionController?.generateSection(state.activeRawSection || "tools", { automatic: true, ...context }).catch((error) => {
      console.warn("peekMyAgent auto translation refresh failed", error);
    });
  },
  isGenerationBusy: () => translationActionController?.loading || false,
  onWarning: (message, error) => console.warn(`peekMyAgent ${message}`, error),
});
requestDetailCache = new RequestDetailCache({
  loadDetail: async (sourceId, requestId) => (await api.requestDetail(sourceId, requestId)).request,
  onLoaded: async (fullRequest) => {
    const { request, data } = sourceTimelineController.mergeRequestDetail(fullRequest);
    if (data) state.data = data;
    await rebuildTranslationLookupForCurrentData();
    return request;
  },
  onCached: (fullRequest) => {
    const { request, data } = sourceTimelineController.mergeRequestDetail(fullRequest);
    if (data) state.data = data;
    return request;
  },
});
translationActionController = new TranslationActionController({
  getContext: () => ({
    sourceId: state.data?.source?.id || state.activeSourceId || "",
    targetLanguage: currentTargetLanguage(),
    targetLanguageLabel: currentTargetLanguageLabel(),
    agent: translationAgentCandidatesForData(state.data)[0] || "Claude Code",
    activeSection: state.activeRawSection || "system",
    requestId: state.activeRequestId || "",
    rawMode: state.activeRawMode || "request",
  }),
  getGenerationState: () => state.translationGenerate,
  setGenerationState: (next) => {
    state.translationGenerate = next;
  },
  cache: {
    captureOperation: (context) => translationCacheController.captureOperation(context),
    isOperationCurrent: (operation) => translationCacheController.isOperationCurrent(operation),
    reload: () => loadTranslationsForActiveSource({ autoRefresh: false }),
    isAvailable: () => translationCacheController.available,
  },
  data: {
    ensureRequestDetail: ensureRequestDetailLoaded,
    requestFor: currentRequestById,
    sectionMaterials: sectionTranslationMaterials,
    sectionStats: translationSectionStats,
  },
  api: {
    generateTranslations: (payload) => api.generateTranslations(payload),
  },
  ui: {
    translate: t,
    translatedTextFor,
    labelForKind: translationKindLabel,
    sectionLabel: rawSectionLabel,
    copyText: writeClipboard,
    renderRaw: (requestId, section, mode) =>
      rawSearchController.isComposing() ? false : rawInspectorController.show(requestId, section, { mode }),
    renderTimeline: () => renderTimelineSurface(),
    setTranslationMode: (mode, { reason }) => {
      languagePreferencesController.setTranslationMode(mode, { reason });
    },
    warn: (message, error) => console.warn(`peekMyAgent ${message}`, error),
  },
});
const rawSearchController = new RawSearchController({
  root: els.rawTree,
  translate: t,
  getContext: () => ({
    requestId: state.activeRequestId,
    section: state.activeRawSection,
    mode: state.activeRawMode || "request",
  }),
  render: ({ requestId, section, mode }) => {
    rawInspectorController.show(requestId, section, { mode });
  },
});
const sessionNavigatorController = new SessionNavigatorController({
  element: els.sessionNav,
  documentTarget: document,
  storage: localStorage,
  translate: t,
  escapeHtml,
  projectNameFromWorkspace,
  projectGroupKey,
  displaySourceLabel,
  shortId,
  onSourceSelect: loadSource,
  onFamilySelect: ({ sources }) => {
    const preferred = sources.find((source) => source.available) || sources[0];
    if (preferred && preferred.id !== state.activeSourceId) void loadSource(preferred.id);
  },
  onSourceAction: ({ action, source }) => handleSourceAction(action, source),
  onProjectAction: ({ action, projectGroup }) => handleProjectAction(action, projectGroup),
});
const agentComposerController = new AgentComposerController({
  element: els.agentComposer,
  sendMessage: (payload) => api.sendAgent(payload),
  refreshSource: loadSource,
  translate: t,
  escapeHtml,
  projectNameFromWorkspace,
  shortId,
  cleanText: cleanDisplayText,
  shortPreview,
});
const paneLayoutController = new PaneLayoutController({
  appShell: els.appShell,
  rawPanel: els.rawPanel,
  rawResizer: els.rawResizer,
  rawToggle: els.rawToggle,
  sidebarResizer: els.sidebarResizer,
  sidebarToggle: els.toggleSidebar,
  documentTarget: document,
  windowTarget: window,
  storage: localStorage,
  getLayoutState: () => state,
  setLayout: (patch, options) => clientStore.setLayout(patch, options),
  translate: t,
  onLayoutChanged: () => turnRailController.scheduleActiveSync(),
  onWindowResize: renderTurnRail,
});
const rawInspectorController = new RawInspectorController({
  root: els.rawTree,
  titleElement: els.rawTitle,
  getRequest: currentRequestById,
  getContext: () => ({
    requestId: state.activeRequestId,
    section: state.activeRawSection,
    mode: state.activeRawMode || "request",
  }),
  setContext: (context) => clientStore.setRawContext(context, { reason: "show-raw" }),
  onContextChanged: () => rawSearchController.contextChanged(),
  clearActions: () => translationActionController.clearActions("raw"),
  openPanel: () => paneLayoutController.setRawOpen(true),
  needsDetail: (request, section) =>
    requestNeedsDetail(request) || (section === "system_diff" && requestNeedsDetail(previousRequest(request))),
  loadDetails: (request, section) => ensureDetailsForRawSection(request, section),
  titleFor: (request, section, mode) =>
    requestHasSemanticEvent(request)
      ? `${t("rawEventTitle", { index: request.request_index })} · ${rawSectionLabel(section, request)}`
      : `Request ${request.request_index} · ${mode === "response" ? responseRawSectionLabel(section, request) : rawSectionLabel(section, request)}`,
  renderLoading: () => renderRequestDetailLoading(),
  renderContent: (request, section, mode) => renderRawSections(request, section, mode),
  renderError: (error) => renderRequestDetailError(error),
  decorate: () => rawSearchController.decorate(),
  canRefresh: () => !rawSearchController.isComposing(),
});
const activeSourceController = new ActiveSourceController({
  timeline: sourceTimelineController,
  listSources: () => api.listSources(),
  getContext: () => ({
    sources: state.sources,
    activeSourceId: state.activeSourceId,
    data: state.data,
  }),
  setSources(sources, { render }) {
    state.sources = sources;
    if (render) renderSessionNav();
  },
  resetSourceContext: resetActiveSourceContext,
  captureScroll: captureMainPanelScroll,
  setData(data) {
    state.data = data;
  },
  presentLoadedData: applyLoadedSourceData,
  presentRefreshedData: applyRefreshedSourceData,
  loadTranslations: (data) => loadTranslationsForActiveSource({ data }),
  refreshRaw() {
    if (state.activeRequestId && !els.rawTree.classList.contains("empty")) rawInspectorController.refresh();
  },
  renderData: () => renderAll(),
  isHidden: () => document.hidden,
  scheduleInterval: (callback, delay) => window.setInterval(callback, delay),
  cancelInterval: (timer) => window.clearInterval(timer),
  refreshIntervalMs: LIVE_REFRESH_MS,
  onWarning: (message, error) => console.warn(`peekMyAgent ${message}`, error),
});
clientStore.subscribe((change) => {
  if (change.changedKeys.includes("activeId")) syncActiveTurnDom(change.state.activeId);
  if (change.changedKeys.includes("activeRequestId")) syncActiveRequestDom(change.state.activeRequestId);
});

init();

function normalizeMessagesMode(value) {
  return value === "source" ? "source" : "organized";
}

function currentTargetLanguage() {
  return languagePreferencesController.currentTargetLanguage();
}

function currentTargetLanguageLabel() {
  return languagePreferencesController.currentTargetLanguageLabel();
}

function t(key, vars = {}) {
  return languagePreferencesController.translate(key, vars);
}

async function init() {
  const layoutPreferences = paneLayoutController.readPreferences();
  clientStore.update(
    {
      ...layoutPreferences,
      ...languagePreferencesController.readPreferences(),
      latestOnly: localStorage.getItem(LATEST_ONLY_KEY) === "true",
      rawMessagesMode: normalizeMessagesMode(localStorage.getItem(RAW_MESSAGES_MODE_KEY)),
    },
    { reason: "hydrate-preferences", silent: true },
  );
  languagePreferencesController.applyStaticI18n();
  languagePreferencesController.renderSelectors();
  paneLayoutController.applyCurrentState({ persist: false });
  const requestedSource = new URLSearchParams(window.location.search).get("source");
  await activeSourceController.initialize(requestedSource);
  els.traceImportButton?.addEventListener("click", () => els.traceImportInput?.click());
  els.traceImportInput?.addEventListener("change", importTraceFromFile);
  languagePreferencesController.bind();
  rawSearchController.bind();
  traceTimelineController.bind();
  els.rawTree.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (retranslateButton && els.rawTree.contains(retranslateButton)) {
      event.preventDefault();
      event.stopPropagation();
      translationActionController.retranslate(retranslateButton.dataset.translationRetranslate);
      return;
    }
    const translationButton = event.target.closest("[data-translation-mode]");
    if (translationButton && els.rawTree.contains(translationButton)) {
      setTranslationMode(translationButton.dataset.translationMode || "source", translationButton.dataset.translationSection || "system");
      return;
    }
    const messagesModeButton = event.target.closest("[data-messages-mode]");
    if (messagesModeButton && els.rawTree.contains(messagesModeButton)) {
      setMessagesMode(messagesModeButton.dataset.messagesMode || "organized");
      return;
    }
    const generateButton = event.target.closest("[data-translation-generate]");
    if (generateButton && els.rawTree.contains(generateButton)) {
      translationActionController.generateSection(generateButton.dataset.translationSection || "system");
      return;
    }
    const copyButton = event.target.closest("[data-translation-copy]");
    if (copyButton && els.rawTree.contains(copyButton)) {
      event.preventDefault();
      event.stopPropagation();
      translationActionController.copyBlock(copyButton.dataset.translationCopy, copyButton);
      return;
    }
    const copyAllButton = event.target.closest("[data-translation-copy-all]");
    if (copyAllButton && els.rawTree.contains(copyAllButton)) {
      event.preventDefault();
      event.stopPropagation();
      translationActionController.copySection(copyAllButton.dataset.translationCopyAll, copyAllButton);
      return;
    }
    const button = event.target.closest("[data-raw]");
    if (!button || !els.rawTree.contains(button)) return;
    rawInspectorController.show(button.dataset.raw, button.dataset.rawSection || "full", { mode: button.dataset.rawMode || "request" });
  });
  document.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (!retranslateButton || els.rawTree.contains(retranslateButton)) return;
    event.preventDefault();
    event.stopPropagation();
    translationActionController.retranslate(retranslateButton.dataset.translationRetranslate);
  });
  turnRailController.bind();
  paneLayoutController.bind();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) activeSourceController.refreshLiveData({ force: true });
  });
  activeSourceController.startAutoRefresh();
}

function loadSource(sourceId, options = {}) {
  return activeSourceController.loadSource(sourceId, options);
}

function resetActiveSourceContext() {
  rawInspectorController.invalidate();
  requestDetailCache.clear();
  translationActionController.invalidate();
  translationCacheController.invalidate();
  state.openSupportingTimelines.clear();
  state.openAgentDashboards.clear();
  state.expandedAgentBranches.clear();
  state.agentBranchLimits.clear();
  state.agentBranchFilters.clear();
  state.traceQuery = "";
  state.traceFilter = "all";
  state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
}

function captureMainPanelScroll() {
  const gap = els.mainPanel.scrollHeight - els.mainPanel.scrollTop - els.mainPanel.clientHeight;
  return {
    scrollTop: els.mainPanel.scrollTop,
    nearBottom: gap < 160,
  };
}

function applyRefreshedSourceData(data, { wasNearBottom = false, scrollTop = 0 } = {}) {
  const turnIds = activeTurnIds(data);
  const activeId = turnIds.includes(state.activeId) ? state.activeId : turnIds.at(-1) || null;
  const activeRequestId = data.requests.some((request) => request.id === state.activeRequestId)
    ? state.activeRequestId
    : data.requests.at(-1)?.id || data.requests[0]?.id || null;
  clientStore.setSelection(
    { activeSourceId: data.source.id, activeId, activeRequestId },
    { reason: "refresh-source" },
  );
  renderAll();
  if (wasNearBottom) {
    els.mainPanel.scrollTop = els.mainPanel.scrollHeight;
  } else {
    els.mainPanel.scrollTop = scrollTop;
  }
  turnRailController.scheduleActiveSync();
}

function applyLoadedSourceData(data, { preserveScroll = false, scrollTop = 0 } = {}) {
  state.data = data;
  const turnIds = activeTurnIds(data);
  const activeId = preserveScroll && turnIds.includes(state.activeId) ? state.activeId : turnIds[0] || null;
  const activeRequestId =
    preserveScroll && data.requests.some((request) => request.id === state.activeRequestId)
      ? state.activeRequestId
      : data.requests[0]?.id || null;
  clientStore.setSelection(
    { activeSourceId: data.source.id, activeId, activeRequestId },
    { reason: "load-source" },
  );
  const url = new URL(window.location.href);
  url.searchParams.set("source", state.activeSourceId);
  window.history.replaceState(null, "", url);
  renderAll();
  if (preserveScroll) els.mainPanel.scrollTop = scrollTop;
  else els.mainPanel.scrollTop = 0;
  turnRailController.scheduleActiveSync();
}

function currentRequestById(requestId) {
  return sourceTimelineController.currentRequest(requestId);
}

async function ensureRequestDetailLoaded(requestId) {
  const request = currentRequestById(requestId);
  if (!request) return null;
  const sourceId = state.data?.source?.id || state.activeSourceId || "";
  return requestDetailCache.ensure(sourceId, request);
}

async function ensureDetailsForRawSection(request, section) {
  await ensureRequestDetailLoaded(request.id);
  if (section === "system_diff") {
    const previous = previousRequest(currentRequestById(request.id) || request);
    if (previous) await ensureRequestDetailLoaded(previous.id);
  }
  return currentRequestById(request.id) || request;
}

async function rebuildTranslationLookupForCurrentData() {
  await translationCacheController.refreshLookup(state.data?.requests || []);
}

async function loadTranslationsForActiveSource({ autoRefresh = true, data = state.data } = {}) {
  const sourceId = data?.source?.id || state.activeSourceId || "";
  return translationCacheController.loadContext(
    {
      sourceId,
      targetLanguage: currentTargetLanguage(),
      agents: translationAgentCandidatesForData(data),
      requests: data?.requests || [],
      getRequests: () =>
        state.data?.source?.id === sourceId ? state.data?.requests || [] : data?.requests || [],
    },
    { autoRefresh },
  );
}

function flashButtonLabel(button, text) {
  if (!button) return;
  const original = button.dataset.copyOriginalLabel || button.textContent;
  button.dataset.copyOriginalLabel = original;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = button.dataset.copyOriginalLabel || original;
  }, 1400);
}

async function writeClipboard(text, button) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    flashButtonLabel(button, t("copied"));
  } catch (error) {
    console.warn("peekMyAgent clipboard copy failed", error);
    flashButtonLabel(button, t("copyFailed"));
  }
}

function sectionTranslationMaterials(request, section) {
  if (!["system", "tools", "harness"].includes(section)) return [];
  return translationMaterialsForRequest(request, {
    section,
    extractHarnessParts: extractClientHarnessTranslationParts,
  });
}

function setTranslationMode(mode, section) {
  languagePreferencesController.setTranslationMode(mode);
  rawSearchController.modeChanged();
  if (state.activeRequestId) rawInspectorController.show(state.activeRequestId, section || state.activeRawSection || "full", { mode: state.activeRawMode || "request" });
}

function setMessagesMode(mode) {
  clientStore.setRawView({ rawMessagesMode: normalizeMessagesMode(mode) }, { reason: "set-messages-mode" });
  localStorage.setItem(RAW_MESSAGES_MODE_KEY, state.rawMessagesMode);
  if (state.activeRequestId) {
    rawInspectorController.show(state.activeRequestId, state.activeRawSection || "history", {
      mode: state.activeRawMode || "request",
    });
  }
}

function renderSessionNav() {
  sessionNavigatorController.render({
    sources: state.sources,
    activeSourceId: state.activeSourceId,
  });
}

async function handleSourceAction(action, source) {
  if (action === "pin") {
    await updateSourceMeta(source.id, { pinned: !source.pinned });
    return;
  }
  if (action === "rename") {
    const title = window.prompt(t("renameSessionPrompt"), source.user_title || source.label);
    if (title == null) return;
    await updateSourceMeta(source.id, { title });
    return;
  }
  if (action === "export") {
    exportTraceSource(source.id);
    return;
  }
  if (action === "archive" || action === "remove") {
    const message =
      source.live_watch_id && source.live_status === "watching"
        ? t("archiveLiveConfirm")
        : t("archiveStaticConfirm");
    if (!window.confirm(message)) return;
    await updateSourceMeta(source.id, { archive: true });
    return;
  }
  if (action === "delete") {
    const message =
      source.live_watch_id && source.live_status === "watching"
        ? t("deleteLiveConfirm")
        : t("deleteStaticConfirm");
    if (!window.confirm(message)) return;
    await updateSourceMeta(source.id, { delete: true });
  }
}

async function handleProjectAction(action, projectGroup) {
  const count = projectGroup.sources.length;
  const project = projectGroup.project;
  if (action === "archive") {
    if (!window.confirm(t("archiveProjectConfirm", { project, count }))) return;
    await updateProjectSources(projectGroup, { archive: true });
    return;
  }
  if (action === "delete") {
    if (!window.confirm(t("deleteProjectConfirm", { project, count }))) return;
    await updateProjectSources(projectGroup, { delete: true });
  }
}

async function exportTraceSource(sourceId) {
  if (!window.confirm(t("exportTraceConfirm"))) return;
  try {
    const response = await api.exportTrace(sourceId);
    const blob = await response.blob();
    const link = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = contentDispositionFileName(response.headers.get("content-disposition")) || "peekmyagent-trace.peektrace.json.gz";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    window.alert(t("exportTraceFailed", { message: error.message }));
  }
}

async function importTraceFromFile(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const response = await api.importTrace(await file.arrayBuffer(), file.name);
    activeSourceController.acceptSources(response.sources || (await api.listSources()), {
      render: true,
      reason: "import-trace",
    });
    if (response.source_id) await loadSource(response.source_id);
  } catch (error) {
    window.alert(t("importTraceFailed", { message: error.message }));
  }
}

async function updateSourceMeta(sourceId, payload) {
  try {
    const response = await api.updateSource({ id: sourceId, ...payload });
    activeSourceController.acceptSources(response.sources || (await api.listSources()), {
      render: false,
      reason: "update-source-meta",
    });
  } catch (error) {
    console.warn("peekMyAgent source update failed", error);
    window.alert(t("sourceUpdateFailed", { message: error.message }));
    activeSourceController.acceptSources(await api.listSources(), {
      render: true,
      reason: "recover-source-meta",
    });
    return;
  }
  if ((payload.archive || payload.remove || payload.delete) && state.activeSourceId === sourceId) {
    const first = state.sources.find((source) => source.available) || state.sources[0];
    if (first) await loadSource(first.id);
    else renderSessionNav();
    return;
  }
  renderSessionNav();
  if (state.activeSourceId === sourceId && Object.prototype.hasOwnProperty.call(payload, "title")) {
    await loadSource(sourceId, { preserveScroll: true });
  }
}

async function updateProjectSources(projectGroup, payload) {
  const affectedActiveSource = projectGroup.sources.some((source) => source.id === state.activeSourceId);
  try {
    const response = await api.updateSource({
      project: {
        agent: projectGroup.agent,
        workspace: projectGroup.workspace || "",
        project: projectGroup.project,
      },
      ...payload,
    });
    activeSourceController.acceptSources(response.sources || (await api.listSources()), {
      render: false,
      reason: "update-project-sources",
    });
  } catch (error) {
    console.warn("peekMyAgent project update failed", error);
    window.alert(t("projectUpdateFailed", { message: error.message }));
    activeSourceController.acceptSources(await api.listSources(), {
      render: true,
      reason: "recover-project-sources",
    });
    return;
  }
  if ((payload.archive || payload.remove || payload.delete) && affectedActiveSource) {
    const first = state.sources.find((source) => source.available) || state.sources[0];
    if (first) await loadSource(first.id);
    else renderSessionNav();
    return;
  }
  renderSessionNav();
}

function renderAll() {
  translationActionController.clearActions();
  renderHeaderSurface();
  renderTimelineSurface({ updateViewControls: false });
  renderComposerSurface();
}

function renderHeaderSurface() {
  const { source, stats, requests } = state.data;
  els.pageTitle.textContent = source.kind === "codex_rollout_pending" ? t("codexPendingTitle") : displaySourceLabel(source.label);
  els.stats.innerHTML = [
    [t("statRequests"), stats.request_count],
    [t("statResponses"), stats.response_count || 0],
    [t("statSubagents"), stats.subagent_instance_count ?? stats.subagent_count],
    [t("statToolUse"), stats.tool_call_count],
    [t("statToolResult"), stats.tool_result_count],
    ["Raw", formatBytes(stats.raw_body_bytes)],
  ]
    .map(([label, value]) => `<span class="stat">${label}: ${escapeHtml(String(value))}</span>`)
    .join("");
  renderViewControls();
  els.watchSummary.innerHTML = renderProgressiveLoadNotice(state.data?.partial);
  els.sessionInfoBody.innerHTML = renderSessionInfo(source, stats, requests);
  renderSessionNav();
  bindWatchControls();
}

function renderViewControls() {
  const captureMode = state.data?.source?.workbench?.capture_label || "";
  const captureModeLabel = captureMode ? captureLabelText(captureMode) : t("sessionInfo");
  const captureModeHelp = captureMode ? captureLabelHelp(captureMode) : t("sessionInfo");
  els.viewControls.innerHTML =
    `<button class="stat stat-button ${state.latestOnly && !traceQueryActive() ? "active" : ""}" type="button" data-latest-only ${traceQueryActive() ? `disabled title="${escapeHtml(t("latestDisabledBySearch"))}"` : ""}>${state.latestOnly && !traceQueryActive() ? t("showAllTurns") : t("latestOnly")}</button>` +
    `<button class="stat stat-button session-info-trigger" type="button" data-session-info title="${escapeHtml(captureModeHelp)}">${escapeHtml(captureModeLabel)}</button>`;
  bindViewControlEvents();
  bindSessionInfoControls();
}

function renderTimelineSurface({ updateViewControls = true } = {}) {
  if (!state.data) return;
  translationActionController.clearActions("timeline");
  if (updateViewControls) renderViewControls();
  const { source, requests } = state.data;
  const timelineView = currentTimelineView();
  traceTimelineController.render({
    queryHtml: renderTraceQueryBarView({
      timelineView,
      query: state.traceQuery,
      filter: state.traceFilter,
      resultPageSize: TRACE_RESULT_PAGE_SIZE,
      translate: t,
      escapeHtml,
    }),
    timelineHtml: requests.length
      ? timelineView.filteredTurns.length
        ? renderTurnTimelineView({
            turnWindowOrTurns: timelineView.turnWindow,
            requests,
            requestExcerpt,
            renderTurnGroup,
            translate: t,
            escapeHtml,
          })
        : renderTraceNoResultsView({ translate: t, escapeHtml })
      : renderEmptyTimelineView({ summary: source.workbench, translate: t, escapeHtml }),
    activeTurnId: state.activeId,
    activeRequestId: state.activeRequestId,
  });
}

function renderComposerSurface() {
  if (!state.data) return;
  agentComposerController.render(state.data.source);
}

function renderProgressiveLoadNotice(partial) {
  const error = sourceTimelineController.progressiveLoadError;
  if (!partial?.has_more && !error) return "";
  const loaded = partial?.loaded_request_count || state.data?.requests?.length || 0;
  const total = partial?.total_request_count || state.data?.stats?.request_count || loaded;
  const message = error
    ? t("traceFullLoadFailed", { message: error })
    : t("traceInitialLoading", { loaded, total });
  return `
    <div class="progressive-load-notice ${error ? "error" : ""}">
      <span class="progressive-load-dot" aria-hidden="true"></span>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function traceQueryActive() {
  return state.traceFilter !== "all" || Boolean(String(state.traceQuery || "").trim());
}

function currentTimelineView(data = state.data) {
  return buildTraceTimelineView({
    turns: data?.turns || [],
    requests: data?.requests || [],
    query: state.traceQuery,
    filter: state.traceFilter,
    resultLimit: state.traceResultLimit,
    latestOnly: state.latestOnly,
    activeId: state.activeId,
    requestExcerpt,
  });
}

function renderSessionInfo(source, stats, requests) {
  const summary = source.workbench;
  if (!summary) return renderSessionRequestFacts(requests);
  const watchText = summary.watch_ids?.length ? summary.watch_ids.join(", ") : t("emptyNotRecorded");
  const conversationText = summary.conversation_ids?.length ? summary.conversation_label : t("archivedByWatch");
  const redactionText = summary.redaction_count ? t("redactionCount", { count: summary.redaction_count }) : t("noHeaderRedaction");
  return `
    <section class="summary-hero" aria-label="${escapeHtml(t("sessionSummaryAria"))}">
      <div class="summary-head">
        <div>
          <p class="eyeline">${escapeHtml(t("transparencyWorkbench"))}</p>
          <h3>${escapeHtml(summary.agent)} · ${escapeHtml(summary.mode)}</h3>
          <p class="summary-note">${escapeHtml(summary.project)} · ${escapeHtml(captureLabelText(summary.capture_label))} · ${escapeHtml(summary.status)}</p>
        </div>
        <div class="summary-badges">
          <span class="badge ${summary.capture_label === "exact proxy capture" ? "exact" : "partial"}" title="${escapeHtml(captureLabelHelp(summary.capture_label))}">${escapeHtml(captureLabelText(summary.capture_label))}</span>
          ${stats.subagent_instance_count ? `<span class="badge subagent">${escapeHtml(t("subagentInstanceCount", { count: stats.subagent_instance_count }))}</span>` : ""}
          ${stats.subagent_count ? `<span class="badge subagent muted">${escapeHtml(t("subagentRequestCount", { count: stats.subagent_count }))}</span>` : ""}
          <span class="badge ${summary.redaction_count ? "risk" : "muted"}">${escapeHtml(redactionText)}</span>
        </div>
      </div>
      <div class="summary-grid">
        ${renderSummaryMetric("Agent", summary.agent)}
        ${renderSummaryMetric(t("project"), summary.project)}
        ${renderSummaryMetric("Watch", watchText)}
        ${renderSummaryMetric(t("session"), conversationText)}
        ${renderSummaryMetric(t("statRequests"), t("itemCount", { count: stats.request_count }))}
        ${renderSummaryMetric("Raw", formatBytes(stats.raw_body_bytes))}
      </div>
      ${renderSessionRequestFacts(requests)}
      ${renderLiveWatchActions(source)}
    </section>
  `;
}

function renderSessionRequestFacts(requests) {
  if (!requests?.length) return "";
  const first = requests[0];
  const last = requests[requests.length - 1];
  return `
    <section class="session-facts" aria-label="${escapeHtml(t("defaultRequestInfo"))}">
      <h3>${escapeHtml(t("defaultRequestInfo"))}</h3>
      <div class="summary-grid compact">
        ${renderSummaryMetric("Endpoint", joinUnique(requests.map((request) => [request.method, request.path].filter(Boolean).join(" "))))}
        ${renderSummaryMetric("Model", joinUnique(requests.map((request) => request.model)))}
        ${renderSummaryMetric("Provider", joinUnique(requests.map((request) => request.summary?.protocol?.provider_label || providerLabel(request.provider))))}
        ${renderSummaryMetric("Protocol", joinUnique(requests.map((request) => request.summary?.protocol?.protocol_label || protocolLabel(request.protocol))))}
        ${renderSummaryMetric(t("extension"), joinUnique(requests.flatMap((request) => request.summary?.protocol?.extensions || []).map(extensionLabel)) || t("none"))}
        ${renderSummaryMetric("Debug source", joinUnique(requests.map((request) => request.debug_source)))}
        ${renderSummaryMetric(t("firstCapture"), formatTimestamp(first.captured_at))}
        ${renderSummaryMetric(t("lastCapture"), formatTimestamp(last.captured_at))}
        ${renderSummaryMetric(t("session"), joinUnique(requests.map((request) => shortId(request.conversation_id))))}
      </div>
    </section>
  `;
}

function renderLiveWatchActions(source) {
  if (!source.live_watch_id) return "";
  const stopped = source.live_status !== "watching";
  return `
    <div class="watch-control-bar" data-watch-controls>
      <div>
        <strong>${escapeHtml(stopped ? t("watchStopped") : t("watchRunning"))}</strong>
        <span>${escapeHtml(stopped ? t("watchStoppedNote") : t("watchRunningNote"))}</span>
      </div>
      <div class="watch-control-actions">
        ${
          stopped
            ? ""
            : `<button class="secondary-button small" type="button" data-watch-action="stop">${escapeHtml(t("stopWatch"))}</button>
               <button class="danger-button small" type="button" data-watch-action="clear">${escapeHtml(t("stopAndClear"))}</button>`
        }
        ${stopped ? `<button class="danger-button small" type="button" data-watch-action="clear">${escapeHtml(t("clearEntry"))}</button>` : ""}
      </div>
    </div>
  `;
}

function bindWatchControls() {
  document.querySelectorAll("[data-watch-action]").forEach((button) => {
    button.addEventListener("click", () => stopActiveWatch(button.dataset.watchAction === "clear"));
  });
}

function bindSessionInfoControls() {
  document.querySelectorAll("[data-session-info]").forEach((button) => {
    button.addEventListener("click", showSessionInfoModal);
  });
  if (state.sessionInfoControlsBound) return;
  state.sessionInfoControlsBound = true;
  document.querySelectorAll("[data-session-info-close]").forEach((button) => {
    button.addEventListener("click", hideSessionInfoModal);
  });
  els.sessionInfoModal.addEventListener("click", (event) => {
    if (event.target === els.sessionInfoModal) hideSessionInfoModal();
  });
}

function showSessionInfoModal() {
  els.sessionInfoModal.classList.remove("hidden");
  els.sessionInfoModal.setAttribute("aria-hidden", "false");
}

function hideSessionInfoModal() {
  els.sessionInfoModal.classList.add("hidden");
  els.sessionInfoModal.setAttribute("aria-hidden", "true");
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.sessionInfoModal.classList.contains("hidden")) hideSessionInfoModal();
});

async function stopActiveWatch(clear) {
  if (!state.data?.source?.live_watch_id) return;
  try {
    await api.stopWatch({
      id: state.data.source.id,
      clear,
    });
    activeSourceController.acceptSources(await api.listSources(), {
      render: true,
      reason: "stop-watch",
    });
    if (clear) {
      const first = state.sources.find((source) => source.available) || state.sources[0];
      if (first) await loadSource(first.id);
      return;
    }
    await loadSource(state.data.source.id);
  } catch (error) {
    showSessionInfoModal();
    els.sessionInfoBody.insertAdjacentHTML(
      "beforeend",
      `<div class="inline-error"><strong>${escapeHtml(t("watchActionFailed"))}</strong><span>${escapeHtml(error.message)}</span></div>`,
    );
  }
}

function renderSummaryMetric(label, value) {
  return `
    <div class="summary-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || t("emptyNotRecorded"))}</strong>
    </div>
  `;
}

function requestDisplayTitle(request) {
  return buildTimelineRequestIdentity(request, {
    translate: t,
    cleanText: cleanDisplayText,
    preview: shortPreview,
  }).title;
}

function requestExcerpt(request) {
  return buildTimelineRequestIdentity(request, {
    translate: t,
    cleanText: cleanDisplayText,
    preview: shortPreview,
  }).excerpt;
}

function commandMessageLabel(commandMessage) {
  return timelineCommandMessageLabel(commandMessage);
}

function commandMessagePreview(commandMessage) {
  return timelineCommandMessagePreview(commandMessage, {
    cleanText: cleanDisplayText,
    preview: shortPreview,
  });
}

function renderTurnRail() {
  turnRailController.render();
}

function railTurnUniverse(data = state.data) {
  return currentTimelineView(data).railTurns;
}

function activeTurnIds(data = state.data) {
  return railTurnUniverse(data).map((turn) => turn.id);
}

function turnTitleText(turn) {
  if (turn.command_message) return commandMessagePreview(turn.command_message);
  return cleanDisplayText(turn.user_input || turn.title || `#${turn.first_request_index || ""}-${turn.last_request_index || ""}`) || `Turn ${turn.index}`;
}

function turnExcerptText(turn) {
  const parts = [
    turn.command_message ? commandMessagePreview(turn.command_message) : turn.user_input ? shortPreview(cleanDisplayText(turn.user_input), 150) : "",
    t("turnRequests", { count: turn.request_count || turn.request_ids?.length || 0 }),
    turn.internal_request_count ? t("turnInternal", { count: turn.internal_request_count }) : "",
    turn.tool_call_count || turn.tool_result_count ? t("turnTools", { calls: turn.tool_call_count || 0, results: turn.tool_result_count || 0 }) : "",
    `#${turn.first_request_index || ""}-${turn.last_request_index || ""}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

function renderNavItem(request) {
  const title = requestDisplayTitle(request);
  return `
    <button class="nav-item" type="button" data-jump="${escapeHtml(request.id)}">
      <span class="nav-index">${request.request_index}</span>
      <span>
        <span class="nav-title">
          ${escapeHtml(title)}
          ${request.is_subagent ? '<span class="badge subagent">subagent</span>' : ""}
        </span>
        <span class="nav-excerpt">${escapeHtml(requestExcerpt(request))}</span>
      </span>
    </button>
  `;
}

function renderTurnGroup(turn, requestMap) {
  const requests = turn.request_ids.map((id) => requestMap.get(id)).filter(Boolean);
  if (turn.trace_filter_active) {
    return `
      <section class="turn-group trace-match-turn" id="${escapeHtml(turn.id)}" data-turn-group="${escapeHtml(turn.id)}">
        <header class="turn-header">
          <div class="turn-heading">
            <span class="turn-number">${escapeHtml(t("traceTurnMatches", { index: turn.index, count: turn.trace_match_count || requests.length }))}</span>
            <span class="trace-match-turn-title">${escapeHtml(turnTitleText(turn))}</span>
          </div>
        </header>
        ${traceFilterShowsMechanismStory(turn.trace_filter) ? renderTurnStoryForTurn(turn, requestMap) : ""}
        ${turn.trace_filter === "subagents" ? renderAgentBranchesForTurn(turn) : ""}
        <div class="turn-request-list trace-match-requests">${requests.map(renderTurnRequest).join("")}</div>
      </section>
    `;
  }
  const lead = findTurnLeadRequest(requests, turn);
  let primaryRequests = requests.filter(isPrimaryTurnRequest);
  // Always pin the turn's defining user input to the top — even when it was
  // classified parent_spawn (and so isn't "primary") — so the user message
  // always precedes the multi-agent dashboard and the work it triggered.
  if (lead) primaryRequests = [lead, ...primaryRequests.filter((request) => request.id !== lead.id)];
  const primaryIds = new Set(primaryRequests.map((request) => request.id));
  const responseRequests = requests.filter((request) => !primaryIds.has(request.id) && !isPrimaryTurnRequest(request) && isTurnResponseRequest(request));
  const supportingRequests = requests.filter((request) => !primaryIds.has(request.id) && !isTurnResponseRequest(request));
  return `
    <section class="turn-group" id="${escapeHtml(turn.id)}" data-turn-group="${escapeHtml(turn.id)}">
      <header class="turn-header">
        <div class="turn-heading">
          <span class="turn-number">Turn ${escapeHtml(turn.index)}</span>
        </div>
      </header>
      ${renderTurnStoryForTurn(turn, requestMap)}
      ${
        primaryRequests.length
          ? `<div class="turn-request-list primary-requests">${primaryRequests.map((request) => renderTurnRequest(request, request.id === lead?.id ? turn : null)).join("")}</div>`
          : ""
      }
      ${renderAgentBranchesForTurn(turn)}
      ${responseRequests.length ? `<div class="turn-request-list response-requests">${responseRequests.map(renderTurnRequest).join("")}</div>` : ""}
      ${renderSupportingRequests(supportingRequests, turn.id)}
    </section>
  `;
}

function renderTurnStoryForTurn(turn, requestMap) {
  const requestIds = turn.all_request_ids || turn.request_ids || [];
  const view = buildTurnStoryView({
    turn,
    requests: requestIds.map((id) => requestMap.get(id)).filter(Boolean),
    agentTrace: state.data?.agent_trace,
    translate: t,
  });
  return renderTurnStoryView(view, { translate: t, escapeHtml });
}

function isPrimaryTurnRequest(request) {
  return isPrimaryTimelineRequest(request, { cleanText: cleanDisplayText });
}

function isTurnResponseRequest(request) {
  return isTimelineResponseRequest(request);
}

function renderSupportingRequests(requests, turnId) {
  if (!requests.length) return "";
  const open = state.openSupportingTimelines.has(turnId);
  return `
    <details class="turn-supporting-requests" ${open ? "open" : ""}>
      <summary data-supporting-timeline-toggle="${escapeHtml(turnId)}">${escapeHtml(t("supportingTimeline", { count: requests.length }))}</summary>
      ${
        open
          ? `<div class="turn-request-list supporting-requests">
              ${requests.map(renderTurnRequest).join("")}
            </div>`
          : ""
      }
    </details>
  `;
}

function renderAgentBranchesForTurn(turn) {
  const trace = state.data?.agent_trace;
  const view = buildAgentGraphView({
    turn,
    trace,
    dashboardOpen: state.openAgentDashboards.has(turn.id),
    activeFilter: state.agentBranchFilters.get(turn.id) || "all",
    branchLimit: state.agentBranchLimits.get(turn.id) || AGENT_BRANCH_PAGE_SIZE,
    expandedBranchIds: state.expandedAgentBranches,
  });
  return renderAgentGraphView(view, {
    translate: t,
    escapeHtml,
    shortId,
    shortPreview,
  });
}

function requestAgentBranchStatusLabel(status) {
  if (status === "returned") return t("returned");
  if (status === "completed") return t("completed");
  if (status === "running") return t("running");
  return t("unknown");
}

function renderProviderUsageStats(request) {
  return renderRequestAgentBranchStat(request);
}

function renderRequestAgentBranchStat(request) {
  const branch = request.trace?.agent_branch;
  const agentId = branch?.agent_id || request.trace?.claude_agent_id || null;
  if (!agentId && !request.is_subagent) return "";
  const label = branch?.index ? `${t("subagentShort")}${branch.index}` : t("subagentShort");
  const titleParts = [
    branch?.label ? t("branchTooltipLabel", { label: branch.label }) : "",
    branch?.agent_type ? t("typeTooltipLabel", { type: branch.agent_type }) : "",
    agentId ? `x-claude-code-agent-id：${agentId}` : "",
    branch?.status ? t("statusTooltipLabel", { status: requestAgentBranchStatusLabel(branch.status) }) : "",
  ].filter(Boolean);
  const text = escapeHtml(label);
  const title = escapeHtml(titleParts.join("；") || t("subagentSourceTooltip"));
  if (branch?.id) {
    return `<button class="stat-chip subagent jumpable" type="button" data-agent-branch-jump="${escapeHtml(branch.id)}" title="${title} ${escapeHtml(t("jumpToBranchTooltip"))}">${text}</button>`;
  }
  return `<span class="stat-chip subagent" title="${title}">${text}</span>`;
}

function renderUpstreamEntry(request, evidenceView = buildRequestEvidenceView(request, { translate: t })) {
  const expanded = !isTimelineSemanticEvent(request) && state.upstreamExpanded.has(request.id);
  const meta = renderProviderUsageStats(request);
  const view = buildTimelineUpstreamView(request, {
    translate: t,
    cleanText: cleanDisplayText,
    preview: shortPreview,
    serialize: stableJson,
    formatCompactNumber,
  });
  return renderTimelineUpstreamEntryView({
    entry: {
      ...view,
      ownerAria: t("ownerAria"),
      metaHtml: meta,
      actionsHtml: renderUpstreamQuickActions(request, expanded, evidenceView),
    },
    escapeHtml,
  });
}

function renderUpstreamQuickActions(request, expanded, evidenceView = buildRequestEvidenceView(request, { translate: t })) {
  return renderTimelineUpstreamQuickActionsView({
    requestId: request.id,
    expanded,
    expandable: !isTimelineSemanticEvent(request),
    sections: timelineUpstreamQuickSections(request),
    expandLabel: evidenceView.upstream.expandLabel,
    collapseLabel: evidenceView.upstream.collapseLabel,
    rawTitle: evidenceView.upstream.rawTitle,
    translate: t,
    escapeHtml,
  });
}

function shouldShowTimelineRequestContent(request) {
  return requestShowsTimelineContent(request, { cleanText: cleanDisplayText });
}

function renderTurnRequest(request, turnInput = null) {
  return renderRequestCard(request, { turnInput });
}

function renderRequestCard(request, options = {}) {
  const semanticEvent = isTimelineSemanticEvent(request);
  const evidenceView = buildRequestEvidenceView(request, { translate: t });
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const assistantResponse = shouldShowTimelineAssistantResponse(request) ? renderAssistantResponse(request) : "";
  const toolExchange = showInlineContent ? renderToolExchange(request) : "";
  const upstreamOpen = !semanticEvent && state.upstreamExpanded.has(request.id);
  return renderTimelineRequestCardView({
    requestId: request.id,
    requestIndex: request.request_index,
    upstreamOpen,
    upstreamEntryHtml: options.turnInput
      ? renderTurnInputEntry(request, options.turnInput, evidenceView)
      : renderUpstreamEntry(request, evidenceView),
    upstreamBodyHtml: upstreamOpen ? renderUpstreamDetailsBody(request) : renderCollapsedUpstreamPlaceholder(request),
    toolExchangeHtml: toolExchange,
    assistantResponseHtml: assistantResponse,
    showUpstreamDetails: !semanticEvent,
    upstreamDetailsLabel: evidenceView.upstream.detailsLabel,
    translate: t,
    escapeHtml,
  });
}

function renderUpstreamDetailsBody(request) {
  if (requestNeedsDetail(request)) {
    const error = requestDetailCache.errorFor(request.id);
    return `
      <div class="request-body">
        ${error ? renderRequestDetailError(error) : renderRequestDetailLoading()}
      </div>
    `;
  }
  return renderUpstreamDetailView(buildUpstreamDetailView(request, { cleanText: cleanDisplayText }), {
    translate: t,
    escapeHtml,
    renderPre,
    renderMarkdown: renderSafeMarkdown,
    formatBytes,
    formatCharCount,
    formatCompactNumber,
    formatPercent,
    shortId,
    shortPreview,
    commandMessageLabel,
    messageKindLabel,
  });
}

function renderCollapsedUpstreamPlaceholder(request) {
  return `
    <div class="request-body request-body-placeholder" aria-hidden="true">
      <span>${escapeHtml(t("upstreamLazyPlaceholder", { index: request.request_index }))}</span>
    </div>
  `;
}

function renderTurnInputEntry(request, turn, evidenceView = buildRequestEvidenceView(request, { translate: t })) {
  const expanded = state.upstreamExpanded.has(request.id);
  const meta = renderProviderUsageStats(request);
  const view = buildTimelineTurnInputView(request, turn, {
    translate: t,
    cleanText: cleanDisplayText,
    preview: shortPreview,
  });
  return renderTimelineUpstreamEntryView({
    entry: {
      ...view,
      ownerAria: t("ownerAria"),
      metaHtml: meta,
      actionsHtml: renderUpstreamQuickActions(request, expanded, evidenceView),
    },
    escapeHtml,
  });
}

function messageKindLabel(kind, role) {
  return timelineMessageKindLabel(kind, role, t);
}

function shortPreview(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function markdownPreview(value, limit) {
  const text = cleanDisplayText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}...`;
}

function renderToolExchange(request) {
  const view = buildTimelineToolExchangeView(request);
  if (!view) return "";
  return renderTimelineToolExchangeView({
    pairs: view.pairs,
    counts: view.counts,
    translate: t,
    escapeHtml,
    renderPre,
    serializeArguments: (value) => JSON.stringify(value, null, 2),
  });
}

function renderAssistantResponse(request) {
  const expanded = state.responseExpanded.has(request.id);
  const view = buildTimelineAssistantResponseView(request, {
    expanded,
    translate: t,
    cleanText: cleanDisplayText,
    preview: shortPreview,
    markdownPreview,
    formatCompactNumber,
    formatCharCount,
  });
  if (!view) return "";
  return renderTimelineAssistantResponseView({
    view: {
      ...view,
      thinking: buildAssistantThinkingView(view.thinking, request),
    },
    translate: t,
    escapeHtml,
    renderMarkdown: renderSafeMarkdown,
    renderTranslationMarkdown: renderMarkdownPreview,
    renderPre,
    serialize: stableJson,
  });
}

function buildAssistantThinkingView(thinking, request) {
  if (!thinking?.text) return null;
  const translation = translatedTextFor("assistant_thinking", thinking.text);
  const actionId = translationActionController.registerAction({
    kind: "assistant_thinking",
    sourceText: thinking.text,
    section: "response",
    requestId: request.id,
    surface: "timeline",
    metadata: { source: "response.thinking" },
  });
  return {
    ...thinking,
    translation,
    actionId,
    actionLabel: translation ? t("retranslateThinking") : t("translateThinking"),
    translationLoading: state.translationGenerate.loading,
  };
}

function rawSectionData(request, section) {
  return buildRawSectionData(request, section, {
    translate: t,
    harnessMaterials: section === "harness" ? sectionTranslationMaterials(request, "harness") : [],
  });
}

function renderRawDetail(title, value) {
  return renderRawDetailView({ title, value, escapeHtml, renderJson });
}

function renderPre(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function bindViewControlEvents() {
  els.viewControls.querySelectorAll("[data-latest-only]").forEach((button) => {
    button.addEventListener("click", toggleLatestOnly);
  });
}

function jumpToTurn(turnId, scroll = true) {
  if (!turnId) return;
  clientStore.setSelection({ activeId: turnId }, { reason: "jump-to-turn" });
  renderTimelineSurface();
  markActiveTurn(turnId, scroll);
}

function jumpToRequest(requestId) {
  if (!requestId) return;
  const request = state.data?.requests?.find((item) => item.id === requestId);
  if (!request) return;
  if (request.turn_id && request.turn_id !== state.activeId) jumpToTurn(request.turn_id, false);
  if (!els.timeline.querySelector(`[data-card="${cssEscape(requestId)}"]`) && request.turn_id) {
    state.openSupportingTimelines.add(request.turn_id);
    renderTimelineSurface();
  }
  markActiveRequest(requestId, true);
}

function jumpToAgentBranch(branchId) {
  if (!branchId) return;
  const turn = state.data?.turns?.find((item) => (item.agent_branches || []).includes(branchId));
  if (turn) {
    clientStore.setSelection({ activeId: turn.id }, { reason: "jump-to-agent-branch" });
    state.openAgentDashboards.add(turn.id);
    state.agentBranchFilters.set(turn.id, "all");
    const sortedBranchIds = (state.data?.agent_trace?.branches || [])
      .filter((item) => (turn.agent_branches || []).includes(item.id))
      .sort((left, right) => Number(left.first_request_index || 0) - Number(right.first_request_index || 0))
      .map((item) => item.id);
    const branchIndex = sortedBranchIds.indexOf(branchId);
    if (branchIndex >= 0) {
      state.agentBranchLimits.set(turn.id, Math.max(AGENT_BRANCH_PAGE_SIZE, Math.ceil((branchIndex + 1) / AGENT_BRANCH_PAGE_SIZE) * AGENT_BRANCH_PAGE_SIZE));
    }
  }
  if (!state.expandedAgentBranches.has(branchId)) {
    state.expandedAgentBranches.add(branchId);
  }
  renderTimelineSurface();
  const target = document.querySelector(`[data-branch="${cssEscape(branchId)}"]`);
  if (!target) return;
  const turnElement = target.closest("[data-turn-group]");
  if (turnElement?.dataset.turnGroup && turnElement.dataset.turnGroup !== state.activeId) markActiveTurn(turnElement.dataset.turnGroup, false);
  scrollElementIntoView(target, { blockOffset: 90 });
  target.classList.add("focus");
  setTimeout(() => target.classList.remove("focus"), 1800);
}

function toggleAgentBranch(branchId) {
  if (!branchId) return;
  if (state.expandedAgentBranches.has(branchId)) state.expandedAgentBranches.delete(branchId);
  else state.expandedAgentBranches.add(branchId);
  renderTimelineSurface();
}

function scrollElementIntoView(target, { blockOffset = 0 } = {}) {
  const scroller = nearestScrollParent(target);
  if (!scroller || scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const targetRect = target.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  scroller.scrollTo({
    top: scroller.scrollTop + targetRect.top - scrollerRect.top - blockOffset,
  });
}

function nearestScrollParent(element) {
  let current = element?.parentElement || null;
  while (current) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`) && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return document.scrollingElement;
}

function toggleUpstreamDetails(requestId) {
  if (!requestId) return;
  const nextOpen = !state.upstreamExpanded.has(requestId);
  if (nextOpen) state.upstreamExpanded.add(requestId);
  else state.upstreamExpanded.delete(requestId);
  renderTimelineSurface();
  const panel = document.querySelector(`[data-upstream-panel="${cssEscape(requestId)}"]`);
  if (nextOpen) {
    const internalWrapper = panel?.closest(".turn-internal-request");
    if (internalWrapper) internalWrapper.open = true;
    panel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ensureRequestDetailLoaded(requestId)
      .then(() => {
        if (state.upstreamExpanded.has(requestId)) renderTimelineSurface();
      })
      .catch(() => {
        if (state.upstreamExpanded.has(requestId)) renderTimelineSurface();
      });
  }
  updateUpstreamToggleButtons(requestId, nextOpen);
}

function syncUpstreamDetailsState(panel) {
  const requestId = panel?.dataset?.upstreamPanel;
  if (!requestId) return;
  const open = Boolean(panel.open);
  if (open === state.upstreamExpanded.has(requestId)) return;
  if (open) state.upstreamExpanded.add(requestId);
  else state.upstreamExpanded.delete(requestId);
  renderTimelineSurface();
  if (open) {
    ensureRequestDetailLoaded(requestId)
      .then(() => {
        if (state.upstreamExpanded.has(requestId)) renderTimelineSurface();
      })
      .catch(() => {
        if (state.upstreamExpanded.has(requestId)) renderTimelineSurface();
      });
  }
  updateUpstreamToggleButtons(requestId, open);
}

function updateUpstreamToggleButtons(requestId, open) {
  const request = state.data?.requests?.find((item) => item.id === requestId);
  const evidenceView = buildRequestEvidenceView(request || {}, { translate: t });
  document.querySelectorAll(`[data-upstream-toggle="${cssEscape(requestId)}"]`).forEach((button) => {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.closest(".upstream-entry")?.classList.toggle("active", open);
    const label = button.querySelector(".toggle-label");
    if (label) label.textContent = open ? evidenceView.upstream.collapseLabel : evidenceView.upstream.expandLabel;
  });
}

function toggleLatestOnly() {
  clientStore.setTimeline({ latestOnly: !state.latestOnly }, { reason: "toggle-latest-only" });
  localStorage.setItem(LATEST_ONLY_KEY, String(state.latestOnly));
  renderTimelineSurface();
  if (state.latestOnly) {
    const latestTurn = currentTimelineView().turnWindow.turns[0];
    if (latestTurn?.id) markActiveTurn(latestTurn.id, true);
  } else if (state.activeId) {
    markActiveTurn(state.activeId, false);
  }
}

function toggleResponseExpansion(requestId) {
  if (!requestId) return;
  if (state.responseExpanded.has(requestId)) state.responseExpanded.delete(requestId);
  else state.responseExpanded.add(requestId);
  renderTimelineSurface();
  document.getElementById(requestId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function markActiveTurn(id, scroll) {
  clientStore.setSelection({ activeId: id }, { reason: "mark-active-turn" });
  const target = document.getElementById(id);
  if (scroll) target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function syncActiveTurnDom(id) {
  renderTurnRail();
  els.turnRail.querySelectorAll("[data-turn]").forEach((button) => button.classList.toggle("active", button.dataset.turn === id));
  traceTimelineController.syncActiveTurn(id);
}

function markActiveRequest(id, scroll) {
  clientStore.setSelection({ activeRequestId: id }, { reason: "mark-active-request" });
  const target = document.getElementById(id);
  if (scroll) target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function syncActiveRequestDom(id) {
  traceTimelineController.syncActiveRequest(id);
}

function showSystemDiff(id) {
  rawInspectorController.show(id, "system_diff");
}

function renderRawSections(request, activeSection = "full", mode = "request") {
  const body = request.raw?.body || {};
  if (mode === "response") return renderResponseOnlyRawSection(request, activeSection);
  if (requestHasSemanticEvent(request)) {
    const eventSection = activeSection === "metadata" ? "metadata" : "full";
    const sectionData = rawSectionData(request, eventSection);
    return `
      ${renderRawStickyControls(request, eventSection, mode)}
      ${renderRawSourceNotice({ title: t("rawEventNoticeTitle"), text: t("rawEventNotice"), escapeHtml })}
      ${normalizedRawSearchQuery() ? renderRawSearchResults(request, eventSection, mode) : renderRawDetail(sectionData.title, sectionData.value)}
    `;
  }
  if (activeSection === "system_diff") {
    return `
      ${renderRawStickyControls(request, activeSection, mode)}
      ${renderSystemDiff(request)}
    `;
  }
  const sectionData = rawSectionData(request, activeSection);
  if (activeSection !== "full") {
    return `
      ${renderRawStickyControls(request, activeSection, mode)}
      ${renderRawSectionEvidence(request, activeSection, mode)}
      ${renderRawSectionContent(request, activeSection, sectionData)}
    `;
  }
  return `
    ${renderRawStickyControls(request, activeSection, mode)}
    ${normalizedRawSearchQuery() ? renderRawSearchResults(request, activeSection, mode) : `
    ${renderRawDetail(sectionData.title, sectionData.value)}
    `}
  `;
}

function renderRequestDetailLoading() {
  return renderRequestDetailLoadingView({ translate: t, escapeHtml });
}

function renderRequestDetailError(error) {
  return renderRequestDetailErrorView({ error, translate: t, escapeHtml });
}

function renderResponseOnlyRawSection(request, activeSection) {
  const section = ["response", "tool_calls", "tools"].includes(activeSection) ? activeSection : "response";
  const detail =
    section === "tools"
      ? renderResponseOnlyToolsSchemaSection(request)
      : normalizedRawSearchQuery()
        ? renderRawSearchResults(request, section, "response")
        : section === "tool_calls"
        ? renderRawDetail("response tool_use", { [t("currentResponseToolUse")]: request.summary?.response?.tool_calls || [] })
        : normalizeMessagesMode(state.rawMessagesMode) === "organized"
          ? renderMessagesSection(request, "response", responseConversationMessages(request))
          : renderRawDetail(responseRawSectionLabel("response", request), rawResponseSectionValue(request));
  return `
    ${renderRawStickyControls(request, section, "response")}
    ${detail}
  `;
}

function renderRawStickyControls(request, section, mode = "request") {
  const navigation =
    mode === "response"
      ? renderResponseRawNavigation({ request, activeSection: section, translate: t, escapeHtml })
      : renderRequestRawNavigation({ request, activeSection: section, hasPrevious: Boolean(previousRequest(request)), translate: t, escapeHtml });
  return renderRawStickyControlsView({
    navigation,
    searchControls: renderRawSearchControls(request, section, mode),
    viewControls: renderTranslationControls(request, section) || renderMessagesControls(section),
  });
}

function renderResponseOnlyToolsSchemaSection(request) {
  const sectionData = rawSectionData(request, "tools");
  return `
    ${renderRawSectionEvidence(request, "tools", "response")}
    ${renderRawSectionContent(request, "tools", sectionData)}
  `;
}

function renderRawSectionEvidence(request, section, mode = "request") {
  return renderRawSectionEvidenceView({
    evidence: buildRawSectionEvidenceView(request, section, { mode, translate: t }),
    escapeHtml,
  });
}

function renderRawSearchControls(request, section, mode = "request") {
  const query = rawSearchController.query;
  const scope = rawSearchScopeLabel(section, mode, request);
  const matches = normalizedRawSearchQuery() ? rawSearchMatchCount(request, section, mode) : 0;
  return renderRawSearchControlsView({
    query,
    scope,
    matches,
    position: rawSearchController.position(matches),
    translate: t,
    escapeHtml,
  });
}

function rawSearchMatchCount(request, section, mode = "request") {
  if (usesTranslatedStructuredSearch(section, mode)) {
    return translationViewForSection(request, section).searchMatchCount;
  }
  return rawSearchEntriesForSection(request, section, mode).length;
}

function renderRawSearchResults(request, section, mode = "request") {
  const query = normalizedRawSearchQuery();
  const scope = rawSearchScopeLabel(section, mode, request);
  const entries = rawSearchEntriesForSection(request, section, mode);
  return renderRawSearchResultsView({ query, scope, entries, translate: t, escapeHtml, highlightSnippet: highlightSearchSnippet, renderPre });
}

function rawSearchEntriesForSection(request, section, mode = "request") {
  const query = normalizedRawSearchQuery();
  if (!query) return [];
  return filterRawSearchEntries(rawSearchCandidateEntries(request, section, mode), query);
}

function rawSearchCandidateEntries(request, section, mode = "request") {
  if (mode === "response") {
    if (section === "tool_calls") return rawSearchEntries({ [t("currentResponseToolUse")]: request.summary?.response?.tool_calls || [] }, "response.tool_use");
    if (section === "tools") return rawSearchEntries(rawSectionData(request, "tools").value, "Tools");
    return rawSearchEntries(rawResponseSectionValue(request), "response");
  }
  if (["tools", "harness", "system"].includes(section)) {
    return rawSearchEntries(rawSectionData(request, section).value, rawSectionLabel(section, request));
  }
  if (section === "system_diff") {
    const previous = previousRequest(request);
    return rawSearchEntries(
      {
        previous_system: previous ? systemTextFromRequest(previous) : "",
        current_system: systemTextFromRequest(request),
      },
      "system_diff",
    );
  }
  return rawSearchEntries(rawSectionData(request, section).value, rawSectionLabel(section, request));
}

function rawSearchEntries(value, rootPath) {
  return collectRawSearchEntries(value, rootPath, { serialize: stableJson, preview: shortPreview });
}

function normalizedRawSearchQuery() {
  return rawSearchController.normalizedQuery();
}

function rawSearchScopeLabel(section, mode = "request", request = null) {
  if (mode === "response" && section === "tools") return "Tools schema";
  if (mode === "response" && section === "tool_calls") return "Response tool_use";
  if (mode === "response") return responseRawSectionLabel(section, request);
  return rawSectionLabel(section, request);
}

function highlightSearchSnippet(text, query) {
  return rawSearchSnippetSegments(text, query)
    .map((segment) => (segment.match ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)))
    .join("");
}

function renderRawSectionContent(request, section, sectionData) {
  if (["history", "message", "messages"].includes(section)) return renderMessagesSection(request, section, sectionData.value);
  if (state.translationMode === currentTargetLanguage() && translationCacheController.available) {
    if (["system", "tools", "harness"].includes(section)) return renderTranslatedSection(request, section);
  }
  if (normalizedRawSearchQuery()) return renderRawSearchResults(request, section, state.activeRawMode || "request");
  return renderRawDetail(sectionData.title, sectionData.value);
}

function usesTranslatedStructuredSearch(section, mode = state.activeRawMode || "request") {
  return (
    (mode === "request" || (mode === "response" && section === "tools")) &&
    ["system", "tools", "harness"].includes(section) &&
    state.translationMode === currentTargetLanguage() &&
    translationCacheController.available
  );
}

function renderMessagesControls(section) {
  return renderMessagesControlsView({ section, mode: normalizeMessagesMode(state.rawMessagesMode), translate: t, escapeHtml });
}

function renderMessagesSection(request, section, messagesValue) {
  const requestIndexes = messageTimelineRequestIndexes(request, state.data?.requests || []);
  const timelineRequestIndexes =
    section === "history"
      ? requestIndexes.slice(0, -1)
      : section === "response"
        ? [request.request_index]
        : requestIndexes;
  return renderMessagesSectionView({
    messagesValue,
    timelineRequestIndexes,
    sourceTitle: rawSectionLabel(section, request),
    mode: normalizeMessagesMode(state.rawMessagesMode),
    translate: t,
    escapeHtml,
    renderRawDetail,
    renderMarkdown: renderSafeMarkdown,
    renderJson,
    formatNumber: formatCompactNumber,
  });
}

function renderTranslationControls(request, section) {
  const stats = translationSectionStats(request, section);
  const cache = translationCacheController.translations;
  const generating = Boolean(state.translationGenerate.loading);
  const targetLanguage = currentTargetLanguage();
  const languageLabel = currentTargetLanguageLabel();
  return renderTranslationControlsView({
    section,
    stats,
    cacheAvailable: Boolean(cache?.available),
    cacheTargetLanguage: cache?.target_language || "",
    generating,
    generateError: state.translationGenerate.error,
    generateMessage: state.translationGenerate.message,
    targetLanguage,
    languageLabel,
    translationMode: state.translationMode,
    sectionLabel: rawSectionLabel(section),
    translate: t,
    escapeHtml,
  });
}

function translationViewForSection(request, section) {
  return buildTranslationSectionView({
    section,
    materials: sectionTranslationMaterials(request, section),
    query: normalizedRawSearchQuery(),
    translatedTextFor,
    labelForKind: translationKindLabel,
  });
}

function renderTranslatedSection(request, section) {
  const view = translationViewForSection(request, section);
  const fallback = section === "system" ? t("noSystemPrompt") : section === "tools" ? t("noToolDescriptions") : t("noHarnessPrompts");
  const emptyText = view.query && view.totalMaterials
    ? t("rawSearchNoResults", { section: rawSearchScopeLabel(section, state.activeRawMode || "request"), query: view.query })
    : fallback;
  return renderTranslationSectionView({
    view,
    emptyText,
    generating: Boolean(state.translationGenerate.loading),
    targetLanguageLabel: currentTargetLanguageLabel(),
    translate: t,
    escapeHtml,
    renderMarkdown: renderMarkdownPreview,
    renderPre,
    registerAction: (action) =>
      translationActionController.registerAction({
        ...action,
        section: state.activeRawSection || section,
        surface: "raw",
      }),
  });
}

function translationKindLabel(kind) {
  if (kind === "tool_description") return t("toolDescription");
  if (kind === "tool_parameter_description") return t("parameterDescriptions");
  if (kind === "system_prompt") return "System";
  if (kind === "system_injected_context") return t("systemInjectedContext");
  if (kind === "assistant_thinking") return "Thinking";
  if (kind === "harness_reminder") return t("harnessReminder");
  if (kind === "harness_compact") return t("harnessCompact");
  if (kind === "harness_command") return t("harnessCommand");
  if (kind === "harness_suggestion") return "Suggestion";
  if (kind === "harness_developer") return t("harnessDeveloper");
  if (kind === "harness_codex_context") return t("harnessCodexContext");
  const codexLabelKey = {
    harness_codex_environment: "harnessCodexEnvironment",
    harness_codex_ambient_ui: "harnessCodexAmbientUi",
    harness_codex_app: "harnessCodexApp",
    harness_codex_skills: "harnessCodexSkills",
    harness_codex_apps: "harnessCodexApps",
    harness_codex_plugins: "harnessCodexPlugins",
    harness_codex_recommended_plugins: "harnessCodexRecommendedPlugins",
    harness_codex_collaboration: "harnessCodexCollaboration",
    harness_codex_multi_agent_policy: "harnessCodexMultiAgentPolicy",
    harness_codex_multi_agent_orchestration: "harnessCodexMultiAgentOrchestration",
    harness_codex_memory: "harnessCodexMemory",
    harness_codex_permissions: "harnessCodexPermissions",
    harness_codex_internal: "harnessCodexInternal",
    harness_codex_lifecycle: "harnessCodexLifecycle",
    harness_codex_subagent: "harnessCodexSubagent",
  }[kind];
  if (codexLabelKey) return t(codexLabelKey);
  return t("description");
}

function translationSectionStats(request, section) {
  return summarizeTranslationSection(sectionTranslationMaterials(request, section), { translatedTextFor });
}

function translatedTextFor(kind, sourceText) {
  const source = normalizeTranslationText(sourceText);
  const translated = source ? translationCacheController.translationLookup.get(translationLookupKey(kind, source))?.translated_text || "" : "";
  return sanitizeTranslationOutput(kind, translated);
}

function rawSectionLabel(section, request = null) {
  if (requestHasSemanticEvent(request)) return section === "metadata" ? t("rawEventMetadata") : t("rawEventSource");
  const labels = {
    full: t(requestUsesReconstructedUpstream(request) ? "rawReconstructedRequest" : "rawFull"),
    system: "System",
    system_diff: "System diff",
    tools: "Tools",
    harness: t("rawHarness"),
    history: t("rawHistory"),
    message: t("rawMessage"),
    messages: t("rawHistory"),
    upstream_tool_calls: "Upstream tool_use",
    tool_calls: "Tool use",
    tool_results: "Tool result",
    response: "Response",
    metadata: t("rawRequestMetadata"),
  };
  return labels[section] || "Raw";
}

function responseRawSectionLabel(section, request = null) {
  if (section === "tool_calls") return "Response tool_use";
  if (section === "tools") return "Tools schema";
  return responseUsesReconstructedDownstream(request) ? t("rawReconstructedResponse") : "Response";
}

function renderSystemDiff(request) {
  const previous = previousRequest(request);
  if (!previous) {
    return `<div class="empty-box">${escapeHtml(t("noPreviousSystemDiff"))}</div>`;
  }
  const before = systemTextFromRequest(previous);
  const after = systemTextFromRequest(request);
  return renderSystemDiffView({
    model: buildSystemDiffModel(before, after),
    previousIndex: previous.request_index,
    currentIndex: request.request_index,
    translate: t,
    escapeHtml,
  });
}

function previousRequest(request) {
  const requests = state.data?.requests || [];
  const index = requests.findIndex((item) => item.id === request.id);
  return index > 0 ? requests[index - 1] : null;
}

function systemTextFromRequest(request) {
  const body = request.raw?.body || {};
  const messages = extractRequestMessages(body);
  const parts = [];
  if (typeof body.system === "string") parts.push(body.system);
  if (Array.isArray(body.system)) {
    for (const part of body.system) parts.push(extractContentText(part));
  }
  if (typeof body.instructions === "string") parts.push(body.instructions);
  if (Array.isArray(body.instructions)) {
    for (const part of body.instructions) parts.push(extractContentText(part));
  }
  for (const message of messages) {
    if (message.role === "system") parts.push(extractContentText(message.content));
  }
  return parts.filter(Boolean).join("\n\n");
}

function collectTranslationMaterials(request) {
  return [
    ...translationMaterialsForRequest(request, {
      extractHarnessParts: extractClientHarnessTranslationParts,
    }),
    ...collectResponseTranslationMaterials(request),
  ];
}

function collectResponseTranslationMaterials(request) {
  const thinking = normalizeTranslationText(request.summary?.response?.thinking || "");
  if (!thinking) return [];
  return [
    {
      kind: "assistant_thinking",
      source_text: thinking,
      metadata: { source: "response.thinking" },
    },
  ];
}

function extractClientHarnessTranslationParts(messages) {
  return extractHarnessTranslationParts(messages, {
    labelForPart(kind, { reminderIndex = 0 } = {}) {
      if (kind === "harness_compact") return t("harnessCompact");
      if (kind === "harness_command") return t("harnessCommand");
      if (kind === "harness_suggestion") return t("harnessSuggestion");
      if (kind === "harness_reminder") return `${t("harnessReminder")} #${reminderIndex + 1}`;
      if (kind === "harness_developer") return t("harnessDeveloper");
      if (kind === "harness_codex_context") return t("harnessCodexContext");
      if (kind.startsWith("harness_codex_")) return translationKindLabel(kind);
      return kind;
    },
  });
}

async function materialHash(kind, sourceText) {
  const bytes = new TextEncoder().encode(translationLookupKey(kind, sourceText));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renderJson(value, key) {
  if (Array.isArray(value)) {
    const summary = `[${value.length}]`;
    return `<details open><summary>${key ? `<span class="json-key">${escapeHtml(key)}</span>: ` : ""}${summary}</summary><div class="json-node">${value.map((item, index) => renderJson(item, String(index))).join("")}</div></details>`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return `<details open><summary>${key ? `<span class="json-key">${escapeHtml(key)}</span>: ` : ""}{${keys.length}}</summary><div class="json-node">${keys.map((itemKey) => renderJson(value[itemKey], itemKey)).join("")}</div></details>`;
  }
  return `<div>${key ? `<span class="json-key">${escapeHtml(key)}</span>: ` : ""}${renderPrimitive(value)}</div>`;
}

function renderPrimitive(value) {
  if (value === null) return '<span class="json-null">null</span>';
  if (typeof value === "string") return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  if (typeof value === "number") return `<span class="json-number">${value}</span>`;
  if (typeof value === "boolean") return `<span class="json-boolean">${value}</span>`;
  return escapeHtml(String(value));
}

function contentDispositionFileName(value) {
  const text = String(value || "");
  const utf8Match = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return utf8Match[1].trim();
    }
  }
  const quoted = text.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const plain = text.match(/filename=([^;]+)/i);
  return plain ? plain[1].trim() : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displaySourceLabel(label) {
  return cleanDisplayText(label).replace(/\s*Write the title in [\s\S]*$/i, "").trim() || t("unnamedSession");
}

function projectNameFromWorkspace(workspace) {
  if (!workspace) return "";
  const normalized = String(workspace).replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized || "";
}

function projectGroupKey(agent, project) {
  return `${encodeURIComponent(agent || "Unknown Agent")}::${encodeURIComponent(project || t("unassignedProject"))}`;
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(/<command-message\b[^>]*>([\s\S]*?)<\/command-message>/gi, "$1")
    .replace(/<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi, "$1")
    .replace(/\s*Write the title in [\s\S]*?Keep technical terms and code identifiers in their original form\.?\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function captureLabelText(label) {
  if (label === "exact proxy capture") return t("exactProxyCapture");
  if (label === "Codex local semantic trace") return t("codexSemanticCapture");
  if (label === "otel raw body") return t("otelRawBody");
  return label || t("unknownCapture");
}

function captureLabelHelp(label) {
  if (label === "exact proxy capture") return t("exactProxyHelp");
  if (label === "Codex local semantic trace") return t("codexSemanticHelp");
  if (label === "otel raw body") return t("otelRawHelp");
  return t("captureHelp");
}

function protocolLabel(protocol) {
  const labels = {
    openai_chat_completions: "OpenAI Chat",
    openai_responses: "OpenAI Responses",
    anthropic_messages: "Anthropic",
    gemini_generate_content: "Gemini",
    unknown: t("unknownProtocol"),
  };
  return labels[protocol] || protocol || "";
}

function providerLabel(provider) {
  const labels = {
    xiaomi_mimo: "MiMo",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google_gemini: "Google Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    moonshot: "Moonshot",
    unknown: t("unknownProvider"),
  };
  return labels[provider] || provider || "";
}

function extensionLabel(extension) {
  const labels = {
    reasoning_content: "reasoning",
    thinking: "thinking",
  };
  return labels[extension] || extension;
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
  const timePart = [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join(":");
  return `${datePart} ${timePart} ${timezoneOffsetLabel(date)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function timezoneOffsetLabel(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return minutes ? `GMT${sign}${hours}:${pad2(minutes)}` : `GMT${sign}${hours}`;
}

function shortPath(value) {
  const parts = String(value || "").split("/");
  if (parts.length <= 4) return value;
  return `.../${parts.slice(-4).join("/")}`;
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function formatCharCount(count) {
  const number = Number(count) || 0;
  return `${number.toLocaleString()} chars`;
}

function formatCompactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1000000) return `${(number / 1000000).toFixed(1)}m`;
  if (Math.abs(number) >= 10000) return `${(number / 1000).toFixed(1)}k`;
  return number.toLocaleString();
}

function formatPercent(ratioValue) {
  const value = Number(ratioValue || 0) * 100;
  if (value >= 10) return `${value.toFixed(0)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  if (value > 0) return `${value.toFixed(2)}%`;
  return "0%";
}

function joinUnique(values, fallback = t("emptyNotRecorded")) {
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!unique.length) return fallback;
  if (unique.length <= 2) return unique.join(" / ");
  return `${unique.slice(0, 2).join(" / ")} +${unique.length - 2}`;
}

function stableJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}
