import { renderMarkdownPreview, renderSafeMarkdown } from "./markdown.js";
import { AgentComposerController } from "./agent-composer-controller.js";
import {
  renderMessagesControls as renderMessagesControlsView,
  renderMessagesSection as renderMessagesSectionView,
} from "./messages-renderer.js";
import { ViewerApiClient } from "./api-client.js";
import { ViewerClientStore } from "./client-store.js";
import { AGENT_BRANCH_PAGE_SIZE, buildAgentGraphView } from "./agent-graph-model.js";
import { renderAgentGraph as renderAgentGraphView } from "./agent-graph-renderer.js";
import { RequestDetailCache, requestNeedsDetail } from "./request-detail-cache.js";
import {
  renderTimelineAssistantResponse as renderTimelineAssistantResponseView,
  renderTimelineRequestCard as renderTimelineRequestCardView,
  renderTimelineToolExchange as renderTimelineToolExchangeView,
  renderTimelineUpstreamEntry as renderTimelineUpstreamEntryView,
  renderTimelineUpstreamQuickActions as renderTimelineUpstreamQuickActionsView,
} from "./request-card-renderer.js";
import {
  rawResponseSectionValue,
  rawSectionData as buildRawSectionData,
  rawUpstreamRequestValue,
} from "./raw-view-model.js";
import {
  collectRawSearchEntries,
  filterRawSearchEntries,
  rawSearchSnippetSegments,
} from "./raw-search-model.js";
import { RawSearchController } from "./raw-search-controller.js";
import { SessionNavigatorController } from "./session-navigator-controller.js";
import { PaneLayoutController } from "./pane-layout-controller.js";
import { DEFAULT_UI_LANGUAGE, translateUi } from "./ui-i18n.js";
import {
  renderRawDetail as renderRawDetailView,
  renderRawSearchControls as renderRawSearchControlsView,
  renderRawSearchResults as renderRawSearchResultsView,
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
  groupToolTranslationMaterials,
  translationSectionStats as summarizeTranslationSection,
} from "./translation-view-model.js";
import { TurnRailController } from "./turn-rail.js";
import {
  buildTraceTimelineView,
  findTurnLeadRequest,
  TRACE_RESULT_PAGE_SIZE,
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
  extractTranslationSchemaDescriptions as extractSchemaDescriptionsForTranslation,
  isSkippableTranslationMaterial,
  normalizeTranslationSourceText as normalizeTranslationText,
  systemTranslationKind,
  translationLookupKey,
  translationToolDescription as toolDescriptionOf,
  translationToolName as toolNameOf,
} from "./translation-blocks.js";

const api = new ViewerApiClient();
const clientStore = new ViewerClientStore();
const state = Object.assign(clientStore.state, {
  sources: [],
  data: null,
  sourceLoadSeq: 0,
  progressiveLoadError: "",
  autoRefreshTimer: 0,
  autoRefreshInFlight: false,
  sessionInfoControlsBound: false,
  responseExpanded: new Set(),
  upstreamExpanded: new Set(),
  translations: null,
  translationLookup: new Map(),
  translationGenerate: { loading: false, error: "", message: "" },
  translationAutoRefresh: new Set(),
  translationActionItems: new Map(),
  nextTranslationActionId: 1,
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
const TRANSLATION_MODE_KEY = "peekmyagent.translationMode";
const UI_LANGUAGE_KEY = "peekmyagent.uiLanguage";
const TARGET_TRANSLATION_LANGUAGE_KEY = "peekmyagent.targetTranslationLanguage";
const RAW_MESSAGES_MODE_KEY = "peekmyagent.rawMessagesMode";
const DEFAULT_TRANSLATION_LANGUAGE = "zh-CN";
const INITIAL_SOURCE_REQUEST_LIMIT = 32;
const PROGRESSIVE_SOURCE_MIN_REQUESTS = 72;
const SUPPORTED_UI_LANGUAGES = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];
const SUPPORTED_TRANSLATION_LANGUAGES = [
  { value: "aa", label: "Afar" },
  { value: "af", label: "Afrikaans" },
  { value: "sq", label: "Albanian" },
  { value: "am", label: "Amharic" },
  { value: "ar", label: "Arabic" },
  { value: "hy", label: "Armenian" },
  { value: "as", label: "Assamese" },
  { value: "ay", label: "Aymara" },
  { value: "az", label: "Azerbaijani" },
  { value: "bm", label: "Bambara" },
  { value: "eu", label: "Basque" },
  { value: "be", label: "Belarusian" },
  { value: "bn", label: "Bengali" },
  { value: "bho", label: "Bhojpuri" },
  { value: "brx", label: "Bodo" },
  { value: "bs", label: "Bosnian" },
  { value: "bg", label: "Bulgarian" },
  { value: "my", label: "Burmese" },
  { value: "ca", label: "Catalan" },
  { value: "ceb", label: "Cebuano" },
  { value: "hne", label: "Chhattisgarhi" },
  { value: "zh-CN", label: "中文（简体）", aliases: ["Chinese", "Chinese Simplified", "Simplified Chinese", "zh", "zh-Hans"] },
  { value: "zh-TW", label: "中文（繁體）", aliases: ["Traditional Chinese", "Chinese Traditional", "zh-Hant", "zh-HK", "zh-MO"] },
  { value: "co", label: "Corsican" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "dv", label: "Dhivehi" },
  { value: "doi", label: "Dogri" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English", aliases: ["en-US", "en-GB"] },
  { value: "eo", label: "Esperanto" },
  { value: "et", label: "Estonian" },
  { value: "ee", label: "Ewe" },
  { value: "fil", label: "Filipino" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "ff", label: "Fulfulde" },
  { value: "gl", label: "Galician" },
  { value: "gbm", label: "Garhwali" },
  { value: "ka", label: "Georgian" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "gu", label: "Gujarati" },
  { value: "gn", label: "Guarani" },
  { value: "ht", label: "Haitian Creole" },
  { value: "bgc", label: "Haryanvi" },
  { value: "ha", label: "Hausa" },
  { value: "haw", label: "Hawaiian" },
  { value: "he", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hmn", label: "Hmong" },
  { value: "hu", label: "Hungarian" },
  { value: "is", label: "Icelandic" },
  { value: "ig", label: "Igbo" },
  { value: "ilo", label: "Ilocano" },
  { value: "id", label: "Indonesian" },
  { value: "ga", label: "Irish" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "日本語", aliases: ["Japanese", "ja-JP"] },
  { value: "jv", label: "Javanese" },
  { value: "kl", label: "Kalaallisut" },
  { value: "kn", label: "Kannada" },
  { value: "ks", label: "Kashmiri" },
  { value: "kk", label: "Kazakh" },
  { value: "km", label: "Khmer" },
  { value: "rw", label: "Kinyarwanda" },
  { value: "gom", label: "Konkani (Goan)" },
  { value: "ko", label: "한국어", aliases: ["Korean", "ko-KR"] },
  { value: "kri", label: "Krio" },
  { value: "ku", label: "Kurdish" },
  { value: "ckb", label: "Kurdish (Sorani)" },
  { value: "ky", label: "Kyrgyz" },
  { value: "lmn", label: "Lambadi" },
  { value: "lo", label: "Lao" },
  { value: "la", label: "Latin" },
  { value: "lv", label: "Latvian" },
  { value: "ln", label: "Lingala" },
  { value: "lt", label: "Lithuanian" },
  { value: "lg", label: "Luganda" },
  { value: "lb", label: "Luxembourgish" },
  { value: "mk", label: "Macedonian" },
  { value: "mag", label: "Magahi" },
  { value: "mai", label: "Maithili" },
  { value: "mg", label: "Malagasy" },
  { value: "ms", label: "Malay" },
  { value: "ml", label: "Malayalam" },
  { value: "mt", label: "Maltese" },
  { value: "mi", label: "Maori" },
  { value: "mr", label: "Marathi" },
  { value: "mwr", label: "Marwari" },
  { value: "mni", label: "Meiteilon (Manipuri)" },
  { value: "min", label: "Minangkabau" },
  { value: "lus", label: "Mizo" },
  { value: "mn", label: "Mongolian" },
  { value: "ne", label: "Nepali" },
  { value: "no", label: "Norwegian" },
  { value: "ny", label: "Nyanja" },
  { value: "or", label: "Odia" },
  { value: "om", label: "Oromo" },
  { value: "ps", label: "Pashto" },
  { value: "fa", label: "Persian" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "pa", label: "Punjabi" },
  { value: "qu", label: "Quechua" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sck", label: "Sadri" },
  { value: "sgs", label: "Samogitian" },
  { value: "sm", label: "Samoan" },
  { value: "sa", label: "Sanskrit" },
  { value: "sat", label: "Santali" },
  { value: "gd", label: "Scots Gaelic" },
  { value: "nso", label: "Sepedi" },
  { value: "sr", label: "Serbian" },
  { value: "hbs", label: "Serbocroatian" },
  { value: "st", label: "Sesotho" },
  { value: "sn", label: "Shona" },
  { value: "sd", label: "Sindhi" },
  { value: "si", label: "Sinhala" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "so", label: "Somali" },
  { value: "es", label: "Spanish" },
  { value: "su", label: "Sundanese" },
  { value: "sjp", label: "Surjapuri" },
  { value: "sw", label: "Swahili" },
  { value: "sv", label: "Swedish" },
  { value: "tg", label: "Tajik" },
  { value: "zgh", label: "Tamazight" },
  { value: "ta", label: "Tamil" },
  { value: "tt", label: "Tatar" },
  { value: "te", label: "Telugu" },
  { value: "th", label: "Thai" },
  { value: "bo", label: "Tibetan" },
  { value: "ti", label: "Tigrinya" },
  { value: "ts", label: "Tsonga" },
  { value: "tw", label: "Twi" },
  { value: "tr", label: "Turkish" },
  { value: "tk", label: "Turkmen" },
  { value: "ug", label: "Uighur" },
  { value: "uk", label: "Ukrainian" },
  { value: "ur", label: "Urdu" },
  { value: "uz", label: "Uzbek" },
  { value: "vah", label: "Varhadi" },
  { value: "vi", label: "Vietnamese" },
  { value: "cy", label: "Welsh" },
  { value: "fy", label: "Western Frisian" },
  { value: "xh", label: "Xhosa" },
  { value: "yi", label: "Yiddish" },
  { value: "yo", label: "Yoruba" },
  { value: "zu", label: "Zulu" },
];
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
    showRaw(requestId, section, { mode });
  },
  onAgentJump: jumpToRequest,
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
const requestDetailCache = new RequestDetailCache({
  loadDetail: async (sourceId, requestId) => (await api.requestDetail(sourceId, requestId)).request,
  onLoaded: async (fullRequest) => {
    const merged = mergeRequestDetail(fullRequest);
    await rebuildTranslationLookupForCurrentData();
    return merged;
  },
  onCached: mergeRequestDetail,
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
    showRaw(requestId, section, { mode });
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
clientStore.subscribe((change) => {
  if (change.changedKeys.includes("activeId")) syncActiveTurnDom(change.state.activeId);
  if (change.changedKeys.includes("activeRequestId")) syncActiveRequestDom(change.state.activeRequestId);
});

init();

function normalizeUiLanguage(value) {
  return SUPPORTED_UI_LANGUAGES.some((language) => language.value === value) ? value : DEFAULT_UI_LANGUAGE;
}

function normalizeTranslationLanguage(value, fallback = DEFAULT_TRANSLATION_LANGUAGE) {
  const matched = resolveTranslationLanguage(value);
  if (matched) return matched.value;
  const fallbackMatched = resolveTranslationLanguage(fallback);
  return fallbackMatched?.value || DEFAULT_TRANSLATION_LANGUAGE;
}

function normalizeMessagesMode(value) {
  return value === "source" ? "source" : "organized";
}

function currentTargetLanguage() {
  return normalizeTranslationLanguage(state.targetTranslationLanguage);
}

function currentTargetLanguageLabel() {
  const language = currentTargetLanguage();
  return SUPPORTED_TRANSLATION_LANGUAGES.find((item) => item.value === language)?.label || language;
}

function defaultTranslationLanguage() {
  return recommendedSystemTranslationLanguage() || DEFAULT_TRANSLATION_LANGUAGE;
}

function recommendedSystemTranslationLanguage() {
  const browserLanguages = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const language of browserLanguages) {
    const normalized = String(language || "").trim();
    if (!normalized) continue;
    if (/^zh($|-)/i.test(normalized)) {
      if (/-(tw|hk|mo)|hant/i.test(normalized)) return "zh-TW";
      return "zh-CN";
    }
    const exact = resolveTranslationLanguage(normalized);
    if (exact) return exact.value;
    const primary = normalized.split("-")[0];
    const primaryMatch = resolveTranslationLanguage(primary);
    if (primaryMatch) return primaryMatch.value;
  }
  return "";
}

function languageSearchValue(option) {
  return `${option.label} · ${option.value}`;
}

function resolveTranslationLanguage(value) {
  const normalized = normalizeLanguageSearchValue(value);
  if (!normalized) return null;
  const codeSuffix = normalized.match(/(?:^|\s)([a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i)?.[1];
  if (codeSuffix) {
    const codeMatch = SUPPORTED_TRANSLATION_LANGUAGES.find((language) => normalizeLanguageSearchValue(language.value) === codeSuffix);
    if (codeMatch) return codeMatch;
  }
  return (
    SUPPORTED_TRANSLATION_LANGUAGES.find((language) => {
      const candidates = [language.value, language.label, languageSearchValue(language), ...(language.aliases || [])];
      return candidates.some((candidate) => normalizeLanguageSearchValue(candidate) === normalized);
    }) ||
    SUPPORTED_TRANSLATION_LANGUAGES.find((language) => {
      const candidates = [language.value, language.label, ...(language.aliases || [])];
      return candidates.some((candidate) => normalizeLanguageSearchValue(candidate).startsWith(`${normalized}-`));
    }) ||
    null
  );
}

function normalizeLanguageSearchValue(value) {
  return String(value || "")
    .trim()
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function t(key, vars = {}) {
  return translateUi(state.uiLanguage, key, vars);
}

function renderLanguageOptions(options, selected) {
  return options
    .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
    .join("");
}

function renderLanguageSelectors() {
  if (els.uiLanguageSelect) {
    els.uiLanguageSelect.innerHTML = renderLanguageOptions(SUPPORTED_UI_LANGUAGES, state.uiLanguage);
  }
  if (els.translationLanguageSelect) {
    els.translationLanguageSelect.innerHTML = renderLanguageOptions(SUPPORTED_TRANSLATION_LANGUAGES, currentTargetLanguage());
    els.translationLanguageSelect.title = t("translationLanguageSearchPlaceholder");
  }
}

function applyStaticI18n() {
  document.documentElement.lang = state.uiLanguage;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.setAttribute("title", t(node.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
}

async function setUiLanguage(value) {
  clientStore.setLanguage({ uiLanguage: normalizeUiLanguage(value) }, { reason: "set-ui-language" });
  localStorage.setItem(UI_LANGUAGE_KEY, state.uiLanguage);
  applyStaticI18n();
  paneLayoutController.refreshLabels();
  if (state.data) renderAll();
  if (state.activeRequestId) showRaw(state.activeRequestId, state.activeRawSection, { mode: state.activeRawMode || "request" });
}

async function setTargetTranslationLanguage(value) {
  const next = normalizeTranslationLanguage(value);
  if (next === currentTargetLanguage()) {
    renderLanguageSelectors();
    return;
  }
  clientStore.setLanguage(
    { targetTranslationLanguage: next, translationMode: next },
    { reason: "set-translation-language" },
  );
  state.translationAutoRefresh.clear();
  localStorage.setItem(TARGET_TRANSLATION_LANGUAGE_KEY, next);
  localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  await loadTranslationsForActiveSource();
  renderLanguageSelectors();
  if (state.data) renderAll();
  if (state.activeRequestId) showRaw(state.activeRequestId, state.activeRawSection, { mode: state.activeRawMode || "request" });
}

async function setTargetTranslationLanguageFromSelect() {
  const resolved = resolveTranslationLanguage(els.translationLanguageSelect?.value);
  if (!resolved) {
    renderLanguageSelectors();
    return;
  }
  await setTargetTranslationLanguage(resolved.value);
}

async function init() {
  const layoutPreferences = paneLayoutController.readPreferences();
  const storedTargetLanguage = localStorage.getItem(TARGET_TRANSLATION_LANGUAGE_KEY);
  const targetTranslationLanguage = storedTargetLanguage
    ? normalizeTranslationLanguage(storedTargetLanguage)
    : defaultTranslationLanguage();
  clientStore.update(
    {
      ...layoutPreferences,
      latestOnly: localStorage.getItem(LATEST_ONLY_KEY) === "true",
      rawMessagesMode: normalizeMessagesMode(localStorage.getItem(RAW_MESSAGES_MODE_KEY)),
      uiLanguage: normalizeUiLanguage(localStorage.getItem(UI_LANGUAGE_KEY)),
      targetTranslationLanguage,
      translationMode: localStorage.getItem(TRANSLATION_MODE_KEY) === targetTranslationLanguage ? targetTranslationLanguage : "source",
    },
    { reason: "hydrate-preferences", silent: true },
  );
  applyStaticI18n();
  renderLanguageSelectors();
  paneLayoutController.applyCurrentState({ persist: false });
  state.sources = await api.listSources();
  renderSessionNav();
  const requestedSource = new URLSearchParams(window.location.search).get("source");
  const first =
    state.sources.find((source) => source.id === requestedSource && source.available) ||
    state.sources.find((source) => source.available) ||
    state.sources[0];
  if (first) await loadSource(first.id);
  els.traceImportButton?.addEventListener("click", () => els.traceImportInput?.click());
  els.traceImportInput?.addEventListener("change", importTraceFromFile);
  els.uiLanguageSelect?.addEventListener("change", (event) => {
    setUiLanguage(event.target.value);
  });
  els.translationLanguageSelect?.addEventListener("change", () => {
    setTargetTranslationLanguageFromSelect();
  });
  rawSearchController.bind();
  traceTimelineController.bind();
  els.rawTree.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (retranslateButton && els.rawTree.contains(retranslateButton)) {
      event.preventDefault();
      event.stopPropagation();
      retranslateTranslationBlock(retranslateButton.dataset.translationRetranslate);
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
      generateTranslationsForActiveSource(generateButton.dataset.translationSection || "system");
      return;
    }
    const copyButton = event.target.closest("[data-translation-copy]");
    if (copyButton && els.rawTree.contains(copyButton)) {
      event.preventDefault();
      event.stopPropagation();
      copyTranslationBlock(copyButton.dataset.translationCopy, copyButton);
      return;
    }
    const copyAllButton = event.target.closest("[data-translation-copy-all]");
    if (copyAllButton && els.rawTree.contains(copyAllButton)) {
      event.preventDefault();
      event.stopPropagation();
      copyAllTranslations(copyAllButton.dataset.translationCopyAll, copyAllButton);
      return;
    }
    const button = event.target.closest("[data-raw]");
    if (!button || !els.rawTree.contains(button)) return;
    showRaw(button.dataset.raw, button.dataset.rawSection || "full", { mode: button.dataset.rawMode || "request" });
  });
  document.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (!retranslateButton || els.rawTree.contains(retranslateButton)) return;
    event.preventDefault();
    event.stopPropagation();
    retranslateTranslationBlock(retranslateButton.dataset.translationRetranslate);
  });
  turnRailController.bind();
  paneLayoutController.bind();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshLiveData({ force: true });
  });
  startAutoRefresh();
}

async function loadSource(sourceId, { preserveScroll = false } = {}) {
  const scrollTop = els.mainPanel.scrollTop;
  const loadSeq = (state.sourceLoadSeq += 1);
  const progressive = shouldUseProgressiveSourceLoad(sourceId, { preserveScroll });
  if (state.activeSourceId && state.activeSourceId !== sourceId) {
    requestDetailCache.clear();
    state.openSupportingTimelines.clear();
    state.openAgentDashboards.clear();
    state.expandedAgentBranches.clear();
    state.agentBranchLimits.clear();
    state.agentBranchFilters.clear();
    state.traceQuery = "";
    state.traceFilter = "all";
    state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
  }
  state.progressiveLoadError = "";
  const initialData = requestDetailCache.mergeIntoData(
    await fetchViewerData(sourceId, progressive ? { initial: true, limit: INITIAL_SOURCE_REQUEST_LIMIT } : {}),
  );
  if (loadSeq !== state.sourceLoadSeq) return;
  applyLoadedSourceData(initialData, { preserveScroll, scrollTop });
  if (progressive && initialData.partial?.has_more) {
    loadFullSourceInBackground(sourceId, { loadSeq });
    return;
  }
  loadTranslationsForSourceLoad(loadSeq);
}

async function refreshSources() {
  state.sources = await api.listSources();
  renderSessionNav();
  if (state.activeSourceId && !state.sources.some((source) => source.id === state.activeSourceId)) {
    const first = state.sources.find((source) => source.available) || state.sources[0];
    if (first) await loadSource(first.id);
  }
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(() => refreshLiveData(), LIVE_REFRESH_MS);
}

async function refreshLiveData({ force = false } = {}) {
  if (state.autoRefreshInFlight || document.hidden) return;
  const activeBefore = currentSourceFromList();

  state.autoRefreshInFlight = true;
  try {
    const nextSources = await api.listSources();
    const sourceChanged = sourcesSignature(nextSources) !== sourcesSignature(state.sources);
    state.sources = nextSources;
    if (sourceChanged) renderSessionNav();

    const activeAfter = currentSourceFromList();
    if (!state.activeSourceId || !activeAfter) return;
    if (!activeAfter.available) return;
    const activeNeedsReload =
      force ||
      activeAfter.request_count !== activeBefore?.request_count ||
      activeAfter.response_count !== activeBefore?.response_count ||
      activeAfter.live_status !== activeBefore?.live_status ||
      activeAfter.last_seen !== activeBefore?.last_seen ||
      activeAfter.last_response_seen !== activeBefore?.last_response_seen;

    if (activeNeedsReload) await refreshActiveSource(activeAfter);
  } catch (error) {
    console.warn("peekMyAgent auto refresh failed", error);
  } finally {
    state.autoRefreshInFlight = false;
  }
}

async function refreshActiveSource(activeSource) {
  const previousData = state.data;
  const nextData = requestDetailCache.mergeIntoData(await fetchViewerData(activeSource.id));
  if (!shouldRenderRefreshedData(previousData, nextData)) return;

  const wasNearBottom = isMainPanelNearBottom();
  const previousScrollTop = els.mainPanel.scrollTop;
  state.data = nextData;
  await loadTranslationsForActiveSource();
  const turnIds = activeTurnIds(nextData);
  const activeId = turnIds.includes(state.activeId) ? state.activeId : turnIds.at(-1) || null;
  const activeRequestId = nextData.requests.some((request) => request.id === state.activeRequestId)
    ? state.activeRequestId
    : nextData.requests.at(-1)?.id || nextData.requests[0]?.id || null;
  clientStore.setSelection(
    { activeSourceId: nextData.source.id, activeId, activeRequestId },
    { reason: "refresh-source" },
  );
  renderAll();
  if (wasNearBottom) {
    els.mainPanel.scrollTop = els.mainPanel.scrollHeight;
  } else {
    els.mainPanel.scrollTop = previousScrollTop;
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

async function loadFullSourceInBackground(sourceId, { loadSeq } = {}) {
  window.setTimeout(async () => {
    try {
      const fullData = requestDetailCache.mergeIntoData(await fetchViewerData(sourceId));
      if (loadSeq !== state.sourceLoadSeq || state.activeSourceId !== fullData.source.id) return;
      const scrollTop = els.mainPanel.scrollTop;
      applyLoadedSourceData(fullData, { preserveScroll: true, scrollTop });
      loadTranslationsForSourceLoad(loadSeq);
    } catch (error) {
      if (loadSeq !== state.sourceLoadSeq || state.activeSourceId !== sourceId) return;
      state.progressiveLoadError = error.message;
      renderAll();
      console.warn("peekMyAgent full trace background load failed", error);
    }
  }, 40);
}

async function loadTranslationsForSourceLoad(loadSeq) {
  try {
    await loadTranslationsForActiveSource();
    if (loadSeq !== state.sourceLoadSeq) return;
    if (state.activeRequestId && !els.rawTree.classList.contains("empty")) {
      showRaw(state.activeRequestId, state.activeRawSection, { mode: state.activeRawMode || "request" });
    }
  } catch (error) {
    console.warn("peekMyAgent translation load failed", error);
  }
}

function shouldUseProgressiveSourceLoad(sourceId, { preserveScroll = false } = {}) {
  if (preserveScroll) return false;
  const source = state.sources.find((item) => item.id === sourceId);
  return Number(source?.request_count || 0) >= PROGRESSIVE_SOURCE_MIN_REQUESTS;
}

function fetchViewerData(sourceId, { initial = false, limit = INITIAL_SOURCE_REQUEST_LIMIT } = {}) {
  return api.viewSource(sourceId, { initial, limit });
}

function currentRequestById(requestId) {
  return (state.data?.requests || []).find((item) => item.id === requestId) || null;
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

function mergeRequestDetail(fullRequest) {
  if (!fullRequest?.id || !state.data?.requests) return fullRequest;
  const index = state.data.requests.findIndex((request) => request.id === fullRequest.id);
  if (index === -1) return fullRequest;
  const previous = state.data.requests[index];
  const merged = {
    ...previous,
    ...fullRequest,
    changes: previous.changes || fullRequest.changes,
    context_delta: previous.context_delta || fullRequest.context_delta,
    trace: {
      ...(fullRequest.trace || {}),
      context_chain_key: previous.trace?.context_chain_key || fullRequest.trace?.context_chain_key || null,
      previous_context_request_index: previous.trace?.previous_context_request_index || fullRequest.trace?.previous_context_request_index || null,
    },
  };
  state.data.requests[index] = merged;
  return merged;
}

async function rebuildTranslationLookupForCurrentData() {
  if (!state.translations?.available) return;
  state.translationLookup = await buildTranslationLookup(state.data?.requests || [], state.translations);
}

async function loadTranslationsForActiveSource({ autoRefresh = true } = {}) {
  const agents = translationAgentCandidatesForData(state.data);
  const targetLanguage = currentTargetLanguage();
  if (!agents.length) {
    state.translations = null;
    state.translationLookup = new Map();
    return;
  }
  try {
    const attempts = [];
    for (const agent of agents) {
      const translations = await api.translations(agent, targetLanguage);
      attempts.push(translations);
      if (translations.available) {
        state.translations = translations;
        await rebuildTranslationLookupForCurrentData();
        return;
      }
    }
    state.translations = attempts[0] || { available: false, target_language: targetLanguage, entries: {} };
    state.translationLookup = new Map();
    if (autoRefresh) maybeAutoRefreshTranslations(agents[0] || "OpenClaw");
  } catch (error) {
    console.warn("peekMyAgent translation cache unavailable", error);
    state.translations = { available: false, error: error.message, target_language: targetLanguage, entries: {} };
    state.translationLookup = new Map();
  }
}

function maybeAutoRefreshTranslations(agent) {
  const sourceId = state.data?.source?.id || state.activeSourceId || "";
  const key = `${sourceId}\0${agent}\0${currentTargetLanguage()}`;
  if (!sourceId || state.translationAutoRefresh.has(key) || state.translationGenerate.loading) return;
  state.translationAutoRefresh.add(key);
  setTimeout(() => {
    generateTranslationsForActiveSource(state.activeRawSection || "tools", { automatic: true, agent }).catch((error) => {
      console.warn("peekMyAgent auto translation refresh failed", error);
    });
  }, 0);
}

async function generateTranslationsForActiveSource(section, { automatic = false, agent = null } = {}) {
  if (state.translationGenerate.loading) return;
  const selectedAgent = agent || translationAgentCandidatesForData(state.data)[0] || "Claude Code";
  const activeSection = section || state.activeRawSection || "system";
  if (state.activeRequestId) {
    try {
      await ensureRequestDetailLoaded(state.activeRequestId);
    } catch (error) {
      console.warn("peekMyAgent request detail unavailable before translation", error);
    }
  }
  const activeRequest = (state.data?.requests || []).find((request) => request.id === state.activeRequestId);
  const targetLanguage = currentTargetLanguage();
  const languageLabel = currentTargetLanguageLabel();
  state.translationGenerate = {
    loading: true,
    error: "",
    message: automatic ? t("autoTranslating", { language: languageLabel }) : t("translatingSection"),
  };
  if (state.activeRequestId) showRaw(state.activeRequestId, activeSection, { mode: state.activeRawMode || "request" });
  try {
    const result = await api.generateTranslations({
      agent: selectedAgent,
      source_id: state.data?.source?.id || state.activeSourceId || "",
      request_id: state.activeRequestId || "",
      section: activeSection,
      force: !automatic,
      target_language: targetLanguage,
    });
    await loadTranslationsForActiveSource({ autoRefresh: false });
    const translated = Number(result.translate?.translated || 0);
    const remaining = Number(result.translate?.remaining || 0);
    const stats = activeRequest ? translationSectionStats(activeRequest, activeSection) : { total: 0, hit: 0, missing: 0 };
    const cacheAvailable = Boolean(state.translations?.available);
    const message = translationGenerateMessage({ cacheAvailable, translated, remaining, stats });
    state.translationGenerate = {
      loading: false,
      error: "",
      message: automatic && message === t("translationCacheLatest", { language: languageLabel }) ? t("translationAutoUpdated") : message,
    };
    if (cacheAvailable && stats.hit > 0) {
      clientStore.setLanguage({ translationMode: targetLanguage }, { reason: "translation-generated" });
      localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
    }
  } catch (error) {
    state.translationGenerate = {
      loading: false,
      error: error.message,
      message: "",
    };
  }
  if (state.activeRequestId) showRaw(state.activeRequestId, activeSection, { mode: state.activeRawMode || "request" });
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

function translationBlockClipboardText(item) {
  const kind = item.kind;
  const sourceText = item.sourceText || item.source_text || "";
  const label = item.metadata?.label || translationKindLabel(kind);
  const translation = translatedTextFor(kind, sourceText);
  const parts = [`## ${label}  [${kind}]`, "", `${t("sourceLabel")}:`, sourceText];
  if (translation) parts.push("", `${t("translationLabel")}:`, translation);
  return parts.join("\n");
}

function copyTranslationBlock(actionId, button) {
  const item = state.translationActionItems.get(actionId);
  if (!item) return;
  writeClipboard(translationBlockClipboardText(item), button);
}

function sectionTranslationMaterials(request, section) {
  if (section === "system") return collectSystemTranslationMaterials(request);
  if (section === "tools") return collectToolTranslationMaterials(request);
  if (section === "harness") return collectHarnessTranslationMaterials(request);
  return [];
}

function copyAllTranslations(section, button) {
  const request = (state.data?.requests || []).find((item) => item.id === state.activeRequestId);
  if (!request) return;
  const materials = sectionTranslationMaterials(request, section);
  if (!materials.length) return;
  const header = `# ${rawSectionLabel(section)} · ${t("requestClipboardTitle", { index: request.request_index })}`;
  const body = section === "tools" ? toolsTranslationClipboardText(materials) : materials.map((material) => translationBlockClipboardText(material)).join("\n\n---\n\n");
  writeClipboard(`${header}\n\n${body}\n`, button);
}

function toolsTranslationClipboardText(materials) {
  return groupToolTranslationMaterials(materials)
    .map((group) => {
      const parts = [`## ${t("toolClipboardHeading")}: ${group.toolName}`];
      if (group.description) parts.push("", translationMaterialClipboardSection(group.description, t("toolDescription")));
      for (const parameter of group.parameters) {
        const parameterName = parameter.metadata?.field_name || parameter.metadata?.path || "parameter";
        parts.push("", translationMaterialClipboardSection(parameter, t("parameterClipboardHeading", { name: parameterName })));
      }
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

function translationMaterialClipboardSection(material, label) {
  const sourceText = material.source_text || "";
  const translation = translatedTextFor(material.kind, sourceText);
  const parts = [`### ${label}`, "", `${t("sourceLabel")}:`, sourceText];
  if (translation) parts.push("", `${t("translationLabel")}:`, translation);
  return parts.join("\n");
}

async function retranslateTranslationBlock(actionId) {
  const item = state.translationActionItems.get(actionId);
  if (!item || state.translationGenerate.loading) return;
  const selectedAgent = translationAgentCandidatesForData(state.data)[0] || "Claude Code";
  const materials = item.materials?.length
    ? item.materials
    : [
        {
          kind: item.kind,
          source_text: item.sourceText,
          metadata: item.metadata || {},
        },
      ];
  const targetLanguage = currentTargetLanguage();
  state.translationGenerate = { loading: true, error: "", message: materials.length > 1 ? t("translatingParameterGroup") : t("retranslatingBlock") };
  if (item.surface === "raw" && state.activeRequestId) showRaw(state.activeRequestId, item.section || state.activeRawSection || "system", { mode: state.activeRawMode || "request" });
  try {
    const result = await api.generateTranslations({
      agent: selectedAgent,
      source_id: state.data?.source?.id || state.activeSourceId || "",
      request_id: item.requestId || state.activeRequestId || "",
      target_language: targetLanguage,
      force: true,
      materials,
    });
    await loadTranslationsForActiveSource({ autoRefresh: false });
    const translated = Number(result.translate?.translated || 0);
    state.translationGenerate = {
      loading: false,
      error: "",
      message: translated
        ? materials.length > 1
          ? t("retranslatedParametersDone", { count: translated })
          : t("retranslatedBlockDone")
        : t("translationCacheLatest", { language: currentTargetLanguageLabel() }),
    };
    clientStore.setLanguage({ translationMode: targetLanguage }, { reason: "translation-block-generated" });
    localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  } catch (error) {
    state.translationGenerate = {
      loading: false,
      error: error.message,
      message: "",
    };
  }
  if (item.surface === "timeline") {
    renderTimelineSurface();
  } else if (item.surface === "raw" && state.activeRequestId) {
    showRaw(state.activeRequestId, item.section || state.activeRawSection || "system", { mode: state.activeRawMode || "request" });
  }
}

function translationGenerateMessage({ cacheAvailable, translated, remaining, stats }) {
  const languageLabel = currentTargetLanguageLabel();
  if (!cacheAvailable) return t("translationCacheNotFoundAfterGenerate", { language: languageLabel });
  if (stats.total && stats.hit < stats.total) {
    return translated
      ? t("translationSectionPartialWithTranslated", { translated, hit: stats.hit, total: stats.total, remaining })
      : t("translationSectionPartial", { language: languageLabel, hit: stats.hit, total: stats.total });
  }
  if (translated) return t("translationSectionCompletedWithTranslated", { translated, language: languageLabel, hit: stats.hit, total: stats.total });
  return stats.total ? t("translationSectionLatest", { language: languageLabel, hit: stats.hit, total: stats.total }) : t("translationCacheLatest", { language: languageLabel });
}

function translationAgentCandidatesForData(data) {
  const values = [];
  add(data?.source?.agent);
  add(data?.source?.id);
  add(data?.source?.store_watch_id);
  for (const request of data?.requests || []) {
    add(request.agent_profile);
    add(request.raw?.agent_profile);
    add(request.watch_id);
    add(request.raw?.watch_id);
    add(request.raw?.body?.metadata?.agent);
  }
  if (values.some((value) => /claude-code|claude|anthropic|\bcc\b/i.test(value))) add("Claude Code");
  if (values.some((value) => /trae-cn|trae/i.test(value))) add("Trae CN");
  return values;

  function add(value) {
    const normalized = String(value || "").trim();
    if (normalized && !values.includes(normalized)) values.push(normalized);
  }
}

async function buildTranslationLookup(requests, translations) {
  const entries = translations?.entries || {};
  if (!translations?.available || !Object.keys(entries).length || !window.crypto?.subtle) return new Map();
  const unique = new Map();
  for (const request of requests) {
    for (const item of collectTranslationMaterials(request)) {
      const sourceText = normalizeTranslationText(item.source_text);
      if (sourceText) unique.set(translationLookupKey(item.kind, sourceText), { ...item, source_text: sourceText });
    }
  }
  const pairs = await Promise.all(
    [...unique.values()].map(async (item) => {
      const hash = await materialHash(item.kind, item.source_text);
      const entry = entries[hash];
      return entry?.translated_text ? [translationLookupKey(item.kind, item.source_text), entry] : null;
    }),
  );
  return new Map(pairs.filter(Boolean));
}

function setTranslationMode(mode, section) {
  const targetLanguage = currentTargetLanguage();
  clientStore.setLanguage(
    { translationMode: mode === targetLanguage ? targetLanguage : "source" },
    { reason: "set-translation-mode" },
  );
  rawSearchController.modeChanged();
  localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  if (state.activeRequestId) showRaw(state.activeRequestId, section || state.activeRawSection || "full", { mode: state.activeRawMode || "request" });
}

function setMessagesMode(mode) {
  clientStore.setRawView({ rawMessagesMode: normalizeMessagesMode(mode) }, { reason: "set-messages-mode" });
  localStorage.setItem(RAW_MESSAGES_MODE_KEY, state.rawMessagesMode);
  if (state.activeRequestId) showRaw(state.activeRequestId, "messages", { mode: state.activeRawMode || "request" });
}

function shouldRenderRefreshedData(previousData, nextData) {
  if (!previousData) return true;
  return dataSignature(previousData) !== dataSignature(nextData);
}

function dataSignature(data) {
  const requests = data?.requests || [];
  return [
    data?.source?.id || "",
    data?.source?.live_status || "",
    data?.source?.conversation_id || "",
    requests.length,
    requests.at(-1)?.id || "",
    requests.at(-1)?.captured_at || "",
    requests
      .map((request) =>
        [
          request.id,
          request.summary?.response?.captured ? "r" : "",
          request.summary?.response?.received_at || "",
          request.summary?.response?.raw_body_bytes || "",
          request.summary?.response?.truncated ? "truncated" : "",
        ].join(":"),
      )
      .join(","),
  ].join("|");
}

function sourcesSignature(sources) {
  return (sources || [])
    .map((source) =>
      [
        source.id,
        source.label || "",
        source.pinned ? "pinned" : "",
        source.live_status || "",
        source.request_count || 0,
        source.response_count || 0,
        source.last_seen || "",
        source.last_response_seen || "",
        source.conversation_id || "",
      ].join(":"),
    )
    .join("|");
}

function currentSourceFromList() {
  return state.sources.find((source) => source.id === state.activeSourceId) || null;
}

function isMainPanelNearBottom() {
  const gap = els.mainPanel.scrollHeight - els.mainPanel.scrollTop - els.mainPanel.clientHeight;
  return gap < 160;
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
    state.sources = response.sources || (await api.listSources());
    renderSessionNav();
    if (response.source_id) await loadSource(response.source_id);
  } catch (error) {
    window.alert(t("importTraceFailed", { message: error.message }));
  }
}

async function updateSourceMeta(sourceId, payload) {
  try {
    const response = await api.updateSource({ id: sourceId, ...payload });
    state.sources = response.sources || (await api.listSources());
  } catch (error) {
    console.warn("peekMyAgent source update failed", error);
    window.alert(t("sourceUpdateFailed", { message: error.message }));
    state.sources = await api.listSources();
    renderSessionNav();
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
    state.sources = response.sources || (await api.listSources());
  } catch (error) {
    console.warn("peekMyAgent project update failed", error);
    window.alert(t("projectUpdateFailed", { message: error.message }));
    state.sources = await api.listSources();
    renderSessionNav();
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
  clearTranslationActions();
  renderHeaderSurface();
  renderTimelineSurface({ updateViewControls: false });
  renderComposerSurface();
}

function renderHeaderSurface() {
  const { source, stats, requests } = state.data;
  els.pageTitle.textContent = displaySourceLabel(source.label);
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
  els.viewControls.innerHTML =
    `<button class="stat stat-button ${state.latestOnly && !traceQueryActive() ? "active" : ""}" type="button" data-latest-only ${traceQueryActive() ? `disabled title="${escapeHtml(t("latestDisabledBySearch"))}"` : ""}>${state.latestOnly && !traceQueryActive() ? t("showAllTurns") : t("latestOnly")}</button>` +
    `<button class="stat stat-button session-info-trigger" type="button" data-session-info>${t("sessionInfo")}</button>`;
  bindViewControlEvents();
  bindSessionInfoControls();
}

function renderTimelineSurface({ updateViewControls = true } = {}) {
  if (!state.data) return;
  clearTranslationActions("timeline");
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
  if (!partial?.has_more && !state.progressiveLoadError) return "";
  const loaded = partial?.loaded_request_count || state.data?.requests?.length || 0;
  const total = partial?.total_request_count || state.data?.stats?.request_count || loaded;
  const message = state.progressiveLoadError
    ? t("traceFullLoadFailed", { message: state.progressiveLoadError })
    : t("traceInitialLoading", { loaded, total });
  return `
    <div class="progressive-load-notice ${state.progressiveLoadError ? "error" : ""}">
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
    state.sources = await api.listSources();
    renderSessionNav();
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
  if (request.source_hint.type === "metadata") return request.source_hint.label || t("metadataRequest");
  if (request.summary?.command_message) return commandMessageLabel(request.summary.command_message);
  return request.is_subagent ? t("subagentRequest") : request.source_hint.type === "parent_spawn" ? t("parentSpawnRequest") : t("mainAgentRequest");
}

function requestExcerpt(request) {
  if (request.summary?.command_message) return commandMessagePreview(request.summary.command_message);
  return request.source_hint.type === "metadata"
    ? request.summary.internal_request_preview || request.summary.current_user || request.summary.assistant_preview || t("noTextSummary")
    : request.summary.current_user || request.summary.assistant_preview || t("noTextSummary");
}

function commandMessageLabel(commandMessage) {
  return `Command ${commandMessage?.command || ""}`.trim();
}

function commandMessagePreview(commandMessage) {
  const command = commandMessage?.command || "/command";
  const body = cleanDisplayText(commandMessage?.body || commandMessage?.preview || "");
  return body ? `${command} · ${shortPreview(body, 180)}` : `Command ${command}`;
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
      ${
        primaryRequests.length
          ? `<div class="turn-request-list primary-requests">${primaryRequests.map((request) => renderTurnRequest(request, request.id === lead?.id ? turn : null)).join("")}</div>`
          : ""
      }
      ${renderAgentBranchesForTurn(turn, requestMap)}
      ${responseRequests.length ? `<div class="turn-request-list response-requests">${responseRequests.map(renderTurnRequest).join("")}</div>` : ""}
      ${renderSupportingRequests(supportingRequests, turn.id)}
    </section>
  `;
}

function isPrimaryTurnRequest(request) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.is_subagent) return false;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return false;
  return shouldShowTimelineRequestContent(request) || Boolean(request.summary?.command_message);
}

function isTurnResponseRequest(request) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.is_subagent) return false;
  return shouldShowTimelineAssistantResponse(request);
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

function renderAgentBranchesForTurn(turn, requestMap) {
  const trace = state.data?.agent_trace;
  const view = buildAgentGraphView({
    turn,
    trace,
    requestMap,
    dashboardOpen: state.openAgentDashboards.has(turn.id),
    activeFilter: state.agentBranchFilters.get(turn.id) || "all",
    branchLimit: state.agentBranchLimits.get(turn.id) || AGENT_BRANCH_PAGE_SIZE,
    expandedBranchIds: state.expandedAgentBranches,
    requestTitle: requestDisplayTitle,
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

function renderUpstreamEntry(request) {
  const expanded = state.upstreamExpanded.has(request.id);
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const entryPreview = cleanDisplayText(request.summary?.entry?.text || "");
  const showPreview = showInlineContent || Boolean(entryPreview);
  const meta = renderProviderUsageStats(request);
  return renderTimelineUpstreamEntryView({
    entry: {
      requestIndex: request.request_index,
      kindClass: upstreamKindClass(request),
      userTurn: isUserTurnEntry(request),
      compact: !showInlineContent,
      label: upstreamEntryLabel(request),
      preview: showPreview ? upstreamEntryPreview(request) : "",
      ownerAria: t("ownerAria"),
      metaHtml: meta,
      actionsHtml: renderUpstreamQuickActions(request, expanded),
    },
    escapeHtml,
  });
}

function renderUpstreamQuickActions(request, expanded) {
  const hasUpstreamToolCalls = (request.summary?.current_tool_calls || []).length > 0;
  const hasToolResults = (request.summary?.current_tool_results || []).length > 0;
  const upstreamSections = [
    { section: "system", label: "System" },
    { section: "tools", label: "Tools" },
    ...(hasUpstreamToolCalls ? [{ section: "upstream_tool_calls", label: "tool_use" }] : []),
    ...(hasToolResults ? [{ section: "tool_results", label: "tool_result" }] : []),
  ];
  return renderTimelineUpstreamQuickActionsView({
    requestId: request.id,
    expanded,
    sections: upstreamSections,
    translate: t,
    escapeHtml,
  });
}

function shouldShowTimelineRequestContent(request) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.summary?.command_message) return false;
  if (request.is_subagent) return false;
  if (request.source_hint?.type === "parent_spawn") return false;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return false;
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return false;
  return Boolean(cleanDisplayText(request.summary?.current_user || ""));
}

// A turn-starting message the user actually sent — real input or a slash
// command — gets a prominent tint so a new turn is obvious at a glance.
function isUserTurnEntry(request) {
  if (request.summary?.command_message) return true;
  return request.summary?.entry?.kind === "user_input";
}

function upstreamKindClass(request) {
  if (request.source_hint?.type === "metadata") return "metadata";
  if (request.summary?.command_message) return "command-message";
  if (request.summary?.entry?.kind === "subagent_result") return "subagent-result";
  if ((request.summary?.current_tool_results?.length || 0) > 0) return "tool-result";
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return "tool-use";
  return "user";
}

function upstreamEntryLabel(request) {
  if (request.source_hint?.type === "metadata") return requestDisplayTitle(request);
  if (request.summary?.command_message) return commandMessageLabel(request.summary.command_message);
  const entry = request.summary?.entry;
  // Harness injections (compact prompt, task notification) frequently ride in
  // the same message as the prior turn's tool_results — they must win over the
  // incidental generic tool_result label.
  const knownEntryLabel = localizedEntryLabel(entry);
  if (knownEntryLabel) return knownEntryLabel;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return t("toolResultUpstream");
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return t("toolUseUpstream");
  if (request.is_subagent) return "Subagent input";
  // Distinguish other harness-injected continuations from genuine user input
  // instead of labeling everything "User input".
  if (entry?.kind && entry.kind !== "user_input" && entry.kind !== "unknown" && entry.label) return entry.label;
  return "User input";
}

function localizedEntryLabel(entry) {
  if (!entry?.kind) return "";
  if (entry.kind === "compact" || entry.kind === "task_notification" || entry.kind === "subagent_result" || entry.kind === "framework_reminder" || entry.kind === "agent_internal") {
    return messageKindLabel(entry.kind, entry.role);
  }
  return "";
}

function upstreamEntryPreview(request) {
  if (request.source_hint?.type === "metadata") {
    const frameworkReminder = [...(request.summary?.history_stack || [])].reverse().find((item) => item.kind === "framework_reminder");
    return shortPreview(request.summary.internal_request_preview || frameworkReminder?.text || requestDisplayTitle(request), 260);
  }
  if (request.summary?.command_message) return commandMessagePreview(request.summary.command_message);
  const entry = request.summary?.entry;
  // Harness injections riding alongside tool_results win over the generic
  // result-return preview.
  if ((entry?.kind === "compact" || entry?.kind === "task_notification" || entry?.kind === "subagent_result") && entry.text) {
    return shortPreview(cleanDisplayText(entry.text), 420);
  }
  const toolResults = request.summary?.current_tool_results || [];
  if (toolResults.length) {
    return t("resultReturnPreview", { count: toolResults.length });
  }
  const toolCalls = request.summary?.current_tool_calls || [];
  if (toolCalls.length) {
    const text = toolCalls.map((call) => `${call.name || "unknown"} ${stableJson(call.arguments ?? null)}`).join("\n");
    if (text) return shortPreview(text, 320);
  }
  if (entry?.text) return shortPreview(cleanDisplayText(entry.text), 420);
  return shortPreview(cleanDisplayText(request.summary.current_user || requestExcerpt(request)), 420);
}

function renderTurnRequest(request, turnInput = null) {
  return renderRequestCard(request, { turnInput });
}

function renderRequestCard(request, options = {}) {
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const assistantResponse = shouldShowTimelineAssistantResponse(request) ? renderAssistantResponse(request) : "";
  const toolExchange = showInlineContent ? renderToolExchange(request) : "";
  const upstreamOpen = state.upstreamExpanded.has(request.id);
  return renderTimelineRequestCardView({
    requestId: request.id,
    requestIndex: request.request_index,
    upstreamOpen,
    upstreamEntryHtml: options.turnInput ? renderTurnInputEntry(request, options.turnInput) : renderUpstreamEntry(request),
    upstreamBodyHtml: upstreamOpen ? renderUpstreamDetailsBody(request) : renderCollapsedUpstreamPlaceholder(request),
    toolExchangeHtml: toolExchange,
    assistantResponseHtml: assistantResponse,
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

function renderTurnInputEntry(request, turn) {
  const expanded = state.upstreamExpanded.has(request.id);
  const entry = request.summary?.entry;
  const kindClass = upstreamKindClass(request);
  const knownEntryLabel = localizedEntryLabel(entry);
  let label = "User input";
  if (turn.command_message) label = commandMessageLabel(turn.command_message);
  else if (knownEntryLabel) label = knownEntryLabel;
  else if (entry?.kind && entry.kind !== "user_input" && entry.kind !== "unknown" && entry.label) label = entry.label;
  const inputText = cleanDisplayText(
    turn.command_message ? commandMessagePreview(turn.command_message) : turn.user_input || entry?.text || turn.title || "",
  );
  const meta = renderProviderUsageStats(request);
  return renderTimelineUpstreamEntryView({
    entry: {
      requestIndex: request.request_index,
      kindClass,
      userTurn: isUserTurnEntry(request),
      label,
      preview: inputText,
      ownerAria: t("ownerAria"),
      metaHtml: meta,
      actionsHtml: renderUpstreamQuickActions(request, expanded),
    },
    escapeHtml,
  });
}

function shouldShowTimelineAssistantResponse(request) {
  if (request.source_hint?.type === "metadata") return false;
  const response = request.summary?.response;
  if (!response?.captured) return false;
  return Boolean(response.text || response.preview || response.thinking || (response.tool_calls || []).length);
}

function messageKindLabel(kind, role) {
  if (kind === "compact") return t("compactMessage");
  if (kind === "context_count") return t("contextCountMessage");
  if (kind === "subagent_result") return t("subagentResult");
  if (kind === "task_notification") return t("taskNotification");
  if (kind === "framework_reminder") return t("frameworkReminder");
  if (kind === "agent_internal") return t("agentInternal");
  if (kind === "tool_result") return "Tool result";
  if (kind === "tool_use") return "Tool use";
  if (kind === "assistant") return "Assistant";
  if (kind === "user") return "User";
  if (kind === "system") return "System";
  return role || kind || "Message";
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
  const calls = request.summary.current_tool_calls || [];
  const results = request.summary.current_tool_results || [];
  if (!calls.length && !results.length) return "";
  return renderTimelineToolExchangeView({
    pairs: pairToolEvents(calls, results),
    counts: { calls: calls.length, results: results.length },
    translate: t,
    escapeHtml,
    renderPre,
    serializeArguments: (value) => JSON.stringify(value, null, 2),
  });
}

function renderAssistantResponse(request) {
  const response = request.summary.response;
  if (!response?.captured) return "";
  const responseText = response.text || response.preview || "";
  const longResponse = cleanDisplayText(responseText).length > 200;
  const expanded = state.responseExpanded.has(request.id);
  const visibleText = longResponse && !expanded ? markdownPreview(responseText, 200) : responseText;
  const meta = [
    response.latency_ms != null ? `${response.latency_ms}ms` : "",
    response.finish_reason ? `finish: ${response.finish_reason}` : "",
    response.truncated ? t("truncated") : "",
    ...formatResponseUsageMeta(response.usage),
  ].filter(Boolean);
  return renderTimelineAssistantResponseView({
    view: {
      requestId: request.id,
      expanded,
      longResponse,
      visibleText,
      meta,
      toolCalls: response.tool_calls || [],
      thinking: buildAssistantThinkingView(response, request),
    },
    translate: t,
    escapeHtml,
    renderMarkdown: renderSafeMarkdown,
    renderTranslationMarkdown: renderMarkdownPreview,
    renderPre,
    serialize: stableJson,
  });
}

function buildAssistantThinkingView(response, request) {
  const thinking = response?.thinking || "";
  if (!thinking) return null;
  const preview = response.thinking_preview || shortPreview(thinking, 120);
  const translation = translatedTextFor("assistant_thinking", thinking);
  const actionId = registerTranslationAction({
    kind: "assistant_thinking",
    sourceText: thinking,
    section: "response",
    requestId: request.id,
    surface: "timeline",
    metadata: { source: "response.thinking" },
  });
  return {
    text: thinking,
    charCount: formatCharCount(thinking.length),
    preview,
    translation,
    actionId,
    actionLabel: translation ? t("retranslateThinking") : t("translateThinking"),
    translationLoading: state.translationGenerate.loading,
  };
}

function formatResponseUsageMeta(usage) {
  if (!usage || typeof usage !== "object") return [];
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const cache = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const total = usage.total_tokens;
  const items = [
    input != null ? `input ${formatCompactNumber(Number(input))}` : "",
    cache != null ? `cache ${formatCompactNumber(Number(cache))}` : "",
    output != null ? `output ${formatCompactNumber(Number(output))}` : "",
    total != null ? `total ${formatCompactNumber(Number(total))}` : "",
  ].filter(Boolean);
  if (items.length) return items;
  return Object.entries(usage)
    .filter(([, value]) => value != null && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key} ${String(value)}`);
}

function pairToolEvents(calls, results) {
  const remainingResults = [...results];
  const pairs = calls.map((call) => {
    const matchIndex = remainingResults.findIndex((result) => result.id && call.id && result.id === call.id);
    const result = matchIndex >= 0 ? remainingResults.splice(matchIndex, 1)[0] : null;
    return { call, result, confidence: result ? "id" : "call_only" };
  });
  for (const result of remainingResults) pairs.push({ call: null, result, confidence: "result_only" });
  return pairs;
}

function rawSectionData(request, section) {
  return buildRawSectionData(request, section, {
    translate: t,
    harnessMaterials: section === "harness" ? collectHarnessTranslationMaterials(request) : [],
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
  document.querySelectorAll(`[data-upstream-toggle="${cssEscape(requestId)}"]`).forEach((button) => {
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.closest(".upstream-entry")?.classList.toggle("active", open);
    const label = button.querySelector(".toggle-label");
    if (label) label.textContent = open ? t("collapseUpstream") : t("expandUpstream");
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

async function showRaw(id, section = "full", { mode = "request" } = {}) {
  const request = state.data.requests.find((item) => item.id === id);
  if (!request) return;
  const contextChanged = state.activeRequestId !== id || state.activeRawSection !== section || state.activeRawMode !== mode;
  if (contextChanged) rawSearchController.contextChanged();
  clearTranslationActions("raw");
  clientStore.setRawContext(
    { requestId: id, section, mode },
    { reason: "show-raw" },
  );
  markActiveRequest(id, false);
  paneLayoutController.setRawOpen(true);
  els.rawTitle.textContent = `Request ${request.request_index} · ${mode === "response" ? responseRawSectionLabel(section) : rawSectionLabel(section)}`;
  els.rawTree.className = "raw-tree";
  if (requestNeedsDetail(request)) {
    els.rawTree.innerHTML = renderRequestDetailLoading();
  }
  try {
    const hydrated = await ensureDetailsForRawSection(request, section);
    if (state.activeRequestId !== id || state.activeRawSection !== section || state.activeRawMode !== mode) return;
    els.rawTree.innerHTML = renderRawSections(hydrated, section, mode);
    rawSearchController.decorate();
  } catch (error) {
    if (state.activeRequestId !== id || state.activeRawSection !== section || state.activeRawMode !== mode) return;
    els.rawTree.innerHTML = renderRequestDetailError(error);
  }
}

function showSystemDiff(id) {
  showRaw(id, "system_diff");
}

function renderRawSections(request, activeSection = "full", mode = "request") {
  const body = request.raw?.body || {};
  if (mode === "response") return renderResponseOnlyRawSection(request, activeSection);
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
      ${renderMessagesControls(activeSection)}
      ${renderRawSectionContent(request, activeSection, sectionData)}
    `;
  }
  return `
    ${renderRawStickyControls(request, activeSection, mode)}
    ${normalizedRawSearchQuery() ? renderRawSearchResults(request, activeSection, mode) : `
    ${renderRawDetail(t("rawFullCapture"), rawUpstreamRequestValue(request))}
    ${renderRawDetail("system", body.system ?? null)}
    ${renderRawDetail("tools", body.tools ?? null)}
    ${renderRawDetail("messages / history", body.messages ?? null)}
    ${renderRawDetail(t("rawRequestMetadata"), rawSectionData(request, "metadata").value)}
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
        : renderRawDetail("response", rawResponseSectionValue(request));
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
    translationControls: renderTranslationControls(request, section),
  });
}

function renderResponseOnlyToolsSchemaSection(request) {
  const sectionData = rawSectionData(request, "tools");
  return `
    ${renderRawSourceNotice({ title: t("responseOnlyToolsNoticeTitle"), text: t("responseOnlyToolsNotice"), escapeHtml })}
    ${renderRawSectionContent(request, "tools", sectionData)}
  `;
}

function renderRawSearchControls(request, section, mode = "request") {
  const query = rawSearchController.query;
  const scope = rawSearchScopeLabel(section, mode);
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
  const scope = rawSearchScopeLabel(section, mode);
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
    return rawSearchEntries(rawSectionData(request, section).value, rawSectionLabel(section));
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
  return rawSearchEntries(rawSectionData(request, section).value, rawSectionLabel(section));
}

function rawSearchEntries(value, rootPath) {
  return collectRawSearchEntries(value, rootPath, { serialize: stableJson, preview: shortPreview });
}

function normalizedRawSearchQuery() {
  return rawSearchController.normalizedQuery();
}

function rawSearchScopeLabel(section, mode = "request") {
  if (mode === "response" && section === "tools") return "Tools schema";
  if (mode === "response" && section === "tool_calls") return "Response tool_use";
  if (mode === "response") return responseRawSectionLabel(section);
  return rawSectionLabel(section);
}

function highlightSearchSnippet(text, query) {
  return rawSearchSnippetSegments(text, query)
    .map((segment) => (segment.match ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text)))
    .join("");
}

function renderRawSectionContent(request, section, sectionData) {
  if (section === "messages") return renderMessagesSection(sectionData.value);
  if (state.translationMode === currentTargetLanguage() && state.translations?.available) {
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
    Boolean(state.translations?.available)
  );
}

function renderMessagesControls(section) {
  return renderMessagesControlsView({ section, mode: normalizeMessagesMode(state.rawMessagesMode), translate: t, escapeHtml });
}

function renderMessagesSection(messagesValue) {
  return renderMessagesSectionView({
    messagesValue,
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
  const cache = state.translations;
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
      registerTranslationAction({
        ...action,
        section: state.activeRawSection || section,
        surface: "raw",
      }),
  });
}

function registerTranslationAction({ kind, sourceText, section, requestId = "", surface = "raw", metadata = {}, materials = null }) {
  const id = String(state.nextTranslationActionId++);
  state.translationActionItems.set(id, {
    kind,
    sourceText,
    section,
    requestId: requestId || state.activeRequestId || "",
    surface,
    metadata,
    materials,
  });
  return id;
}

function clearTranslationActions(surface = "") {
  if (!surface) {
    state.translationActionItems.clear();
    state.nextTranslationActionId = 1;
    return;
  }
  for (const [id, item] of state.translationActionItems.entries()) {
    if (item.surface === surface) state.translationActionItems.delete(id);
  }
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
  return t("description");
}

function translationSectionStats(request, section) {
  return summarizeTranslationSection(sectionTranslationMaterials(request, section), { translatedTextFor });
}

function translatedTextFor(kind, sourceText) {
  const source = normalizeTranslationText(sourceText);
  return source ? state.translationLookup.get(translationLookupKey(kind, source))?.translated_text || "" : "";
}

function rawSectionLabel(section) {
  const labels = {
    full: t("rawFull"),
    system: "System",
    system_diff: "System diff",
    tools: "Tools",
    harness: t("rawHarness"),
    messages: "Messages",
    upstream_tool_calls: "Upstream tool_use",
    tool_calls: "Tool use",
    tool_results: "Tool result",
    response: "Response",
    metadata: t("rawRequestMetadata"),
  };
  return labels[section] || "Raw";
}

function responseRawSectionLabel(section) {
  if (section === "tool_calls") return "Response tool_use";
  if (section === "tools") return "Tools schema";
  return "Response raw";
}

function renderSystemDiff(request) {
  const previous = previousRequest(request);
  if (!previous) {
    return `<div class="empty-box">${escapeHtml(t("noPreviousSystemDiff"))}</div>`;
  }
  const before = systemTextFromRequest(previous);
  const after = systemTextFromRequest(request);
  const diffRows = createLineDiff(before, after);
  const compactRows = compactDiffRows(diffRows, 4);
  const added = diffRows.filter((row) => row.type === "add").length;
  const removed = diffRows.filter((row) => row.type === "remove").length;
  const changed = added || removed;
  return `
    <section class="system-diff">
      <div class="diff-summary">
        <div>
          <h3>System prompt diff</h3>
          <p>#${escapeHtml(previous.request_index)} → #${escapeHtml(request.request_index)} · ${escapeHtml(changed ? t("diffRowsChanged", { added, removed }) : t("noVisibleLineChanges"))}</p>
        </div>
        <div class="diff-legend" aria-label="${escapeHtml(t("diffLegendAria"))}">
          <span class="legend-remove">${escapeHtml(t("diffRemove"))}</span>
          <span class="legend-add">${escapeHtml(t("diffAdd"))}</span>
          <span class="legend-context">${escapeHtml(t("diffContext"))}</span>
        </div>
      </div>
      ${
        changed
          ? `<div class="diff-lines">${compactRows.map(renderDiffRow).join("")}</div>`
          : `<div class="empty-box">${escapeHtml(t("noDiffRows"))}</div>`
      }
    </section>
  `;
}

function previousRequest(request) {
  const requests = state.data?.requests || [];
  const index = requests.findIndex((item) => item.id === request.id);
  return index > 0 ? requests[index - 1] : null;
}

function systemTextFromRequest(request) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts = [];
  if (typeof body.system === "string") parts.push(body.system);
  if (Array.isArray(body.system)) {
    for (const part of body.system) parts.push(extractContentText(part));
  }
  for (const message of messages) {
    if (message.role === "system") parts.push(extractContentText(message.content));
  }
  return parts.filter(Boolean).join("\n\n");
}

function collectTranslationMaterials(request) {
  return [
    ...collectSystemTranslationMaterials(request),
    ...collectToolTranslationMaterials(request),
    ...collectHarnessTranslationMaterials(request),
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

function collectSystemTranslationMaterials(request) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const materials = [];
  extractSystemPartsForTranslation(body, messages).forEach((part, index) => {
    const sourceText = normalizeTranslationText(part.text);
    const kind = systemTranslationKind(sourceText);
    if (isSkippableTranslationMaterial(kind, sourceText)) return;
    materials.push({
      kind,
      source_text: sourceText,
      metadata: { source: part.source, index },
    });
  });
  return dedupeTranslationMaterials(materials);
}

function collectToolTranslationMaterials(request) {
  const body = request.raw?.body || {};
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const materials = [];
  tools.forEach((tool, toolIndex) => {
    const toolName = toolNameOf(tool);
    const description = toolDescriptionOf(tool);
    if (description) {
      materials.push({
        kind: "tool_description",
        source_text: description,
        metadata: { tool_name: toolName, path: `tools[${toolIndex}].description` },
      });
    }
    const schema = tool.input_schema || tool.function?.parameters || tool.parameters || null;
    for (const item of extractSchemaDescriptionsForTranslation(schema, { rootPath: `tools[${toolIndex}].input_schema` })) {
      materials.push({
        kind: "tool_parameter_description",
        source_text: item.description,
        metadata: { tool_name: toolName, path: item.path, field_name: item.field_name },
      });
    }
  });
  return dedupeToolTranslationMaterials(materials);
}

function isCompactPromptText(text) {
  const t = String(text || "");
  return /create a detailed summary of the conversation so far/i.test(t) || (/Respond with TEXT ONLY/i.test(t) && /<analysis>[\s\S]*<summary>/i.test(t));
}

// Mirror of the server's extractHarnessTranslationParts: pull the harness
// injected prompt fragments (framework reminders, /compact, slash commands,
// suggestion mode) out of the message history for original/translated display.
// Reads request.raw.body (already shipped to the client), so no extra payload.
function collectHarnessTranslationMaterials(request) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const materials = [];
  messages.forEach((message, messageIndex) => {
    if (!message || message.role !== "user") return;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: extractContentText(message.content) }];
    const fullText = extractContentText(message.content);

    for (const block of blocks) {
      const text = typeof block === "string" ? block : block?.type === "text" ? block.text || "" : "";
      if (isCompactPromptText(text)) {
        materials.push({ kind: "harness_compact", source_text: text, metadata: { label: t("harnessCompact"), path: `messages[${messageIndex}]` } });
        break;
      }
    }
    if (/<command-(?:name|message)\b/i.test(fullText)) {
      const commandBody = fullText
        .replace(/<command-message\b[^>]*>([\s\S]*?)<\/command-message>/gi, "")
        .replace(/<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (commandBody) materials.push({ kind: "harness_command", source_text: commandBody, metadata: { label: t("harnessCommand"), path: `messages[${messageIndex}]` } });
    }
    if (/^\s*\[SUGGESTION MODE:/i.test(fullText)) {
      materials.push({ kind: "harness_suggestion", source_text: fullText, metadata: { label: t("harnessSuggestion"), path: `messages[${messageIndex}]` } });
    }
    const reminderRegex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
    let match;
    let reminderIndex = 0;
    while ((match = reminderRegex.exec(fullText))) {
      const inner = (match[1] || "").trim();
      if (inner) materials.push({ kind: "harness_reminder", source_text: inner, metadata: { label: `${t("harnessReminder")} #${reminderIndex + 1}`, path: `messages[${messageIndex}].reminder[${reminderIndex}]` } });
      reminderIndex += 1;
    }
  });
  return dedupeTranslationMaterials(materials);
}

function extractSystemPartsForTranslation(body, messages) {
  const output = [];
  if (typeof body.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body.system)) {
    for (const part of body.system) output.push({ source: "body.system", text: extractContentText(part) });
  }
  for (const message of messages) {
    if (message.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => normalizeTranslationText(part.text));
}

function dedupeTranslationMaterials(materials) {
  return [...new Map(materials.map((item) => [translationLookupKey(item.kind, normalizeTranslationText(item.source_text)), { ...item, source_text: normalizeTranslationText(item.source_text) }])).values()].filter(
    (item) => item.source_text,
  );
}

function dedupeToolTranslationMaterials(materials) {
  return [
    ...new Map(
      materials.map((item) => {
        const sourceText = normalizeTranslationText(item.source_text);
        const metadata = item.metadata || {};
        const key = [translationLookupKey(item.kind, sourceText), metadata.tool_name || "unknown", metadata.field_name || metadata.path || ""].join("\0");
        return [key, { ...item, source_text: sourceText }];
      }),
    ).values(),
  ].filter((item) => item.source_text);
}

async function materialHash(kind, sourceText) {
  const bytes = new TextEncoder().encode(translationLookupKey(kind, sourceText));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractContentText).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string" || Array.isArray(content.content)) return extractContentText(content.content);
    return JSON.stringify(content);
  }
  return "";
}

function createLineDiff(before, after) {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const table = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));
  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let col = afterLines.length - 1; col >= 0; col -= 1) {
      table[row][col] =
        beforeLines[row] === afterLines[col] ? table[row + 1][col + 1] + 1 : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }
  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length && newIndex < afterLines.length) {
    if (beforeLines[oldIndex] === afterLines[newIndex]) {
      rows.push({ type: "context", oldLine: oldIndex + 1, newLine: newIndex + 1, text: beforeLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({ type: "remove", oldLine: oldIndex + 1, newLine: "", text: beforeLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ type: "add", oldLine: "", newLine: newIndex + 1, text: afterLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < beforeLines.length) {
    rows.push({ type: "remove", oldLine: oldIndex + 1, newLine: "", text: beforeLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < afterLines.length) {
    rows.push({ type: "add", oldLine: "", newLine: newIndex + 1, text: afterLines[newIndex] });
    newIndex += 1;
  }
  return rows;
}

function splitDiffLines(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized ? normalized.split("\n") : [];
}

function compactDiffRows(rows, contextSize) {
  const changedIndexes = rows.flatMap((row, index) => (row.type === "context" ? [] : [index]));
  if (!changedIndexes.length) return rows;
  const keep = new Set();
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextSize);
    const end = Math.min(rows.length - 1, index + contextSize);
    for (let cursor = start; cursor <= end; cursor += 1) keep.add(cursor);
  }
  const output = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped) {
        output.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      output.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped) output.push({ type: "skip", count: skipped });
  return output;
}

function renderDiffRow(row) {
  if (row.type === "skip") return `<div class="diff-skip">${escapeHtml(t("diffSkip", { count: row.count }))}</div>`;
  const marker = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
  return `
    <div class="diff-line ${escapeHtml(row.type)}">
      <span class="diff-marker">${marker}</span>
      <span class="diff-line-number">${escapeHtml(row.oldLine)}</span>
      <span class="diff-line-number">${escapeHtml(row.newLine)}</span>
      <code>${escapeHtml(row.text || " ")}</code>
    </div>
  `;
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
  if (label === "otel raw body") return t("otelRawBody");
  return label || t("unknownCapture");
}

function captureLabelHelp(label) {
  if (label === "exact proxy capture") return t("exactProxyHelp");
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
