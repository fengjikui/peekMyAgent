import { renderMarkdownPreview, renderSafeMarkdown } from "./markdown.js";
import { ViewerApiClient } from "./api-client.js";
import { RequestDetailCache, requestNeedsDetail } from "./request-detail-cache.js";
import {
  rawResponseSectionValue,
  rawSectionData as buildRawSectionData,
  rawUpstreamRequestValue,
} from "./raw-view-model.js";
import {
  clampRawSearchIndex,
  collectRawSearchEntries,
  escapeRawSearchRegExp,
  filterRawSearchEntries,
  nextRawSearchIndex,
  normalizeRawSearchQuery,
  rawSearchSnippetSegments,
} from "./raw-search-model.js";
import { TurnRailController } from "./turn-rail.js";
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
const state = {
  sources: [],
  data: null,
  activeId: null,
  activeRequestId: null,
  activeSourceId: null,
  sourceLoadSeq: 0,
  progressiveLoadError: "",
  activeRawMode: "request",
  rawOpen: true,
  activeRawSection: "full",
  rawSearchQuery: "",
  rawSearchTimer: 0,
  rawSearchComposing: false,
  rawSearchActiveIndex: 0,
  rawSearchRevealPending: false,
  rawMessagesMode: "organized",
  rawWidth: 0,
  sidebarOpen: true,
  sidebarWidth: 0,
  autoRefreshTimer: 0,
  autoRefreshInFlight: false,
  sessionInfoControlsBound: false,
  responseExpanded: new Set(),
  upstreamExpanded: new Set(),
  latestOnly: false,
  translationMode: "source",
  translations: null,
  translationLookup: new Map(),
  translationGenerate: { loading: false, error: "", message: "" },
  translationAutoRefresh: new Set(),
  translationActionItems: new Map(),
  nextTranslationActionId: 1,
  collapsedAgentBranches: new Set(),
  expandedAgentBranches: new Set(),
  openAgentDashboards: new Set(),
  openSupportingTimelines: new Set(),
  agentBranchLimits: new Map(),
  agentBranchFilters: new Map(),
  traceQuery: "",
  traceFilter: "all",
  traceQueryTimer: 0,
  traceSearchComposing: false,
  traceResultLimit: 24,
  agentSend: { loading: false, error: "", message: "", result: null },
  openSourceMenuId: null,
  openProjectMenuKey: null,
  uiLanguage: "zh-CN",
  targetTranslationLanguage: "zh-CN",
};

const LIVE_REFRESH_MS = 1200;
const LATEST_ONLY_KEY = "peekmyagent.latestOnly";
const PROJECT_COLLAPSE_KEY = "peekmyagent.collapsedProjects";
const TRANSLATION_MODE_KEY = "peekmyagent.translationMode";
const UI_LANGUAGE_KEY = "peekmyagent.uiLanguage";
const TARGET_TRANSLATION_LANGUAGE_KEY = "peekmyagent.targetTranslationLanguage";
const RAW_MESSAGES_MODE_KEY = "peekmyagent.rawMessagesMode";
const DEFAULT_UI_LANGUAGE = "zh-CN";
const DEFAULT_TRANSLATION_LANGUAGE = "zh-CN";
const TIMELINE_WINDOW_THRESHOLD = 180;
const TIMELINE_WINDOW_SIZE = 120;
const INITIAL_SOURCE_REQUEST_LIMIT = 32;
const PROGRESSIVE_SOURCE_MIN_REQUESTS = 72;
const AGENT_BRANCH_PAGE_SIZE = 24;
const AGENT_EVENT_LIMIT = 80;
const AGENT_SUMMARY_DOT_LIMIT = 8;
const TRACE_RESULT_PAGE_SIZE = 24;
const traceSearchTextCache = new WeakMap();
const RAW_MESSAGE_MARKDOWN_INLINE_CHARS = 5000;
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
const I18N = {
  "zh-CN": {
    brandSubtitle: "本地请求观察器",
    sessionsLabel: "会话",
    importTrace: "导入 Trace",
    dashboardEyeline: "Local dashboard · 请求时间线",
    timelineTitle: "Agent 请求时间线",
    sessionInfoEyeline: "当前会话",
    uiLanguageLabel: "界面",
    translationLanguageLabel: "翻译",
    translationLanguageSearchPlaceholder: "搜索目标语言",
    languageSettingsAria: "语言设置",
    rawTitleEmpty: "选择一条请求",
    rawEmpty: "点击任意请求的 Raw 按钮查看完整捕获。",
    requestDetailLoading: "正在加载这条请求的完整详情…",
    requestDetailLoadFailed: "请求详情加载失败：{message}",
    sessionInfoTitle: "会话信息",
    toggleSidebarTitle: "折叠会话栏",
    expandSidebarTitle: "展开会话栏",
    toggleSidebarAria: "切换会话栏",
    toggleRawTitle: "折叠 Raw JSON 面板",
    expandRawTitle: "展开 Raw JSON 面板",
    toggleRawAria: "切换 Raw JSON 面板",
    sessionListAria: "会话列表",
    sidebarResizerAria: "调整会话栏宽度",
    rawResizerAria: "调整 Raw JSON 面板宽度",
    turnRailAria: "当前会话轮次导航",
    closeSessionInfoAria: "关闭会话信息",
    statRequests: "请求",
    statResponses: "回复",
    statSubagents: "子 Agent 实例",
    statToolUse: "工具调用",
    statToolResult: "工具结果",
    showAllTurns: "显示全部轮次",
    latestOnly: "只看最新轮次",
    latestDisabledBySearch: "搜索与筛选始终覆盖全部轮次",
    sessionInfo: "会话信息",
    traceInitialLoading: "先显示前 {loaded}/{total} 条请求，完整 Trace 正在后台载入…",
    traceFullLoadFailed: "完整 Trace 后台加载失败：{message}",
    traceSearchPlaceholder: "搜索用户输入、回复、工具或请求编号",
    traceSearchAria: "搜索当前 Trace",
    traceFilterAria: "按 Trace 事件类型筛选",
    traceFilterAll: "全部 {count}",
    traceFilterIssues: "异常 {count}",
    traceFilterSlow: "慢请求 {count}",
    traceFilterTools: "工具 {count}",
    traceFilterSubagents: "子 Agent {count}",
    traceNoResultsTitle: "没有匹配的执行链路",
    traceNoResultsBody: "调整搜索词或筛选条件后重试。原始 Trace 数据没有被删除。",
    traceMatchCount: "显示 {shown}/{total} 条匹配请求",
    traceShowMore: "再显示 {count} 条",
    traceTurnMatches: "Turn {index} · {count} 条匹配",
    emptyTimelineTitle: "等待 Agent 发出下一次模型请求",
    emptyTimelineBody: "这个 watch 已经创建。把 Agent 的 provider/base URL 指向本地代理后，请求会出现在这里。",
    emptyStatus: "状态",
    emptyWatching: "监听中",
    emptyWatch: "Watch",
    emptyNotRecorded: "未记录",
    emptyCapture: "捕获",
    source: "原文",
    copyAll: "复制全部",
    toolClipboardHeading: "工具",
    parameterClipboardHeading: "参数：{name}",
    updateCurrentSection: "刷新当前区块",
    updating: "更新中...",
    translationModeAria: "语言切换",
    translationCacheHit: "{hit}/{total} 已缓存 · {language}",
    translationCacheMissing: "未找到 {language} 缓存",
    autoTranslating: "未找到 {language} 缓存，正在自动刷新翻译...",
    translatingSection: "正在刷新当前区块翻译...",
    translatingParameterGroup: "正在重译当前参数组...",
    retranslatingBlock: "正在重译当前块...",
    translationAutoUpdated: "已自动刷新翻译。",
    translationCacheNotFoundAfterGenerate: "生成已结束，但仍未找到 {language} 缓存。",
    translationSectionPartialWithTranslated: "已补齐 {translated} 条；当前区块命中 {hit}/{total}，剩余 {remaining} 条。",
    translationSectionPartial: "{language} 缓存存在，但当前区块仍只命中 {hit}/{total}。",
    translationSectionCompletedWithTranslated: "已补齐 {translated} 条 {language} 缓存，当前区块 {hit}/{total} 已缓存。",
    translationSectionLatest: "{language} 缓存已是最新，当前区块 {hit}/{total} 已缓存。",
    translationCacheLatest: "{language} 缓存已是最新。",
    copied: "已复制",
    copyFailed: "复制失败",
    sourceLabel: "原文",
    translationLabel: "译文",
    copyBlockTitle: "复制这一块的原文 + 译文到剪贴板",
    copyAllTitle: "把当前 {section} 的全部块（原文 + 译文）复制到剪贴板",
    refreshSectionTitle: "仅刷新当前请求的 {section} 翻译块；已缓存内容也会重译。",
    noSystemPrompt: "这条请求没有可翻译的 system prompt。",
    noToolDescriptions: "这条请求没有可翻译的 tool 描述。",
    noHarnessPrompts: "这条请求没有可翻译的 harness 注入提示词。",
    toolDescriptionCount: "1 个工具说明",
    noToolDescription: "无工具说明",
    parameterCount: "{count} 个参数说明",
    parameterDescriptions: "参数说明",
    cacheState: "{language}缓存",
    missingTranslation: "缺少翻译",
    retranslateParameters: "重译参数",
    translateParameters: "翻译参数",
    retranslateThinking: "重译 Thinking",
    translateThinking: "翻译 Thinking",
    retranslatedParametersDone: "已重译 {count} 个参数说明。",
    retranslatedBlockDone: "已重译当前块。",
    retranslate: "重译",
    translate: "翻译",
    copy: "复制",
    toolDescription: "工具说明",
    systemInjectedContext: "注入上下文",
    harnessReminder: "框架提醒",
    harnessCompact: "压缩指令",
    harnessCommand: "斜杠命令",
    harnessSuggestion: "Suggestion 模式",
    description: "说明",
    responseOnlyToolsNoticeTitle: "Tools schema",
    responseOnlyToolsNotice: "这些工具描述与 schema 来自本次请求上行中 Harness/Agent 注入的 tools，用于帮助理解 response 里的 tool_use；它们不是 response body 返回的字段。",
    rawNavDownstream: "模型下行",
    rawNavReference: "上行参考",
    fullCaptureTitle: "查看捕获到的完整上行请求",
    rawFullCapture: "完整请求",
    rawFull: "完整请求",
    rawRequestMetadata: "请求 Metadata",
    rawHarness: "Harness 提示词",
    rawHarnessTitle: "harness 注入提示词",
    currentResponseToolUse: "本次响应 tool_use",
    currentUpstreamToolUse: "本次上行 tool_use",
    currentUpstreamToolResult: "本次上行 tool_result",
    rawSearchPlaceholder: "搜索当前 {section}",
    rawSearchAria: "搜索当前 Raw 区块",
    rawSearchScope: "当前范围：{section}",
    rawSearchClear: "清除搜索",
    rawSearchPrevious: "上一个匹配项",
    rawSearchNext: "下一个匹配项",
    rawSearchResultCount: "{count} 条匹配",
    rawSearchNoResults: "当前 {section} 中没有匹配 “{query}”。",
    rawSearchMatchedIn: "匹配于 {scope}",
    rawSearchValue: "值",
    messagesViewAria: "Messages 展示方式",
    messagesOrganized: "整理",
    messagesOriginal: "原文",
    messagesEmpty: "这条请求没有 messages。",
    messageRole: "role",
    messageType: "type",
    messageRawDetails: "原始块",
    messageTextFallback: "(无文本内容)",
    messageTextTruncated: "整理视图仅渲染前 {shown} / {total} 字符；切换到原文查看完整 JSON。",
    unassignedProject: "未归属项目",
    requestUnit: "{count} 请求",
    requestCount: "{count} 条请求",
    requestClipboardTitle: "请求 #{index}",
    sessionActionsAria: "会话操作",
    projectActionsAria: "项目操作",
    moreActions: "更多操作",
    pin: "置顶",
    unpin: "取消置顶",
    rename: "重命名",
    exportTrace: "导出 Trace",
    exportTraceConfirm: "导出的 Trace 会尽量脱敏常见 token/API key，但仍可能包含私有提示词、源码片段、文件路径或工具输出。分享前请先检查内容。继续导出吗？",
    exportTraceFailed: "导出 Trace 失败：{message}",
    archive: "归档",
    deleteData: "删除数据",
    archiveProject: "归档项目",
    deleteProjectData: "删除项目数据",
    renameSessionPrompt: "重命名会话",
    archiveLiveConfirm: "归档会停止这条监听，但不会删除已保存的捕获数据。确定继续吗？",
    archiveStaticConfirm: "归档会从左侧隐藏这条会话，但不会删除本地捕获数据。确定继续吗？",
    archiveProjectConfirm: "归档会从左侧隐藏项目“{project}”下的 {count} 条会话；正在监听的会话会停止，但不会删除已保存的捕获数据。确定继续吗？",
    deleteLiveConfirm: "删除会停止这条监听，并删除已保存的捕获数据。正在运行的 Agent 需要重新通过 peekMyAgent 启动后才能继续捕获。确定删除吗？",
    deleteStaticConfirm: "删除会移除这条会话的本地捕获数据，无法从 dashboard 恢复。确定删除吗？",
    deleteProjectConfirm: "删除会移除项目“{project}”下 {count} 条会话的本地捕获数据，无法从 dashboard 恢复；正在运行的 Agent 需要重新通过 peekMyAgent 启动后才能继续捕获。确定删除吗？",
    importTraceFailed: "导入 Trace 失败：{message}",
    sourceUpdateFailed: "更新会话失败：{message}",
    projectUpdateFailed: "更新项目失败：{message}",
    archivedByWatch: "按监听任务归档",
    redactionCount: "{count} 处 header 脱敏",
    noHeaderRedaction: "未发现 header 脱敏",
    sessionSummaryAria: "当前会话统计信息",
    transparencyWorkbench: "本地 Agent 透明度工作台",
    subagentInstanceCount: "子 Agent 实例 {count}",
    subagentRequestCount: "子 Agent 请求 {count}",
    project: "项目",
    session: "会话",
    defaultRequestInfo: "请求默认信息",
    extension: "扩展",
    none: "无",
    firstCapture: "首次捕获",
    lastCapture: "最近捕获",
    watchStopped: "监听已停止",
    watchRunning: "监听正在运行",
    watchStoppedNote: "已保留当前捕获结果，可以清空左侧条目。",
    watchRunningNote: "关闭页面不会停止监听；需要停止时请在这里操作。",
    stopWatch: "仅停止监听",
    stopAndClear: "停止并清空",
    clearEntry: "清空条目",
    sendViaResumeNote: "独立 resume 发送；原终端不显示，也不会继承到原终端后续上下文",
    composerPlaceholder: "输入消息，Enter 发送，Shift+Enter 换行",
    send: "独立发送",
    sending: "发送中",
    sendUnavailable: "当前记录不可发送",
    sendUnsupported: "当前 Agent 暂不支持页面发送",
    watchPaused: "监听已暂停",
    currentProject: "当前项目",
    sent: "已独立发送；原终端不会显示，也不会继承这条上下文",
    sendFailed: "发送失败 exit {code}{preview}",
    sentWaitingCapture: "正在独立发送；这不会写入原终端...",
    sentRefreshingCapture: "已独立发送，正在刷新捕获...",
    watchActionFailed: "监听操作失败",
    metadataRequest: "元数据请求",
    subagentRequest: "子代理请求",
    parentSpawnRequest: "启动子代理",
    mainAgentRequest: "主代理请求",
    noTextSummary: "(无文本摘要)",
    jumpToTurnAria: "跳转到 Turn {index}",
    turnRailAriaDynamic: "轮次导航，当前第 {current} 轮，共 {total} 轮",
    turnRailAriaTotal: "轮次导航，共 {total} 轮",
    timelineWindowSummary: "长 Trace 分段渲染：当前显示第 {start}-{end} / {total} 轮",
    timelineWindowBefore: "前面还有 {count} 轮未渲染",
    timelineWindowAfter: "后面还有 {count} 轮未渲染",
    jumpToFirstTurn: "跳到开头",
    jumpToLastTurn: "跳到结尾",
    turnRequests: "{count} 请求",
    turnInternal: "{count} 内部",
    turnTools: "工具 {calls}/{results}",
    supportingTimeline: "幕后请求时间线 · {count} 条",
    multiAgentAria: "多 Agent 分支",
    multiAgentSummary: "multi-agent · {count} 个子 Agent",
    subagentDetails: "子 Agent 详情",
    branchSummary: "{branches} 条分支 · {requests} 个请求 · {returned} 条回流 · 工具 {calls}/{results} · {signal}",
    branchStatusSummary: "已回流 {returned} · 已完成未回流 {completed} · 运行中 {running}",
    agentShowingCount: "当前显示 {shown}/{total} 个子 Agent",
    showMoreAgents: "再显示 {count} 个",
    agentStatusFilterAria: "按子 Agent 状态筛选",
    agentFilterAll: "全部 {count}",
    agentFilterReturned: "已回流 {count}",
    agentFilterCompleted: "未回流 {count}",
    agentFilterRunning: "运行中 {count}",
    noAgentsForFilter: "当前状态下没有子 Agent。",
    subagentFallback: "子 Agent {index}",
    childSeq: "子{index}",
    parentCall: "父级调用",
    resultReturn: "结果回流",
    jumpToAgentBranch: "跳到这个子 Agent 的详情。",
    noRecordedRequests: "未记录请求",
    eventOrder: "事件顺序",
    eventOrderCount: "事件顺序 · 显示 {shown}/{total}",
    requestTools: "请求工具 {tools}",
    subagentReply: "子 Agent 回复",
    modelRequest: "模型请求",
    returned: "已回流",
    completed: "已完成",
    running: "运行中",
    unknown: "未知",
    highConfidence: "高置信",
    mediumConfidence: "中置信",
    noBranch: "无分支",
    notEvaluated: "未评估",
    subagentShort: "子agent",
    branchTooltipLabel: "分支：{label}",
    typeTooltipLabel: "类型：{type}",
    statusTooltipLabel: "状态：{status}",
    subagentSourceTooltip: "这条请求来自 Claude Code 子 Agent。",
    jumpToBranchTooltip: "点击跳到对应的 Agent 分支。",
    ownerAria: "请求归属",
    collapseUpstream: "折叠上行",
    expandUpstream: "展开上行",
    subagentBadge: "子代理",
    parentSpawnBadge: "启动子代理",
    slashCommandTitle: "Claude Code slash command 展开后的命令消息。",
    redactedBadgeTitle: "已隐藏 {count} 个敏感 header 字段，例如 authorization、cookie 或 token。",
    redactedBadge: "已脱敏 {count}",
    captureAndChanges: "捕获与变化",
    toolResultUpstream: "Tool result 回传",
    toolUseUpstream: "Tool use 上行",
    resultReturnPreview: "Result 回传 · {count} 个工具结果",
    upstreamDetails: "上行详情 #{index}",
    upstreamLazyPlaceholder: "展开后加载上行详情 #{index}",
    systemSummary: "System 摘要 · {count} 段",
    noSystemSummary: "(无 system 摘要)",
    toolsCount: "Tools · {count} 个",
    historyStack: "History / message stack · {count} 条",
    noHistoryMessages: "没有可展示的历史消息。",
    currentUserInput: "当前用户输入",
    noTextContent: "没有文本内容。",
    argumentsLabel: "参数",
    resultLabel: "结果",
    historyReused: "历史重放",
    historyNew: "本次新增",
    baseline: "基线",
    frameworkAutoAdded: "Claude Code 自动补充",
    baselineRequestSummary: "基线请求 · {count} 条上下文消息",
    reuseSummary: "复用 {reused}/{total} 条消息 · 新增 {added} 条",
    contextReuse: "上下文复用",
    noNewRoles: "无新增角色",
    newMessageDetails: "新增消息明细 · {count} 条",
    currentRoundMessages: "本轮新增消息",
    currentUser: "当前用户",
    itemCount: "{count} 条",
    currentResultEvent: "本次结果事件",
    providerTokenStats: "厂商 token 统计",
    actualUpstream: "实际上行 {count}",
    providerInputTokenTitle: "模型厂商输入 token。",
    cacheHitTokenTitle: "缓存命中 token 及比例。",
    nonCacheInputTitle: "非 cache read 的输入 token 占比。",
    providerOutputTokenTitle: "模型厂商输出 token。",
    reused: "复用",
    changed: "变化",
    baselineStatus: "基线",
    compactMessage: "上下文压缩 (/compact)",
    contextCountMessage: "上下文统计 (/context)",
    subagentResult: "子 Agent 结果回流",
    taskNotification: "任务通知",
    frameworkReminder: "框架提醒",
    agentInternal: "Agent 内部",
    agentInternalRequest: "Agent 内部请求 · {preview}",
    baselineRequestBadge: "基线请求",
    baselineRequestTitle: "这条请求是本会话中用于对比后续变化的第一条请求。",
    systemChanged: "系统变化",
    systemChangedTitle: "查看本次 system prompt 相对上一条请求的差异。",
    toolsChanged: "工具变化",
    toolsChangedTitle: "本次请求里的工具 schema 或工具列表与上一条请求不同。",
    paramsChanged: "参数变化",
    paramsChangedTitle: "模型参数或请求参数发生变化，例如 model、temperature、stream、beta 等。",
    cumulative: "累计 {count}",
    notCaptured: "未捕获",
    upstreamStructureAria: "上行请求结构摘要",
    viewRawTitle: "在右侧查看 {label} Raw",
    currentToolExchange: "本轮 tool_use / tool_result · {calls} / {results}",
    truncated: "已截断",
    assistantReply: "Assistant 回复",
    collapse: "收起",
    viewAll: "查看全部",
    responseNoText: "已捕获响应，但没有解析出文本回复。",
    responseExpandedHint: "已展开，内容区内部滚动；点击收起回到摘要。",
    responseCollapsedHint: "仅显示前200字，点击查看全部后展开。",
    assistantToolUse: "Assistant 发起 tool_use · {count}",
    pairedById: "已按 id 配对",
    waitingToolResult: "等待结果或未捕获",
    unpairedToolResult: "未配对结果",
    noMatchedToolResult: "本次捕获中还没有匹配到工具结果。",
    noPreviousSystemDiff: "这条请求没有上一条请求，无法生成 system diff。",
    noVisibleLineChanges: "没有可见行级变化",
    diffRowsChanged: "+{added} / -{removed} 行",
    diffLegendAria: "diff 图例",
    diffRemove: "删除",
    diffAdd: "新增",
    diffContext: "上下文",
    noDiffRows: "hash 显示 system 发生变化，但按当前文本抽取结果没有发现行级差异。可能是结构、空白或非文本字段变化；可以切到 System Raw 继续检查。",
    diffSkip: "跳过 {count} 行未变化内容",
    unnamedSession: "未命名会话",
    exactCaptureTitle: "通过本地代理捕获到 Agent 发给模型服务的真实上行请求。",
    partialCaptureTitle: "这条数据来自调试、导入或不完整来源，不能等同于完整上行请求。",
    exactCapture: "精确捕获",
    partialCapture: "部分捕获",
    exactProxyCapture: "精确代理捕获",
    otelRawBody: "OTel Raw 请求体",
    unknownCapture: "未知捕获方式",
    exactProxyHelp: "通过本地代理捕获 Agent 发给模型服务的上行请求。",
    otelRawHelp: "通过 OTel raw body 文件读取请求体，HTTP 层信息可能不完整。",
    captureHelp: "当前数据源的捕获方式。",
    unknownProtocol: "未知协议",
    unknownProvider: "未知厂商",
  },
  "en-US": {
    brandSubtitle: "Local request observer",
    sessionsLabel: "Sessions",
    importTrace: "Import Trace",
    dashboardEyeline: "Local dashboard · request timeline",
    timelineTitle: "Agent request timeline",
    sessionInfoEyeline: "Current session",
    uiLanguageLabel: "UI",
    translationLanguageLabel: "Translate",
    translationLanguageSearchPlaceholder: "Search language",
    languageSettingsAria: "Language settings",
    rawTitleEmpty: "Select a request",
    rawEmpty: "Click any Raw button to inspect the full capture.",
    requestDetailLoading: "Loading full request detail...",
    requestDetailLoadFailed: "Failed to load request detail: {message}",
    sessionInfoTitle: "Session Info",
    toggleSidebarTitle: "Collapse session sidebar",
    expandSidebarTitle: "Expand session sidebar",
    toggleSidebarAria: "Toggle session sidebar",
    toggleRawTitle: "Collapse Raw JSON panel",
    expandRawTitle: "Expand Raw JSON panel",
    toggleRawAria: "Toggle Raw JSON panel",
    sessionListAria: "Session list",
    sidebarResizerAria: "Resize session sidebar",
    rawResizerAria: "Resize Raw JSON panel",
    turnRailAria: "Current session turn navigation",
    closeSessionInfoAria: "Close session info",
    statRequests: "Requests",
    statResponses: "Responses",
    statSubagents: "Subagent instances",
    statToolUse: "Tool use",
    statToolResult: "Tool result",
    showAllTurns: "Show all turns",
    latestOnly: "Latest turn only",
    latestDisabledBySearch: "Search and filters always cover all turns",
    sessionInfo: "Session Info",
    traceInitialLoading: "Showing the first {loaded}/{total} requests while the full Trace loads in the background...",
    traceFullLoadFailed: "Background full Trace load failed: {message}",
    traceSearchPlaceholder: "Search user input, responses, tools, or request number",
    traceSearchAria: "Search this Trace",
    traceFilterAria: "Filter Trace event types",
    traceFilterAll: "All {count}",
    traceFilterIssues: "Issues {count}",
    traceFilterSlow: "Slow {count}",
    traceFilterTools: "Tools {count}",
    traceFilterSubagents: "Subagents {count}",
    traceNoResultsTitle: "No matching execution path",
    traceNoResultsBody: "Try another query or filter. The original Trace data has not been removed.",
    traceMatchCount: "Showing {shown}/{total} matching requests",
    traceShowMore: "Show {count} more",
    traceTurnMatches: "Turn {index} · {count} matches",
    emptyTimelineTitle: "Waiting for the next model request",
    emptyTimelineBody: "This watch has been created. Requests will appear here once the Agent provider/base URL points to the local proxy.",
    emptyStatus: "Status",
    emptyWatching: "watching",
    emptyWatch: "Watch",
    emptyNotRecorded: "not recorded",
    emptyCapture: "Capture",
    source: "Source",
    copyAll: "Copy all",
    toolClipboardHeading: "Tool",
    parameterClipboardHeading: "Parameter: {name}",
    updateCurrentSection: "Refresh section",
    updating: "Updating...",
    translationModeAria: "Language switcher",
    translationCacheHit: "{hit}/{total} cached · {language}",
    translationCacheMissing: "No {language} cache",
    autoTranslating: "No {language} cache; refreshing translations...",
    translatingSection: "Refreshing the current section...",
    translatingParameterGroup: "Retranslating the current parameter group...",
    retranslatingBlock: "Retranslating the current block...",
    translationAutoUpdated: "Translations refreshed automatically.",
    translationCacheNotFoundAfterGenerate: "Generation finished, but no {language} cache was found.",
    translationSectionPartialWithTranslated: "Added {translated}; current section hits {hit}/{total}, {remaining} remaining.",
    translationSectionPartial: "{language} cache exists, but this section still only hits {hit}/{total}.",
    translationSectionCompletedWithTranslated: "Added {translated} {language} cache entries; this section hits {hit}/{total}.",
    translationSectionLatest: "{language} cache is up to date; this section hits {hit}/{total}.",
    translationCacheLatest: "{language} cache is up to date.",
    copied: "Copied",
    copyFailed: "Copy failed",
    sourceLabel: "Source",
    translationLabel: "Translation",
    copyBlockTitle: "Copy this block's source and translation to the clipboard",
    copyAllTitle: "Copy all blocks in the current {section}, including source and translation",
    refreshSectionTitle: "Refresh translation blocks for the current request's {section}; cached content is retranslated.",
    noSystemPrompt: "This request has no translatable system prompt.",
    noToolDescriptions: "This request has no translatable tool descriptions.",
    noHarnessPrompts: "This request has no translatable harness prompts.",
    toolDescriptionCount: "1 tool description",
    noToolDescription: "No tool description",
    parameterCount: "{count} parameter descriptions",
    parameterDescriptions: "Parameter descriptions",
    cacheState: "{language} cache",
    missingTranslation: "Missing translation",
    retranslateParameters: "Retranslate parameters",
    translateParameters: "Translate parameters",
    retranslateThinking: "Retranslate Thinking",
    translateThinking: "Translate Thinking",
    retranslatedParametersDone: "Retranslated {count} parameter descriptions.",
    retranslatedBlockDone: "Retranslated the current block.",
    retranslate: "Retranslate",
    translate: "Translate",
    copy: "Copy",
    toolDescription: "Tool description",
    systemInjectedContext: "Injected context",
    harnessReminder: "Harness reminder",
    harnessCompact: "Compact instruction",
    harnessCommand: "Slash command",
    harnessSuggestion: "Suggestion mode",
    description: "Description",
    responseOnlyToolsNoticeTitle: "Tools schema",
    responseOnlyToolsNotice: "These tool descriptions and schemas come from the Harness/Agent-injected tools in the upstream request. They help explain tool_use in the response; they are not fields returned by the response body.",
    rawNavDownstream: "Model response",
    rawNavReference: "Upstream reference",
    fullCaptureTitle: "View the complete captured upstream request",
    rawFullCapture: "Full request",
    rawFull: "Full request",
    rawRequestMetadata: "Request metadata",
    rawHarness: "Harness prompts",
    rawHarnessTitle: "harness injected prompts",
    currentResponseToolUse: "Current response tool_use",
    currentUpstreamToolUse: "Current upstream tool_use",
    currentUpstreamToolResult: "Current upstream tool_result",
    rawSearchPlaceholder: "Search current {section}",
    rawSearchAria: "Search current Raw section",
    rawSearchScope: "Scope: {section}",
    rawSearchClear: "Clear search",
    rawSearchPrevious: "Previous match",
    rawSearchNext: "Next match",
    rawSearchResultCount: "{count} matches",
    rawSearchNoResults: "No matches for \"{query}\" in current {section}.",
    rawSearchMatchedIn: "Matched in {scope}",
    rawSearchValue: "Value",
    messagesViewAria: "Messages view mode",
    messagesOrganized: "Organized",
    messagesOriginal: "Source",
    messagesEmpty: "This request has no messages.",
    messageRole: "role",
    messageType: "type",
    messageRawDetails: "Raw block",
    messageTextFallback: "(no text content)",
    messageTextTruncated: "Organized view renders the first {shown} of {total} characters only. Switch to Source for the full JSON.",
    unassignedProject: "Unassigned project",
    requestUnit: "{count} requests",
    requestCount: "{count} requests",
    requestClipboardTitle: "Request #{index}",
    sessionActionsAria: "Session actions",
    projectActionsAria: "Project actions",
    moreActions: "More actions",
    pin: "Pin",
    unpin: "Unpin",
    rename: "Rename",
    exportTrace: "Export Trace",
    exportTraceConfirm: "Exported traces are sanitized for common token/API-key patterns, but may still include private prompts, code snippets, file paths, or tool output. Review before sharing. Continue?",
    exportTraceFailed: "Export Trace failed: {message}",
    archive: "Archive",
    deleteData: "Delete data",
    archiveProject: "Archive project",
    deleteProjectData: "Delete project data",
    renameSessionPrompt: "Rename session",
    archiveLiveConfirm: "Archiving will stop this watch without deleting saved captures. Continue?",
    archiveStaticConfirm: "Archiving hides this session from the sidebar without deleting local captures. Continue?",
    archiveProjectConfirm: "Archiving hides {count} sessions under project \"{project}\" from the sidebar. Live watches will stop, but saved captures stay on disk. Continue?",
    deleteLiveConfirm: "Deleting will stop this watch and delete saved captures. The running Agent must be relaunched through peekMyAgent to capture again. Delete?",
    deleteStaticConfirm: "Deleting removes this session's local capture data and cannot be restored from the dashboard. Delete?",
    deleteProjectConfirm: "Deleting removes local capture data for {count} sessions under project \"{project}\" and cannot be restored from the dashboard. Live Agents must be relaunched through peekMyAgent to capture again. Delete?",
    importTraceFailed: "Import Trace failed: {message}",
    sourceUpdateFailed: "Session update failed: {message}",
    projectUpdateFailed: "Project update failed: {message}",
    archivedByWatch: "Archived by watch",
    redactionCount: "{count} redacted headers",
    noHeaderRedaction: "No header redaction",
    sessionSummaryAria: "Current session statistics",
    transparencyWorkbench: "Local Agent transparency workbench",
    subagentInstanceCount: "Subagent instances {count}",
    subagentRequestCount: "Subagent requests {count}",
    project: "Project",
    session: "Session",
    defaultRequestInfo: "Default Request Info",
    extension: "Extensions",
    none: "None",
    firstCapture: "First capture",
    lastCapture: "Last capture",
    watchStopped: "Watch stopped",
    watchRunning: "Watch running",
    watchStoppedNote: "Current captures are preserved; you can clear the sidebar entry.",
    watchRunningNote: "Closing this page will not stop the watch; use these controls when you need to stop it.",
    stopWatch: "Stop watch",
    stopAndClear: "Stop and clear",
    clearEntry: "Clear entry",
    sendViaResumeNote: "Detached resume send; the original terminal will not show it or inherit it later",
    composerPlaceholder: "Type a message. Enter to send, Shift+Enter for newline",
    send: "Send separately",
    sending: "Sending",
    sendUnavailable: "Current record cannot send",
    sendUnsupported: "This Agent does not support page sending yet",
    watchPaused: "Watch paused",
    currentProject: "Current project",
    sent: "Sent separately; the original terminal will not show or inherit this context",
    sendFailed: "Send failed exit {code}{preview}",
    sentWaitingCapture: "Sending separately; this does not write to the original terminal...",
    sentRefreshingCapture: "Sent separately; refreshing captures...",
    watchActionFailed: "Watch action failed",
    metadataRequest: "Metadata request",
    subagentRequest: "Subagent request",
    parentSpawnRequest: "Spawn subagent",
    mainAgentRequest: "Main agent request",
    noTextSummary: "(no text summary)",
    jumpToTurnAria: "Jump to Turn {index}",
    turnRailAriaDynamic: "Turn navigation, currently turn {current} of {total}",
    turnRailAriaTotal: "Turn navigation, {total} turns",
    timelineWindowSummary: "Large Trace window: showing turns {start}-{end} of {total}",
    timelineWindowBefore: "{count} earlier turns are not rendered",
    timelineWindowAfter: "{count} later turns are not rendered",
    jumpToFirstTurn: "Jump to start",
    jumpToLastTurn: "Jump to end",
    turnRequests: "{count} requests",
    turnInternal: "{count} internal",
    turnTools: "tools {calls}/{results}",
    supportingTimeline: "Behind-the-scenes request timeline · {count}",
    multiAgentAria: "Multi-agent branches",
    multiAgentSummary: "multi-agent · {count} subagents",
    subagentDetails: "Subagent details",
    branchSummary: "{branches} branches · {requests} requests · {returned} returned · tools {calls}/{results} · {signal}",
    branchStatusSummary: "{returned} returned · {completed} completed, not returned · {running} running",
    agentShowingCount: "Showing {shown}/{total} subagents",
    showMoreAgents: "Show {count} more",
    agentStatusFilterAria: "Filter by subagent status",
    agentFilterAll: "All {count}",
    agentFilterReturned: "Returned {count}",
    agentFilterCompleted: "Not returned {count}",
    agentFilterRunning: "Running {count}",
    noAgentsForFilter: "No subagents match this status.",
    subagentFallback: "Subagent {index}",
    childSeq: "sub{index}",
    parentCall: "Parent call",
    resultReturn: "Result return",
    jumpToAgentBranch: "Jump to this subagent's detail.",
    noRecordedRequests: "No recorded requests",
    eventOrder: "Event order",
    eventOrderCount: "Event order · showing {shown}/{total}",
    requestTools: "Request tools {tools}",
    subagentReply: "Subagent reply",
    modelRequest: "Model request",
    returned: "Returned",
    completed: "Completed",
    running: "Running",
    unknown: "Unknown",
    highConfidence: "High confidence",
    mediumConfidence: "Medium confidence",
    noBranch: "No branch",
    notEvaluated: "Not evaluated",
    subagentShort: "subagent",
    branchTooltipLabel: "Branch: {label}",
    typeTooltipLabel: "Type: {type}",
    statusTooltipLabel: "Status: {status}",
    subagentSourceTooltip: "This request comes from a Claude Code subagent.",
    jumpToBranchTooltip: "Click to jump to the matching Agent branch.",
    ownerAria: "Request owner",
    collapseUpstream: "Collapse upstream",
    expandUpstream: "Expand upstream",
    subagentBadge: "Subagent",
    parentSpawnBadge: "Spawn subagent",
    slashCommandTitle: "Command message expanded from a Claude Code slash command.",
    redactedBadgeTitle: "Hidden {count} sensitive header fields such as authorization, cookie, or token.",
    redactedBadge: "redacted {count}",
    captureAndChanges: "Capture and changes",
    toolResultUpstream: "Tool result return",
    toolUseUpstream: "Tool use upstream",
    resultReturnPreview: "Result return · {count} tool results",
    upstreamDetails: "Upstream details #{index}",
    upstreamLazyPlaceholder: "Expand to load upstream details #{index}",
    systemSummary: "System summary · {count} blocks",
    noSystemSummary: "(no system summary)",
    toolsCount: "Tools · {count}",
    historyStack: "History / message stack · {count}",
    noHistoryMessages: "No history messages to display.",
    currentUserInput: "Current user input",
    noTextContent: "No text content.",
    argumentsLabel: "Arguments",
    resultLabel: "Result",
    historyReused: "History replay",
    historyNew: "New in this request",
    baseline: "Baseline",
    frameworkAutoAdded: "Claude Code auto-added",
    baselineRequestSummary: "Baseline request · {count} context messages",
    reuseSummary: "Reused {reused}/{total} messages · added {added}",
    contextReuse: "Context reuse",
    noNewRoles: "No new roles",
    newMessageDetails: "New message details · {count}",
    currentRoundMessages: "New messages this round",
    currentUser: "Current user",
    itemCount: "{count} items",
    currentResultEvent: "Current result event",
    providerTokenStats: "Provider token stats",
    actualUpstream: "actual upstream {count}",
    providerInputTokenTitle: "Provider input tokens.",
    cacheHitTokenTitle: "Cache-hit tokens and ratio.",
    nonCacheInputTitle: "Non cache-read input token ratio.",
    providerOutputTokenTitle: "Provider output tokens.",
    reused: "Reused",
    changed: "Changed",
    baselineStatus: "Baseline",
    compactMessage: "Context compact (/compact)",
    contextCountMessage: "Context usage (/context)",
    subagentResult: "Subagent result return",
    taskNotification: "Task notification",
    frameworkReminder: "Framework reminder",
    agentInternal: "Agent internal",
    agentInternalRequest: "Agent internal request · {preview}",
    baselineRequestBadge: "Baseline request",
    baselineRequestTitle: "This is the first request in the session and is used as the comparison baseline.",
    systemChanged: "System changed",
    systemChangedTitle: "View this request's system prompt diff against the previous request.",
    toolsChanged: "Tools changed",
    toolsChangedTitle: "Tool schema or tool list differs from the previous request.",
    paramsChanged: "Params changed",
    paramsChangedTitle: "Model or request parameters changed, such as model, temperature, stream, or beta.",
    cumulative: "cumulative {count}",
    notCaptured: "not captured",
    upstreamStructureAria: "Upstream request structure summary",
    viewRawTitle: "View {label} Raw on the right",
    currentToolExchange: "Current tool_use / tool_result · {calls} / {results}",
    truncated: "truncated",
    assistantReply: "Assistant reply",
    collapse: "Collapse",
    viewAll: "View all",
    responseNoText: "Response captured, but no text reply was parsed.",
    responseExpandedHint: "Expanded; content scrolls inside this area. Collapse to return to the summary.",
    responseCollapsedHint: "Only the first 200 chars are shown. Click View all to expand.",
    assistantToolUse: "Assistant emitted tool_use · {count}",
    pairedById: "Paired by id",
    waitingToolResult: "Waiting for result or not captured",
    unpairedToolResult: "Unpaired result",
    noMatchedToolResult: "No matching tool result was captured yet.",
    noPreviousSystemDiff: "This request has no previous request, so no system diff can be generated.",
    noVisibleLineChanges: "No visible line-level changes",
    diffRowsChanged: "+{added} / -{removed} lines",
    diffLegendAria: "diff legend",
    diffRemove: "Removed",
    diffAdd: "Added",
    diffContext: "Context",
    noDiffRows: "The hash says system changed, but the current text extraction found no line-level diff. It may be a structural, whitespace, or non-text field change; switch to System Raw for inspection.",
    diffSkip: "Skipped {count} unchanged lines",
    unnamedSession: "Untitled session",
    exactCaptureTitle: "Captured the real upstream request sent by the Agent to the model service through the local proxy.",
    partialCaptureTitle: "This data comes from debug, import, or incomplete sources and is not equivalent to a full upstream request.",
    exactCapture: "Exact capture",
    partialCapture: "Partial capture",
    exactProxyCapture: "Exact proxy capture",
    otelRawBody: "OTel Raw body",
    unknownCapture: "Unknown capture mode",
    exactProxyHelp: "Captured the upstream request sent by the Agent to the model service through the local proxy.",
    otelRawHelp: "Read the request body from OTel raw body files; HTTP-layer metadata may be incomplete.",
    captureHelp: "Capture mode for the current data source.",
    unknownProtocol: "Unknown protocol",
    unknownProvider: "Unknown provider",
  },
};
const RAW_WIDTH_KEY = "peekmyagent.rawWidth";
const RAW_WIDTH_MIN = 320;
const RAW_WIDTH_MAX = 760;
const SIDEBAR_WIDTH_KEY = "peekmyagent.sidebarWidth";
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 420;
const MAIN_PANEL_MIN = 520;
const RESIZER_WIDTH = 6;
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
const requestDetailCache = new RequestDetailCache({
  loadDetail: async (sourceId, requestId) => (await api.requestDetail(sourceId, requestId)).request,
  onLoaded: async (fullRequest) => {
    const merged = mergeRequestDetail(fullRequest);
    await rebuildTranslationLookupForCurrentData();
    return merged;
  },
  onCached: mergeRequestDetail,
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
  const dictionary = I18N[state.uiLanguage] || I18N[DEFAULT_UI_LANGUAGE] || {};
  const fallback = I18N[DEFAULT_UI_LANGUAGE] || {};
  const template = dictionary[key] ?? fallback[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? "" : String(vars[name])));
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
  state.uiLanguage = normalizeUiLanguage(value);
  localStorage.setItem(UI_LANGUAGE_KEY, state.uiLanguage);
  applyStaticI18n();
  if (state.data) renderAll();
  if (state.activeRequestId) showRaw(state.activeRequestId, state.activeRawSection, { mode: state.activeRawMode || "request" });
}

async function setTargetTranslationLanguage(value) {
  const next = normalizeTranslationLanguage(value);
  if (next === currentTargetLanguage()) {
    renderLanguageSelectors();
    return;
  }
  state.targetTranslationLanguage = next;
  state.translationMode = next;
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
  state.rawOpen = localStorage.getItem("peekmyagent.rawOpen") !== "false";
  state.rawWidth = readRawPanelWidth();
  if (state.rawWidth) applyRawPanelWidth(state.rawWidth);
  state.sidebarOpen = localStorage.getItem("peekmyagent.sidebarOpen") !== "false";
  state.sidebarWidth = readSidebarWidth();
  state.latestOnly = localStorage.getItem(LATEST_ONLY_KEY) === "true";
  state.rawMessagesMode = normalizeMessagesMode(localStorage.getItem(RAW_MESSAGES_MODE_KEY));
  state.uiLanguage = normalizeUiLanguage(localStorage.getItem(UI_LANGUAGE_KEY));
  const storedTargetLanguage = localStorage.getItem(TARGET_TRANSLATION_LANGUAGE_KEY);
  state.targetTranslationLanguage = storedTargetLanguage ? normalizeTranslationLanguage(storedTargetLanguage) : defaultTranslationLanguage();
  state.translationMode = localStorage.getItem(TRANSLATION_MODE_KEY) === currentTargetLanguage() ? currentTargetLanguage() : "source";
  applyStaticI18n();
  renderLanguageSelectors();
  if (state.sidebarWidth) applySidebarWidth(state.sidebarWidth);
  setRawPanelOpen(state.rawOpen);
  setSidebarOpen(state.sidebarOpen);
  state.sources = await api.listSources();
  renderSessionNav();
  const requestedSource = new URLSearchParams(window.location.search).get("source");
  const first =
    state.sources.find((source) => source.id === requestedSource && source.available) ||
    state.sources.find((source) => source.available) ||
    state.sources[0];
  if (first) await loadSource(first.id);
  els.rawToggle.addEventListener("click", () => setRawPanelOpen(!state.rawOpen));
  els.toggleSidebar.addEventListener("click", () => setSidebarOpen(!state.sidebarOpen));
  els.traceImportButton?.addEventListener("click", () => els.traceImportInput?.click());
  els.traceImportInput?.addEventListener("change", importTraceFromFile);
  els.uiLanguageSelect?.addEventListener("change", (event) => {
    setUiLanguage(event.target.value);
  });
  els.translationLanguageSelect?.addEventListener("change", () => {
    setTargetTranslationLanguageFromSelect();
  });
  els.rawTree.addEventListener("click", (event) => {
    const searchNavigationButton = event.target.closest("[data-raw-search-nav]");
    if (searchNavigationButton && els.rawTree.contains(searchNavigationButton)) {
      navigateRawSearch(searchNavigationButton.dataset.rawSearchNav === "previous" ? -1 : 1);
      return;
    }
    const clearSearchButton = event.target.closest("[data-raw-search-clear]");
    if (clearSearchButton && els.rawTree.contains(clearSearchButton)) {
      state.rawSearchQuery = "";
      state.rawSearchActiveIndex = 0;
      state.rawSearchRevealPending = false;
      if (state.activeRequestId) showRaw(state.activeRequestId, state.activeRawSection, { mode: state.activeRawMode || "request" });
      return;
    }
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
  els.rawTree.addEventListener("input", (event) => {
    const input = event.target.closest("[data-raw-search]");
    if (!input || !els.rawTree.contains(input)) return;
    state.rawSearchQuery = input.value || "";
    if (event.isComposing || state.rawSearchComposing) return;
    state.rawSearchActiveIndex = 0;
    state.rawSearchRevealPending = true;
    scheduleRawSearchRender();
  });
  els.rawTree.addEventListener("compositionstart", (event) => {
    const input = event.target.closest("[data-raw-search]");
    if (!input || !els.rawTree.contains(input)) return;
    state.rawSearchComposing = true;
    window.clearTimeout(state.rawSearchTimer);
  });
  els.rawTree.addEventListener("compositionend", (event) => {
    const input = event.target.closest("[data-raw-search]");
    if (!input || !els.rawTree.contains(input)) return;
    state.rawSearchComposing = false;
    state.rawSearchQuery = input.value || "";
    state.rawSearchActiveIndex = 0;
    state.rawSearchRevealPending = true;
    scheduleRawSearchRender();
  });
  els.rawTree.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-raw-search]");
    if (!input || !els.rawTree.contains(input)) return;
    if (event.key === "Enter" && !event.isComposing && !state.rawSearchComposing) event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (!retranslateButton || els.rawTree.contains(retranslateButton)) return;
    event.preventDefault();
    event.stopPropagation();
    retranslateTranslationBlock(retranslateButton.dataset.translationRetranslate);
  });
  turnRailController.bind();
  bindSidebarResizer();
  bindRawResizer();
  window.addEventListener("resize", () => {
    if (state.sidebarWidth) setSidebarWidth(state.sidebarWidth, { persist: false });
    if (state.rawWidth) setRawPanelWidth(state.rawWidth, { persist: false });
    renderTurnRail();
    scheduleActiveSync();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshLiveData({ force: true });
  });
  startAutoRefresh();
}

function scheduleRawSearchRender() {
  if (!state.activeRequestId) return;
  window.clearTimeout(state.rawSearchTimer);
  state.rawSearchTimer = window.setTimeout(() => {
    showRaw(state.activeRequestId, state.activeRawSection, { mode: state.activeRawMode || "request" });
    requestAnimationFrame(() => restoreSearchInputFocus(els.rawTree.querySelector("[data-raw-search]")));
  }, 120);
}

function restoreSearchInputFocus(input) {
  if (!input) return;
  input.focus();
  const cursor = input.value.length;
  input.setSelectionRange(cursor, cursor);
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
  state.activeSourceId = nextData.source.id;
  await loadTranslationsForActiveSource();
  const turnIds = activeTurnIds(nextData);
  if (!turnIds.includes(state.activeId)) {
    state.activeId = turnIds.at(-1) || null;
  }
  if (!nextData.requests.some((request) => request.id === state.activeRequestId)) {
    state.activeRequestId = nextData.requests.at(-1)?.id || nextData.requests[0]?.id || null;
  }
  renderAll();
  if (wasNearBottom) {
    els.mainPanel.scrollTop = els.mainPanel.scrollHeight;
  } else {
    els.mainPanel.scrollTop = previousScrollTop;
  }
  scheduleActiveSync();
}

function applyLoadedSourceData(data, { preserveScroll = false, scrollTop = 0 } = {}) {
  state.data = data;
  const turnIds = activeTurnIds(data);
  if (!preserveScroll || !turnIds.includes(state.activeId)) {
    state.activeId = turnIds[0] || null;
  }
  if (!preserveScroll || !data.requests.some((request) => request.id === state.activeRequestId)) {
    state.activeRequestId = data.requests[0]?.id || null;
  }
  state.activeSourceId = data.source.id;
  const url = new URL(window.location.href);
  url.searchParams.set("source", state.activeSourceId);
  window.history.replaceState(null, "", url);
  renderAll();
  if (preserveScroll) els.mainPanel.scrollTop = scrollTop;
  else els.mainPanel.scrollTop = 0;
  scheduleActiveSync();
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
      state.translationMode = targetLanguage;
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
    state.translationMode = targetLanguage;
    localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  } catch (error) {
    state.translationGenerate = {
      loading: false,
      error: error.message,
      message: "",
    };
  }
  renderAll();
  if (item.surface === "raw" && state.activeRequestId) showRaw(state.activeRequestId, item.section || state.activeRawSection || "system", { mode: state.activeRawMode || "request" });
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
  state.translationMode = mode === targetLanguage ? targetLanguage : "source";
  state.rawSearchActiveIndex = 0;
  state.rawSearchRevealPending = Boolean(normalizedRawSearchQuery());
  localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  if (state.activeRequestId) showRaw(state.activeRequestId, section || state.activeRawSection || "full", { mode: state.activeRawMode || "request" });
}

function setMessagesMode(mode) {
  state.rawMessagesMode = normalizeMessagesMode(mode);
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
  els.sessionNav.innerHTML = renderSourceGroups(state.sources);
  document.querySelectorAll("[data-project-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleProjectGroup(button.dataset.projectToggle));
  });
  document.querySelectorAll("[data-project-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handleProjectAction(button.dataset.projectAction, button.dataset.projectKey);
    });
  });
  document.querySelectorAll("[data-source]").forEach((button) => {
    button.addEventListener("click", () => loadSource(button.dataset.source));
  });
  document.querySelectorAll("[data-source-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handleSourceAction(button.dataset.sourceAction, button.dataset.sourceId);
    });
  });
  document.removeEventListener("click", closeNavMenuOnce);
  document.addEventListener("click", closeNavMenuOnce);
}

function renderSourceGroups(sources) {
  const collapsed = readCollapsedProjects();
  const agentGroups = groupSourcesByAgentAndProject(sources);
  return agentGroups
    .map(
      (agentGroup) => `
        <section class="source-agent-group">
          <p class="source-agent-title">${escapeHtml(agentGroup.agent)}</p>
          ${agentGroup.projects.map((projectGroup) => renderProjectGroup(projectGroup, collapsed)).join("")}
        </section>
      `,
    )
    .join("");
}

function renderProjectGroup(projectGroup, collapsed) {
  const isCollapsed = collapsed[projectGroup.key] === true;
  const menuOpen = state.openProjectMenuKey === projectGroup.key;
  return `
    <section class="source-project-group ${isCollapsed ? "collapsed" : ""} ${menuOpen ? "menu-open" : ""}">
      <div class="source-project-header">
        <button class="source-project-toggle" type="button" data-project-toggle="${escapeHtml(projectGroup.key)}" aria-expanded="${String(!isCollapsed)}" title="${escapeHtml(projectGroup.workspace || projectGroup.project)}">
          <span class="source-project-chevron" aria-hidden="true">›</span>
          <span class="source-project-name">${escapeHtml(projectGroup.project)}</span>
          <span class="source-project-count">${projectGroup.sources.length}</span>
        </button>
        <span class="source-project-actions" aria-label="${escapeHtml(t("projectActionsAria"))}">
          <button class="session-action menu-trigger" type="button" data-project-action="menu" data-project-key="${escapeHtml(projectGroup.key)}" title="${escapeHtml(t("moreActions"))}" aria-haspopup="menu" aria-expanded="${String(menuOpen)}">⋯</button>
        </span>
        ${
          menuOpen
            ? `<div class="session-menu project-menu" role="menu">
                <button type="button" role="menuitem" data-project-action="archive" data-project-key="${escapeHtml(projectGroup.key)}">${escapeHtml(t("archiveProject"))}</button>
                <button class="danger" type="button" role="menuitem" data-project-action="delete" data-project-key="${escapeHtml(projectGroup.key)}">${escapeHtml(t("deleteProjectData"))}</button>
              </div>`
            : ""
        }
      </div>
      ${isCollapsed ? "" : `<div class="source-project-sessions">${projectGroup.sources.map(renderSessionItem).join("")}</div>`}
    </section>
  `;
}

function groupSourcesByAgentAndProject(sources) {
  const agentMap = new Map();
  for (const source of sources || []) {
    const agent = source.agent || "Unknown Agent";
    const project = source.project || projectNameFromWorkspace(source.workspace) || t("unassignedProject");
    const workspace = source.workspace || "";
    const projectKey = projectGroupKey(agent, workspace || project);
    if (!agentMap.has(agent)) agentMap.set(agent, { agent, projectMap: new Map() });
    const agentGroup = agentMap.get(agent);
    if (!agentGroup.projectMap.has(projectKey)) agentGroup.projectMap.set(projectKey, { key: projectKey, agent, workspace, project, sources: [] });
    agentGroup.projectMap.get(projectKey).sources.push(source);
  }
  return [...agentMap.values()].map((agentGroup) => ({
    agent: agentGroup.agent,
    projects: [...agentGroup.projectMap.values()],
  }));
}

function toggleProjectGroup(key) {
  const collapsed = readCollapsedProjects();
  collapsed[key] = !collapsed[key];
  writeCollapsedProjects(collapsed);
  renderSessionNav();
}

function projectGroupByKey(key) {
  return groupSourcesByAgentAndProject(state.sources)
    .flatMap((agentGroup) => agentGroup.projects)
    .find((projectGroup) => projectGroup.key === key);
}

function renderSessionItem(source) {
  const active = source.id === state.activeSourceId ? "active" : "";
  const disabled = source.available ? "" : "disabled";
  const status = source.live_watch_id ? source.live_status || "stopped" : "static";
  const subtitle = source.conversation_id ? shortId(source.conversation_id) : source.agent;
  const label = displaySourceLabel(source.label);
  const menuOpen = state.openSourceMenuId === source.id;
  return `
    <div class="session-item ${active} ${source.pinned ? "pinned" : ""} ${menuOpen ? "menu-open" : ""}" data-status="${escapeHtml(status)}">
      <button class="session-main" type="button" data-source="${escapeHtml(source.id)}" title="${escapeHtml(label)}" ${disabled}>
        <span class="session-dot" aria-hidden="true"></span>
        <span class="session-copy">
          <span class="session-title">${escapeHtml(label)}</span>
          <span class="session-subtitle">${escapeHtml(subtitle)} · ${escapeHtml(t("requestUnit", { count: source.request_count || 0 }))}</span>
        </span>
      </button>
      <span class="session-actions" aria-label="${escapeHtml(t("sessionActionsAria"))}">
        <button class="session-action menu-trigger" type="button" data-source-action="menu" data-source-id="${escapeHtml(source.id)}" title="${escapeHtml(t("moreActions"))}" aria-haspopup="menu" aria-expanded="${String(menuOpen)}">⋯</button>
      </span>
      ${
        menuOpen
          ? `<div class="session-menu" role="menu">
              <button type="button" role="menuitem" data-source-action="pin" data-source-id="${escapeHtml(source.id)}">${escapeHtml(source.pinned ? t("unpin") : t("pin"))}</button>
              <button type="button" role="menuitem" data-source-action="rename" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t("rename"))}</button>
              <button type="button" role="menuitem" data-source-action="export" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t("exportTrace"))}</button>
              <button type="button" role="menuitem" data-source-action="archive" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t("archive"))}</button>
              <button class="danger" type="button" role="menuitem" data-source-action="delete" data-source-id="${escapeHtml(source.id)}">${escapeHtml(t("deleteData"))}</button>
            </div>`
          : ""
      }
    </div>
  `;
}

async function handleSourceAction(action, sourceId) {
  const source = state.sources.find((item) => item.id === sourceId);
  if (!source) return;
  if (action === "menu") {
    state.openSourceMenuId = state.openSourceMenuId === sourceId ? null : sourceId;
    state.openProjectMenuKey = null;
    renderSessionNav();
    return;
  }
  state.openSourceMenuId = null;
  if (action === "pin") {
    await updateSourceMeta(sourceId, { pinned: !source.pinned });
    return;
  }
  if (action === "rename") {
    const title = window.prompt(t("renameSessionPrompt"), source.user_title || source.label);
    if (title == null) return;
    await updateSourceMeta(sourceId, { title });
    return;
  }
  if (action === "export") {
    exportTraceSource(sourceId);
    return;
  }
  if (action === "archive" || action === "remove") {
    const message =
      source.live_watch_id && source.live_status === "watching"
        ? t("archiveLiveConfirm")
        : t("archiveStaticConfirm");
    if (!window.confirm(message)) return;
    await updateSourceMeta(sourceId, { archive: true });
    return;
  }
  if (action === "delete") {
    const message =
      source.live_watch_id && source.live_status === "watching"
        ? t("deleteLiveConfirm")
        : t("deleteStaticConfirm");
    if (!window.confirm(message)) return;
    await updateSourceMeta(sourceId, { delete: true });
  }
}

async function handleProjectAction(action, projectKey) {
  const projectGroup = projectGroupByKey(projectKey);
  if (!projectGroup) return;
  if (action === "menu") {
    state.openProjectMenuKey = state.openProjectMenuKey === projectKey ? null : projectKey;
    state.openSourceMenuId = null;
    renderSessionNav();
    return;
  }
  state.openProjectMenuKey = null;
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

function closeNavMenuOnce(event) {
  if (!state.openSourceMenuId && !state.openProjectMenuKey) return;
  if (event.target?.closest?.("[data-source-action], [data-project-action], .session-menu")) return;
  state.openSourceMenuId = null;
  state.openProjectMenuKey = null;
  renderSessionNav();
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

function readCollapsedProjects() {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeCollapsedProjects(collapsed) {
  localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify(collapsed));
}

function renderAll() {
  clearTranslationActions();
  const { source, stats, requests, turns } = state.data;
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
  els.viewControls.innerHTML =
    `<button class="stat stat-button ${state.latestOnly && !traceQueryActive() ? "active" : ""}" type="button" data-latest-only ${traceQueryActive() ? `disabled title="${escapeHtml(t("latestDisabledBySearch"))}"` : ""}>${state.latestOnly && !traceQueryActive() ? t("showAllTurns") : t("latestOnly")}</button>` +
    `<button class="stat stat-button session-info-trigger" type="button" data-session-info>${t("sessionInfo")}</button>`;
  els.watchSummary.innerHTML = renderProgressiveLoadNotice(state.data?.partial);
  els.sessionInfoBody.innerHTML = renderSessionInfo(source, stats, requests);
  renderSessionNav();
  els.traceQueryBar.innerHTML = renderTraceQueryBar(requests);
  const filteredTurns = traceFilteredTurns(turns, requests);
  const turnWindow = timelineWindowInfo(filteredTurns, requests);
  els.timeline.innerHTML = requests.length ? (filteredTurns.length ? renderTurnTimeline(turnWindow, requests) : renderTraceNoResults()) : renderEmptyTimeline(source.workbench);
  els.agentComposer.innerHTML = renderAgentComposer(source);
  renderTurnRail();
  bindSessionInfoControls();
  bindWatchControls();
  bindAgentComposer();
  bindTraceQueryEvents();
  bindRequestEvents();
  if (state.activeId) markActiveTurn(state.activeId, false);
  if (state.activeRequestId) markActiveRequest(state.activeRequestId, false);
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

function renderTraceQueryBar(requests) {
  const counts = traceFilterCounts(requests);
  const matchCount = traceQueryActive() ? traceMatchingRequestCount(state.data?.turns || [], requests) : counts.all;
  const shownCount = Math.min(matchCount, state.traceResultLimit);
  const filters = [
    ["all", t("traceFilterAll", { count: counts.all })],
    ["issues", t("traceFilterIssues", { count: counts.issues })],
    ["slow", t("traceFilterSlow", { count: counts.slow })],
    ["tools", t("traceFilterTools", { count: counts.tools })],
    ["subagents", t("traceFilterSubagents", { count: counts.subagents })],
  ];
  return `
    <label class="trace-search-field">
      <input type="search" value="${escapeHtml(state.traceQuery)}" placeholder="${escapeHtml(t("traceSearchPlaceholder"))}" aria-label="${escapeHtml(t("traceSearchAria"))}" data-trace-search>
    </label>
    <div class="trace-filter-group" role="group" aria-label="${escapeHtml(t("traceFilterAria"))}">
      ${filters.map(([filter, label]) => `<button class="trace-filter ${state.traceFilter === filter ? "active" : ""}" type="button" data-trace-filter="${escapeHtml(filter)}" aria-pressed="${escapeHtml(String(state.traceFilter === filter))}">${escapeHtml(label)}</button>`).join("")}
    </div>
    ${
      traceQueryActive()
        ? `<div class="trace-match-status">
            <span>${escapeHtml(t("traceMatchCount", { shown: shownCount, total: matchCount }))}</span>
            ${matchCount > shownCount ? `<button type="button" data-trace-more>${escapeHtml(t("traceShowMore", { count: Math.min(TRACE_RESULT_PAGE_SIZE, matchCount - shownCount) }))}</button>` : ""}
          </div>`
        : ""
    }
  `;
}

function bindTraceQueryEvents() {
  const input = els.traceQueryBar?.querySelector("[data-trace-search]");
  input?.addEventListener("input", (event) => {
    state.traceQuery = input.value || "";
    state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
    if (event.isComposing || state.traceSearchComposing) return;
    scheduleTraceSearchRender();
  });
  input?.addEventListener("compositionstart", () => {
    state.traceSearchComposing = true;
    window.clearTimeout(state.traceQueryTimer);
  });
  input?.addEventListener("compositionend", () => {
    state.traceSearchComposing = false;
    state.traceQuery = input.value || "";
    state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
    scheduleTraceSearchRender();
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && !state.traceSearchComposing) event.preventDefault();
  });
  els.traceQueryBar?.querySelectorAll("[data-trace-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.traceFilter = button.dataset.traceFilter || "all";
      state.traceResultLimit = TRACE_RESULT_PAGE_SIZE;
      const filteredTurns = traceFilteredTurns(state.data?.turns || [], state.data?.requests || []);
      if (!filteredTurns.some((turn) => turn.id === state.activeId)) state.activeId = filteredTurns[0]?.id || null;
      renderAll();
    });
  });
  const moreButton = els.traceQueryBar?.querySelector("[data-trace-more]");
  moreButton?.addEventListener("click", () => {
    state.traceResultLimit += TRACE_RESULT_PAGE_SIZE;
    renderAll();
  });
}

function scheduleTraceSearchRender() {
  window.clearTimeout(state.traceQueryTimer);
  state.traceQueryTimer = window.setTimeout(() => {
    renderAll();
    requestAnimationFrame(() => restoreSearchInputFocus(els.traceQueryBar?.querySelector("[data-trace-search]")));
  }, 160);
}

function traceQueryActive() {
  return state.traceFilter !== "all" || Boolean(String(state.traceQuery || "").trim());
}

function traceFilterCounts(requests) {
  const list = Array.isArray(requests) ? requests : [];
  return {
    all: list.length,
    issues: list.filter(traceRequestHasIssue).length,
    slow: list.filter(traceRequestIsSlow).length,
    tools: list.filter(traceRequestHasTools).length,
    subagents: list.filter((request) => request.is_subagent).length,
  };
}

function traceFilteredTurns(turns, requests) {
  const normalizedTurns = Array.isArray(turns) && turns.length ? turns : fallbackTurns(requests);
  const filter = state.traceFilter || "all";
  const query = String(state.traceQuery || "").trim().toLocaleLowerCase();
  if (filter === "all" && !query) return normalizedTurns;
  const requestMap = new Map((requests || []).map((request) => [request.id, request]));
  let remaining = state.traceResultLimit;
  const matchedTurns = [];
  for (const turn of normalizedTurns) {
    const turnRequests = (turn.request_ids || []).map((id) => requestMap.get(id)).filter(Boolean);
    const matchedRequestIds = traceMatchingRequestIdsForTurn(turn, turnRequests, filter, query);
    if (!matchedRequestIds.length || remaining <= 0) continue;
    const visibleRequestIds = matchedRequestIds.slice(0, remaining);
    remaining -= visibleRequestIds.length;
    matchedTurns.push({
      ...turn,
      request_ids: visibleRequestIds,
      request_count: visibleRequestIds.length,
      trace_filter_active: true,
      trace_match_count: matchedRequestIds.length,
    });
  }
  return matchedTurns;
}

function traceMatchingRequestCount(turns, requests) {
  const normalizedTurns = Array.isArray(turns) && turns.length ? turns : fallbackTurns(requests);
  const requestMap = new Map((requests || []).map((request) => [request.id, request]));
  const filter = state.traceFilter || "all";
  const query = String(state.traceQuery || "").trim().toLocaleLowerCase();
  let count = 0;
  for (const turn of normalizedTurns) {
    const turnRequests = (turn.request_ids || []).map((id) => requestMap.get(id)).filter(Boolean);
    count += traceMatchingRequestIdsForTurn(turn, turnRequests, filter, query).length;
  }
  return count;
}

function traceMatchingRequestIdsForTurn(turn, turnRequests, filter, query) {
  const directMatches = turnRequests.filter((request) => traceRequestMatchesFilter(request, filter) && (!query || traceSearchTextForRequest(request).includes(query)));
  if (directMatches.length || !query || filter !== "all" || !traceSearchTextForTurn(turn).includes(query)) return directMatches.map((request) => request.id);
  const lead = turnLeadRequest(turnRequests, turn) || turnRequests[0];
  return lead ? [lead.id] : [];
}

function traceRequestMatchesFilter(request, filter) {
  if (filter === "issues") return traceRequestHasIssue(request);
  if (filter === "slow") return traceRequestIsSlow(request);
  if (filter === "tools") return traceRequestHasTools(request);
  if (filter === "subagents") return Boolean(request.is_subagent);
  return true;
}

function traceRequestHasIssue(request) {
  const status = Number(request.upstream_status ?? request.summary?.response?.status ?? 0);
  if (status >= 400) return true;
  const evidence = [
    request.summary?.entry?.text,
    request.summary?.response?.preview,
    ...(request.summary?.current_tool_results || []).map((result) => result.content),
  ]
    .filter(Boolean)
    .join("\n");
  return /(?:api error|\berror\b|exception|permission denied|timed? out|timeout|失败|报错|不可用)/i.test(evidence);
}

function traceRequestIsSlow(request) {
  return Number(request.summary?.response?.latency_ms || 0) >= 5000;
}

function traceRequestHasTools(request) {
  return Boolean((request.summary?.response?.tool_calls?.length || 0) + (request.summary?.current_tool_results?.length || 0));
}

function traceSearchTextForTurn(turn) {
  return [turn.index, turn.title, turn.user_input, turn.command_message?.command, turn.command_message?.body].filter(Boolean).join(" ").toLocaleLowerCase();
}

function traceSearchTextForRequest(request) {
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
    ...(request.summary?.response?.tool_calls || []).flatMap((call) => [call.name, shortPreview(stableJson(call.arguments), 1000)]),
    ...(request.summary?.current_tool_results || []).map((result) => result.content),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  traceSearchTextCache.set(request, text);
  return text;
}

function renderTraceNoResults() {
  return `
    <section class="trace-no-results">
      <h3>${escapeHtml(t("traceNoResultsTitle"))}</h3>
      <p>${escapeHtml(t("traceNoResultsBody"))}</p>
    </section>
  `;
}

function baseTurnList(turns, requests) {
  const normalizedTurns = Array.isArray(turns) && turns.length ? turns : fallbackTurns(requests);
  if (traceQueryActive() || !state.latestOnly || normalizedTurns.length <= 1) return normalizedTurns;
  return [normalizedTurns.at(-1)];
}

function timelineWindowInfo(turns, requests) {
  const allTurns = baseTurnList(turns, requests);
  if (state.latestOnly || allTurns.length <= TIMELINE_WINDOW_THRESHOLD) {
    return {
      turns: allTurns,
      allTurns,
      start: 0,
      end: allTurns.length,
      total: allTurns.length,
      windowed: false,
    };
  }
  const rawActiveIndex = allTurns.findIndex((turn) => turn.id === state.activeId);
  const activeIndex = rawActiveIndex >= 0 ? rawActiveIndex : 0;
  const halfWindow = Math.floor(TIMELINE_WINDOW_SIZE / 2);
  const maxStart = Math.max(0, allTurns.length - TIMELINE_WINDOW_SIZE);
  const start = Math.min(Math.max(0, activeIndex - halfWindow), maxStart);
  const end = Math.min(allTurns.length, start + TIMELINE_WINDOW_SIZE);
  return {
    turns: allTurns.slice(start, end),
    allTurns,
    start,
    end,
    total: allTurns.length,
    windowed: true,
  };
}

function visibleTurnList(turns, requests) {
  return timelineWindowInfo(turns, requests).turns;
}

function renderEmptyTimeline(summary) {
  return `
    <section class="empty-timeline">
      <h3>${escapeHtml(t("emptyTimelineTitle"))}</h3>
      <p>${escapeHtml(t("emptyTimelineBody"))}</p>
      <div class="empty-grid">
        ${renderSummaryMetric(t("emptyStatus"), summary?.status || t("emptyWatching"))}
        ${renderSummaryMetric(t("emptyWatch"), summary?.watch_ids?.join(", ") || t("emptyNotRecorded"))}
        ${renderSummaryMetric(t("emptyCapture"), summary?.capture_label || "exact proxy capture")}
      </div>
    </section>
  `;
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

function renderAgentComposer(source) {
  const canSend = canSendToAgentSource(source);
  const watching = source?.live_status === "watching";
  const supported = /claude|openclaw/i.test(source?.agent || "");
  const enabled = canSend && watching && supported && !state.agentSend.loading;
  const statusText = composerStatusText(source, { canSend, watching, supported });
  const result = state.agentSend.result;
  const statusClass = state.agentSend.error || result?.exit_code ? "error" : "";
  const statusMessage = state.agentSend.error || state.agentSend.message || (result ? agentSendResultText(result) : "");
  return `
    <form class="agent-compose-form ${enabled ? "" : "disabled"}" data-agent-compose data-source-id="${escapeHtml(source?.id || "")}">
      <div class="agent-compose-target">
        <strong>${escapeHtml(source?.agent || "Agent")}</strong>
        <span>${escapeHtml(statusText)}</span>
        ${supported && canSend ? `<span class="agent-compose-note">${escapeHtml(t("sendViaResumeNote"))}</span>` : ""}
      </div>
      <div class="agent-compose-row">
        <textarea
          class="agent-compose-input"
          name="message"
          rows="1"
          placeholder="${escapeHtml(enabled ? t("composerPlaceholder") : statusText)}"
          ${enabled ? "" : "disabled"}
        ></textarea>
        <button class="primary-button small agent-compose-send" type="submit" ${enabled ? "" : "disabled"}>
          ${escapeHtml(state.agentSend.loading ? t("sending") : t("send"))}
        </button>
      </div>
      <p class="agent-compose-status ${statusClass}" data-agent-compose-status ${statusMessage ? "" : "hidden"}>${escapeHtml(statusMessage)}</p>
    </form>
  `;
}

function canSendToAgentSource(source) {
  if (!source) return false;
  if (source.live_watch_id) return true;
  return Boolean(source.store_watch_id && source.conversation_id && ["watching", "paused"].includes(source.live_status || ""));
}

function composerStatusText(source, { canSend, watching, supported }) {
  if (!canSend) return t("sendUnavailable");
  if (!supported) return t("sendUnsupported");
  if (!watching) return source?.live_status === "paused" ? t("watchPaused") : t("watchStopped");
  const project = source.project || projectNameFromWorkspace(source.workspace) || t("currentProject");
  const conversation = source.conversation_id ? ` · ${shortId(source.conversation_id)}` : "";
  return `${project}${conversation}`;
}

function agentSendResultText(result) {
  const code = Number(result?.exit_code || 0);
  if (!code) return t("sent");
  const output = cleanDisplayText(result?.stderr || result?.stdout || "");
  const preview = output ? ` · ${shortPreview(output, 120)}` : "";
  return t("sendFailed", { code, preview });
}

function bindAgentComposer() {
  const form = document.querySelector("[data-agent-compose]");
  if (!form) return;
  const textarea = form.querySelector("textarea[name='message']");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendAgentComposerMessage(textarea?.value || "");
  });
  textarea?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendAgentComposerMessage(textarea.value || "");
    }
  });
}

async function sendAgentComposerMessage(rawMessage) {
  const message = String(rawMessage || "").trim();
  if (!message || !state.data?.source?.id || state.agentSend.loading) return;
  const sourceId = state.data.source.id;
  state.agentSend = { loading: true, error: "", message: t("sentWaitingCapture"), result: null };
  updateAgentComposerUi(sourceId, { loading: true, message: state.agentSend.message, value: "" });
  await nextUiTick();
  try {
    const result = await api.sendAgent({
      source_id: sourceId,
      message,
    });
    state.agentSend = {
      loading: false,
      error: "",
      message: "",
      result,
    };
    updateAgentComposerUi(sourceId, { loading: false, message: t("sentRefreshingCapture"), result });
    await loadSource(result?.source_id || sourceId, { preserveScroll: true });
  } catch (error) {
    state.agentSend = { loading: false, error: error.message, message: "", result: null };
    updateAgentComposerUi(sourceId, { loading: false, error: error.message, value: rawMessage });
  }
}

function updateAgentComposerUi(sourceId, { loading, message = "", error = "", result = null, value } = {}) {
  const form = document.querySelector("[data-agent-compose]");
  if (!form || form.dataset.sourceId !== sourceId) return;
  const textarea = form.querySelector("textarea[name='message']");
  const button = form.querySelector(".agent-compose-send");
  const status = form.querySelector("[data-agent-compose-status]");
  form.classList.toggle("disabled", Boolean(loading));
  if (textarea) {
    textarea.disabled = Boolean(loading);
    if (value !== undefined) textarea.value = String(value || "");
  }
  if (button) {
    button.disabled = Boolean(loading);
    button.textContent = loading ? t("sending") : t("send");
  }
  if (status) {
    const statusText = error || message || (result ? agentSendResultText(result) : "");
    status.textContent = statusText;
    status.hidden = !statusText;
    status.classList.toggle("error", Boolean(error || Number(result?.exit_code || 0)));
  }
}

function nextUiTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  const requests = data?.requests || [];
  const turns = data?.turns || [];
  const filtered = traceFilteredTurns(turns, requests);
  if (traceQueryActive() || !state.latestOnly || filtered.length <= 1) return filtered;
  return [filtered.at(-1)];
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

function renderTurnTimeline(turnWindowOrTurns, requests) {
  const turnWindow = Array.isArray(turnWindowOrTurns)
    ? {
        turns: turnWindowOrTurns,
        allTurns: turnWindowOrTurns,
        start: 0,
        end: turnWindowOrTurns.length,
        total: turnWindowOrTurns.length,
        windowed: false,
      }
    : turnWindowOrTurns;
  const normalizedTurns = Array.isArray(turnWindow?.turns) && turnWindow.turns.length ? turnWindow.turns : fallbackTurns(requests);
  const requestMap = new Map(requests.map((request) => [request.id, request]));
  return [renderTimelineWindowEdge(turnWindow, "before"), ...normalizedTurns.map((turn) => renderTurnGroup(turn, requestMap)), renderTimelineWindowEdge(turnWindow, "after")].join("");
}

function renderTimelineWindowEdge(turnWindow, edge) {
  if (!turnWindow?.windowed) return "";
  const hiddenCount = edge === "before" ? turnWindow.start : turnWindow.total - turnWindow.end;
  if (hiddenCount <= 0) return "";
  const target = edge === "before" ? turnWindow.allTurns?.[0] : turnWindow.allTurns?.at(-1);
  const label = edge === "before" ? t("timelineWindowBefore", { count: hiddenCount }) : t("timelineWindowAfter", { count: hiddenCount });
  const summary = t("timelineWindowSummary", { start: turnWindow.start + 1, end: turnWindow.end, total: turnWindow.total });
  return `
    <section class="timeline-window-edge-card ${edge}" aria-label="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
      <span>${escapeHtml(summary)}</span>
      ${target?.id ? `<button type="button" data-turn-window-jump="${escapeHtml(target.id)}">${escapeHtml(edge === "before" ? t("jumpToFirstTurn") : t("jumpToLastTurn"))}</button>` : ""}
    </section>
  `;
}

function fallbackTurns(requests) {
  return requests.map((request, index) => ({
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
    subagent_count: request.is_subagent ? 1 : 0,
    parent_spawn_count: request.source_hint?.type === "parent_spawn" ? 1 : 0,
    tool_call_count: request.summary?.current_tool_calls?.length || 0,
    tool_result_count: request.summary?.current_tool_results?.length || 0,
    raw_body_bytes: request.counts?.raw_body_bytes || 0,
  }));
}

// The request that carries this turn's defining user input (earliest, non-
// subagent, non-metadata, matching the turn's user text or a slash command).
// Used to pin the user message to the top of the turn regardless of whether it
// was classified main or parent_spawn.
function turnLeadRequest(requests, turn) {
  const turnKey = normalizeTurnDisplayText(turn.user_input || turn.title || "");
  return (
    requests.find(
      (request) =>
        request.source_hint?.type !== "metadata" &&
        !request.is_subagent &&
        (Boolean(request.summary?.command_message) || (turnKey && normalizeTurnDisplayText(request.summary?.current_user || "") === turnKey)),
    ) || null
  );
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
  const lead = turnLeadRequest(requests, turn);
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

function normalizeTurnDisplayText(value) {
  return cleanDisplayText(value).replace(/\s+/g, " ").trim();
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
  const branches = (trace?.branches || []).filter((branch) => (turn.agent_branches || []).includes(branch.id));
  if (!branches.length) return "";
  const sortedBranches = [...branches].sort((left, right) => Number(left.first_request_index || 0) - Number(right.first_request_index || 0));
  const spawnIndexes = [...new Set(branches.map((branch) => branch.spawn?.parent_request_index).filter(Boolean))];
  const returnIndexes = [...new Set(branches.map((branch) => branch.return?.parent_request_index).filter(Boolean))];
  const typeNames = [...new Set(sortedBranches.map((branch, index) => agentBranchName(branch, index)))];
  const summaryDots = sortedBranches
    .slice(0, AGENT_SUMMARY_DOT_LIMIT)
    .map((branch, index) => `<span class="agent-summary-dot" style="--branch-color:${escapeHtml(agentBranchColor(index))}" aria-hidden="true"></span>`)
    .join("");
  const dashboardOpen = state.openAgentDashboards.has(turn.id);
  const activeFilter = state.agentBranchFilters.get(turn.id) || "all";
  const branchEntries = sortedBranches.map((branch, index) => ({ branch, index }));
  const filteredEntries = activeFilter === "all" ? branchEntries : branchEntries.filter(({ branch }) => branch.status === activeFilter);
  const branchLimit = Math.max(AGENT_BRANCH_PAGE_SIZE, state.agentBranchLimits.get(turn.id) || AGENT_BRANCH_PAGE_SIZE);
  const visibleEntries = filteredEntries.slice(0, branchLimit);
  const hiddenBranchCount = Math.max(0, filteredEntries.length - visibleEntries.length);
  const returned = sortedBranches.filter((branch) => branch.status === "returned").length;
  const completed = sortedBranches.filter((branch) => branch.status === "completed").length;
  const running = sortedBranches.filter((branch) => branch.status === "running").length;
  const dashboardBody = dashboardOpen
    ? `
      <div class="agent-branch-head">
        <div>
          <p>${escapeHtml(agentTraceSummary(trace, branches))}</p>
          <p class="agent-branch-status-line">${escapeHtml(t("branchStatusSummary", { returned, completed, running }))}</p>
        </div>
        <div class="agent-branch-head-meta">
          ${spawnIndexes.length ? `<span>spawn #${escapeHtml(spawnIndexes.join(", #"))}</span>` : ""}
          ${returnIndexes.length ? `<span>return #${escapeHtml(returnIndexes.join(", #"))}</span>` : ""}
          <span>${escapeHtml(branchConfidenceLabel(trace?.confidence))}</span>
        </div>
      </div>
      <div class="agent-branch-toolbar">
        <div class="agent-status-filters" role="group" aria-label="${escapeHtml(t("agentStatusFilterAria"))}">
          ${renderAgentFilterButton(turn.id, "all", t("agentFilterAll", { count: sortedBranches.length }), activeFilter)}
          ${renderAgentFilterButton(turn.id, "running", t("agentFilterRunning", { count: running }), activeFilter)}
          ${renderAgentFilterButton(turn.id, "completed", t("agentFilterCompleted", { count: completed }), activeFilter)}
          ${renderAgentFilterButton(turn.id, "returned", t("agentFilterReturned", { count: returned }), activeFilter)}
        </div>
        <span>${escapeHtml(t("agentShowingCount", { shown: visibleEntries.length, total: filteredEntries.length }))}</span>
      </div>
      <div class="agent-flow-map">
        ${visibleEntries.map(({ branch, index }) => renderAgentMapCard(branch, index)).join("")}
      </div>
      ${renderAgentEventStrip(filteredEntries)}
      <div class="agent-branch-details" aria-label="${escapeHtml(t("subagentDetails"))}">
        <div class="agent-branch-grid">
          ${visibleEntries.length ? visibleEntries.map(({ branch, index }) => renderAgentBranch(branch, index, requestMap)).join("") : `<p class="agent-filter-empty">${escapeHtml(t("noAgentsForFilter"))}</p>`}
        </div>
        ${
          hiddenBranchCount
            ? `<button class="agent-branch-load-more" type="button" data-agent-branch-more="${escapeHtml(turn.id)}">${escapeHtml(t("showMoreAgents", { count: Math.min(AGENT_BRANCH_PAGE_SIZE, hiddenBranchCount) }))}</button>`
            : ""
        }
      </div>`
    : "";
  return `
    <details class="agent-branch-map" aria-label="${escapeHtml(t("multiAgentAria"))}" data-agent-dashboard="${escapeHtml(turn.id)}" ${dashboardOpen ? "open" : ""}>
      <summary class="agent-branch-summary" data-agent-dashboard-toggle="${escapeHtml(turn.id)}">
        ${summaryDots}
        ${sortedBranches.length > AGENT_SUMMARY_DOT_LIMIT ? `<span class="agent-summary-more">+${escapeHtml(String(sortedBranches.length - AGENT_SUMMARY_DOT_LIMIT))}</span>` : ""}
        <strong>${escapeHtml(t("multiAgentSummary", { count: branches.length }))}</strong>
        <span class="agent-branch-summary-types">${escapeHtml(typeNames.join(" / "))}</span>
      </summary>
      ${dashboardBody}
    </details>
  `;
}

function renderAgentFilterButton(turnId, filter, label, activeFilter) {
  return `<button class="agent-status-filter ${filter === activeFilter ? "active" : ""}" type="button" data-agent-status-filter="${escapeHtml(turnId)}" data-agent-filter-value="${escapeHtml(filter)}" aria-pressed="${escapeHtml(String(filter === activeFilter))}">${escapeHtml(label)}</button>`;
}

function agentTraceSummary(trace, branches) {
  const returned = branches.filter((branch) => branch.status === "returned").length;
  const requestCount = branches.reduce((sum, branch) => sum + (branch.request_ids?.length || 0), 0);
  const toolCalls = branches.reduce((sum, branch) => sum + (branch.response_tool_call_count || 0), 0);
  const toolResults = branches.reduce((sum, branch) => sum + (branch.request_tool_result_count || 0), 0);
  const signal = trace?.signals?.child_instance || "agent id";
  return t("branchSummary", { branches: branches.length, requests: requestCount, returned, calls: toolCalls, results: toolResults, signal });
}

const AGENT_BRANCH_COLORS = ["#2563eb", "#16a34a", "#b4690e", "#7c3aed", "#dc2626", "#0891b2", "#db2777", "#65a30d"];
function agentBranchColor(index) {
  return AGENT_BRANCH_COLORS[index % AGENT_BRANCH_COLORS.length];
}
function agentBranchName(branch, index) {
  return branch.agent_type || branch.spawn?.subagent_type || t("subagentFallback", { index: index + 1 });
}

function renderAgentBranch(branch, index, requestMap) {
  const firstRequest = requestMap.get(branch.request_ids?.[0]);
  const title = branch.label || branch.agent_type || t("subagentFallback", { index: index + 1 });
  const collapsed = !state.expandedAgentBranches.has(branch.id);
  const summary = agentBranchCompactSummary(branch);
  const name = agentBranchName(branch, index);
  const color = agentBranchColor(index);
  return `
    <article class="agent-branch-card ${collapsed ? "collapsed" : ""}" data-branch="${escapeHtml(branch.id)}" style="--branch-color:${escapeHtml(color)}">
      <button class="agent-branch-toggle" type="button" data-agent-branch-toggle="${escapeHtml(branch.id)}" aria-expanded="${escapeHtml(String(!collapsed))}">
        <span class="agent-branch-index">${escapeHtml(`${collapsed ? "▸" : "▾"}`)}</span>
        <div>
          <strong><span class="agent-type-chip">${escapeHtml(name)}</span> ${escapeHtml(t("childSeq", { index: index + 1 }))} · ${escapeHtml(title)}</strong>
          <p>${escapeHtml(shortId(branch.agent_id))} · ${escapeHtml(requestDisplayTitle(firstRequest || {}))}</p>
          <p class="agent-branch-compact">${escapeHtml(summary)}</p>
        </div>
        <span class="agent-branch-status ${escapeHtml(branch.status || "unknown")}">${escapeHtml(branchStatusLabel(branch.status))}</span>
      </button>
      ${
        collapsed
          ? ""
          : `<div class="agent-branch-body">
              ${branch.spawn ? renderBranchEdge(t("parentCall"), branch.spawn.parent_request_id, `#${branch.spawn.parent_request_index} · ${branch.spawn.label || branch.spawn.id}`) : ""}
              <div class="agent-branch-steps">
                ${(branch.steps || []).map((step) => renderAgentBranchStep(step)).join("")}
              </div>
              ${branch.return ? renderBranchEdge(t("resultReturn"), branch.return.parent_request_id, `#${branch.return.parent_request_index} · ${shortPreview(branch.return.result_preview, 90)}`) : ""}
              <p class="agent-branch-note">${escapeHtml(branch.linkage_note || "")}</p>
            </div>`
      }
    </article>
  `;
}

function renderAgentMapCard(branch, index) {
  const title = branch.label || branch.agent_type || t("subagentFallback", { index: index + 1 });
  const name = agentBranchName(branch, index);
  const color = agentBranchColor(index);
  const indexes = [
    branch.spawn?.parent_request_index ? `#${branch.spawn.parent_request_index}` : "",
    ...(branch.request_indexes || []).slice(0, 4).map((requestIndex) => `#${requestIndex}`),
    branch.return?.parent_request_index ? `#${branch.return.parent_request_index}` : "",
  ].filter(Boolean);
  const overflow = Math.max(0, (branch.request_indexes?.length || 0) - 4);
  return `
    <button class="agent-map-card ${escapeHtml(branch.status || "unknown")}" type="button" data-agent-branch-jump="${escapeHtml(branch.id)}" style="--branch-color:${escapeHtml(color)}" title="${escapeHtml(branch.linkage_note || t("jumpToAgentBranch"))}">
      <span class="agent-map-topline">
        <span class="agent-map-dot" aria-hidden="true"></span>
        <strong>${escapeHtml(name)}</strong>
        <span class="agent-map-seq">${escapeHtml(t("childSeq", { index: index + 1 }))}</span>
        <em>${escapeHtml(branchStatusLabel(branch.status))}</em>
      </span>
      <span class="agent-map-title">${escapeHtml(shortPreview(title, 44))}</span>
      <span class="agent-map-indexes">${escapeHtml(indexes.join(" → ") || t("noRecordedRequests"))}${overflow ? ` <span>+${escapeHtml(String(overflow))}</span>` : ""}</span>
    </button>
  `;
}

function agentBranchCompactSummary(branch) {
  const requestCount = branch.request_ids?.length || 0;
  const toolUse = branch.response_tool_call_count || 0;
  const toolResult = branch.request_tool_result_count || 0;
  const edges = [branch.spawn ? `spawn #${branch.spawn.parent_request_index}` : "", branch.return ? `return #${branch.return.parent_request_index}` : ""].filter(Boolean).join(" · ");
  return [t("turnRequests", { count: requestCount }), toolUse || toolResult ? t("turnTools", { calls: toolUse, results: toolResult }) : "", edges].filter(Boolean).join(" · ");
}

function renderAgentEventStrip(branchEntries) {
  const events = agentFlowEvents(branchEntries);
  if (!events.length) return "";
  const visibleEvents = events.slice(0, AGENT_EVENT_LIMIT);
  return `
    <div class="agent-event-strip" aria-label="${escapeHtml(t("eventOrder"))}">
      <span class="agent-event-label">${escapeHtml(t("eventOrderCount", { shown: visibleEvents.length, total: events.length }))}</span>
      <div class="agent-event-list">
        ${visibleEvents.map(renderAgentEvent).join("")}
      </div>
    </div>
  `;
}

function agentFlowEvents(branchEntries) {
  const events = [];
  for (const [displayIndex, entry] of branchEntries.entries()) {
    const branch = entry?.branch || entry;
    const index = Number.isInteger(entry?.index) ? entry.index : displayIndex;
    const agentLabel = t("childSeq", { index: index + 1 });
    if (branch.spawn?.parent_request_index) {
      events.push({
        order: events.length,
        request_id: branch.spawn.parent_request_id,
        request_index: branch.spawn.parent_request_index,
        label: `${agentLabel} spawn`,
      });
    }
    for (const step of branch.steps || []) {
      events.push({
        order: events.length,
        request_id: step.request_id,
        request_index: step.request_index,
        label: `${agentLabel} ${agentStepEventLabel(step)}`,
      });
    }
    if (branch.return?.parent_request_index) {
      events.push({
        order: events.length,
        request_id: branch.return.parent_request_id,
        request_index: branch.return.parent_request_index,
        label: `${agentLabel} return`,
      });
    }
  }
  return events.sort((left, right) => Number(left.request_index || 0) - Number(right.request_index || 0) || left.order - right.order);
}

function agentStepEventLabel(step) {
  if (step.request_tool_results?.length) return "tool_result";
  if (step.response_tool_calls?.length) return "tool_use";
  if (step.finish_reason === "end_turn") return "done";
  return "request";
}

function renderAgentEvent(event) {
  return `
    <button class="agent-event" type="button" data-agent-jump="${escapeHtml(event.request_id || "")}">
      <strong>#${escapeHtml(event.request_index || "")}</strong>
      <span>${escapeHtml(event.label)}</span>
    </button>
  `;
}

function renderBranchEdge(label, requestId, text) {
  return `
    <button class="branch-edge" type="button" data-agent-jump="${escapeHtml(requestId || "")}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text || t("emptyNotRecorded"))}</strong>
    </button>
  `;
}

function renderAgentBranchStep(step) {
  const responseCalls = step.response_tool_calls || [];
  const requestResults = step.request_tool_results || [];
  const title = responseCalls.length ? t("requestTools", { tools: responseCalls.map((call) => call.name).join(", ") }) : step.finish_reason === "end_turn" ? t("subagentReply") : t("modelRequest");
  return `
    <button class="agent-branch-step" type="button" data-agent-jump="${escapeHtml(step.request_id)}">
      <span class="step-request">#${escapeHtml(step.request_index)}</span>
      <span class="step-body">
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml([step.response_id ? `response ${shortId(step.response_id)}` : "", step.finish_reason ? `finish ${step.finish_reason}` : ""].filter(Boolean).join(" · "))}</em>
        ${responseCalls.length ? `<small>tool_use ${escapeHtml(responseCalls.map((call) => `${call.name}${call.id ? `:${shortId(call.id)}` : ""}`).join(", "))}</small>` : ""}
        ${requestResults.length ? `<small>tool_result ${escapeHtml(requestResults.map((result) => shortId(result.id)).join(", "))}</small>` : ""}
        ${step.response_preview ? `<small>${escapeHtml(shortPreview(step.response_preview, 110))}</small>` : ""}
      </span>
    </button>
  `;
}

function branchStatusLabel(status) {
  if (status === "returned") return t("returned");
  if (status === "completed") return t("completed");
  if (status === "running") return t("running");
  return t("unknown");
}

function branchConfidenceLabel(confidence) {
  if (confidence === "high") return t("highConfidence");
  if (confidence === "medium") return t("mediumConfidence");
  if (confidence === "none") return t("noBranch");
  return confidence || t("notEvaluated");
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
    branch?.status ? t("statusTooltipLabel", { status: branchStatusLabel(branch.status) }) : "",
  ].filter(Boolean);
  const text = escapeHtml(label);
  const title = escapeHtml(titleParts.join("；") || t("subagentSourceTooltip"));
  if (branch?.id) {
    return `<button class="stat-chip subagent jumpable" type="button" data-agent-branch-jump="${escapeHtml(branch.id)}" title="${title} ${escapeHtml(t("jumpToBranchTooltip"))}">${text}</button>`;
  }
  return `<span class="stat-chip subagent" title="${title}">${text}</span>`;
}

function aggregateProviderUsage(requests) {
  return requests.reduce(
    (stats, request) => {
      const usage = request.summary?.response?.usage || {};
      const hasPromptTokens = usage.prompt_tokens != null;
      const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      const cache = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
      stats.input += input;
      stats.output += output;
      stats.cache += cache;
      stats.actual_input += Math.max(0, hasPromptTokens ? input - cache : input);
      stats.total += hasPromptTokens ? input : input + cache;
      if (hasPromptTokens) {
        stats.input_title = "OpenAI-compatible usage.prompt_tokens aggregate. cached_tokens is a subset.";
        stats.cache_title = "OpenAI-compatible usage.prompt_tokens_details.cached_tokens aggregate.";
      }
      return stats;
    },
    {
      input: 0,
      output: 0,
      cache: 0,
      actual_input: 0,
      total: 0,
      input_title: "Provider usage.input_tokens aggregate.",
      cache_title: "Provider usage.cache_read_input_tokens aggregate.",
    },
  );
}

function renderUpstreamEntry(request) {
  const expanded = state.upstreamExpanded.has(request.id);
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const entryPreview = cleanDisplayText(request.summary?.entry?.text || "");
  const showPreview = showInlineContent || Boolean(entryPreview);
  const meta = renderProviderUsageStats(request);
  return `
    <section class="upstream-entry ${escapeHtml(upstreamKindClass(request))} ${isUserTurnEntry(request) ? "user-turn" : ""} ${showInlineContent ? "" : "compact"}">
      <div class="upstream-entry-row">
        <div class="upstream-entry-title">
          <span class="request-index">#${escapeHtml(request.request_index)}</span>
          <span class="upstream-label">${escapeHtml(upstreamEntryLabel(request))}</span>
        </div>
        ${meta ? `<div class="upstream-entry-meta" aria-label="${escapeHtml(t("ownerAria"))}">${meta}</div>` : ""}
        <div class="upstream-entry-actions">
          ${renderUpstreamQuickActions(request, expanded)}
        </div>
      </div>
      ${showPreview ? `<div class="upstream-entry-preview">${escapeHtml(upstreamEntryPreview(request))}</div>` : ""}
    </section>
  `;
}

function renderUpstreamQuickActions(request, expanded) {
  const hasUpstreamToolCalls = (request.summary?.current_tool_calls || []).length > 0;
  const hasToolResults = (request.summary?.current_tool_results || []).length > 0;
  const upstreamSections = [
    ["system", "System"],
    ["tools", "Tools"],
    ...(hasUpstreamToolCalls ? [["upstream_tool_calls", "tool_use"]] : []),
    ...(hasToolResults ? [["tool_results", "tool_result"]] : []),
  ];
  return `
    <button class="inspect-button upstream-toggle-button" type="button" data-upstream-toggle="${escapeHtml(request.id)}" aria-expanded="${expanded ? "true" : "false"}">
      <span class="toggle-label">${escapeHtml(expanded ? t("collapseUpstream") : t("expandUpstream"))}</span>
    </button>
    ${upstreamSections
      .map(
        ([section, label]) => `
          <button class="raw-section-button" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}">${escapeHtml(label)}</button>
        `,
      )
      .join("")}
    <button class="raw-button compact" type="button" data-raw="${escapeHtml(request.id)}" title="${escapeHtml(t("fullCaptureTitle"))}">Raw</button>
  `;
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

function renderUpstreamBadges(request) {
  return [
    renderConfidenceBadge(request.confidence),
    request.is_subagent ? `<span class="badge subagent">${escapeHtml(t("subagentBadge"))}</span>` : "",
    request.source_hint.type === "parent_spawn" ? `<span class="badge subagent">${escapeHtml(t("parentSpawnBadge"))}</span>` : "",
    request.summary?.command_message ? `<span class="badge command" title="${escapeHtml(t("slashCommandTitle"))}">${escapeHtml(commandMessageLabel(request.summary.command_message))}</span>` : "",
    request.redaction_count ? `<span class="badge risk" title="${escapeHtml(t("redactedBadgeTitle", { count: request.redaction_count }))}">${escapeHtml(t("redactedBadge", { count: request.redaction_count }))}</span>` : "",
    ...renderChangeBadges(request),
  ]
    .filter(Boolean)
    .join("");
}

function renderUpstreamDetailMeta(request) {
  const badges = renderUpstreamBadges(request);
  if (!badges) return "";
  return `
    <section class="upstream-detail-meta">
      <p class="block-title">${escapeHtml(t("captureAndChanges"))}</p>
      <div class="upstream-detail-badges">${badges}</div>
    </section>
  `;
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
  const toolNames = request.summary.tool_names.slice(0, 18);
  const moreTools = Math.max(0, request.summary.tool_names.length - toolNames.length);
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const assistantResponse = shouldShowTimelineAssistantResponse(request) ? renderAssistantResponse(request) : "";
  const toolExchange = showInlineContent ? renderToolExchange(request) : "";
  const upstreamOpen = state.upstreamExpanded.has(request.id);
  return `
    <article class="request-card" id="${escapeHtml(request.id)}" data-card="${escapeHtml(request.id)}">
      ${options.turnInput ? renderTurnInputEntry(request, options.turnInput) : renderUpstreamEntry(request)}
      <details class="request-upstream-details request-upstream-panel" data-upstream-panel="${escapeHtml(request.id)}" ${upstreamOpen ? "open" : ""}>
        <summary class="upstream-panel-summary">${escapeHtml(t("upstreamDetails", { index: request.request_index }))}</summary>
        ${upstreamOpen ? renderUpstreamDetailsBody(request, toolNames, moreTools) : renderCollapsedUpstreamPlaceholder(request)}
      </details>
      ${toolExchange}
      ${assistantResponse}
    </article>
  `;
}

function renderUpstreamDetailsBody(request, toolNames, moreTools) {
  if (requestNeedsDetail(request)) {
    const error = requestDetailCache.errorFor(request.id);
    return `
      <div class="request-body">
        ${error ? renderRequestDetailError(error) : renderRequestDetailLoading()}
      </div>
    `;
  }
  return `
    <div class="request-body">
      <details>
        <summary class="metric-summary">
          <span>${escapeHtml(t("systemSummary", { count: request.counts.system }))}</span>
          ${renderCompositionSectionStat(request, "system")}
        </summary>
        <div class="details-body">${renderPre(request.summary.system_preview || t("noSystemSummary"))}</div>
      </details>
      <details>
        <summary class="metric-summary">
          <span>${escapeHtml(t("toolsCount", { count: request.counts.tools }))}</span>
          ${renderCompositionSectionStat(request, "tools")}
        </summary>
        <div class="details-body">
          <div class="tool-list">
            ${toolNames.map((name) => `<span class="tool-chip">${escapeHtml(name)}</span>`).join("")}
            ${moreTools ? `<span class="tool-chip">+${moreTools}</span>` : ""}
          </div>
        </div>
      </details>
      ${renderHistoryStack(request)}
      ${renderInternalRequestBlock(request)}
      ${renderCurrentMessageDelta(request)}
      ${renderContextComposition(request)}
    </div>
  `;
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
  return `
    <section class="upstream-entry ${escapeHtml(kindClass)} ${isUserTurnEntry(request) ? "user-turn" : ""}">
      <div class="upstream-entry-row">
        <div class="upstream-entry-title">
          <span class="request-index">#${escapeHtml(request.request_index)}</span>
          <span class="upstream-label">${escapeHtml(label)}</span>
        </div>
        ${meta ? `<div class="upstream-entry-meta" aria-label="${escapeHtml(t("ownerAria"))}">${meta}</div>` : ""}
        <div class="upstream-entry-actions">
          ${renderUpstreamQuickActions(request, expanded)}
        </div>
      </div>
      ${inputText ? `<div class="upstream-entry-preview">${escapeHtml(inputText)}</div>` : ""}
    </section>
  `;
}

function shouldShowTimelineAssistantResponse(request) {
  if (request.source_hint?.type === "metadata") return false;
  const response = request.summary?.response;
  if (!response?.captured) return false;
  return Boolean(response.text || response.preview || response.thinking || (response.tool_calls || []).length);
}

function renderHistoryStack(request) {
  const stack = request.summary.history_stack || [];
  const roleSummary = request.summary.roles.join(" -> ");
  return `
    <details>
      <summary class="metric-summary">
        <span>${escapeHtml(t("historyStack", { count: stack.length || request.counts.messages }))}</span>
        ${renderCompositionSectionStat(request, "history_context")}
      </summary>
      <div class="details-body">
        <div class="history-stack-meta">
          <span>roles: ${escapeHtml(roleSummary || "empty")}</span>
          <span>history=${escapeHtml(String(request.counts.history))}</span>
          <span>raw=${escapeHtml(formatBytes(request.counts.raw_body_bytes))}</span>
        </div>
        ${
          stack.length
            ? `<div class="history-stack">${stack.map(renderHistoryStackItem).join("")}</div>`
            : `<div class="empty-box">${escapeHtml(t("noHistoryMessages"))}</div>`
        }
      </div>
    </details>
  `;
}

function renderHistoryStackItem(item) {
  const toolCalls = item.tool_calls || [];
  const toolResults = item.tool_results || [];
  if (item.kind === "framework_reminder") return renderFrameworkReminderHistoryItem(item);
  const chips = [
    `<span class="history-chip role">role: ${escapeHtml(item.role || "unknown")}</span>`,
    renderHistoryContextChip(item.context_status),
    item.is_current_user ? `<span class="history-chip current">${escapeHtml(t("currentUserInput"))}</span>` : "",
    item.command_message ? `<span class="history-chip command">${escapeHtml(commandMessageLabel(item.command_message))}</span>` : "",
    ...toolCalls.map((call) => `<span class="history-chip tool">call ${escapeHtml(call.name || "unknown")}${call.id ? ` · ${escapeHtml(shortId(call.id))}` : ""}</span>`),
    ...toolResults.map((result) => `<span class="history-chip result">result${result.id ? ` · ${escapeHtml(shortId(result.id))}` : ""}</span>`),
  ].join("");
  return `
    <article class="history-stack-item ${escapeHtml(item.kind || "message")} role-${escapeHtml(item.role || "unknown")}">
      <header>
        <span class="history-index">#${escapeHtml(String(item.index || ""))}</span>
        <strong>${escapeHtml(item.label || messageKindLabel(item.kind, item.role))}</strong>
        <div class="history-chips">${chips}</div>
      </header>
      ${item.text ? `<p>${escapeHtml(item.text)}</p>` : `<p class="muted">${escapeHtml(t("noTextContent"))}</p>`}
      ${toolCalls.length ? `<div class="history-tool-detail">${toolCalls.map((call) => renderPre(`${t("argumentsLabel")} ${call.name || "unknown"}${call.id ? ` (${call.id})` : ""}\n${call.arguments_preview || "(empty)"}`)).join("")}</div>` : ""}
      ${toolResults.length ? `<div class="history-tool-detail">${toolResults.map((result) => renderPre(`${t("resultLabel")}${result.id ? ` (${result.id})` : ""}\n${result.content || "(empty)"}`)).join("")}</div>` : ""}
    </article>
  `;
}

function renderHistoryContextChip(status) {
  if (status === "reused") return `<span class="history-chip reused">${escapeHtml(t("historyReused"))}</span>`;
  if (status === "new") return `<span class="history-chip new">${escapeHtml(t("historyNew"))}</span>`;
  if (status === "baseline") return `<span class="history-chip baseline">${escapeHtml(t("baseline"))}</span>`;
  return "";
}

function renderFrameworkReminderHistoryItem(item) {
  return `
    <article class="history-stack-item framework_reminder role-${escapeHtml(item.role || "unknown")}">
      <details>
        <summary>
          <span class="history-index">#${escapeHtml(String(item.index || ""))}</span>
          <strong>${escapeHtml(item.label || t("frameworkReminder"))}</strong>
          <span class="history-chip framework">${escapeHtml(t("frameworkAutoAdded"))}</span>
          ${item.char_count ? `<span class="history-chip">${escapeHtml(formatCharCount(item.char_count))}</span>` : ""}
        </summary>
        <div class="history-framework-body">
          ${renderPre(item.full_text || item.text || "(empty)")}
        </div>
      </details>
    </article>
  `;
}

function renderContextDelta(request) {
  const delta = request.context_delta;
  if (!delta) return "";
  const fixed = delta.fixed_context || {};
  const fixedParts = [
    ["System", fixed.system],
    ["Tools", fixed.tools],
    ["Params", fixed.params],
  ];
  const roleText = formatRoleCounts(delta.new_roles || {});
  const reuseText = delta.baseline
    ? t("baselineRequestSummary", { count: delta.total_messages || request.counts.messages })
    : t("reuseSummary", { reused: delta.reused_messages || 0, total: delta.total_messages || 0, added: delta.new_messages || 0 });
  return `
    <section class="summary-block context-delta-block">
      <p class="block-title">${escapeHtml(t("contextReuse"))}</p>
      <div class="context-delta-grid">
        <span><strong>${escapeHtml(reuseText)}</strong></span>
        <span>${fixedParts.map(([label, status]) => `${label}: ${contextStatusLabel(status)}`).join(" · ")}</span>
        <span>${escapeHtml(roleText || t("noNewRoles"))}</span>
      </div>
      ${renderMessageDeltaDetails(delta)}
    </section>
  `;
}

function renderMessageDeltaDetails(delta) {
  const previews = delta.previews || [];
  if (!previews.length) return "";
  return `
    <details class="message-delta-details">
      <summary>${escapeHtml(t("newMessageDetails", { count: delta.new_messages || previews.length }))}</summary>
      <div class="message-delta-list">
        ${previews
          .map(
            (item) => `
              <article class="message-delta-item">
                <span>${escapeHtml(messageKindLabel(item.kind, item.role))}</span>
                <p>${escapeHtml(item.text || "(empty)")}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderCurrentMessageDelta(request) {
  const delta = request.context_delta || {};
  const previews = delta.previews || [];
  if (request.summary?.entry?.kind === "subagent_result") return renderSubagentResultDelta(request);
  if (!previews.length) return "";
  return `
    <section class="summary-block message-delta-block">
      <div class="block-title-row">
        <p class="block-title">${escapeHtml(t("currentRoundMessages"))}</p>
        <span class="block-title-meta">
          ${renderCompositionSectionStat(request, "current_user", t("currentUser"))}
          <span class="message-delta-count">${escapeHtml(t("itemCount", { count: delta.new_messages || previews.length }))}</span>
        </span>
      </div>
      <div class="message-delta-list">
        ${previews
          .map(
            (item) => `
              <article class="message-delta-item">
                <span>${escapeHtml(messageKindLabel(item.kind, item.role))}</span>
                <p>${escapeHtml(item.text || "(empty)")}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSubagentResultDelta(request) {
  const entry = request.summary?.entry || {};
  const subagent = entry.subagent || {};
  const fallbackText = cleanDisplayText(subagent.preview || entry.text || request.summary?.current_user || "");
  const markdownText = cleanDisplayText(subagent.result || fallbackText);
  if (!markdownText) return "";
  const name = cleanDisplayText(subagent.name || t("subagentFallback", { index: "" }).trim());
  const status = cleanDisplayText(subagent.status || "");
  return `
    <section class="summary-block message-delta-block subagent-result-event">
      <div class="block-title-row">
        <p class="block-title">${escapeHtml(t("currentResultEvent"))}</p>
        <span class="block-title-meta">
          ${name ? `<span class="message-delta-count">${escapeHtml(name)}${status ? ` · ${escapeHtml(status)}` : ""}</span>` : ""}
        </span>
      </div>
      <div class="subagent-result-markdown assistant-response-markdown" title="${escapeHtml(fallbackText || markdownText)}">
        ${renderSafeMarkdown(markdownText)}
      </div>
    </section>
  `;
}

function renderContextComposition(request) {
  const composition = request.summary?.composition;
  if (!composition?.total_payload_chars) return "";
  const usage = aggregateProviderUsage([request]);
  const actualRatio = usage.total ? usage.actual_input / usage.total : 0;
  const cacheRatio = usage.total ? usage.cache / usage.total : 0;
  const tokenStats = [
    usage.input ? ["input", formatCompactNumber(usage.input), t("providerInputTokenTitle")] : null,
    usage.cache ? ["cache", `${formatCompactNumber(usage.cache)} · ${formatPercent(cacheRatio)}`, t("cacheHitTokenTitle")] : null,
    usage.cache ? ["actual", formatPercent(actualRatio), t("nonCacheInputTitle")] : null,
    usage.output ? ["output", formatCompactNumber(usage.output), t("providerOutputTokenTitle")] : null,
  ].filter(Boolean);
  return `
    <section class="summary-block composition-block">
      <div class="block-title-row">
        <div class="composition-heading">
          <p class="block-title">${escapeHtml(t("providerTokenStats"))}</p>
          ${tokenStats.map(([label, value, title]) => renderCompositionMetric(label, value, title)).join("")}
        </div>
        <span class="composition-total">${escapeHtml(t("actualUpstream", { count: formatCharCount(composition.total_payload_chars) }))}</span>
      </div>
    </section>
  `;
}

function renderCompositionSectionStat(request, key, label) {
  const item = request.summary?.composition?.sections?.[key];
  if (!item || !item.chars) return "";
  return `
    <span class="composition-metric ${escapeHtml(compositionSectionClass(key))}">
      ${label ? `<em>${escapeHtml(label)}</em>` : ""}
      <strong>${escapeHtml(formatPercent(item.ratio))}</strong>
      <small>${escapeHtml(formatCharCount(item.chars))}</small>
    </span>
  `;
}

function compositionSectionClass(key) {
  if (key === "current_user") return "user";
  if (key === "history_context") return "history";
  if (key === "tool_result") return "tool";
  return key || "params";
}

function renderCompositionMetric(label, value, title) {
  return `
    <span class="composition-token" title="${escapeHtml(title || "")}">
      <em>${escapeHtml(label)}</em>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function formatRoleCounts(counts) {
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([role, count]) => `${messageKindLabel(role, role)} ${count}`)
    .join(" · ");
}

function contextStatusLabel(status) {
  if (status === "reused") return t("reused");
  if (status === "changed") return t("changed");
  if (status === "baseline") return t("baselineStatus");
  return t("unknown");
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

function renderInternalRequestBlock(request) {
  if (request.source_hint.type !== "metadata" || !request.summary.internal_request_preview) return "";
  return `
    <details class="internal-request">
      <summary>${escapeHtml(t("agentInternalRequest", { preview: shortPreview(request.summary.internal_request_preview, 72) }))}</summary>
      <div class="details-body">${renderPre(request.summary.internal_request_preview)}</div>
    </details>
  `;
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

function renderChangeBadges(request) {
  if (request.request_index === 1) return [`<span class="badge muted" title="${escapeHtml(t("baselineRequestTitle"))}">${escapeHtml(t("baselineRequestBadge"))}</span>`];
  const badges = [];
  if (request.changes.system_changed) {
    badges.push(
      `<button class="badge changed badge-button" type="button" data-system-diff="${escapeHtml(request.id)}" title="${escapeHtml(t("systemChangedTitle"))}">${escapeHtml(t("systemChanged"))}</button>`,
    );
  }
  if (request.changes.tools_changed) badges.push(`<span class="badge changed" title="${escapeHtml(t("toolsChangedTitle"))}">${escapeHtml(t("toolsChanged"))}</span>`);
  if (request.changes.params_changed) badges.push(`<span class="badge muted" title="${escapeHtml(t("paramsChangedTitle"))}">${escapeHtml(t("paramsChanged"))}</span>`);
  return badges;
}

function renderStructureStrip(request) {
  const currentToolCalls = request.summary.current_tool_calls?.length ?? request.counts.tool_calls;
  const currentToolResults = request.summary.current_tool_results?.length ?? request.counts.tool_results;
  const cells = [
    ["Messages", request.counts.messages, signedDelta(request.changes.messages_delta), "messages"],
    ["System", request.counts.system, request.changes.system_changed ? "changed" : "", "system"],
    ["Tools", request.counts.tools, signedDelta(request.changes.tools_delta), "tools"],
    ["Tool use", currentToolCalls, currentToolCalls === request.counts.tool_calls ? "" : t("cumulative", { count: request.counts.tool_calls }), "upstream_tool_calls"],
    ["Tool result", currentToolResults, currentToolResults === request.counts.tool_results ? "" : t("cumulative", { count: request.counts.tool_results }), "tool_results"],
    ["Raw", formatBytes(request.counts.raw_body_bytes), signedBytes(request.changes.raw_bytes_delta), "full"],
  ];
  return `
    <section class="structure-strip" aria-label="${escapeHtml(t("upstreamStructureAria"))}">
      ${cells
        .map(
          ([label, value, delta, section]) => `
            <button class="structure-cell" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}" title="${escapeHtml(t("viewRawTitle", { label }))}">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
              ${delta ? `<em>${escapeHtml(delta)}</em>` : ""}
              <small class="structure-raw-chip">Raw</small>
            </button>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderToolExchange(request) {
  const calls = request.summary.current_tool_calls || [];
  const results = request.summary.current_tool_results || [];
  if (!calls.length && !results.length) return "";
  const pairs = pairToolEvents(calls, results);
  return `
    <section class="summary-block">
      <p class="block-title">${escapeHtml(t("currentToolExchange", { calls: calls.length, results: results.length }))}</p>
      <div class="tool-exchange-list">
        ${pairs
          .map((pair) => renderToolExchangeItem(pair))
          .join("")}
      </div>
    </section>
  `;
}

function renderAssistantResponse(request) {
  const response = request.summary.response;
  if (!response?.captured) return "";
  const responseToolUseCount = response.tool_calls?.length || 0;
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
  return `
    <section class="summary-block assistant-response-block ${expanded ? "expanded" : ""}">
      <div class="block-title-row">
        <div class="response-heading">
          <p class="block-title">${escapeHtml(t("assistantReply"))}</p>
          <div class="response-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        </div>
        <div class="response-actions">
          ${
            responseToolUseCount
              ? `<button class="mini-raw-button" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="tool_calls" data-raw-mode="response">Tool use · ${escapeHtml(String(responseToolUseCount))}</button>`
              : ""
          }
          ${
            longResponse
              ? `<button class="mini-raw-button response-toggle-button" type="button" data-response-toggle="${escapeHtml(request.id)}">${escapeHtml(expanded ? t("collapse") : t("viewAll"))}</button>`
              : ""
          }
          <button class="mini-raw-button" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="response" data-raw-mode="response">Raw</button>
        </div>
      </div>
      ${renderAssistantThinking(response, request)}
      ${renderAssistantToolCalls(response.tool_calls || [])}
      ${
        visibleText
          ? `<div class="text-box assistant-response-text assistant-response-markdown ${longResponse && !expanded ? "collapsed" : ""}">${renderSafeMarkdown(visibleText)}</div>`
          : (response.tool_calls || []).length
            ? ""
            : `<div class="empty-box">${escapeHtml(t("responseNoText"))}</div>`
      }
      ${longResponse ? `<p class="response-hint">${escapeHtml(expanded ? t("responseExpandedHint") : t("responseCollapsedHint"))}</p>` : ""}
    </section>
  `;
}

function renderAssistantToolCalls(toolCalls) {
  if (!toolCalls.length) return "";
  return `
    <section class="assistant-tool-calls">
      <p class="block-title">${escapeHtml(t("assistantToolUse", { count: toolCalls.length }))}</p>
      <div class="assistant-tool-list">
        ${toolCalls.map((call) => renderPre(`tool_use ${call.name || "unknown"}${call.id ? ` (${call.id})` : ""}\n${stableJson(call.arguments ?? null)}`)).join("")}
      </div>
    </section>
  `;
}

function renderAssistantThinking(response, request) {
  const thinking = response?.thinking || "";
  if (!thinking) return "";
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
  return `
    <details class="assistant-thinking">
      <summary>
        <span>Thinking</span>
        <em>${escapeHtml(formatCharCount(thinking.length))}</em>
        <small>${escapeHtml(preview)}</small>
      </summary>
      <div class="details-body">
        <div class="thinking-translation-toolbar">
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${state.translationGenerate.loading ? "disabled" : ""}>${escapeHtml(translation ? t("retranslateThinking") : t("translateThinking"))}</button>
        </div>
        ${translation ? `<div class="thinking-translation">${renderMarkdownPreview(translation)}</div>` : ""}
        ${renderPre(thinking)}
      </div>
    </details>
  `;
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

function renderToolExchangeItem({ call, result, confidence }) {
  const title = call?.name || result?.id || "tool_result";
  const confidenceLabel = confidence === "id" ? t("pairedById") : confidence === "call_only" ? t("waitingToolResult") : t("unpairedToolResult");
  return `
    <article class="tool-exchange">
      <header>
        <span class="tool-exchange-kind">${call ? "Tool use" : "Tool result"}</span>
        <strong>${escapeHtml(title)}</strong>
        ${call?.id || result?.id ? `<code>${escapeHtml(call?.id || result?.id)}</code>` : ""}
        <em>${escapeHtml(confidenceLabel)}</em>
      </header>
      ${
        call
          ? `<div class="tool-event tool-use">
              <p>${escapeHtml(t("argumentsLabel"))}</p>
              ${renderPre(JSON.stringify(call.arguments, null, 2))}
            </div>`
          : ""
      }
      ${
        result
          ? `<div class="tool-event tool-result">
              <p>${escapeHtml(t("resultLabel"))}</p>
              ${renderPre(result.content || "(empty)")}
            </div>`
          : `<div class="tool-event empty-tool-result">${escapeHtml(t("noMatchedToolResult"))}</div>`
      }
    </article>
  `;
}

function renderRawSectionNav(request, activeSection) {
  const hasUpstreamToolUse = (request.summary?.current_tool_calls || []).length > 0;
  const hasUpstreamToolResult = (request.summary?.current_tool_results || []).length > 0;
  const sections = [
    ["full", t("rawFull")],
    ["system", "System"],
    ...(previousRequest(request) ? [["system_diff", "System diff"]] : []),
    ["tools", "Tools"],
    ["harness", "Harness"],
    ["messages", "Messages"],
    ...(hasUpstreamToolUse ? [["upstream_tool_calls", "tool_use"]] : []),
    ...(hasUpstreamToolResult ? [["tool_results", "tool_result"]] : []),
    ["metadata", "Metadata"],
  ];
  return `
    <div class="raw-section-nav request-sections">
      ${sections
        .map(
          ([section, label]) => `
            <button class="${section === activeSection ? "active" : ""}" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}">
              ${escapeHtml(label)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderRawSectionNavGroup(label, sections, request, activeSection, mode = "request") {
  if (!sections.length) return "";
  return `
    <div class="raw-section-nav-group">
      <span class="raw-section-nav-label">${escapeHtml(label)}</span>
      ${sections
        .map(
          ([section, sectionLabel]) => `
            <button class="${section === activeSection ? "active" : ""}" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}" ${mode === "response" ? 'data-raw-mode="response"' : ""}>
              ${escapeHtml(sectionLabel)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function rawSectionData(request, section) {
  return buildRawSectionData(request, section, {
    translate: t,
    harnessMaterials: section === "harness" ? collectHarnessTranslationMaterials(request) : [],
  });
}

function renderRawDetail(title, value) {
  return `
    <details open>
      <summary>${escapeHtml(title)}</summary>
      <div class="json-node">${renderJson(value)}</div>
    </details>
  `;
}

function renderPre(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function bindRequestEvents() {
  document.querySelectorAll("[data-latest-only]").forEach((button) => {
    button.addEventListener("click", toggleLatestOnly);
  });
  document.querySelectorAll("[data-response-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleResponseExpansion(button.dataset.responseToggle);
    });
  });
  document.querySelectorAll("[data-upstream-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleUpstreamDetails(button.dataset.upstreamToggle);
    });
  });
  document.querySelectorAll("[data-upstream-panel]").forEach((panel) => {
    panel.addEventListener("toggle", () => syncUpstreamDetailsState(panel));
  });
  document.querySelectorAll("[data-turn-window-jump]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      jumpToTurn(button.dataset.turnWindowJump, true);
    });
  });
  document.querySelectorAll("[data-raw]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showRaw(button.dataset.raw, button.dataset.rawSection || "full", { mode: button.dataset.rawMode || "request" });
    });
  });
  document.querySelectorAll("[data-agent-jump]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      jumpToRequest(button.dataset.agentJump);
    });
  });
  document.querySelectorAll("[data-agent-branch-jump]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      jumpToAgentBranch(button.dataset.agentBranchJump);
    });
  });
  document.querySelectorAll("[data-agent-branch-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleAgentBranch(button.dataset.agentBranchToggle);
    });
  });
  document.querySelectorAll("[data-supporting-timeline-toggle]").forEach((summary) => {
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      const turnId = summary.dataset.supportingTimelineToggle;
      if (state.openSupportingTimelines.has(turnId)) state.openSupportingTimelines.delete(turnId);
      else state.openSupportingTimelines.add(turnId);
      renderAll();
    });
  });
  // Control the multi-agent dashboard open state ourselves (persist across
  // renderAll) so toggling an inner branch card no longer snaps the whole panel
  // shut.
  document.querySelectorAll("[data-agent-dashboard-toggle]").forEach((summary) => {
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      const turnId = summary.dataset.agentDashboardToggle;
      if (state.openAgentDashboards.has(turnId)) state.openAgentDashboards.delete(turnId);
      else state.openAgentDashboards.add(turnId);
      renderAll();
    });
  });
  document.querySelectorAll("[data-agent-branch-more]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const turnId = button.dataset.agentBranchMore;
      const current = state.agentBranchLimits.get(turnId) || AGENT_BRANCH_PAGE_SIZE;
      state.agentBranchLimits.set(turnId, current + AGENT_BRANCH_PAGE_SIZE);
      renderAll();
    });
  });
  document.querySelectorAll("[data-agent-status-filter]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const turnId = button.dataset.agentStatusFilter;
      const filter = button.dataset.agentFilterValue || "all";
      state.agentBranchFilters.set(turnId, filter);
      state.agentBranchLimits.set(turnId, AGENT_BRANCH_PAGE_SIZE);
      renderAll();
    });
  });
  document.querySelectorAll("[data-system-diff]").forEach((button) => {
    button.addEventListener("click", () => showSystemDiff(button.dataset.systemDiff));
  });
}

function jumpToTurn(turnId, scroll = true) {
  if (!turnId) return;
  state.activeId = turnId;
  renderAll();
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
    state.activeId = turn.id;
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
  renderAll();
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
  renderAll();
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
  renderAll();
  const panel = document.querySelector(`[data-upstream-panel="${cssEscape(requestId)}"]`);
  if (nextOpen) {
    const internalWrapper = panel?.closest(".turn-internal-request");
    if (internalWrapper) internalWrapper.open = true;
    panel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ensureRequestDetailLoaded(requestId)
      .then(() => {
        if (state.upstreamExpanded.has(requestId)) renderAll();
      })
      .catch(() => {
        if (state.upstreamExpanded.has(requestId)) renderAll();
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
  renderAll();
  if (open) {
    ensureRequestDetailLoaded(requestId)
      .then(() => {
        if (state.upstreamExpanded.has(requestId)) renderAll();
      })
      .catch(() => {
        if (state.upstreamExpanded.has(requestId)) renderAll();
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
  state.latestOnly = !state.latestOnly;
  localStorage.setItem(LATEST_ONLY_KEY, String(state.latestOnly));
  renderAll();
  if (state.latestOnly) {
    const latestTurn = visibleTurnList(state.data?.turns, state.data?.requests || [])[0];
    if (latestTurn?.id) markActiveTurn(latestTurn.id, true);
  } else if (state.activeId) {
    markActiveTurn(state.activeId, false);
  }
}

function toggleResponseExpansion(requestId) {
  if (!requestId) return;
  if (state.responseExpanded.has(requestId)) state.responseExpanded.delete(requestId);
  else state.responseExpanded.add(requestId);
  renderAll();
  document.getElementById(requestId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function markActiveTurn(id, scroll) {
  state.activeId = id;
  renderTurnRail();
  document.querySelectorAll("[data-turn]").forEach((button) => button.classList.toggle("active", button.dataset.turn === id));
  document.querySelectorAll("[data-turn-group]").forEach((group) => group.classList.toggle("active", group.dataset.turnGroup === id));
  const target = document.getElementById(id);
  if (scroll) target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function markActiveRequest(id, scroll) {
  state.activeRequestId = id;
  document.querySelectorAll("[data-card]").forEach((card) => card.classList.toggle("active", card.dataset.card === id));
  const target = document.getElementById(id);
  if (scroll) target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setRawPanelOpen(open) {
  state.rawOpen = open;
  if (open) {
    if (state.rawWidth) applyRawPanelWidth(state.rawWidth);
    else els.appShell.style.removeProperty("--raw-width");
  } else {
    els.appShell.style.setProperty("--raw-width", "0px");
  }
  els.appShell.classList.toggle("raw-collapsed", !open);
  els.rawToggle.classList.toggle("active", open);
  els.rawToggle.title = open ? t("toggleRawTitle") : t("expandRawTitle");
  els.rawToggle.setAttribute("aria-pressed", String(open));
  localStorage.setItem("peekmyagent.rawOpen", String(open));
  scheduleActiveSync();
}

function bindRawResizer() {
  if (!els.rawResizer) return;
  els.rawResizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setRawPanelOpen(true);
    els.appShell.classList.add("resizing-raw");
    els.rawResizer.setPointerCapture(event.pointerId);
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  els.rawResizer.addEventListener("mousedown", (event) => {
    if (els.appShell.classList.contains("resizing-raw")) return;
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setRawPanelOpen(true);
    els.appShell.classList.add("resizing-raw");
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  els.rawResizer.addEventListener("pointermove", (event) => {
    if (!els.appShell.classList.contains("resizing-raw")) return;
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  document.addEventListener("mousemove", (event) => {
    if (!els.appShell.classList.contains("resizing-raw")) return;
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  els.rawResizer.addEventListener("pointerup", (event) => finishRawResize(event));
  els.rawResizer.addEventListener("pointercancel", (event) => finishRawResize(event));
  document.addEventListener("mouseup", (event) => finishRawResize(event));
  els.rawResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setRawPanelOpen(true);
    const step = event.shiftKey ? 80 : 24;
    const direction = event.key === "ArrowLeft" ? 1 : -1;
    setRawPanelWidth((state.rawWidth || currentRawPanelWidth()) + direction * step);
  });
}

function finishRawResize(event) {
  if (!els.appShell.classList.contains("resizing-raw")) return;
  els.appShell.classList.remove("resizing-raw");
  try {
    els.rawResizer.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture can already be released by the browser on cancel.
  }
  if (state.rawWidth) localStorage.setItem(RAW_WIDTH_KEY, String(state.rawWidth));
  scheduleActiveSync();
}

function updateRawPanelWidthFromPointer(clientX, { persist = true } = {}) {
  const shellRect = els.appShell.getBoundingClientRect();
  const width = shellRect.right - clientX;
  setRawPanelWidth(width, { persist });
}

function setRawPanelWidth(width, { persist = true } = {}) {
  const nextWidth = clampRawPanelWidth(width);
  state.rawWidth = nextWidth;
  applyRawPanelWidth(nextWidth);
  if (persist) localStorage.setItem(RAW_WIDTH_KEY, String(nextWidth));
  scheduleActiveSync();
}

function applyRawPanelWidth(width) {
  els.appShell.style.setProperty("--raw-width", `${Math.round(width)}px`);
  els.rawResizer?.setAttribute("aria-valuenow", String(Math.round(width)));
  els.rawResizer?.setAttribute("aria-valuemin", String(RAW_WIDTH_MIN));
  els.rawResizer?.setAttribute("aria-valuemax", String(Math.round(maxRawPanelWidth())));
}

function readRawPanelWidth() {
  const stored = Number(localStorage.getItem(RAW_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampRawPanelWidth(stored) : 0;
}

function currentRawPanelWidth() {
  return els.rawPanel.getBoundingClientRect().width || Math.min(Math.max(window.innerWidth * 0.34, 380), 560);
}

function clampRawPanelWidth(width) {
  return Math.round(Math.min(Math.max(Number(width) || RAW_WIDTH_MIN, RAW_WIDTH_MIN), maxRawPanelWidth()));
}

function maxRawPanelWidth() {
  const shellWidth = els.appShell.getBoundingClientRect().width || window.innerWidth;
  const sidebarWidth = state.sidebarOpen ? state.sidebarWidth || currentSidebarWidth() : 0;
  const sidebarResizerWidth = state.sidebarOpen ? RESIZER_WIDTH : 0;
  const roomForRaw = shellWidth - sidebarWidth - sidebarResizerWidth - MAIN_PANEL_MIN - RESIZER_WIDTH;
  return Math.max(RAW_WIDTH_MIN, Math.min(RAW_WIDTH_MAX, roomForRaw));
}

function setSidebarOpen(open) {
  const rawShare = rawPanelContentShare();
  state.sidebarOpen = open;
  if (open) {
    if (state.sidebarWidth) applySidebarWidth(state.sidebarWidth);
    else els.appShell.style.removeProperty("--sidebar-width");
  } else {
    els.appShell.style.setProperty("--sidebar-width", "0px");
  }
  els.appShell.classList.toggle("sidebar-collapsed", !open);
  els.toggleSidebar.title = open ? t("toggleSidebarTitle") : t("expandSidebarTitle");
  els.toggleSidebar.classList.toggle("active", open);
  els.toggleSidebar.setAttribute("aria-pressed", String(open));
  localStorage.setItem("peekmyagent.sidebarOpen", String(open));
  if (state.rawOpen && state.rawWidth) setRawPanelWidthFromContentShare(rawShare, { persist: false });
  scheduleActiveSync();
}

function rawPanelContentShare() {
  if (!state.rawOpen) return 0;
  const contentWidth = currentContentWidth();
  if (!contentWidth) return 0;
  return currentRawPanelWidth() / contentWidth;
}

function setRawPanelWidthFromContentShare(share, { persist = true } = {}) {
  if (!share) {
    setRawPanelWidth(state.rawWidth || currentRawPanelWidth(), { persist });
    return;
  }
  setRawPanelWidth(currentContentWidth() * share, { persist });
}

function currentContentWidth() {
  const shellWidth = els.appShell.getBoundingClientRect().width || window.innerWidth;
  const sidebarWidth = state.sidebarOpen ? state.sidebarWidth || currentSidebarWidth() : 0;
  const sidebarResizerWidth = state.sidebarOpen ? RESIZER_WIDTH : 0;
  const rawResizerWidth = state.rawOpen ? RESIZER_WIDTH : 0;
  return Math.max(0, shellWidth - sidebarWidth - sidebarResizerWidth - rawResizerWidth);
}

function bindSidebarResizer() {
  if (!els.sidebarResizer) return;
  els.sidebarResizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setSidebarOpen(true);
    els.appShell.classList.add("resizing-sidebar");
    els.sidebarResizer.setPointerCapture(event.pointerId);
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  els.sidebarResizer.addEventListener("mousedown", (event) => {
    if (els.appShell.classList.contains("resizing-sidebar")) return;
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setSidebarOpen(true);
    els.appShell.classList.add("resizing-sidebar");
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  els.sidebarResizer.addEventListener("pointermove", (event) => {
    if (!els.appShell.classList.contains("resizing-sidebar")) return;
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  document.addEventListener("mousemove", (event) => {
    if (!els.appShell.classList.contains("resizing-sidebar")) return;
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  els.sidebarResizer.addEventListener("pointerup", (event) => finishSidebarResize(event));
  els.sidebarResizer.addEventListener("pointercancel", (event) => finishSidebarResize(event));
  document.addEventListener("mouseup", (event) => finishSidebarResize(event));
  els.sidebarResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarOpen(true);
    const step = event.shiftKey ? 80 : 24;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setSidebarWidth((state.sidebarWidth || currentSidebarWidth()) + direction * step);
  });
}

function finishSidebarResize(event) {
  if (!els.appShell.classList.contains("resizing-sidebar")) return;
  els.appShell.classList.remove("resizing-sidebar");
  try {
    els.sidebarResizer.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture can already be released by the browser on cancel.
  }
  if (state.sidebarWidth) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(state.sidebarWidth));
  scheduleActiveSync();
}

function updateSidebarWidthFromPointer(clientX, { persist = true } = {}) {
  const shellRect = els.appShell.getBoundingClientRect();
  const width = clientX - shellRect.left;
  setSidebarWidth(width, { persist });
}

function setSidebarWidth(width, { persist = true } = {}) {
  const nextWidth = clampSidebarWidth(width);
  state.sidebarWidth = nextWidth;
  applySidebarWidth(nextWidth);
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
  if (state.rawOpen && state.rawWidth) setRawPanelWidth(state.rawWidth, { persist: false });
  scheduleActiveSync();
}

function applySidebarWidth(width) {
  els.appShell.style.setProperty("--sidebar-width", `${Math.round(width)}px`);
  els.sidebarResizer?.setAttribute("aria-valuenow", String(Math.round(width)));
  els.sidebarResizer?.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  els.sidebarResizer?.setAttribute("aria-valuemax", String(Math.round(maxSidebarWidth())));
}

function readSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : 0;
}

function currentSidebarWidth() {
  return Number.parseFloat(getComputedStyle(els.appShell).getPropertyValue("--sidebar-width")) || SIDEBAR_WIDTH_MIN;
}

function clampSidebarWidth(width) {
  return Math.round(Math.min(Math.max(Number(width) || SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MIN), maxSidebarWidth()));
}

function maxSidebarWidth() {
  const shellWidth = els.appShell.getBoundingClientRect().width || window.innerWidth;
  const rawWidth = state.rawOpen ? state.rawWidth || currentRawPanelWidth() : 0;
  const rawResizerWidth = state.rawOpen ? RESIZER_WIDTH : 0;
  const roomForSidebar = shellWidth - rawWidth - rawResizerWidth - MAIN_PANEL_MIN - RESIZER_WIDTH;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, roomForSidebar));
}

function scheduleActiveSync() {
  turnRailController.scheduleActiveSync();
}

async function showRaw(id, section = "full", { mode = "request" } = {}) {
  const request = state.data.requests.find((item) => item.id === id);
  if (!request) return;
  const contextChanged = state.activeRequestId !== id || state.activeRawSection !== section || state.activeRawMode !== mode;
  if (contextChanged) {
    state.rawSearchActiveIndex = 0;
    state.rawSearchRevealPending = Boolean(normalizedRawSearchQuery());
  }
  clearTranslationActions("raw");
  markActiveRequest(id, false);
  state.activeRawSection = section;
  state.activeRawMode = mode;
  setRawPanelOpen(true);
  els.rawTitle.textContent = `Request ${request.request_index} · ${mode === "response" ? responseRawSectionLabel(section) : rawSectionLabel(section)}`;
  els.rawTree.className = "raw-tree";
  if (requestNeedsDetail(request)) {
    els.rawTree.innerHTML = renderRequestDetailLoading();
  }
  try {
    const hydrated = await ensureDetailsForRawSection(request, section);
    if (state.activeRequestId !== id || state.activeRawSection !== section || state.activeRawMode !== mode) return;
    els.rawTree.innerHTML = renderRawSections(hydrated, section, mode);
    decorateRawSearchResults();
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
  return `<div class="empty-box">${escapeHtml(t("requestDetailLoading"))}</div>`;
}

function renderRequestDetailError(error) {
  return `<div class="empty-box error">${escapeHtml(t("requestDetailLoadFailed", { message: error?.message || String(error || "unknown") }))}</div>`;
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
  const navigation = mode === "response" ? renderResponseOnlyRawNav(request, section) : renderRawSectionNav(request, section);
  return `
    <div class="raw-sticky-controls">
      ${navigation}
      ${renderRawSearchControls(request, section, mode)}
      ${renderTranslationControls(request, section)}
    </div>
  `;
}

function renderResponseOnlyRawNav(request, activeSection) {
  const downstreamSections = [
    ["response", "Response"],
    ["tool_calls", "tool_use"],
  ];
  return `
    <div class="raw-section-nav">
      ${renderRawSectionNavGroup(t("rawNavDownstream"), downstreamSections, request, activeSection, "response")}
      ${renderRawSectionNavGroup(t("rawNavReference"), [["tools", "Tools schema"]], request, activeSection, "response")}
    </div>
  `;
}

function renderResponseOnlyToolsSchemaSection(request) {
  const sectionData = rawSectionData(request, "tools");
  return `
    <div class="raw-source-notice">
      <strong>${escapeHtml(t("responseOnlyToolsNoticeTitle"))}</strong>
      <span>${escapeHtml(t("responseOnlyToolsNotice"))}</span>
    </div>
    ${renderRawSectionContent(request, "tools", sectionData)}
  `;
}

function renderRawSearchControls(request, section, mode = "request") {
  const query = state.rawSearchQuery || "";
  const scope = rawSearchScopeLabel(section, mode);
  const matches = normalizedRawSearchQuery() ? rawSearchMatchCount(request, section, mode) : 0;
  return `
    <div class="raw-search-bar">
      <label class="raw-search-input-wrap">
        <span>${escapeHtml(t("rawSearchScope", { section: scope }))}</span>
        <input
          type="search"
          value="${escapeHtml(query)}"
          placeholder="${escapeHtml(t("rawSearchPlaceholder", { section: scope }))}"
          aria-label="${escapeHtml(t("rawSearchAria"))}"
          data-raw-search="true"
        />
      </label>
      ${
        query
          ? `<span class="raw-search-count" data-raw-search-position title="${escapeHtml(t("rawSearchResultCount", { count: matches }))}">${escapeHtml(matches ? `${Math.min(state.rawSearchActiveIndex + 1, matches)}/${matches}` : "0/0")}</span>
             <span class="raw-search-navigation" role="group" aria-label="${escapeHtml(t("rawSearchResultCount", { count: matches }))}">
               <button type="button" data-raw-search-nav="previous" title="${escapeHtml(t("rawSearchPrevious"))}" aria-label="${escapeHtml(t("rawSearchPrevious"))}" ${matches ? "" : "disabled"}>↑</button>
               <button type="button" data-raw-search-nav="next" title="${escapeHtml(t("rawSearchNext"))}" aria-label="${escapeHtml(t("rawSearchNext"))}" ${matches ? "" : "disabled"}>↓</button>
             </span>
             <button type="button" class="raw-search-clear" data-raw-search-clear="true">${escapeHtml(t("rawSearchClear"))}</button>`
          : ""
      }
    </div>
  `;
}

function rawSearchMatchCount(request, section, mode = "request") {
  if (usesTranslatedStructuredSearch(section, mode)) {
    if (section === "tools") return matchingToolTranslationGroups(request).length;
    return matchingTranslationMaterials(request, section).length;
  }
  return rawSearchEntriesForSection(request, section, mode).length;
}

function decorateRawSearchResults() {
  const query = normalizedRawSearchQuery();
  if (!query) return;
  const targets = [...els.rawTree.querySelectorAll("[data-raw-search-target]")];
  targets.forEach((target) => highlightRawSearchText(target, query));
  const matches = visibleRawSearchMarks();
  state.rawSearchActiveIndex = clampRawSearchIndex(state.rawSearchActiveIndex, matches.length);
  syncRawSearchActiveMatch(matches, state.rawSearchRevealPending);
  state.rawSearchRevealPending = false;
}

function highlightRawSearchText(root, query) {
  const matcher = new RegExp(escapeRawSearchRegExp(query), "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue || !matcher.test(node.nodeValue)) {
        matcher.lastIndex = 0;
        return NodeFilter.FILTER_REJECT;
      }
      matcher.lastIndex = 0;
      if (parent.closest("button, input, textarea, script, style, mark, details:not([open]), .raw-sticky-controls")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const text = node.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of text.matchAll(new RegExp(escapeRawSearchRegExp(query), "gi"))) {
      const index = match.index || 0;
      if (index > cursor) fragment.append(document.createTextNode(text.slice(cursor, index)));
      const mark = document.createElement("mark");
      mark.className = "raw-search-highlight";
      mark.textContent = match[0];
      fragment.append(mark);
      cursor = index + match[0].length;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

function navigateRawSearch(delta) {
  const matches = visibleRawSearchMarks();
  if (!matches.length) return;
  state.rawSearchActiveIndex = nextRawSearchIndex(state.rawSearchActiveIndex, delta, matches.length);
  syncRawSearchActiveMatch(matches, true);
}

function visibleRawSearchMarks() {
  const matches = [...els.rawTree.querySelectorAll("mark")].filter((mark) => mark.getClientRects().length > 0);
  matches.forEach((mark) => mark.classList.add("raw-search-highlight"));
  return matches;
}

function syncRawSearchActiveMatch(matches, scroll) {
  els.rawTree.querySelectorAll(".raw-search-highlight-active").forEach((mark) => mark.classList.remove("raw-search-highlight-active"));
  els.rawTree.querySelectorAll(".raw-search-target-active").forEach((target) => target.classList.remove("raw-search-target-active"));
  const active = matches[state.rawSearchActiveIndex];
  active?.classList.add("raw-search-highlight-active");
  active?.closest("[data-raw-search-target]")?.classList.add("raw-search-target-active");
  const position = els.rawTree.querySelector("[data-raw-search-position]");
  if (position) {
    position.textContent = matches.length ? `${state.rawSearchActiveIndex + 1}/${matches.length}` : "0/0";
    position.title = t("rawSearchResultCount", { count: matches.length });
  }
  const navigation = els.rawTree.querySelector(".raw-search-navigation");
  if (navigation) navigation.setAttribute("aria-label", t("rawSearchResultCount", { count: matches.length }));
  els.rawTree.querySelectorAll("[data-raw-search-nav]").forEach((button) => {
    button.disabled = !matches.length;
  });
  if (scroll && active) active.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
}

function renderRawSearchResults(request, section, mode = "request") {
  const query = normalizedRawSearchQuery();
  const scope = rawSearchScopeLabel(section, mode);
  const entries = rawSearchEntriesForSection(request, section, mode);
  if (!query) return "";
  if (!entries.length) {
    return `<div class="empty-box">${escapeHtml(t("rawSearchNoResults", { section: scope, query }))}</div>`;
  }
  return `
    <section class="raw-search-results">
      ${entries
        .slice(0, 120)
        .map(
          (entry) => `
            <article class="raw-search-result" data-raw-search-target="true">
              <header>
                <strong>${escapeHtml(entry.path || scope)}</strong>
                <span>${escapeHtml(t("rawSearchMatchedIn", { scope: entry.scope || scope }))}</span>
              </header>
              <p>${highlightSearchSnippet(entry.text, query)}</p>
              ${entry.value !== entry.text ? `<details><summary>${escapeHtml(t("rawSearchValue"))}</summary>${renderPre(entry.value)}</details>` : ""}
            </article>
          `,
        )
        .join("")}
    </section>
  `;
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
  return normalizeRawSearchQuery(state.rawSearchQuery);
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
    if (section === "system") return renderTranslatedSystemSection(request);
    if (section === "tools") return renderTranslatedToolsSection(request);
    if (section === "harness") return renderTranslatedHarnessSection(request);
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

function translationMaterialMatchesQuery(item, extraText = "") {
  const query = normalizedRawSearchQuery().toLowerCase();
  if (!query) return true;
  const translated = translatedTextFor(item.kind, item.source_text);
  const metadata = item.metadata || {};
  const displayedText = translated || item.source_text;
  return [extraText, metadata.tool_name, metadata.field_name, metadata.label, displayedText]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(query);
}

function matchingTranslationMaterials(request, section) {
  return sectionTranslationMaterials(request, section).filter((item) => translationMaterialMatchesQuery(item));
}

function matchingToolTranslationGroups(request) {
  const groups = groupToolTranslationMaterials(collectToolTranslationMaterials(request));
  const query = normalizedRawSearchQuery();
  if (!query) return groups;
  const lowerQuery = query.toLowerCase();
  return groups
    .map((group, index) => {
      const lowerName = group.toolName.toLowerCase();
      const nameMatch = lowerName.includes(lowerQuery);
      const contentMatch = [group.description, ...group.parameters].filter(Boolean).some((item) => translationMaterialMatchesQuery(item, group.toolName));
      const rank = lowerName === lowerQuery ? 0 : nameMatch ? 1 : 2;
      return { group, index, rank, matches: nameMatch || contentMatch };
    })
    .filter((entry) => entry.matches)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.group);
}

function renderMessagesControls(section) {
  if (section !== "messages") return "";
  const mode = normalizeMessagesMode(state.rawMessagesMode);
  return `
    <div class="translation-toolbar compact">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(t("messagesViewAria"))}">
        <button type="button" class="${mode === "organized" ? "active" : ""}" data-messages-mode="organized">${escapeHtml(t("messagesOrganized"))}</button>
        <button type="button" class="${mode === "source" ? "active" : ""}" data-messages-mode="source">${escapeHtml(t("messagesOriginal"))}</button>
      </div>
    </div>
  `;
}

function renderMessagesSection(messagesValue) {
  const messages = Array.isArray(messagesValue) ? messagesValue : [];
  if (state.rawMessagesMode === "source") return renderRawDetail("messages / history", messages);
  if (!messages.length) return `<div class="empty-box">${escapeHtml(t("messagesEmpty"))}</div>`;
  return `
    <section class="raw-message-list">
      ${messages.map((message, index) => renderOrganizedMessage(message, index)).join("")}
    </section>
  `;
}

function renderOrganizedMessage(message, index) {
  const role = typeof message === "object" && message ? message.role || "unknown" : "unknown";
  const blocks = normalizeMessageBlocks(message);
  return `
    <article class="raw-message-card role-${escapeHtml(safeClassName(role))}">
      <header class="raw-message-card-header">
        <strong>#${escapeHtml(String(index))} ${escapeHtml(String(role))}</strong>
        <span>${escapeHtml(t("messageRole"))}: ${escapeHtml(String(role))}</span>
      </header>
      <div class="raw-message-blocks">
        ${blocks.map((block, blockIndex) => renderOrganizedMessageBlock(block, blockIndex)).join("")}
      </div>
    </article>
  `;
}

function normalizeMessageBlocks(message) {
  if (message == null) return [{ type: "empty", text: "", raw: message }];
  if (typeof message !== "object") return [{ type: "text", text: String(message), raw: message }];
  const content = message.content;
  if (Array.isArray(content)) {
    return content.length ? content.map((block) => normalizeMessageBlock(block)) : [{ type: "empty", text: "", raw: content }];
  }
  if (typeof content === "string") return [{ type: "text", text: content, raw: content }];
  if (content != null) return [normalizeMessageBlock(content)];
  return [normalizeMessageBlock(message)];
}

function normalizeMessageBlock(block) {
  if (block == null) return { type: "empty", text: "", raw: block };
  if (typeof block !== "object") return { type: "text", text: String(block), raw: block };
  const type = String(block.type || "object");
  const text = messageBlockText(block);
  return { type, text, raw: block };
}

function messageBlockText(block) {
  if (!block || typeof block !== "object") return String(block ?? "");
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.input === "string") return block.input;
  if (typeof block.name === "string" && block.type === "tool_use") return `${block.name}${block.id ? ` (${block.id})` : ""}`;
  return "";
}

function renderOrganizedMessageBlock(block, index) {
  const type = block.type || "unknown";
  const text = block.text || "";
  const isText = type === "text" || (text && !hasStructuredMessagePayload(block.raw));
  const markdownText = truncateOrganizedMessageText(text);
  return `
    <section class="raw-message-block ${escapeHtml(isText ? "text" : "structured")}">
      <header>
        <span>${escapeHtml(t("messageType"))}: ${escapeHtml(String(type))}</span>
        <em>#${escapeHtml(String(index))}</em>
      </header>
      ${
        text
          ? `<div class="raw-message-markdown">${renderSafeMarkdown(markdownText.text)}</div>
             ${
               markdownText.truncated
                 ? `<p class="raw-message-truncation">${escapeHtml(t("messageTextTruncated", { shown: formatCompactNumber(markdownText.text.length), total: formatCompactNumber(text.length) }))}</p>`
                 : ""
             }`
          : `<p class="raw-message-empty">${escapeHtml(t("messageTextFallback"))}</p>`
      }
      ${
        isText
          ? ""
          : `<details class="raw-message-raw"><summary>${escapeHtml(t("messageRawDetails"))}</summary><div class="json-node">${renderJson(block.raw)}</div></details>`
      }
    </section>
  `;
}

function truncateOrganizedMessageText(text) {
  const value = String(text || "");
  if (value.length <= RAW_MESSAGE_MARKDOWN_INLINE_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, RAW_MESSAGE_MARKDOWN_INLINE_CHARS).trimEnd()}\n\n...`,
    truncated: true,
  };
}

function hasStructuredMessagePayload(value) {
  return value && typeof value === "object" && Object.keys(value).some((key) => !["type", "text", "content"].includes(key));
}

function safeClassName(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function renderTranslationControls(request, section) {
  if (!["system", "tools", "harness"].includes(section)) return "";
  const stats = translationSectionStats(request, section);
  const cache = state.translations;
  const available = Boolean(cache?.available);
  const generating = Boolean(state.translationGenerate.loading);
  const generateMessage = state.translationGenerate.error || state.translationGenerate.message || "";
  const targetLanguage = currentTargetLanguage();
  const languageLabel = currentTargetLanguageLabel();
  const statusText = available
    ? t("translationCacheHit", { hit: stats.hit, total: stats.total, language: cache.target_language || languageLabel })
    : t("translationCacheMissing", { language: languageLabel });
  return `
    <div class="translation-toolbar">
      <div class="translation-segmented" role="group" aria-label="${escapeHtml(t("translationModeAria"))}">
        <button type="button" class="${state.translationMode === "source" ? "active" : ""}" data-translation-mode="source" data-translation-section="${escapeHtml(section)}">${escapeHtml(t("source"))}</button>
        <button type="button" class="${state.translationMode === targetLanguage ? "active" : ""}" data-translation-mode="${escapeHtml(targetLanguage)}" data-translation-section="${escapeHtml(section)}">${escapeHtml(languageLabel)}</button>
      </div>
      <div class="translation-toolbar-actions">
        <span class="translation-status ${state.translationGenerate.error ? "error" : stats.missing ? "partial" : "ready"}">${escapeHtml(generateMessage || statusText)}</span>
        <button type="button" class="translation-generate-button" data-translation-copy-all="${escapeHtml(section)}" ${stats.total ? "" : "disabled"} title="${escapeHtml(t("copyAllTitle", { section: rawSectionLabel(section) }))}">${escapeHtml(t("copyAll"))}</button>
        <button type="button" class="translation-generate-button" data-translation-generate="true" data-translation-section="${escapeHtml(section)}" ${generating ? "disabled" : ""} title="${escapeHtml(t("refreshSectionTitle", { section: rawSectionLabel(section) }))}">${escapeHtml(generating ? t("updating") : t("updateCurrentSection"))}</button>
      </div>
    </div>
  `;
}

function renderTranslatedSystemSection(request) {
  const materials = normalizedRawSearchQuery() ? matchingTranslationMaterials(request, "system") : collectSystemTranslationMaterials(request);
  if (!materials.length) return renderStructuredTranslationEmpty("system", t("noSystemPrompt"));
  return `
    <section class="translation-list">
      ${materials
        .map((item, index) =>
          renderTranslationBlock({
            label: `${item.metadata.source || "system"} #${Number.isInteger(item.metadata?.index) ? item.metadata.index + 1 : index + 1}`,
            kind: item.kind,
            sourceText: item.source_text,
            searchTarget: Boolean(normalizedRawSearchQuery()),
          }),
        )
        .join("")}
    </section>
  `;
}

function renderTranslatedToolsSection(request) {
  const materials = collectToolTranslationMaterials(request);
  if (!materials.length) return `<div class="empty-box">${escapeHtml(t("noToolDescriptions"))}</div>`;
  const groups = normalizedRawSearchQuery() ? matchingToolTranslationGroups(request) : groupToolTranslationMaterials(materials);
  if (!groups.length) return renderStructuredTranslationEmpty("tools", t("noToolDescriptions"));
  return `
    <section class="tool-translation-list">
      ${groups.map(renderToolTranslationGroup).join("")}
    </section>
  `;
}

function groupToolTranslationMaterials(materials) {
  const groups = new Map();
  for (const item of materials) {
    const toolName = item.metadata?.tool_name || "unknown";
    if (!groups.has(toolName)) groups.set(toolName, { toolName, description: null, parameters: [] });
    const group = groups.get(toolName);
    if (item.kind === "tool_description" && !group.description) group.description = item;
    else group.parameters.push(item);
  }
  return [...groups.values()];
}

function renderToolTranslationGroup(group) {
  return `
    <section class="tool-translation-group" ${normalizedRawSearchQuery() ? 'data-raw-search-target="true"' : ""}>
      <header class="tool-translation-group-header">
        <strong>${escapeHtml(group.toolName)}</strong>
        <span>${escapeHtml(group.description ? t("toolDescriptionCount") : t("noToolDescription"))} · ${escapeHtml(t("parameterCount", { count: group.parameters.length }))}</span>
      </header>
      ${group.description ? renderTranslationBlock({ label: `${group.toolName} · description`, kind: group.description.kind, sourceText: group.description.source_text }) : ""}
      ${
        group.parameters.length
          ? renderToolParameterSummaryBlock(group.parameters)
          : ""
      }
    </section>
  `;
}

function renderToolParameterSummaryBlock(parameters) {
  const hits = parameters.filter((item) => translatedTextFor(item.kind, item.source_text)).length;
  const actionId = registerTranslationAction({
    kind: "tool_parameter_description",
    sourceText: "",
    section: state.activeRawSection || "tools",
    surface: "raw",
    metadata: { label: t("parameterDescriptions") },
    materials: parameters.map((item) => ({
      kind: item.kind,
      source_text: item.source_text,
      metadata: item.metadata || {},
    })),
  });
  const originalText = parameters
    .map((item) => {
      const label = item.metadata?.field_name || item.metadata?.path || "parameter";
      return `### ${label}\n${item.source_text || ""}`;
    })
    .join("\n\n");
  return `
    <article class="translation-block tool-parameter parameter-summary">
      <header>
        <strong>${escapeHtml(t("parameterDescriptions"))} · ${escapeHtml(String(parameters.length))}</strong>
        <span class="translation-block-meta">
          <span class="translation-kind">${escapeHtml(t("parameterDescriptions"))}</span>
          <span class="translation-cache-state">${escapeHtml(hits ? `${t("cacheState", { language: currentTargetLanguageLabel() })} ${hits}/${parameters.length}` : t("missingTranslation"))}</span>
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${state.translationGenerate.loading ? "disabled" : ""}>${escapeHtml(hits ? t("retranslateParameters") : t("translateParameters"))}</button>
        </span>
      </header>
      <div class="tool-parameter-summary-list">
        ${parameters
          .map((item) => {
            const label = item.metadata?.field_name || item.metadata?.path || "parameter";
            const translated = translatedTextFor(item.kind, item.source_text);
            const displayText = translated || item.source_text || "";
            return `
              <section class="tool-parameter-summary-item">
                <strong>${escapeHtml(label)}</strong>
                ${renderMarkdownPreview(displayText)}
              </section>
            `;
          })
          .join("")}
      </div>
      <details>
        <summary>${escapeHtml(t("source"))}</summary>
        <div class="details-body">${renderPre(originalText)}</div>
      </details>
    </article>
  `;
}

function renderTranslatedHarnessSection(request) {
  const materials = normalizedRawSearchQuery() ? matchingTranslationMaterials(request, "harness") : collectHarnessTranslationMaterials(request);
  if (!materials.length) return renderStructuredTranslationEmpty("harness", t("noHarnessPrompts"));
  return `
    <section class="translation-list">
      ${materials
        .map((item) =>
          renderTranslationBlock({
            label: item.metadata?.label || translationKindLabel(item.kind),
            kind: item.kind,
            sourceText: item.source_text,
            searchTarget: Boolean(normalizedRawSearchQuery()),
          }),
        )
        .join("")}
    </section>
  `;
}

function renderStructuredTranslationEmpty(section, fallback) {
  const query = normalizedRawSearchQuery();
  const message = query
    ? t("rawSearchNoResults", { section: rawSearchScopeLabel(section, state.activeRawMode || "request"), query })
    : fallback;
  return `<div class="empty-box">${escapeHtml(message)}</div>`;
}

function renderTranslationBlock({ label, kind, sourceText, compact = false, searchTarget = false }) {
  const translation = translatedTextFor(kind, sourceText);
  const hit = Boolean(translation);
  const kindClass = translationKindClass(kind);
  const displayText = translation || sourceText || "";
  const actionId = registerTranslationAction({ kind, sourceText, section: state.activeRawSection || "tools", surface: "raw", metadata: { label } });
  return `
    <article class="translation-block ${escapeHtml(kindClass)} ${compact ? "compact" : ""} ${hit ? "hit" : "miss"}" ${searchTarget ? 'data-raw-search-target="true"' : ""}>
      <header>
        <strong>${escapeHtml(label)}</strong>
        <span class="translation-block-meta">
          <span class="translation-kind">${escapeHtml(translationKindLabel(kind))}</span>
          <span class="translation-cache-state">${escapeHtml(hit ? t("cacheState", { language: currentTargetLanguageLabel() }) : t("missingTranslation"))}</span>
          <button type="button" class="translation-inline-button" data-translation-copy="${escapeHtml(actionId)}" title="${escapeHtml(t("copyBlockTitle"))}">${escapeHtml(t("copy"))}</button>
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${state.translationGenerate.loading ? "disabled" : ""}>${escapeHtml(hit ? t("retranslate") : t("translate"))}</button>
        </span>
      </header>
      ${renderMarkdownPreview(displayText)}
      <details>
        <summary>${escapeHtml(t("source"))}</summary>
        <div class="details-body">${renderPre(sourceText || "")}</div>
      </details>
    </article>
  `;
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

function translationKindClass(kind) {
  if (kind === "tool_description") return "tool-description";
  if (kind === "tool_parameter_description") return "tool-parameter";
  if (kind === "system_prompt") return "system-prompt";
  if (kind === "system_injected_context") return "system-injected";
  if (kind === "assistant_thinking") return "assistant-thinking-kind";
  if (kind && kind.startsWith("harness_")) return "harness-kind";
  return "other-kind";
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
  const materials =
    section === "system"
      ? collectSystemTranslationMaterials(request)
      : section === "tools"
        ? collectToolTranslationMaterials(request)
        : section === "harness"
          ? collectHarnessTranslationMaterials(request)
          : [];
  const hit = materials.filter((item) => translatedTextFor(item.kind, item.source_text)).length;
  return { total: materials.length, hit, missing: Math.max(0, materials.length - hit) };
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
  const normalized = String(workspace).replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized || "";
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

function renderConfidenceBadge(confidence) {
  const exact = confidence === "exact";
  return `<span class="badge ${exact ? "exact" : "partial"}" title="${escapeHtml(exact ? t("exactCaptureTitle") : t("partialCaptureTitle"))}">${escapeHtml(exact ? t("exactCapture") : t("partialCapture"))}</span>`;
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

function signedDelta(value) {
  const number = Number(value || 0);
  if (!number) return "";
  return number > 0 ? `+${number}` : String(number);
}

function signedBytes(value) {
  const number = Number(value || 0);
  if (!number) return "";
  return `${number > 0 ? "+" : "-"}${formatBytes(Math.abs(number))}`;
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
