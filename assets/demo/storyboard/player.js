const params = new URLSearchParams(window.location.search);
const catalogUrl = "/assets/demo/storyboard/catalog.zh-CN.json";
const fallbackTimelineUrl = "/assets/demo/source/quickstart/video/timeline.zh-CN.json";
const requestedTimelineUrl = params.get("timeline");
const presentMode = params.get("present") === "1";
const reviewMode = params.get("review") === "1";
const startScene = Number.parseInt(params.get("scene") || "0", 10);
const startElapsedMs = Number.parseInt(params.get("at_ms") || "0", 10);
const autoplay = params.get("autoplay") !== "0";
const subtitlesVisible = params.get("subtitles") !== "0";

if (presentMode) document.body.classList.add("present");
if (reviewMode) document.body.classList.add("review");
if (!subtitlesVisible) document.body.classList.add("no-subtitles");

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
  chapterSelect: document.querySelector(".chapter-select"),
  reviewPointSelect: document.querySelector(".review-point-select"),
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

const state = {
  catalog: null,
  timeline: null,
  timelineUrl: null,
  sceneIndex: 0,
  sceneElapsed: 0,
  playing: false,
  lastFrameTime: null,
  overlayTimers: [],
};

function setControlsDisabled(disabled) {
  for (const element of [
    elements.toggle,
    elements.previous,
    elements.next,
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
  next.set("timeline", state.timelineUrl);
  if (scene === null) next.delete("scene");
  else next.set("scene", String(scene));
  if (atMs === null) next.delete("at_ms");
  else next.set("at_ms", String(atMs));
  window.history.replaceState(null, "", `${window.location.pathname}?${next.toString()}`);
}

function populateChapterSelect() {
  const chapters = state.catalog?.chapters || [];
  elements.chapterSelect.replaceChildren(
    ...chapters.map((chapter) => {
      const option = document.createElement("option");
      option.value = chapter.timeline;
      option.textContent = chapter.label;
      return option;
    }),
  );
  if (!chapters.some((chapter) => chapter.timeline === state.timelineUrl)) {
    const option = document.createElement("option");
    option.value = state.timelineUrl;
    option.textContent = state.timeline?.title || "自定义章节";
    elements.chapterSelect.append(option);
  }
  elements.chapterSelect.value = state.timelineUrl;
}

function populateReviewPointSelect() {
  const points = state.timeline.review_points || [];
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = points.length ? "选择一个稳定复核点" : "本章没有声明复核点";
  elements.reviewPointSelect.replaceChildren(
    placeholder,
    ...points.map((point, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${String(index + 1).padStart(2, "0")} · ${point.name}`;
      return option;
    }),
  );
  elements.reviewPointSelect.disabled = points.length === 0;
  elements.reviewSummary.value = [
    `${state.timeline.scenes.length} 个镜头`,
    `${formatTime(state.timeline.duration_seconds)}`,
    `${points.length} 个渐进复核点`,
  ].join(" · ");

  const chapter = currentCatalogChapter();
  if (chapter?.guide && chapter?.guide_section) {
    elements.guideLink.href = `${chapter.guide}#${markdownHeadingSlug(chapter.guide_section)}`;
    elements.guideLink.textContent = `对应章节：${chapter.guide_section}`;
    elements.guideLink.title = chapter.guide;
    elements.guideLink.hidden = false;
  } else {
    elements.guideLink.hidden = true;
  }
}

function currentCatalogChapter() {
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

async function loadCatalog() {
  const response = await fetch(catalogUrl);
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
  const response = await fetch(timelineUrl);
  if (!response.ok) throw new Error(`无法载入时间线：${response.status}`);
  const timeline = await response.json();
  if (!Array.isArray(timeline.scenes) || timeline.scenes.length === 0) {
    throw new Error("时间线没有镜头");
  }

  state.timeline = timeline;
  state.timelineUrl = timelineUrl;
  document.body.dataset.storyTheme = timeline.theme || "codex";
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
  elements.reviewPointSelect.disabled = (timeline.review_points || []).length === 0;
  populateReviewSheet(currentCatalogChapter());
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

function renderOverlay(overlay) {
  const nodes = [];
  if (overlay.focus) {
    const focus = document.createElement("div");
    focus.className = "focus-box";
    setPercentBox(focus, overlay.focus);
    elements.annotationLayer.append(focus);
    nodes.push(focus);
  }

  if (overlay.label_box && overlay.label) {
    const label = document.createElement("div");
    label.className = overlay.type === "badge" ? "callout-label annotation-badge" : "callout-label";
    label.textContent = overlay.label;
    label.title = overlay.draft || "";
    setPercentBox(label, overlay.label_box);
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
    elements.annotationLayer.append(pulse);
    nodes.push(pulse);
  }

  return nodes;
}

function scheduleOverlays(scene, elapsedMs = 0) {
  clearOverlayTimers();
  elements.annotationLayer.replaceChildren();
  elements.annotationLines.replaceChildren();

  if (reviewMode) {
    for (const overlay of scene.overlays || []) {
      const delay = overlay.delay_ms || 0;
      const effectiveEnd = Number.isFinite(overlay.end_ms)
        ? overlay.end_ms
        : overlay.type === "click" ? delay + 1000 : Number.POSITIVE_INFINITY;
      if (delay > elapsedMs || effectiveEnd <= elapsedMs) continue;

      const nodes = renderOverlay(overlay);
      if (Number.isFinite(overlay.dim_ms) && overlay.dim_ms <= elapsedMs) {
        for (const node of nodes) node.classList.add("annotation-dim");
      }
    }
    return;
  }

  for (const overlay of scene.overlays || []) {
    const delay = overlay.delay_ms || 0;
    const effectiveEnd = Number.isFinite(overlay.end_ms)
      ? overlay.end_ms
      : overlay.type === "click" ? delay + 1000 : Number.POSITIVE_INFINITY;
    if (effectiveEnd <= elapsedMs) continue;

    const showOverlay = () => {
      const nodes = renderOverlay(overlay);
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
    elements.image.src = scene.source_image;
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
  state.playing = next;
  state.lastFrameTime = null;
  if (next) document.body.classList.add("has-started");
  document.body.dataset.playing = next ? "1" : "0";
  elements.toggle.textContent = next ? "暂停" : "播放";
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
elements.previous.addEventListener("click", () => moveScene(-1));
elements.next.addEventListener("click", () => moveScene(1));
elements.scrubber.addEventListener("input", () => {
  setPlaying(false);
  seekAbsolute((Number(elements.scrubber.value) / 1000) * state.timeline.duration_seconds);
});

elements.chapterSelect.addEventListener("change", async () => {
  try {
    await loadTimeline(elements.chapterSelect.value, { updateUrl: true });
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
  if (event.key === "ArrowLeft") moveScene(-1);
  if (event.key === "ArrowRight") moveScene(1);
  if (event.key === " ") {
    event.preventDefault();
    setPlaying(!state.playing);
  }
});

renderLoading();

try {
  const catalog = await loadCatalog();
  const defaultChapter = catalog.chapters.find((chapter) => chapter.id === catalog.default_chapter);
  const timelineUrl = requestedTimelineUrl || defaultChapter?.timeline || fallbackTimelineUrl;
  await loadTimeline(timelineUrl, { sceneIndex: startScene, elapsedMs: startElapsedMs });
  window.requestAnimationFrame(tick);
  if (presentMode && autoplay) setPlaying(true);
} catch (error) {
  renderLoadError(error);
  console.error(error);
}
