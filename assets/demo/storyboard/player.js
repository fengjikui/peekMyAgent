const params = new URLSearchParams(window.location.search);
const repositoryRootUrl = new URL("../../../", import.meta.url);
const catalogUrl = "/assets/demo/storyboard/catalog.zh-CN.json";
const fallbackTimelineUrl = "/assets/demo/source/quickstart/video/timeline.zh-CN.json";
const requestedTimelineUrl = params.get("timeline");
const requestedPlanUrl = params.get("plan");
const editMode = params.get("edit") === "1";
const presentMode = params.get("present") === "1";
const embedMode = params.get("embed") === "1";
const reviewMode = params.get("review") === "1" || editMode;
const startScene = Number.parseInt(params.get("scene") || "0", 10);
const startElapsedMs = Number.parseInt(params.get("at_ms") || "0", 10);
const autoplay = params.get("autoplay") === "1"
  || (params.get("autoplay") !== "0" && !editMode && !embedMode);
let subtitlesVisible = params.get("subtitles") !== "0";

if (presentMode && !editMode) document.body.classList.add("present");
if (embedMode && !presentMode) document.body.classList.add("embed");
if (reviewMode) document.body.classList.add("review");
if (editMode) document.body.classList.add("edit-mode");
if (!subtitlesVisible) document.body.classList.add("no-subtitles");
document.body.dataset.editMode = editMode ? "1" : "0";

const elements = {
  visual: document.querySelector(".visual"),
  image: document.querySelector(".product-frame"),
  titleCard: document.querySelector(".title-card"),
  cardEyebrow: document.querySelector(".card-eyebrow"),
  cardHeadline: document.querySelector(".card-headline"),
  cardSteps: document.querySelector(".card-steps"),
  cardFooter: document.querySelector(".card-footer"),
  annotationLayer: document.querySelector(".annotation-layer"),
  annotationSvg: document.querySelector(".annotation-svg"),
  annotationLines: document.querySelector(".annotation-lines"),
  subtitle: document.querySelector(".subtitle"),
  scrubber: document.querySelector(".scrubber"),
  timecode: document.querySelector(".timecode"),
  sceneNumber: document.querySelector(".scene-number"),
  sceneTitle: document.querySelector(".scene-title"),
  toggle: document.querySelector('[data-action="toggle"]'),
  previous: document.querySelector('[data-action="previous"]'),
  next: document.querySelector('[data-action="next"]'),
  subtitles: document.querySelector('[data-action="subtitles"]'),
  fullscreen: document.querySelector('[data-action="fullscreen"]'),
  chapterSelect: document.querySelector(".chapter-select"),
  chapterFieldLabel: document.querySelector(".chapter-field-label"),
  reviewPointSelect: document.querySelector(".review-point-select"),
  reviewPointFieldLabel: document.querySelector(".review-point-field-label"),
  reviewSummary: document.querySelector(".review-summary"),
  guideLink: document.querySelector(".guide-link"),
  reviewSheetOpen: document.querySelector(".review-sheet-open"),
  reviewSheet: document.querySelector(".review-sheet"),
  reviewSheetClose: document.querySelector(".review-sheet-close"),
  reviewSheetTitle: document.querySelector(".review-sheet-title"),
  reviewSheetStatus: document.querySelector(".review-sheet-status"),
  reviewSheetMetrics: document.querySelector(".review-sheet-metrics"),
  reviewSheetQuestion: document.querySelector(".review-sheet-question-copy"),
  reviewSheetAudience: document.querySelector(".review-sheet-audience"),
  reviewSheetSource: document.querySelector(".review-sheet-source"),
  reviewSheetBoundary: document.querySelector(".review-sheet-boundary"),
  reviewSheetNextGate: document.querySelector(".review-sheet-next-gate"),
  reviewSheetArtifacts: document.querySelector(".review-sheet-artifacts"),
  annotationEditor: document.querySelector(".annotation-editor"),
  annotationEditorSelection: document.querySelector(".annotation-editor-selection"),
  annotationEditorStatus: document.querySelector(".annotation-editor-status"),
  annotationEditorInputs: [...document.querySelectorAll("[data-edit-coordinate]")],
  annotationEditorCopy: document.querySelector('[data-edit-action="copy"]'),
  annotationEditorDownload: document.querySelector('[data-edit-action="download"]'),
  annotationEditorResetScene: document.querySelector('[data-edit-action="reset-scene"]'),
};

const reviewStatusLabels = {
  draft: "制作中",
  "owner-review": "等待中文故事审阅",
  "ready-for-voice": "故事已确认，可进入配音",
  published: "已发布",
};

const reviewArtifactLabels = {
  narration: ["旁白", "逐镜头中文故事母稿"],
  subtitles: ["字幕", "与时间线对齐的 SRT"],
  manifest: ["来源", "Source、版本与隐私边界"],
  review_1920: ["1920", "桌面尺寸渐进标注联系表"],
  review_1024: ["1024", "README 宽度渐进标注联系表"],
};

function resolveRepositoryUrl(value) {
  const text = String(value || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (text.startsWith("/")) return new URL(text.slice(1), repositoryRootUrl).href;
  return new URL(text, window.location.href).href;
}

function resolveGuideUrl(path, section) {
  const slug = markdownHeadingSlug(section);
  if (window.location.hostname.endsWith(".github.io")) {
    const owner = window.location.hostname.split(".")[0];
    const repository = repositoryRootUrl.pathname.split("/").filter(Boolean)[0];
    if (owner && repository) {
      return `https://github.com/${owner}/${repository}/blob/main/${String(path).replace(/^\/+/, "")}#${slug}`;
    }
  }
  return `${resolveRepositoryUrl(path)}#${slug}`;
}

const state = {
  catalog: null,
  timeline: null,
  timelineUrl: null,
  sourceKind: "timeline",
  sceneIndex: 0,
  sceneElapsed: 0,
  playing: false,
  lastFrameTime: null,
  overlayTimers: [],
  annotationDrafts: {},
  editSelection: null,
};

if (editMode) {
  elements.annotationEditor.hidden = false;
  elements.annotationLayer.removeAttribute("aria-hidden");
  for (const input of elements.annotationEditorInputs) input.disabled = true;
  elements.previous.setAttribute("aria-label", "上一标注复核点");
  elements.next.setAttribute("aria-label", "下一标注复核点");
}

function setControlsDisabled(disabled) {
  for (const element of [
    elements.toggle,
    elements.previous,
    elements.next,
    elements.subtitles,
    elements.fullscreen,
    elements.scrubber,
    elements.chapterSelect,
    elements.reviewPointSelect,
    elements.reviewSheetOpen,
  ]) {
    element.disabled = disabled;
  }
}

function renderLoading(message = "正在载入故事板") {
  document.body.dataset.timelineReady = "0";
  delete document.body.dataset.timelineError;
  setPlaying(false);
  setControlsDisabled(true);
  elements.image.hidden = true;
  elements.titleCard.hidden = false;
  elements.cardEyebrow.textContent = "peekMyAgent · 演示审阅";
  elements.cardHeadline.textContent = message;
  elements.cardSteps.replaceChildren();
  elements.cardFooter.textContent = "章节载入后可以直接选择稳定复核点。";
  elements.reviewSummary.value = message;
  elements.guideLink.hidden = true;
  if (elements.reviewSheet.open) elements.reviewSheet.close();
}

function renderLoadError(error) {
  document.body.dataset.timelineReady = "error";
  document.body.dataset.timelineError = error instanceof Error ? error.message : String(error);
  setPlaying(false);
  setControlsDisabled(true);
  elements.image.hidden = true;
  elements.titleCard.hidden = false;
  elements.cardEyebrow.textContent = "peekMyAgent · 演示审阅";
  elements.cardHeadline.textContent = "故事板加载失败";
  elements.cardSteps.replaceChildren();
  elements.cardFooter.textContent = error instanceof Error ? error.message : String(error);
  elements.reviewSummary.value = "请检查本地静态服务器和章节路径";
  elements.guideLink.hidden = true;
  if (elements.reviewSheet.open) elements.reviewSheet.close();
}

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateLocation({ scene = null, atMs = null } = {}) {
  const next = new URLSearchParams(window.location.search);
  next.delete("timeline");
  next.delete("plan");
  next.set(state.sourceKind === "plan" ? "plan" : "timeline", state.timelineUrl);
  if (scene === null) next.delete("scene");
  else next.set("scene", String(scene));
  if (atMs === null) next.delete("at_ms");
  else next.set("at_ms", String(atMs));
  window.history.replaceState(null, "", `${window.location.pathname}?${next.toString()}`);
}

function populateChapterSelect() {
  const chapters = state.catalog?.chapters || [];
  const readmePlanUrl = requestedPlanUrl || (state.sourceKind === "plan" ? state.timelineUrl : null);
  elements.chapterSelect.replaceChildren(
    ...chapters.map((chapter) => {
      const option = document.createElement("option");
      option.value = chapter.timeline;
      option.dataset.sourceKind = "timeline";
      option.textContent = chapter.label;
      return option;
    }),
  );
  if (readmePlanUrl) {
    const option = document.createElement("option");
    option.value = readmePlanUrl;
    option.dataset.sourceKind = "plan";
    option.textContent = "README 首屏精简版";
    elements.chapterSelect.prepend(option);
  }
  if (state.sourceKind !== "plan" && !chapters.some((chapter) => chapter.timeline === state.timelineUrl)) {
    const option = document.createElement("option");
    option.value = state.timelineUrl;
    option.dataset.sourceKind = "timeline";
    option.textContent = state.timeline?.title || "自定义章节";
    elements.chapterSelect.append(option);
  }
  elements.chapterSelect.value = state.timelineUrl;
  elements.chapterFieldLabel.textContent = state.sourceKind === "plan" ? "版本" : "章节";
  elements.chapterSelect.setAttribute(
    "aria-label",
    state.sourceKind === "plan" ? "选择演示版本" : "选择演示章节",
  );
}

function populateReviewPointSelect() {
  const points = state.timeline.review_points || [];
  const isPlan = state.sourceKind === "plan";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = points.length
    ? isPlan ? "选择一个 README 镜头" : "选择一个稳定复核点"
    : isPlan ? "README 计划没有镜头" : "本章没有声明复核点";
  elements.reviewPointSelect.replaceChildren(
    placeholder,
    ...points.map((point, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      const label = isPlan ? state.timeline.scenes[point.scene]?.title : point.name;
      option.textContent = `${String(index + 1).padStart(2, "0")} · ${label}`;
      return option;
    }),
  );
  elements.reviewPointSelect.disabled = points.length === 0;
  elements.reviewPointFieldLabel.textContent = isPlan ? "镜头" : "复核点";
  elements.reviewPointSelect.setAttribute(
    "aria-label",
    isPlan ? "选择 README 镜头" : "选择渐进标注复核点",
  );
  elements.reviewSummary.value = isPlan
    ? `${state.timeline.scenes.length} 个镜头 · ${formatTime(state.timeline.duration_seconds)} · README GIF 精简版`
    : [
        `${state.timeline.scenes.length} 个镜头`,
        `${formatTime(state.timeline.duration_seconds)}`,
        `${points.length} 个渐进复核点`,
      ].join(" · ");

  const chapter = currentCatalogChapter();
  if (chapter?.guide && chapter?.guide_section) {
    elements.guideLink.href = resolveGuideUrl(chapter.guide, chapter.guide_section);
    elements.guideLink.textContent = `对应章节：${chapter.guide_section}`;
    elements.guideLink.title = chapter.guide;
    elements.guideLink.hidden = false;
  } else {
    elements.guideLink.hidden = true;
  }
}

function currentCatalogChapter() {
  if (state.sourceKind === "plan") return null;
  return state.catalog?.chapters.find((item) => item.timeline === state.timelineUrl) || null;
}

function subtitleCueCount() {
  return state.timeline.scenes.reduce(
    (total, scene) => total + (scene.subtitle_cues || []).length,
    0,
  );
}

function populateReviewSheet(chapter) {
  const review = chapter?.review;
  elements.reviewSheetOpen.disabled = !review;
  elements.reviewSheetOpen.hidden = !review;
  if (!review) return;

  elements.reviewSheetTitle.textContent = chapter.label;
  elements.reviewSheetStatus.textContent = reviewStatusLabels[review.status] || review.status;
  elements.reviewSheetStatus.dataset.status = review.status;
  elements.reviewSheetMetrics.textContent = [
    `${state.timeline.scenes.length} 个镜头`,
    `${subtitleCueCount()} 条字幕`,
    `${(state.timeline.review_points || []).length} 个复核点`,
    formatTime(state.timeline.duration_seconds),
  ].join(" · ");
  elements.reviewSheetQuestion.textContent = review.question;
  elements.reviewSheetAudience.textContent = review.audience;
  elements.reviewSheetSource.textContent = review.source.label;
  elements.reviewSheetBoundary.textContent = review.source.boundary;
  elements.reviewSheetNextGate.textContent = review.next_gate;

  elements.reviewSheetArtifacts.replaceChildren(
    ...Object.entries(review.artifacts).map(([key, href]) => {
      const [kind, label] = reviewArtifactLabels[key] || [key, key];
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = href;

      const kindNode = document.createElement("span");
      kindNode.className = "review-artifact-kind";
      kindNode.textContent = kind;
      const labelNode = document.createElement("span");
      labelNode.className = "review-artifact-label";
      labelNode.textContent = label;
      const openNode = document.createElement("span");
      openNode.className = "review-artifact-open";
      openNode.textContent = "打开";
      link.append(kindNode, labelNode, openNode);
      return link;
    }),
  );
}

function markdownHeadingSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, "-");
}

function syncReviewPointSelection() {
  const elapsedMs = Math.round(state.sceneElapsed * 1000);
  const index = (state.timeline.review_points || []).findIndex(
    (point) => point.scene === state.sceneIndex && Math.abs(point.at_ms - elapsedMs) <= 2,
  );
  elements.reviewPointSelect.value = index === -1 ? "" : String(index);
}

function overlayIsActiveAt(overlay, elapsedMs) {
  const delay = overlay.delay_ms || 0;
  const effectiveEnd = Number.isFinite(overlay.end_ms)
    ? overlay.end_ms
    : overlay.type === "click" ? delay + 1000 : Number.POSITIVE_INFINITY;
  return delay <= elapsedMs && effectiveEnd > elapsedMs;
}

function reviewPointHasEditableAnnotation(point) {
  const scene = state.timeline.scenes[point.scene];
  return (scene.overlays || []).some((overlay) => (
    (overlay.focus || overlay.label_box || overlay.click)
    && overlayIsActiveAt(overlay, point.at_ms)
  ));
}

function moveEditableReviewPoint(delta) {
  const candidates = (state.timeline.review_points || [])
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => reviewPointHasEditableAnnotation(point));
  if (!candidates.length) return;

  const currentElapsedMs = Math.round(state.sceneElapsed * 1000);
  const currentIndex = candidates.findIndex(({ point }) => (
    point.scene === state.sceneIndex && Math.abs(point.at_ms - currentElapsedMs) <= 2
  ));
  let targetIndex;
  if (currentIndex !== -1) {
    targetIndex = Math.max(0, Math.min(candidates.length - 1, currentIndex + delta));
  } else if (delta > 0) {
    const nextIndex = candidates.findIndex(({ point }) => (
      point.scene > state.sceneIndex
      || (point.scene === state.sceneIndex && point.at_ms > currentElapsedMs)
    ));
    targetIndex = nextIndex === -1 ? candidates.length - 1 : nextIndex;
  } else {
    const previousIndex = candidates.findLastIndex(({ point }) => (
      point.scene < state.sceneIndex
      || (point.scene === state.sceneIndex && point.at_ms < currentElapsedMs)
    ));
    targetIndex = previousIndex === -1 ? 0 : previousIndex;
  }

  const target = candidates[targetIndex];
  setPlaying(false);
  state.sceneIndex = target.point.scene;
  state.sceneElapsed = target.point.at_ms / 1000;
  renderScene({ resetElapsed: false });
  updateLocation({ scene: target.point.scene, atMs: target.point.at_ms });
}

async function loadCatalog() {
  const response = await fetch(resolveRepositoryUrl(catalogUrl));
  if (!response.ok) throw new Error(`无法载入章节目录：${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog.chapters) || catalog.chapters.length === 0) {
    throw new Error("章节目录为空");
  }
  state.catalog = catalog;
  return catalog;
}

async function loadTimeline(timelineUrl, { sceneIndex = 0, elapsedMs = 0, updateUrl = false } = {}) {
  renderLoading("正在载入章节");
  const response = await fetch(resolveRepositoryUrl(timelineUrl));
  if (!response.ok) throw new Error(`无法载入时间线：${response.status}`);
  const timeline = await response.json();
  if (!Array.isArray(timeline.scenes) || timeline.scenes.length === 0) {
    throw new Error("时间线没有镜头");
  }

  state.timeline = timeline;
  state.timelineUrl = timelineUrl;
  state.sourceKind = "timeline";
  loadAnnotationDrafts();
  document.body.dataset.storyTheme = timeline.theme || "codex";
  document.body.dataset.sourceKind = "timeline";
  state.sceneIndex = Number.isFinite(sceneIndex)
    ? Math.max(0, Math.min(timeline.scenes.length - 1, sceneIndex))
    : 0;
  const sceneDuration = currentScene().end_seconds - currentScene().start_seconds;
  state.sceneElapsed = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.min(elapsedMs / 1000, sceneDuration - 0.001))
    : 0;
  document.body.dataset.timelineDurationMs = String(Math.round(timeline.duration_seconds * 1000));

  populateChapterSelect();
  populateReviewPointSelect();
  setControlsDisabled(false);
  if (editMode) {
    elements.toggle.disabled = true;
    elements.scrubber.disabled = true;
  }
  elements.reviewPointSelect.disabled = (timeline.review_points || []).length === 0;
  populateReviewSheet(currentCatalogChapter());
  renderScene({ resetElapsed: false });
  document.body.dataset.timelineReady = "1";
  if (updateUrl) updateLocation();
}

function readmePlanToTimeline(plan) {
  if (plan?.schema_version !== 1 || !Array.isArray(plan.shots) || plan.shots.length === 0) {
    throw new Error("README GIF 计划没有可播放镜头");
  }
  if (!Array.isArray(plan.resolution) || plan.resolution.length !== 2 || !plan.source_directory) {
    throw new Error("README GIF 计划缺少画面尺寸或素材目录");
  }

  const sourceRoot = `/${String(plan.source_directory).replace(/^\/+|\/+$/g, "")}`;
  let elapsedMs = 0;
  const scenes = plan.shots.map((shot, index) => {
    if (!shot.frame || !Number.isFinite(shot.hold_ms) || shot.hold_ms <= 0) {
      throw new Error(`README GIF 镜头 ${index + 1} 缺少画面或停留时间`);
    }
    const startMs = elapsedMs;
    elapsedMs += shot.hold_ms;
    return {
      id: `readme-${String(index + 1).padStart(2, "0")}`,
      title: shot.purpose,
      start_seconds: startMs / 1000,
      end_seconds: elapsedMs / 1000,
      source_image: `${sourceRoot}/${shot.frame}`,
      subtitle_cues: [],
      transition: { type: "crossfade", duration_ms: plan.fade_ms || 600 },
    };
  });

  return {
    version: plan.schema_version,
    title: plan.title,
    resolution: plan.resolution,
    source_viewport: plan.resolution,
    duration_seconds: elapsedMs / 1000,
    theme: "codex",
    readme_plan: true,
    review_points: scenes.map((scene, index) => ({
      name: plan.shots[index].frame,
      scene: index,
      at_ms: 0,
    })),
    scenes,
  };
}

async function preloadTimelineImages(timeline) {
  await Promise.all(timeline.scenes.map((scene) => new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error(`无法载入 README 镜头：${scene.source_image}`)), { once: true });
    image.src = resolveRepositoryUrl(scene.source_image);
  })));
}

async function loadReadmePlan(planUrl, { sceneIndex = 0, elapsedMs = 0, updateUrl = false } = {}) {
  renderLoading("正在载入 README 精简版");
  const response = await fetch(resolveRepositoryUrl(planUrl));
  if (!response.ok) throw new Error(`无法载入 README GIF 计划：${response.status}`);
  const timeline = readmePlanToTimeline(await response.json());
  await preloadTimelineImages(timeline);

  state.timeline = timeline;
  state.timelineUrl = planUrl;
  state.sourceKind = "plan";
  state.annotationDrafts = {};
  document.body.dataset.storyTheme = timeline.theme;
  document.body.dataset.sourceKind = "plan";
  state.sceneIndex = Number.isFinite(sceneIndex)
    ? Math.max(0, Math.min(timeline.scenes.length - 1, sceneIndex))
    : 0;
  const sceneDuration = currentScene().end_seconds - currentScene().start_seconds;
  state.sceneElapsed = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.min(elapsedMs / 1000, sceneDuration - 0.001))
    : 0;
  document.body.dataset.timelineDurationMs = String(Math.round(timeline.duration_seconds * 1000));

  populateChapterSelect();
  populateReviewPointSelect();
  setControlsDisabled(false);
  if (editMode) {
    elements.toggle.disabled = true;
    elements.scrubber.disabled = true;
    elements.annotationEditorStatus.value = "README 精简版使用已生成图片；请切换到完整章节的复核点调整源标注。";
  }
  elements.reviewPointSelect.disabled = false;
  populateReviewSheet(null);
  renderScene({ resetElapsed: false });
  document.body.dataset.timelineReady = "1";
  if (updateUrl) updateLocation();
}

function currentScene() {
  return state.timeline.scenes[state.sceneIndex];
}

function clearOverlayTimers() {
  for (const timer of state.overlayTimers) window.clearTimeout(timer);
  state.overlayTimers = [];
}

function setPercentBox(node, [x, y, width, height]) {
  node.style.left = `${x}%`;
  node.style.top = `${y}%`;
  node.style.width = `${width}%`;
  node.style.height = `${height}%`;
}

function focusBoxWithPadding([x, y, width, height], padding = [0, 0]) {
  const [paddingX, paddingY] = padding;
  return [
    x - paddingX,
    y - paddingY,
    width + paddingX * 2,
    height + paddingY * 2,
  ];
}

function roundCoordinate(value) {
  return Math.round(value * 100) / 100;
}

function annotationDraftKey(sceneIndex, overlayIndex, field) {
  return `${sceneIndex}:${overlayIndex}:${field}`;
}

function annotationDraftStorageKey() {
  return `pma-storyboard-annotation-drafts:${state.timelineUrl}`;
}

function loadAnnotationDrafts() {
  state.annotationDrafts = {};
  if (!editMode || state.sourceKind !== "timeline") return;
  try {
    const saved = JSON.parse(window.localStorage.getItem(annotationDraftStorageKey()) || "null");
    if (saved?.schema_version === 1 && saved.timeline === state.timelineUrl && saved.changes) {
      state.annotationDrafts = saved.changes;
    }
  } catch {
    elements.annotationEditorStatus.value = "已有本地草稿无法读取，已从仓库坐标重新开始。";
  }
}

function persistAnnotationDrafts() {
  if (!editMode || state.sourceKind !== "timeline") return;
  window.localStorage.setItem(annotationDraftStorageKey(), JSON.stringify({
    schema_version: 1,
    timeline: state.timelineUrl,
    changes: state.annotationDrafts,
  }));
}

function overlayWithDraft(overlay, overlayIndex) {
  if (!editMode) return overlay;
  const next = { ...overlay };
  for (const field of ["focus", "label_box", "click", "route"]) {
    const value = state.annotationDrafts[annotationDraftKey(state.sceneIndex, overlayIndex, field)];
    if (Array.isArray(value)) next[field] = value;
  }
  return next;
}

function clearEditSelection() {
  state.editSelection?.node?.classList.remove("is-edit-selected");
  state.editSelection = null;
  if (!editMode) return;
  elements.annotationEditorSelection.textContent = "点击画面中的标注框开始调整";
  for (const input of elements.annotationEditorInputs) {
    input.value = "";
    input.disabled = true;
  }
}

function displayedBox(node, field) {
  const x = Number.parseFloat(node.style.left) || 0;
  const y = Number.parseFloat(node.style.top) || 0;
  if (field === "click") return [x, y, 0, 0];
  return [
    x,
    y,
    Number.parseFloat(node.style.width) || 0,
    Number.parseFloat(node.style.height) || 0,
  ];
}

function updateEditorInputs(box, field) {
  const coordinates = { x: box[0], y: box[1], w: box[2], h: box[3] };
  for (const input of elements.annotationEditorInputs) {
    const coordinate = input.dataset.editCoordinate;
    const sizeDisabled = field === "click" && (coordinate === "w" || coordinate === "h");
    input.disabled = sizeDisabled;
    input.value = sizeDisabled ? "" : String(roundCoordinate(coordinates[coordinate]));
  }
}

function selectEditableAnnotation(node) {
  state.editSelection?.node?.classList.remove("is-edit-selected");
  node.classList.add("is-edit-selected");
  const overlayIndex = Number(node.dataset.overlayIndex);
  const field = node.dataset.editField;
  state.editSelection = {
    node,
    overlayIndex,
    field,
    padding: [
      Number.parseFloat(node.dataset.paddingX) || 0,
      Number.parseFloat(node.dataset.paddingY) || 0,
    ],
  };
  const fieldLabel = field === "focus" ? "聚焦框" : field === "label_box" ? "编号或文字" : "点击波纹";
  elements.annotationEditorSelection.textContent = [
    `镜头 ${String(state.sceneIndex + 1).padStart(2, "0")}`,
    `标注 ${overlayIndex + 1}`,
    fieldLabel,
  ].join(" · ");
  elements.annotationEditorStatus.value = "坐标显示当前可见范围；调整会自动保存为本地草稿。";
  updateEditorInputs(displayedBox(node, field), field);
}

function setDisplayedBox(node, field, box) {
  node.style.left = `${box[0]}%`;
  node.style.top = `${box[1]}%`;
  if (field !== "click") {
    node.style.width = `${box[2]}%`;
    node.style.height = `${box[3]}%`;
  }
}

function commitEditSelection(box) {
  const selection = state.editSelection;
  if (!selection) return;
  const [paddingX, paddingY] = selection.padding;
  let value;
  if (selection.field === "focus") {
    value = [
      box[0] + paddingX,
      box[1] + paddingY,
      box[2] - paddingX * 2,
      box[3] - paddingY * 2,
    ];
  } else if (selection.field === "click") {
    value = box.slice(0, 2);
  } else {
    value = box;
  }
  state.annotationDrafts[annotationDraftKey(
    state.sceneIndex,
    selection.overlayIndex,
    selection.field,
  )] = value.map(roundCoordinate);
  persistAnnotationDrafts();
  elements.annotationEditorStatus.value = "已保存到当前浏览器；仓库时间线尚未改变。";
}

function constrainEditableBox(box, field, padding = [0, 0]) {
  if (field === "click") {
    return [
      Math.max(0, Math.min(100, box[0])),
      Math.max(0, Math.min(100, box[1])),
      0,
      0,
    ];
  }
  const minimumWidth = field === "focus" ? Math.max(1, padding[0] * 2 + 0.2) : 1;
  const minimumHeight = field === "focus" ? Math.max(1, padding[1] * 2 + 0.2) : 1;
  const width = Math.max(minimumWidth, Math.min(100, box[2]));
  const height = Math.max(minimumHeight, Math.min(100, box[3]));
  return [
    Math.max(0, Math.min(100 - width, box[0])),
    Math.max(0, Math.min(100 - height, box[1])),
    width,
    height,
  ];
}

function beginAnnotationPointerEdit(event) {
  if (!editMode || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  setPlaying(false);
  const node = event.currentTarget;
  selectEditableAnnotation(node);
  const selection = state.editSelection;
  const handle = event.target.closest("[data-resize-handle]")?.dataset.resizeHandle || "move";
  const layerBox = elements.annotationLayer.getBoundingClientRect();
  const start = displayedBox(node, selection.field);
  const startClient = [event.clientX, event.clientY];
  let changed = false;
  node.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    const dx = ((moveEvent.clientX - startClient[0]) / layerBox.width) * 100;
    const dy = ((moveEvent.clientY - startClient[1]) / layerBox.height) * 100;
    changed = changed || Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005;
    let next = [...start];
    if (selection.field === "click" || handle === "move") {
      next[0] += dx;
      next[1] += dy;
    } else {
      if (handle.includes("w")) {
        next[0] += dx;
        next[2] -= dx;
      }
      if (handle.includes("e")) next[2] += dx;
      if (handle.includes("n")) {
        next[1] += dy;
        next[3] -= dy;
      }
      if (handle.includes("s")) next[3] += dy;
    }
    next = constrainEditableBox(next, selection.field, selection.padding);
    setDisplayedBox(node, selection.field, next);
    updateEditorInputs(next, selection.field);
  };

  const finish = () => {
    node.removeEventListener("pointermove", move);
    node.removeEventListener("pointerup", finish);
    node.removeEventListener("pointercancel", finish);
    const box = displayedBox(node, selection.field);
    if (changed) {
      commitEditSelection(box);
    } else {
      elements.annotationEditorStatus.value = "已选择标注；拖动框体，或修改下方精确坐标。";
    }
  };

  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);
}

function makeAnnotationEditable(node, overlayIndex, field, padding = [0, 0], resizable = false) {
  if (!editMode) return;
  node.classList.add("editable-annotation");
  node.dataset.overlayIndex = String(overlayIndex);
  node.dataset.editField = field;
  node.dataset.paddingX = String(padding[0] || 0);
  node.dataset.paddingY = String(padding[1] || 0);
  node.addEventListener("pointerdown", beginAnnotationPointerEdit);
  if (resizable) {
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const handle = document.createElement("span");
      handle.className = "annotation-edit-handle";
      handle.dataset.resizeHandle = corner;
      handle.setAttribute("aria-hidden", "true");
      node.append(handle);
    }
  }
}

function annotationDraftExport() {
  return {
    schema_version: 1,
    timeline: state.timelineUrl,
    generated_at: new Date().toISOString(),
    source_url: window.location.href,
    changes: Object.entries(state.annotationDrafts).map(([key, value]) => {
      const [sceneIndex, overlayIndex, field] = key.split(":");
      const scene = state.timeline.scenes[Number(sceneIndex)];
      const overlay = scene?.overlays?.[Number(overlayIndex)];
      return {
        scene_index: Number(sceneIndex),
        scene_id: scene?.id,
        overlay_index: Number(overlayIndex),
        field,
        value,
        draft: overlay?.draft,
      };
    }),
  };
}

function annotationDraftJson() {
  return `${JSON.stringify(annotationDraftExport(), null, 2)}\n`;
}

function renderOverlay(overlay, overlayIndex) {
  const nodes = [];
  if (overlay.focus) {
    const focus = document.createElement("div");
    focus.className = "focus-box";
    if (overlay.focus_style) focus.classList.add(`focus-box--${overlay.focus_style}`);
    setPercentBox(focus, focusBoxWithPadding(overlay.focus, overlay.focus_padding));
    makeAnnotationEditable(focus, overlayIndex, "focus", overlay.focus_padding, true);
    elements.annotationLayer.append(focus);
    nodes.push(focus);
  }

  if (overlay.label_box && overlay.label) {
    const label = document.createElement("div");
    label.className = overlay.type === "badge" ? "callout-label annotation-badge" : "callout-label";
    label.textContent = overlay.label;
    label.title = overlay.draft || "";
    setPercentBox(label, overlay.label_box);
    makeAnnotationEditable(label, overlayIndex, "label_box");
    elements.annotationLayer.append(label);
    nodes.push(label);
  }

  if (overlay.route?.length > 1) {
    const points = overlay.route.map(([x, y]) => `${x},${y}`).join(" ");
    const shadow = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    shadow.classList.add("route-shadow");
    shadow.setAttribute("points", points);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.classList.add("route-line");
    line.setAttribute("points", points);
    elements.annotationLines.append(shadow, line);
    nodes.push(shadow, line);
  }

  if (overlay.click) {
    const pulse = document.createElement("div");
    pulse.className = "click-pulse";
    pulse.style.left = `${overlay.click[0]}%`;
    pulse.style.top = `${overlay.click[1]}%`;
    makeAnnotationEditable(pulse, overlayIndex, "click");
    elements.annotationLayer.append(pulse);
    nodes.push(pulse);
  }

  return nodes;
}

function scheduleOverlays(scene, elapsedMs = 0) {
  clearOverlayTimers();
  clearEditSelection();
  elements.annotationLayer.replaceChildren();
  elements.annotationLines.replaceChildren();

  if (reviewMode) {
    for (const [overlayIndex, sourceOverlay] of (scene.overlays || []).entries()) {
      const overlay = overlayWithDraft(sourceOverlay, overlayIndex);
      const delay = overlay.delay_ms || 0;
      const effectiveEnd = Number.isFinite(overlay.end_ms)
        ? overlay.end_ms
        : overlay.type === "click" ? delay + 1000 : Number.POSITIVE_INFINITY;
      if (delay > elapsedMs || effectiveEnd <= elapsedMs) continue;

      const nodes = renderOverlay(overlay, overlayIndex);
      if (Number.isFinite(overlay.dim_ms) && overlay.dim_ms <= elapsedMs) {
        for (const node of nodes) node.classList.add("annotation-dim");
      }
    }
    if (editMode && !elements.annotationLayer.querySelector(".editable-annotation")) {
      elements.annotationEditorSelection.textContent = "当前复核点没有可编辑标注";
      elements.annotationEditorStatus.value = "使用左右箭头跳到上一处或下一处有标注的复核点。";
    }
    return;
  }

  for (const [overlayIndex, sourceOverlay] of (scene.overlays || []).entries()) {
    const overlay = overlayWithDraft(sourceOverlay, overlayIndex);
    const delay = overlay.delay_ms || 0;
    const effectiveEnd = Number.isFinite(overlay.end_ms)
      ? overlay.end_ms
      : overlay.type === "click" ? delay + 1000 : Number.POSITIVE_INFINITY;
    if (effectiveEnd <= elapsedMs) continue;

    const showOverlay = () => {
      const nodes = renderOverlay(overlay, overlayIndex);
      if (Number.isFinite(overlay.dim_ms)) {
        const dimOverlay = () => {
          for (const node of nodes) node.classList.add("annotation-dim");
        };
        const dimDelay = overlay.dim_ms - Math.max(delay, elapsedMs);
        if (dimDelay <= 0) {
          dimOverlay();
        } else {
          const dimTimer = window.setTimeout(dimOverlay, dimDelay);
          state.overlayTimers.push(dimTimer);
        }
      }
      if (Number.isFinite(overlay.end_ms)) {
        const exitTimer = window.setTimeout(() => {
          for (const node of nodes) node.classList.add("annotation-exit");
          const removeTimer = window.setTimeout(() => {
            for (const node of nodes) node.remove();
          }, 340);
          state.overlayTimers.push(removeTimer);
        }, overlay.end_ms - Math.max(delay, elapsedMs));
        state.overlayTimers.push(exitTimer);
      }
    };

    if (delay <= elapsedMs) {
      showOverlay();
    } else {
      const timer = window.setTimeout(showOverlay, delay - elapsedMs);
      state.overlayTimers.push(timer);
    }
  }
}

function renderCard(card) {
  elements.titleCard.classList.remove("is-entering");
  elements.cardEyebrow.textContent = card?.eyebrow || "";
  elements.cardHeadline.textContent = card?.headline || "";
  elements.cardSteps.replaceChildren(
    ...(card?.steps || []).map((step) => {
      const item = document.createElement("span");
      item.className = "card-step";
      item.textContent = step;
      return item;
    }),
  );
  elements.cardFooter.textContent = card?.footer || "";
  void elements.titleCard.offsetWidth;
  elements.titleCard.classList.add("is-entering");
}

function applySubtitleLayout(scene) {
  const layout = { ...(state.timeline.subtitle_layout || {}), ...(scene.subtitle_layout || {}) };
  const maxWidth = Number.isFinite(layout.max_width_percent) ? layout.max_width_percent : 72;
  const side = (100 - maxWidth) / 2;
  elements.subtitle.style.right = `${side}%`;
  elements.subtitle.style.left = `${side}%`;
  elements.subtitle.style.bottom = `${Number.isFinite(layout.bottom_percent) ? layout.bottom_percent : 5.2}%`;
}

function positionAnnotationViewport(hasSourceImage) {
  const targets = [elements.annotationLayer, elements.annotationSvg];
  if (!hasSourceImage) {
    for (const target of targets) {
      target.style.inset = "0";
      target.style.width = "100%";
      target.style.height = "100%";
    }
    return;
  }

  const [canvasWidth, canvasHeight] = state.timeline.resolution;
  const [sourceWidth, sourceHeight] = state.timeline.source_viewport || state.timeline.resolution;
  const canvasAspect = canvasWidth / canvasHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  let left = 0;
  let top = 0;
  let width = 100;
  let height = 100;

  if (sourceAspect > canvasAspect) {
    height = (canvasAspect / sourceAspect) * 100;
    top = (100 - height) / 2;
  } else if (sourceAspect < canvasAspect) {
    width = (sourceAspect / canvasAspect) * 100;
    left = (100 - width) / 2;
  }

  for (const target of targets) {
    target.style.inset = "auto";
    target.style.left = `${left}%`;
    target.style.top = `${top}%`;
    target.style.width = `${width}%`;
    target.style.height = `${height}%`;
  }
}

function renderScene({ resetElapsed = true } = {}) {
  const scene = currentScene();
  if (resetElapsed) state.sceneElapsed = 0;

  elements.visual.classList.remove("is-transitioning");
  void elements.visual.offsetWidth;
  elements.visual.classList.add("is-transitioning");

  if (scene.source_image) {
    elements.image.src = resolveRepositoryUrl(scene.source_image);
    elements.image.alt = scene.title;
    elements.image.hidden = false;
    elements.titleCard.hidden = true;
  } else {
    elements.image.hidden = true;
    elements.titleCard.hidden = false;
    renderCard(scene.card);
  }
  positionAnnotationViewport(Boolean(scene.source_image));
  applySubtitleLayout(scene);

  const camera = scene.camera || {};
  elements.visual.style.setProperty("--camera-scale", camera.scale || 1);
  elements.visual.style.setProperty("--camera-origin-x", `${camera.origin?.[0] || 50}%`);
  elements.visual.style.setProperty("--camera-origin-y", `${camera.origin?.[1] || 50}%`);

  elements.sceneNumber.textContent = `${state.sceneIndex + 1}/${state.timeline.scenes.length}`;
  elements.sceneTitle.textContent = scene.title;
  scheduleOverlays(scene, state.sceneElapsed * 1000);
  updateProgress();
}

function updateSubtitle(scene) {
  const cues = scene.subtitle_cues || [];
  if (!cues.length) {
    elements.subtitle.textContent = "";
    return;
  }
  const duration = Math.max(0.001, scene.end_seconds - scene.start_seconds);
  const cueIndex = Math.min(cues.length - 1, Math.floor((state.sceneElapsed / duration) * cues.length));
  elements.subtitle.textContent = cues[cueIndex];
}

function updateProgress() {
  const scene = currentScene();
  const absolute = scene.start_seconds + state.sceneElapsed;
  const duration = state.timeline.duration_seconds;
  elements.scrubber.value = String(Math.round((absolute / duration) * 1000));
  elements.timecode.value = `${formatTime(absolute)} / ${formatTime(duration)}`;
  document.body.dataset.sceneIndex = String(state.sceneIndex);
  document.body.dataset.sceneElapsedMs = String(Math.round(state.sceneElapsed * 1000));
  document.body.dataset.absoluteMs = String(Math.round(absolute * 1000));
  updateSubtitle(scene);
  syncReviewPointSelection();
}

function setPlaying(next) {
  if (editMode) next = false;
  state.playing = next;
  state.lastFrameTime = null;
  if (next) document.body.classList.add("has-started");
  document.body.dataset.playing = next ? "1" : "0";
  elements.toggle.textContent = next ? "暂停" : "播放";
}

function setSubtitlesVisible(next) {
  subtitlesVisible = next;
  document.body.classList.toggle("no-subtitles", !next);
  elements.subtitles.textContent = next ? "字幕开" : "字幕关";
  elements.subtitles.setAttribute("aria-pressed", next ? "true" : "false");
}

function updateFullscreenControl() {
  const fullscreen = Boolean(document.fullscreenElement);
  elements.fullscreen.textContent = fullscreen ? "退出全屏" : "全屏";
  elements.fullscreen.setAttribute("aria-label", fullscreen ? "退出全屏" : "进入全屏");
}

function seekAbsolute(seconds) {
  const clamped = Math.max(0, Math.min(seconds, state.timeline.duration_seconds - 0.001));
  const nextIndex = state.timeline.scenes.findIndex(
    (scene) => clamped >= scene.start_seconds && clamped < scene.end_seconds,
  );
  state.sceneIndex = nextIndex === -1 ? state.timeline.scenes.length - 1 : nextIndex;
  state.sceneElapsed = clamped - currentScene().start_seconds;
  renderScene({ resetElapsed: false });
}

function moveScene(delta) {
  state.sceneIndex = Math.max(0, Math.min(state.timeline.scenes.length - 1, state.sceneIndex + delta));
  renderScene();
}

function tick(timestamp) {
  if (state.playing) {
    if (state.lastFrameTime !== null) state.sceneElapsed += (timestamp - state.lastFrameTime) / 1000;
    state.lastFrameTime = timestamp;
    const scene = currentScene();
    const duration = scene.end_seconds - scene.start_seconds;
    if (state.sceneElapsed >= duration) {
      if (state.sceneIndex < state.timeline.scenes.length - 1) {
        state.sceneIndex += 1;
        renderScene();
      } else {
        state.sceneElapsed = duration;
        setPlaying(false);
      }
    }
    updateProgress();
  }
  window.requestAnimationFrame(tick);
}

elements.toggle.addEventListener("click", () => setPlaying(!state.playing));
elements.previous.addEventListener("click", () => editMode ? moveEditableReviewPoint(-1) : moveScene(-1));
elements.next.addEventListener("click", () => editMode ? moveEditableReviewPoint(1) : moveScene(1));
elements.subtitles.addEventListener("click", () => setSubtitlesVisible(!subtitlesVisible));
elements.fullscreen.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.querySelector(".shell").requestFullscreen();
});
document.addEventListener("fullscreenchange", updateFullscreenControl);
elements.scrubber.addEventListener("input", () => {
  setPlaying(false);
  seekAbsolute((Number(elements.scrubber.value) / 1000) * state.timeline.duration_seconds);
});

elements.chapterSelect.addEventListener("change", async () => {
  try {
    const selected = elements.chapterSelect.selectedOptions[0];
    if (selected?.dataset.sourceKind === "plan") {
      await loadReadmePlan(elements.chapterSelect.value, { updateUrl: true });
    } else {
      await loadTimeline(elements.chapterSelect.value, { updateUrl: true });
    }
  } catch (error) {
    renderLoadError(error);
  }
});

elements.reviewPointSelect.addEventListener("change", () => {
  if (elements.reviewPointSelect.value === "") return;
  const point = state.timeline.review_points[Number(elements.reviewPointSelect.value)];
  setPlaying(false);
  state.sceneIndex = point.scene;
  state.sceneElapsed = point.at_ms / 1000;
  renderScene({ resetElapsed: false });
  updateLocation({ scene: point.scene, atMs: point.at_ms });
});

elements.reviewSheetOpen.addEventListener("click", () => {
  if (!elements.reviewSheetOpen.disabled) elements.reviewSheet.showModal();
});
elements.reviewSheetClose.addEventListener("click", () => elements.reviewSheet.close());
elements.reviewSheet.addEventListener("click", (event) => {
  if (event.target === elements.reviewSheet) elements.reviewSheet.close();
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLElement && event.target.matches("input, select, button, a")) return;
  if (event.key === "ArrowLeft") editMode ? moveEditableReviewPoint(-1) : moveScene(-1);
  if (event.key === "ArrowRight") editMode ? moveEditableReviewPoint(1) : moveScene(1);
  if (event.key === " ") {
    event.preventDefault();
    setPlaying(!state.playing);
  }
});

for (const input of elements.annotationEditorInputs) {
  input.addEventListener("input", () => {
    const selection = state.editSelection;
    if (!selection) return;
    const next = displayedBox(selection.node, selection.field);
    for (const coordinateInput of elements.annotationEditorInputs) {
      const coordinate = coordinateInput.dataset.editCoordinate;
      if (coordinateInput.disabled || coordinateInput.value === "") continue;
      const index = { x: 0, y: 1, w: 2, h: 3 }[coordinate];
      const value = Number.parseFloat(coordinateInput.value);
      if (Number.isFinite(value)) next[index] = value;
    }
    const constrained = constrainEditableBox(next, selection.field, selection.padding);
    setDisplayedBox(selection.node, selection.field, constrained);
    updateEditorInputs(constrained, selection.field);
    commitEditSelection(constrained);
  });
}

elements.annotationEditorCopy.addEventListener("click", async () => {
  const copy = annotationDraftJson();
  try {
    await navigator.clipboard.writeText(copy);
    elements.annotationEditorStatus.value = "调整 JSON 已复制；可以直接粘贴回任务。";
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = copy;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    elements.annotationEditorStatus.value = "调整 JSON 已复制；可以直接粘贴回任务。";
  }
});

elements.annotationEditorDownload.addEventListener("click", () => {
  const blob = new Blob([annotationDraftJson()], { type: "application/json;charset=utf-8" });
  const link = document.createElement("a");
  const chapter = currentCatalogChapter()?.id || "storyboard";
  link.href = URL.createObjectURL(blob);
  link.download = `${chapter}-annotation-adjustments.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  elements.annotationEditorStatus.value = "调整 JSON 已下载；文件不包含 Capture、提示词或本地路径。";
});

elements.annotationEditorResetScene.addEventListener("click", () => {
  const prefix = `${state.sceneIndex}:`;
  for (const key of Object.keys(state.annotationDrafts)) {
    if (key.startsWith(prefix)) delete state.annotationDrafts[key];
  }
  persistAnnotationDrafts();
  renderScene({ resetElapsed: false });
  elements.annotationEditorStatus.value = "本镜头已恢复仓库中的原始坐标。";
});

renderLoading();
setSubtitlesVisible(subtitlesVisible);
updateFullscreenControl();

try {
  const catalog = await loadCatalog();
  const defaultChapter = catalog.chapters.find((chapter) => chapter.id === catalog.default_chapter);
  const timelineUrl = requestedTimelineUrl || defaultChapter?.timeline || fallbackTimelineUrl;
  if (requestedPlanUrl) {
    await loadReadmePlan(requestedPlanUrl, { sceneIndex: startScene, elapsedMs: startElapsedMs });
  } else {
    await loadTimeline(timelineUrl, { sceneIndex: startScene, elapsedMs: startElapsedMs });
  }
  window.requestAnimationFrame(tick);
  if (presentMode && autoplay) setPlaying(true);
} catch (error) {
  renderLoadError(error);
  console.error(error);
}
