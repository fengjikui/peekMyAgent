#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "assets", "demo", "storyboard", "catalog.zh-CN.json");
const storyboardHref = "/assets/demo/storyboard/index.html";
const defaultVideoRoot = path.join(root, "tmp", "storyboard-video");
const options = parseArguments(process.argv.slice(2));
const videoRoot = options.videoRoot;

if (options.help) {
  printHelp();
  process.exit(0);
}

const model = buildReviewModel();
const html = renderReviewIndex(model);
validateGeneratedIndex(html, model);

if (options.check) {
  console.log(summaryLine("storyboard review index check passed", model));
  process.exit(0);
}

writeAtomically(options.output, html);
console.log(summaryLine("storyboard review index generated", model));
console.log(`file: ${relative(options.output)}`);
console.log(`open: http://127.0.0.1:${options.port}/${encodeURI(relative(options.output))}`);

function buildReviewModel() {
  const catalog = readJson(catalogPath);
  assert.equal(catalog.schema_version, 5, "storyboard catalog schema_version must be 5");
  assert(Array.isArray(catalog.chapters) && catalog.chapters.length > 0,
    "storyboard catalog must contain chapters");

  const chapters = catalog.chapters.map((chapter, index) => buildChapter(chapter, index));
  const videoCount = chapters.filter((chapter) => chapter.video).length;
  const verifiedVideoCount = chapters.filter((chapter) => chapter.video?.verified).length;
  const historicalClips = chapters.reduce((sum, chapter) => sum + chapter.history.length, 0);

  if (options.requireVideos) {
    assert.equal(videoCount, chapters.length,
      `expected one formal local picture master for every chapter; found ${videoCount}/${chapters.length}`);
    assert.equal(verifiedVideoCount, chapters.length,
      `expected every local picture master to have a matching publishable render manifest; found ${verifiedVideoCount}/${chapters.length}`);
  }

  return {
    candidateSha: gitHead(),
    candidateWorktreeDirty: gitWorkingTreeDirty(),
    chapters,
    historicalClips,
    schemaVersion: 1,
    videoCount,
    verifiedVideoCount,
  };
}

function buildChapter(chapter, index) {
  assert(typeof chapter.id === "string" && chapter.id, `catalog chapter ${index} needs an id`);
  assert(typeof chapter.label === "string" && chapter.label, `catalog chapter ${chapter.id} needs a label`);
  assert(typeof chapter.timeline === "string" && chapter.timeline.startsWith("/assets/demo/source/"),
    `catalog chapter ${chapter.id} needs a repository timeline`);
  assert(typeof chapter.guide === "string" && chapter.guide.startsWith("/docs/"),
    `catalog chapter ${chapter.id} needs a repository guide`);
  assert(chapter.review && typeof chapter.review === "object",
    `catalog chapter ${chapter.id} needs a review contract`);

  const timelinePath = repoPath(chapter.timeline);
  const timeline = readJson(timelinePath);
  assert(typeof timeline.title === "string" && timeline.title,
    `timeline ${chapter.id} needs a title`);
  assert(Number.isFinite(timeline.duration_seconds) && timeline.duration_seconds > 0,
    `timeline ${chapter.id} needs a positive duration`);
  assert.deepEqual(timeline.resolution, [1920, 1080],
    `timeline ${chapter.id} must use the 1920x1080 production baseline`);
  assert(Array.isArray(timeline.scenes) && timeline.scenes.length > 0,
    `timeline ${chapter.id} needs scenes`);
  assert(Array.isArray(timeline.review_points),
    `timeline ${chapter.id} needs review_points`);

  const video = findFormalVideo(chapter.id, chapter.timeline, timeline.duration_seconds);
  const guideAnchor = markdownHeadingSlug(chapter.guide_section || "");
  const timelineParameter = encodeURIComponent(chapter.timeline);
  return {
    id: chapter.id,
    index: index + 1,
    label: chapter.label,
    title: timeline.title,
    durationSeconds: timeline.duration_seconds,
    sceneCount: timeline.scenes.length,
    subtitleCueCount: timeline.scenes.reduce(
      (total, scene) => total + (Array.isArray(scene.subtitle_cues) ? scene.subtitle_cues.length : 0),
      0,
    ),
    reviewPointCount: timeline.review_points.length,
    theme: themeLabel(timeline.theme),
    templateHref: `${storyboardHref}?timeline=${timelineParameter}`,
    cleanPlaybackHref: `${storyboardHref}?timeline=${timelineParameter}&present=1&autoplay=0&subtitles=0`,
    guideHref: `${chapter.guide}${guideAnchor ? `#${guideAnchor}` : ""}`,
    guideSection: chapter.guide_section || "",
    review: chapter.review,
    video,
    history: findHistoricalVideos(chapter.id, video?.filePath || null),
  };
}

function findFormalVideo(chapterId, timelineHref, expectedDuration) {
  const directory = path.join(videoRoot, chapterId);
  const candidates = [
    path.join(directory, `pma-${chapterId}-picture-full.mp4`),
    path.join(directory, `pma-${chapterId}-picture.mp4`),
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) return null;

  const manifestPath = filePath.replace(/\.mp4$/i, ".render.json");
  const bytes = fs.statSync(filePath).size;
  let manifest = null;
  let verified = false;
  let issue = "缺少 render manifest";
  if (fs.existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
    const durationMatches = Math.abs(Number(manifest.duration_seconds) - expectedDuration) <= 0.05;
    const timelineMatches = `/${manifest.source_timeline}` === timelineHref;
    const shapeMatches = equalArrays(manifest.resolution, [1920, 1080])
      && Number(manifest.fps) === 30
      && manifest.audio === false
      && manifest.subtitles_visible === false;
    verified = manifest.chapter === chapterId
      && durationMatches
      && timelineMatches
      && shapeMatches
      && manifest.publishable_picture_master === true;
    issue = verified ? "" : "render manifest 与当前正式母版合同不一致";
  }

  return {
    bytes,
    filePath,
    href: `/${relative(filePath)}`,
    issue,
    manifest,
    manifestHref: fs.existsSync(manifestPath) ? `/${relative(manifestPath)}` : null,
    verified,
  };
}

function findHistoricalVideos(chapterId, formalVideoPath) {
  const directory = path.join(videoRoot, chapterId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp4"))
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => file !== formalVideoPath)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .map((file) => ({
      bytes: fs.statSync(file).size,
      href: `/${relative(file)}`,
      name: path.basename(file),
    }));
}

function renderReviewIndex(model) {
  const cards = model.chapters.map(renderChapterCard).join("\n");
  const json = JSON.stringify({
    candidateSha: model.candidateSha,
    candidateWorktreeDirty: model.candidateWorktreeDirty,
    chapterCount: model.chapters.length,
    chapters: model.chapters.map((chapter) => ({ id: chapter.id, label: chapter.label })),
    historicalClips: model.historicalClips,
    schemaVersion: model.schemaVersion,
    verifiedVideoCount: model.verifiedVideoCount,
    videoCount: model.videoCount,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>peekMyAgent · 中文演示统一审片</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f2ee;
      --card: #fffdf9;
      --ink: #23252a;
      --muted: #686c73;
      --line: #dedbd4;
      --soft: #eeebe5;
      --accent: #3569cf;
      --accent-soft: #eaf0ff;
      --ok: #267450;
      --ok-soft: #e8f5ee;
      --warn: #8c5b16;
      --warn-soft: #fff1d9;
      --change: #9c3d30;
      --change-soft: #faeae7;
      --shadow: 0 18px 55px rgba(41, 42, 45, .08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: var(--bg); }
    a { color: inherit; }
    button, a.action { font: inherit; }
    .page { width: min(1480px, calc(100% - 56px)); margin: 0 auto; padding: 48px 0 88px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 32px; align-items: end; margin-bottom: 30px; }
    .eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 13px; font-weight: 760; letter-spacing: .09em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 850px; font-size: clamp(34px, 4vw, 58px); line-height: 1.08; letter-spacing: -.035em; }
    .lede { max-width: 900px; margin: 18px 0 0; color: var(--muted); font-size: 17px; line-height: 1.75; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(112px, 1fr)); gap: 10px; }
    .summary-item { min-width: 112px; padding: 15px 17px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.55); }
    .summary-item strong { display: block; font-size: 24px; line-height: 1; }
    .summary-item span { display: block; margin-top: 7px; color: var(--muted); font-size: 12px; }
    .notice { display: flex; gap: 13px; align-items: flex-start; margin: 0 0 28px; padding: 15px 17px; border: 1px solid #d7d3ca; border-radius: 14px; background: #fbfaf7; color: #555960; line-height: 1.65; }
    .notice-badge { flex: 0 0 auto; padding: 3px 8px; border-radius: 999px; background: var(--ink); color: white; font-size: 11px; font-weight: 700; }
    .review-toolbar { display: grid; grid-template-columns: minmax(240px, 1fr) auto; gap: 18px; align-items: center; margin: -12px 0 28px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.52); }
    .review-progress-copy { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
    .review-progress-copy strong { color: var(--ink); }
    .review-progress-track { height: 7px; overflow: hidden; border-radius: 999px; background: #dfddd8; }
    .review-progress-bar { width: 0; height: 100%; border-radius: inherit; background: var(--accent); transition: width .25s ease; }
    .review-toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .review-toolbar-note { grid-column: 1 / -1; margin: -7px 0 0; color: var(--muted); font-size: 11px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .chapter { position: relative; overflow: hidden; min-width: 0; padding: 25px; border: 1px solid var(--line); border-radius: 20px; background: var(--card); box-shadow: 0 1px 0 rgba(255,255,255,.8) inset; }
    .chapter::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--accent); opacity: .72; }
    .chapter[data-review-decision="approved"]::before { background: var(--ok); }
    .chapter[data-review-decision="changes"]::before { background: var(--change); }
    .chapter[data-review-decision="deferred"]::before { background: var(--warn); }
    .chapter-head { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 14px; align-items: start; }
    .chapter-number { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--soft); font-size: 13px; font-weight: 760; }
    .chapter h2 { margin: 1px 0 5px; font-size: 21px; line-height: 1.25; letter-spacing: -.015em; }
    .chapter-title { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .status { white-space: nowrap; padding: 6px 9px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font-size: 11px; font-weight: 700; }
    .facts { display: flex; flex-wrap: wrap; gap: 7px; margin: 17px 0; }
    .fact { padding: 5px 8px; border-radius: 8px; background: var(--soft); color: #555961; font-size: 12px; }
    .question { margin: 0; font-size: 15px; font-weight: 650; line-height: 1.6; }
    .audience { margin: 7px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 19px; }
    .action { display: inline-flex; align-items: center; justify-content: center; min-height: 37px; padding: 0 13px; border: 1px solid var(--line); border-radius: 10px; background: white; color: var(--ink); text-decoration: none; cursor: pointer; }
    .action:hover { border-color: #aeb8ce; background: #f8faff; }
    .action.primary { border-color: var(--accent); background: var(--accent); color: white; }
    .action.secondary { border-color: #b9c8e9; background: var(--accent-soft); color: #274f9d; }
    .action[data-confirming="true"] { border-color: #dfaaa3; background: var(--change-soft); color: var(--change); }
    .action[disabled] { cursor: not-allowed; opacity: .48; }
    .video-state { display: flex; gap: 9px; align-items: center; margin-top: 13px; padding: 10px 12px; border-radius: 10px; background: var(--ok-soft); color: var(--ok); font-size: 12px; line-height: 1.45; }
    .video-state.missing { background: var(--warn-soft); color: var(--warn); }
    .dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
    .owner-review { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 10px; align-items: start; margin-top: 13px; padding: 12px; border: 1px solid var(--line); border-radius: 11px; background: #faf9f6; }
    .owner-review label { display: grid; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 650; }
    .owner-review select, .owner-review textarea { width: 100%; border: 1px solid #cbc8c1; border-radius: 8px; background: white; color: var(--ink); font: inherit; }
    .owner-review select { min-height: 39px; padding: 0 10px; }
    .owner-review textarea { min-height: 63px; padding: 9px 10px; resize: vertical; line-height: 1.45; }
    .owner-review textarea:focus, .owner-review select:focus { outline: 2px solid #b7c9f3; outline-offset: 1px; border-color: #7894d5; }
    details { margin-top: 17px; border-top: 1px solid var(--line); padding-top: 14px; }
    summary { cursor: pointer; color: #4e535c; font-size: 13px; font-weight: 650; }
    .review-copy { display: grid; gap: 11px; margin-top: 13px; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .review-copy p { margin: 0; }
    .review-copy strong { color: var(--ink); }
    .artifact-list, .history-list { display: flex; flex-wrap: wrap; gap: 7px; margin: 0; padding: 0; list-style: none; }
    .artifact-list a, .history-list a { color: #315aa8; text-decoration: none; }
    .artifact-list a:hover, .history-list a:hover { text-decoration: underline; }
    dialog { width: min(1180px, calc(100% - 44px)); padding: 0; border: 0; border-radius: 20px; background: #faf9f6; box-shadow: var(--shadow); }
    dialog::backdrop { background: rgba(29,31,35,.58); backdrop-filter: blur(6px); }
    .dialog-head { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 18px 21px; border-bottom: 1px solid var(--line); }
    .dialog-head h2 { margin: 0; font-size: 18px; }
    .dialog-close { width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 10px; background: white; cursor: pointer; }
    video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #111; }
    .dialog-note { margin: 0; padding: 13px 21px 17px; color: var(--muted); font-size: 12px; }
    footer { margin-top: 30px; color: var(--muted); font-size: 12px; line-height: 1.7; }
    @media (max-width: 1050px) {
      .page { width: min(100% - 30px, 760px); padding-top: 30px; }
      .hero { grid-template-columns: 1fr; align-items: start; }
      .summary { width: 100%; }
      .review-toolbar { grid-template-columns: 1fr; }
      .review-toolbar-actions { justify-content: flex-start; }
      .review-toolbar-note { grid-column: auto; }
      .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      .page { width: min(100% - 20px, 760px); }
      .summary { grid-template-columns: 1fr; }
      .chapter { padding: 20px 17px; }
      .chapter-head { grid-template-columns: 36px minmax(0, 1fr); }
      .chapter-number { width: 36px; height: 36px; }
      .status { grid-column: 2; justify-self: start; }
      .owner-review { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">peekMyAgent · 中文演示生产线</p>
        <h1>统一审片首页</h1>
        <p class="lede">一页审阅十个章节的 HTML 动效模板、无字幕干净播放和本地 MP4 母版。章节事实、状态与下一道确认门全部来自同一份 catalog；本页不复制真实 Capture，也不会把 Git 忽略的视频发布出去。</p>
      </div>
      <div class="summary" aria-label="审片资料统计">
        <div class="summary-item"><strong>${model.chapters.length}</strong><span>中文章节</span></div>
        <div class="summary-item"><strong>${model.verifiedVideoCount}/${model.chapters.length}</strong><span>已验证母版</span></div>
        <div class="summary-item"><strong>${model.historicalClips}</strong><span>历史试剪</span></div>
        <div class="summary-item"><strong id="reviewed-count">0/${model.chapters.length}</strong><span>本轮已审</span></div>
      </div>
    </header>

    <p class="notice"><span class="notice-badge">本地</span><span>请从仓库根目录通过只绑定 <code>127.0.0.1</code> 的静态服务器打开。正式母版默认没有音轨、字幕轨或网页字幕；需要逐句审阅时请打开“HTML 模板”，不要把历史切片误当成发布候选。当前候选：<code>${escapeHtml(shortSha(model.candidateSha))}</code>${model.candidateWorktreeDirty ? "（生成时工作区有未提交修改，仅供内部预览）" : "（干净工作区）"}。</span></p>

    <section class="review-toolbar" aria-label="本轮所有者审阅进度">
      <div>
        <div class="review-progress-copy"><strong id="review-progress-label">本轮尚未开始</strong><span id="review-save-state">只保存在当前浏览器</span></div>
        <div class="review-progress-track" aria-hidden="true"><div class="review-progress-bar"></div></div>
      </div>
      <div class="review-toolbar-actions">
        <button class="action secondary" id="export-review" type="button" disabled>导出审阅 JSON</button>
        <button class="action" id="clear-review" type="button" disabled>清空本轮记录</button>
      </div>
      <p class="review-toolbar-note">结论和备注不会上传，也不会自动修改 catalog。请勿在备注中写入 API Key、真实提示词、源码或隐私路径；导出的 JSON 仍需在分享前人工检查。</p>
    </section>

    <section class="grid" aria-label="中文演示章节">
${cards}
    </section>

    <footer>本页由 <code>scripts/generate-storyboard-review-index.mjs</code> 生成。修改 catalog、时间线或本地母版后重新运行即可；生成文件位于 Git 忽略的 <code>tmp/storyboard-video/</code>。</footer>
  </main>

  <dialog id="video-preview" aria-labelledby="video-preview-title">
    <header class="dialog-head">
      <h2 id="video-preview-title">视频母版预览</h2>
      <button class="dialog-close" type="button" aria-label="关闭视频预览">×</button>
    </header>
    <video controls playsinline preload="metadata"></video>
    <p class="dialog-note">本地无声画面母版 · 1920×1080 · 30 fps · H.264。关闭窗口时会自动暂停并清空视频地址。</p>
  </dialog>

  <script type="application/json" id="review-index-meta">${json}</script>
  <script>
    const dialog = document.querySelector("#video-preview");
    const video = dialog.querySelector("video");
    const title = dialog.querySelector("h2");
    document.querySelectorAll("[data-video-preview]").forEach((button) => {
      button.addEventListener("click", () => {
        video.src = button.dataset.videoPreview;
        title.textContent = button.dataset.videoTitle;
        dialog.showModal();
      });
    });
    const closePreview = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      dialog.close();
    };
    dialog.querySelector(".dialog-close").addEventListener("click", closePreview);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closePreview();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePreview();
    });

    const reviewMeta = JSON.parse(document.querySelector("#review-index-meta").textContent);
    const reviewStorageKey = "peekmyagent.storyboardOwnerReview.v1." + reviewMeta.candidateSha;
    const allowedReviewDecisions = new Set(["pending", "approved", "changes", "deferred"]);
    const reviewDecisionLabels = {
      pending: "未审阅",
      approved: "故事线通过",
      changes: "需要修改",
      deferred: "暂缓决定",
    };
    const reviewedCount = document.querySelector("#reviewed-count");
    const reviewProgressLabel = document.querySelector("#review-progress-label");
    const reviewProgressBar = document.querySelector(".review-progress-bar");
    const reviewSaveState = document.querySelector("#review-save-state");
    const exportReview = document.querySelector("#export-review");
    const clearReview = document.querySelector("#clear-review");
    let reviewStorageAvailable = true;
    let reviewState = loadReviewState();
    let clearConfirmationTimer = null;

    function emptyReviewState() {
      return {
        schema_version: 1,
        kind: "storyboard_owner_review",
        candidate_sha: reviewMeta.candidateSha,
        candidate_worktree_dirty: reviewMeta.candidateWorktreeDirty,
        updated_at: null,
        chapters: Object.fromEntries(reviewMeta.chapters.map((chapter) => [chapter.id, {
          decision: "pending",
          note: "",
          updated_at: null,
        }])),
      };
    }

    function loadReviewState() {
      const fallback = emptyReviewState();
      try {
        const raw = localStorage.getItem(reviewStorageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (parsed?.schema_version !== 1 || parsed?.candidate_sha !== reviewMeta.candidateSha) return fallback;
        for (const chapter of reviewMeta.chapters) {
          const existing = parsed.chapters?.[chapter.id];
          const decision = allowedReviewDecisions.has(existing?.decision) ? existing.decision : "pending";
          fallback.chapters[chapter.id] = {
            decision,
            note: String(existing?.note || "").slice(0, 2000),
            updated_at: typeof existing?.updated_at === "string" ? existing.updated_at : null,
          };
        }
        fallback.updated_at = typeof parsed.updated_at === "string" ? parsed.updated_at : null;
        return fallback;
      } catch {
        reviewStorageAvailable = false;
        return fallback;
      }
    }

    function persistReviewState() {
      try {
        localStorage.setItem(reviewStorageKey, JSON.stringify(reviewState));
        reviewStorageAvailable = true;
        reviewSaveState.textContent = "已保存在当前浏览器";
      } catch {
        reviewStorageAvailable = false;
        reviewSaveState.textContent = "浏览器拒绝本地保存；请及时导出 JSON";
      }
    }

    function updateChapterReview(chapterId, patch) {
      const entry = reviewState.chapters[chapterId];
      if (!entry) return;
      resetClearConfirmation();
      Object.assign(entry, patch);
      const now = new Date().toISOString();
      entry.updated_at = now;
      reviewState.updated_at = now;
      persistReviewState();
      renderReviewProgress();
    }

    function renderReviewProgress() {
      let completed = 0;
      let hasData = false;
      for (const chapter of reviewMeta.chapters) {
        const card = document.getElementById(chapter.id);
        const entry = reviewState.chapters[chapter.id];
        const decision = allowedReviewDecisions.has(entry?.decision) ? entry.decision : "pending";
        const note = String(entry?.note || "").slice(0, 2000);
        if (decision !== "pending") completed += 1;
        if (decision !== "pending" || note.trim()) hasData = true;
        card.dataset.reviewDecision = decision;
        card.querySelector("[data-review-decision-input]").value = decision;
        if (card.querySelector("[data-review-note]").value !== note) {
          card.querySelector("[data-review-note]").value = note;
        }
      }
      reviewedCount.textContent = String(completed) + "/" + String(reviewMeta.chapterCount);
      reviewProgressBar.style.width = String((completed / reviewMeta.chapterCount) * 100) + "%";
      reviewProgressLabel.textContent = completed === 0
        ? "本轮尚未开始"
        : completed === reviewMeta.chapterCount
          ? "十章审阅已完成"
          : "已审 " + String(completed) + " / " + String(reviewMeta.chapterCount) + " 章";
      exportReview.disabled = !hasData;
      clearReview.disabled = !hasData;
      if (!reviewStorageAvailable) reviewSaveState.textContent = "浏览器拒绝本地保存；请及时导出 JSON";
    }

    function buildReviewExportPayload() {
      const decisions = reviewMeta.chapters.map((chapter) => {
        const entry = reviewState.chapters[chapter.id];
        return {
          chapter_id: chapter.id,
          chapter_label: chapter.label,
          decision: entry.decision,
          decision_label: reviewDecisionLabels[entry.decision],
          note: entry.note,
          updated_at: entry.updated_at,
        };
      });
      return {
        schema_version: 1,
        kind: "peekmyagent_storyboard_owner_review",
        candidate_sha: reviewMeta.candidateSha,
        candidate_worktree_dirty: reviewMeta.candidateWorktreeDirty,
        exported_at: new Date().toISOString(),
        chapter_count: reviewMeta.chapterCount,
        reviewed_count: decisions.filter((item) => item.decision !== "pending").length,
        decisions,
        privacy_notice: "Review notes are user-authored local data. Inspect them before sharing; they may contain sensitive text.",
      };
    }

    function downloadReviewJson() {
      resetClearConfirmation();
      const payload = buildReviewExportPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2) + "\\n"], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "pma-storyboard-review-" + reviewMeta.candidateSha.slice(0, 8) + ".json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 0);
      reviewSaveState.textContent = "审阅 JSON 已导出；分享前请检查备注";
    }

    function resetClearConfirmation() {
      if (clearConfirmationTimer) clearTimeout(clearConfirmationTimer);
      clearConfirmationTimer = null;
      delete clearReview.dataset.confirming;
      clearReview.textContent = "清空本轮记录";
      reviewSaveState.textContent = reviewStorageAvailable
        ? reviewState.updated_at ? "已保存在当前浏览器" : "只保存在当前浏览器"
        : "浏览器拒绝本地保存；请及时导出 JSON";
    }

    for (const chapter of reviewMeta.chapters) {
      const card = document.getElementById(chapter.id);
      card.querySelector("[data-review-decision-input]").addEventListener("change", (event) => {
        updateChapterReview(chapter.id, { decision: event.target.value });
      });
      card.querySelector("[data-review-note]").addEventListener("input", (event) => {
        updateChapterReview(chapter.id, { note: event.target.value.slice(0, 2000) });
      });
    }
    exportReview.addEventListener("click", downloadReviewJson);
    clearReview.addEventListener("click", () => {
      if (clearReview.dataset.confirming !== "true") {
        clearReview.dataset.confirming = "true";
        clearReview.textContent = "再次点击确认清空";
        reviewSaveState.textContent = "再次点击才会清空当前候选的记录";
        clearConfirmationTimer = setTimeout(resetClearConfirmation, 15000);
        return;
      }
      resetClearConfirmation();
      try {
        localStorage.removeItem(reviewStorageKey);
        reviewStorageAvailable = true;
      } catch {
        reviewStorageAvailable = false;
      }
      reviewState = emptyReviewState();
      reviewSaveState.textContent = reviewStorageAvailable ? "本轮记录已清空" : "本轮内存记录已清空";
      renderReviewProgress();
    });
    renderReviewProgress();
  </script>
</body>
</html>
`;
}

function renderChapterCard(chapter) {
  const status = statusLabel(chapter.review.status);
  const videoActions = chapter.video
    ? `<a class="action secondary" href="${escapeAttribute(chapter.video.href)}" target="_blank" rel="noopener">打开 MP4</a>
          <button class="action" type="button" data-video-preview="${escapeAttribute(chapter.video.href)}" data-video-title="${escapeAttribute(`${chapter.label} · 视频母版`)}">页内播放</button>`
    : `<button class="action" type="button" disabled>MP4 尚未生成</button>`;
  const videoState = chapter.video
    ? `<div class="video-state ${chapter.video.verified ? "" : "missing"}"><span class="dot"></span><span>${chapter.video.verified ? `正式母版已验证 · ${formatBytes(chapter.video.bytes)} · ${escapeHtml(shortSha(chapter.video.manifest.source_commit))}` : escapeHtml(chapter.video.issue)}</span></div>`
    : `<div class="video-state missing"><span class="dot"></span><span>当前工作区没有本章正式 MP4；HTML、旁白、字幕和审阅帧仍可使用。</span></div>`;
  const artifactLabels = {
    narration: "旁白",
    subtitles: "SRT",
    manifest: "manifest",
    review_1920: "1920 联系表",
    review_1024: "1024 联系表",
  };
  const artifacts = Object.entries(chapter.review.artifacts || {})
    .map(([key, href]) => `<li><a href="${escapeAttribute(href)}" target="_blank" rel="noopener">${escapeHtml(artifactLabels[key] || key)}</a></li>`)
    .join("");
  const renderManifest = chapter.video?.manifestHref
    ? `<li><a href="${escapeAttribute(chapter.video.manifestHref)}" target="_blank" rel="noopener">render manifest</a></li>`
    : "";
  const history = chapter.history.length
    ? `<p><strong>历史试剪（不作为正式母版）</strong></p><ul class="history-list">${chapter.history.map((clip) => (
        `<li><a href="${escapeAttribute(clip.href)}" target="_blank" rel="noopener">${escapeHtml(clip.name)} · ${formatBytes(clip.bytes)}</a></li>`
      )).join("")}</ul>`
    : "";

  return `      <article class="chapter" id="${escapeAttribute(chapter.id)}" data-review-decision="pending">
        <header class="chapter-head">
          <span class="chapter-number">${String(chapter.index).padStart(2, "0")}</span>
          <div>
            <h2>${escapeHtml(chapter.label)}</h2>
            <p class="chapter-title">${escapeHtml(chapter.title)}</p>
          </div>
          <span class="status">${escapeHtml(status)}</span>
        </header>
        <div class="facts">
          <span class="fact">${formatDuration(chapter.durationSeconds)}</span>
          <span class="fact">${chapter.sceneCount} 镜头</span>
          <span class="fact">${chapter.subtitleCueCount} 条字幕</span>
          <span class="fact">${chapter.reviewPointCount} 个复核点</span>
          ${chapter.theme ? `<span class="fact">${escapeHtml(chapter.theme)} 主题</span>` : ""}
        </div>
        <p class="question">${escapeHtml(chapter.review.question)}</p>
        <p class="audience">面向：${escapeHtml(chapter.review.audience)}</p>
        <div class="actions">
          <a class="action primary" href="${escapeAttribute(chapter.templateHref)}" target="_blank" rel="noopener">HTML 模板</a>
          <a class="action" href="${escapeAttribute(chapter.cleanPlaybackHref)}" target="_blank" rel="noopener">干净播放</a>
          ${videoActions}
          <a class="action" href="${escapeAttribute(chapter.guideHref)}" target="_blank" rel="noopener">中文章节</a>
        </div>
        ${videoState}
        <div class="owner-review" aria-label="${escapeAttribute(chapter.label)}的本轮审阅记录">
          <label>本轮结论
            <select data-review-decision-input>
              <option value="pending">未审阅</option>
              <option value="approved">故事线通过</option>
              <option value="changes">需要修改</option>
              <option value="deferred">暂缓决定</option>
            </select>
          </label>
          <label>短备注（可选）
            <textarea data-review-note maxlength="2000" rows="2" placeholder="例如：02:14 的箭头应改为只框住 call_id"></textarea>
          </label>
        </div>
        <details>
          <summary>本章证据、下一道门与制作资料</summary>
          <div class="review-copy">
            <p><strong>Source：</strong>${escapeHtml(chapter.review.source.label)}</p>
            <p><strong>证据边界：</strong>${escapeHtml(chapter.review.source.boundary)}</p>
            <p><strong>下一道门：</strong>${escapeHtml(chapter.review.next_gate)}</p>
            <p><strong>对应章节：</strong>${escapeHtml(chapter.guideSection)}</p>
            <ul class="artifact-list">${artifacts}${renderManifest}</ul>
            ${history}
          </div>
        </details>
      </article>`;
}

function validateGeneratedIndex(html, model) {
  assert.match(html, /^<!doctype html>/);
  assert.match(model.candidateSha, /^[0-9a-f]{40}$/i,
    "review candidate must name an exact Git commit");
  assert(html.includes("统一审片首页"), "generated index needs its visible title");
  assert.equal(countMatches(html, /<article class="chapter"/g), model.chapters.length,
    "generated index must render one card for every catalog chapter");
  assert.equal(countMatches(html, />HTML 模板<\/a>/g), model.chapters.length,
    "generated index must expose every HTML template");
  assert.equal(countMatches(html, />干净播放<\/a>/g), model.chapters.length,
    "generated index must expose every clean playback URL");
  assert.equal(countMatches(html, />中文章节<\/a>/g), model.chapters.length,
    "generated index must expose every mapped Chinese guide");
  assert.equal(countMatches(html, /data-video-preview=/g), model.videoCount,
    "generated index must expose every locally available formal video");
  assert.equal(countMatches(html, /<select data-review-decision-input>/g), model.chapters.length,
    "generated index must render and bind one review decision control per chapter");
  assert.equal(countMatches(html, /<textarea data-review-note/g), model.chapters.length,
    "generated index must render and bind one review note control per chapter");
  assert(html.includes("peekmyagent.storyboardOwnerReview.v1."),
    "generated index must scope local review state by candidate SHA");
  assert(html.includes("kind: \"peekmyagent_storyboard_owner_review\""),
    "generated index must expose the documented review export kind");
  assert(html.includes("function buildReviewExportPayload()"),
    "generated index must expose a deterministic review export payload");
  assert(html.includes("localStorage.setItem(reviewStorageKey"),
    "generated index must persist review state only in the local browser");
  assert(html.includes("再次点击确认清空") && !html.includes("window.confirm("),
    "generated index must use a non-blocking two-step clear confirmation");
  for (const chapter of model.chapters) {
    assert(html.includes(`id="${chapter.id}"`), `generated index is missing chapter ${chapter.id}`);
    assert(html.includes(escapeAttribute(chapter.templateHref)),
      `generated index is missing the template URL for ${chapter.id}`);
  }
  assert(!html.includes(root), "generated index must not expose the local absolute repository path");
}

function parseArguments(args) {
  const parsed = {
    check: false,
    help: false,
    output: path.join(defaultVideoRoot, "review-index.html"),
    port: 43115,
    requireVideos: false,
    videoRoot: defaultVideoRoot,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") parsed.check = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--output") parsed.output = path.resolve(root, requiredValue(args, ++index, argument));
    else if (argument === "--port") parsed.port = Number.parseInt(requiredValue(args, ++index, argument), 10);
    else if (argument === "--require-videos") parsed.requireVideos = true;
    else if (argument === "--video-root") parsed.videoRoot = path.resolve(root, requiredValue(args, ++index, argument));
    else throw new Error(`unknown option: ${argument}`);
  }
  assert(Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535,
    "--port must be an integer between 1 and 65535");
  assert(path.extname(parsed.output).toLowerCase() === ".html", "--output must end in .html");
  assert(parsed.videoRoot === root || parsed.videoRoot.startsWith(`${root}${path.sep}`),
    "--video-root must stay inside the repository workspace");
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/generate-storyboard-review-index.mjs [options]

Options:
  --output <file.html>  Generated page (default: tmp/storyboard-video/review-index.html)
  --port <number>       Port shown in the printed local URL (default: 43115)
  --video-root <dir>    Local picture-master root (default: tmp/storyboard-video)
  --require-videos      Fail unless all catalog chapters have a verified local picture master
  --check               Validate catalog and generated HTML without writing a file
  -h, --help            Show this help

The page only links repository-relative storyboard assets and Git-ignored local videos.
Owner decisions and notes stay in localStorage, scoped to the exact candidate HEAD,
until the reviewer explicitly exports a JSON handoff. The page never updates catalog.
It never embeds a Capture, API key, or absolute local repository path.`);
}

function statusLabel(value) {
  return {
    draft: "制作中",
    "owner-review": "等待中文故事审阅",
    "ready-for-voice": "故事已确认，可进入配音",
    published: "已发布",
  }[value] || String(value || "状态未知");
}

function themeLabel(value) {
  return {
    claude: "Claude Code",
    codex: "Codex",
    "codex-and-claude": "Codex + Claude Code",
  }[value] || String(value || "");
}

function markdownHeadingSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, "-");
}

function writeAtomically(file, contents) {
  assert(file === root || file.startsWith(`${root}${path.sep}`),
    "--output must stay inside the repository workspace");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(temporary, contents, "utf8");
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0,
    `could not resolve the review candidate commit: ${String(result.stderr || result.error || "unknown Git error").trim()}`);
  return result.stdout.trim();
}

function gitWorkingTreeDirty() {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0,
    `could not inspect the review candidate worktree: ${String(result.stderr || result.error || "unknown Git error").trim()}`);
  return Boolean(result.stdout.trim());
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function repoPath(href) {
  const file = path.resolve(root, href.replace(/^\/+/, ""));
  assert(file.startsWith(`${root}${path.sep}`), `repository href escapes the workspace: ${href}`);
  assert(fs.existsSync(file), `repository href does not exist: ${href}`);
  return file;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function summaryLine(prefix, model) {
  return `${prefix}: ${model.chapters.length} chapters, ${model.videoCount} local videos, ${model.verifiedVideoCount} verified picture masters, ${model.historicalClips} historical clips`;
}

function formatDuration(seconds) {
  const rounded = Math.round(seconds);
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function shortSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || "")) ? String(value).slice(0, 8) : "SHA 未记录";
}

function equalArrays(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
