#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { validateStoryboardNarrativeContract } from "./storyboard-narrative-contract.mjs";
import { documentationImpactRuleIds } from "./documentation-consistency-audit.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "assets", "demo", "source");
const storyboardRoot = path.join(root, "assets", "demo", "storyboard");
const catalogPath = path.join(storyboardRoot, "catalog.zh-CN.json");
const mediaBudgetPath = path.join(root, "assets", "demo", "media-budget.json");
const minimumBadgeNarrationGapMs = 2500;
const strict = process.argv.includes("--strict");
const requested = process.argv.slice(2).filter((argument) => argument !== "--strict");
const chapterDirs = requested.length
  ? requested.map(resolveChapterDirectory)
  : discoverChapterDirectories();

assert(chapterDirs.length > 0, "no demo chapters with a manifest and timeline were found");

const totals = {
  chapters: 0,
  scenes: 0,
  subtitleCues: 0,
  sourceImages: 0,
  reviewFrames: 0,
  catalogEntries: 0,
  guideMappings: 0,
  reviewContracts: 0,
  narrativeContracts: 0,
  freshnessContracts: 0,
  trackableMediaFiles: 0,
  trackableMediaBytes: 0,
};
const warnings = [];

auditStoryboardCatalog();
auditMediaBudget();
for (const chapterDir of chapterDirs) auditChapter(chapterDir);

for (const warning of warnings) console.warn(`demo production audit warning: ${warning}`);
console.log([
  "demo production audit passed:",
  `${totals.chapters} chapters,`,
  `${totals.scenes} scenes,`,
  `${totals.subtitleCues} subtitle cues,`,
  `${totals.sourceImages} source images,`,
  `${totals.reviewFrames} review frames,`,
  `${totals.catalogEntries} catalog entries,`,
  `${totals.guideMappings} guide mappings,`,
  `${totals.reviewContracts} review contracts,`,
  `${totals.narrativeContracts} narrative contracts,`,
  `${totals.freshnessContracts} freshness contracts,`,
  `${totals.trackableMediaFiles} trackable media files,`,
  `${formatMiB(totals.trackableMediaBytes)} trackable media`,
].join(" "));

function auditStoryboardCatalog() {
  const readmeSourceCaptureScript = path.join(root, "scripts", "capture-readme-source-frames.mjs");
  assertFile(readmeSourceCaptureScript, "README Source capture script");
  assertTrackable(readmeSourceCaptureScript, "README Source capture script");
  scanTextPrivacy(readmeSourceCaptureScript, "README Source capture script");
  const readmeSourceCapture = fs.readFileSync(readmeSourceCaptureScript, "utf8");
  assert(
    readmeSourceCapture.includes("readme-media-demo.mjs")
      && readmeSourceCapture.includes("Page.captureScreenshot")
      && readmeSourceCapture.includes("1920x1080"),
    "README Source capture must operate the deterministic Viewer and enforce a full 1920x1080 frame",
  );

  const claudeToolLoopCaptureScript = path.join(root, "scripts", "capture-claude-tool-loop-source-frames.mjs");
  assertFile(claudeToolLoopCaptureScript, "Claude tool-loop Source capture script");
  assertTrackable(claudeToolLoopCaptureScript, "Claude tool-loop Source capture script");
  scanTextPrivacy(claudeToolLoopCaptureScript, "Claude tool-loop Source capture script");
  const claudeToolLoopCapture = fs.readFileSync(claudeToolLoopCaptureScript, "utf8");
  assert(
    claudeToolLoopCapture.includes("claude-mechanisms-media-demo.mjs")
      && claudeToolLoopCapture.includes("Page.captureScreenshot")
      && claudeToolLoopCapture.includes("1920x1080")
      && claudeToolLoopCapture.includes("dataset.theme === 'studio'"),
    "Claude tool-loop Source capture must operate the deterministic Viewer in Claude theme and enforce a full 1920x1080 frame",
  );

  const narrativeContractScript = path.join(root, "scripts", "storyboard-narrative-contract.mjs");
  assertFile(narrativeContractScript, "storyboard narrative contract validator");
  assertTrackable(narrativeContractScript, "storyboard narrative contract validator");
  scanTextPrivacy(narrativeContractScript, "storyboard narrative contract validator");

  const freshnessAuditScript = path.join(root, "scripts", "demo-freshness-audit.mjs");
  assertFile(freshnessAuditScript, "demo freshness audit");
  assertTrackable(freshnessAuditScript, "demo freshness audit");
  scanTextPrivacy(freshnessAuditScript, "demo freshness audit");

  const reviewCaptureScript = path.join(root, "scripts", "capture-storyboard-review-frames.mjs");
  assertFile(reviewCaptureScript, "storyboard review capture script");
  assertTrackable(reviewCaptureScript, "storyboard review capture script");
  scanTextPrivacy(reviewCaptureScript, "storyboard review capture script");
  const reviewCaptureSource = fs.readFileSync(reviewCaptureScript, "utf8");
  assert(
    reviewCaptureSource.includes("review_points")
      && reviewCaptureSource.includes('url.searchParams.set("review", "1")')
      && reviewCaptureSource.includes('Page.captureScreenshot'),
    "storyboard review capture script must use timeline review points and frozen browser capture",
  );

  const videoExportScript = path.join(root, "scripts", "export-storyboard-video.mjs");
  assertFile(videoExportScript, "storyboard video export script");
  assertTrackable(videoExportScript, "storyboard video export script");
  scanTextPrivacy(videoExportScript, "storyboard video export script");
  const videoExportSource = fs.readFileSync(videoExportScript, "utf8");
  assert(
    videoExportSource.includes("Page.startScreencast")
      && videoExportSource.includes('url.searchParams.set("subtitles"')
      && videoExportSource.includes("publishable_picture_master")
      && videoExportSource.includes("ffprobe"),
    "storyboard video export must record the real webpage, support a clean subtitle-free master, and verify MP4 output",
  );

  const reviewIndexScript = path.join(root, "scripts", "generate-storyboard-review-index.mjs");
  assertFile(reviewIndexScript, "storyboard review index generator");
  assertTrackable(reviewIndexScript, "storyboard review index generator");
  scanTextPrivacy(reviewIndexScript, "storyboard review index generator");
  const reviewIndexSource = fs.readFileSync(reviewIndexScript, "utf8");
  assert(
    reviewIndexSource.includes("catalog.zh-CN.json")
      && reviewIndexSource.includes("review-index.html")
      && reviewIndexSource.includes("data-video-preview")
      && reviewIndexSource.includes("peekmyagent.storyboardOwnerReview.v1.")
      && reviewIndexSource.includes("buildReviewExportPayload")
      && reviewIndexSource.includes("candidateSha")
      && reviewIndexSource.includes("--require-videos"),
    "storyboard review index must derive chapter links from catalog, distinguish verified local videos, and export local owner review against an exact candidate SHA",
  );

  const reviewHandoffScript = path.join(root, "scripts", "storyboard-review-handoff.mjs");
  assertFile(reviewHandoffScript, "storyboard review handoff validator");
  assertTrackable(reviewHandoffScript, "storyboard review handoff validator");
  scanTextPrivacy(reviewHandoffScript, "storyboard review handoff validator");
  const reviewHandoffSource = fs.readFileSync(reviewHandoffScript, "utf8");
  assert(
    reviewHandoffSource.includes("peekmyagent_storyboard_owner_review")
      && reviewHandoffSource.includes("candidate_worktree_dirty")
      && reviewHandoffSource.includes("privacyRules")
      && reviewHandoffSource.includes("--show-notes")
      && reviewHandoffSource.includes("read-only with respect to catalog"),
    "storyboard review handoff must validate the exported schema, candidate cleanliness, privacy boundary, and explicit note disclosure",
  );

  for (const name of ["index.html", "player.css", "player.js", "README.md", "catalog.zh-CN.json"]) {
    const file = path.join(storyboardRoot, name);
    assertFile(file, "storyboard player artifact");
    assertTrackable(file, "storyboard player artifact");
    scanTextPrivacy(file, "storyboard");
  }

  const catalog = readJson(catalogPath);
  assert(catalog.schema_version === 5, "storyboard catalog schema_version must be 5");
  assert(Array.isArray(catalog.chapters) && catalog.chapters.length > 0,
    "storyboard catalog must contain chapters");

  const ids = new Set();
  const timelines = new Set();
  const reviewStatuses = new Set(["draft", "owner-review", "ready-for-voice", "published"]);
  const reviewArtifacts = ["narration", "subtitles", "manifest", "review_1920", "review_1024"];
  const knownImpactIds = new Set(documentationImpactRuleIds());
  for (const [index, chapter] of catalog.chapters.entries()) {
    const label = `storyboard catalog chapters[${index}]`;
    assert(typeof chapter.id === "string" && chapter.id.length > 0, `${label} needs an id`);
    assert(!ids.has(chapter.id), `${label} duplicates id ${chapter.id}`);
    ids.add(chapter.id);
    assert(typeof chapter.label === "string" && chapter.label.length > 0, `${label} needs a label`);
    assert(typeof chapter.timeline === "string" && chapter.timeline.startsWith("/assets/demo/source/"),
      `${label}.timeline must stay under /assets/demo/source`);
    assert(!timelines.has(chapter.timeline), `${label} duplicates timeline ${chapter.timeline}`);
    timelines.add(chapter.timeline);
    const timeline = path.join(root, chapter.timeline.slice(1));
    assertFile(timeline, `${label} timeline`);
    assert(path.basename(path.dirname(path.dirname(timeline))) === chapter.id,
      `${label}.id must match its source directory`);
    assert(typeof chapter.guide === "string" && chapter.guide.startsWith("/docs/"),
      `${label}.guide must stay under /docs`);
    assert(typeof chapter.guide_section === "string" && chapter.guide_section.trim(),
      `${label}.guide_section is required`);
    const guide = path.join(root, chapter.guide.slice(1));
    assertFile(guide, `${label} guide`);
    assertTrackable(guide, `${label} guide`);
    scanTextPrivacy(guide, "storyboard guide");
    assert(markdownHeadings(fs.readFileSync(guide, "utf8")).includes(chapter.guide_section),
      `${label}.guide_section must name a real Markdown heading: ${chapter.guide_section}`);
    totals.guideMappings += 1;

    const review = chapter.review;
    assert(review && typeof review === "object" && !Array.isArray(review),
      `${label}.review is required`);
    for (const field of ["question", "audience", "next_gate"]) {
      assert(typeof review[field] === "string" && review[field].trim().length >= 12,
        `${label}.review.${field} must be a concrete sentence`);
    }
    assert(reviewStatuses.has(review.status),
      `${label}.review.status must be one of ${[...reviewStatuses].join(", ")}`);
    const productImpactIds = review.freshness?.product_impact_ids;
    assert(Array.isArray(productImpactIds) && productImpactIds.length > 0,
      `${label}.review.freshness.product_impact_ids is required`);
    assert(new Set(productImpactIds).size === productImpactIds.length,
      `${label}.review.freshness.product_impact_ids must be unique`);
    for (const impactId of productImpactIds) {
      assert(knownImpactIds.has(impactId), `${label} has unknown freshness impact id ${impactId}`);
      assert(impactId !== "demo-production",
        `${label} product freshness must not use demo-production`);
    }
    totals.freshnessContracts += 1;
    assert(review.source && typeof review.source === "object" && !Array.isArray(review.source),
      `${label}.review.source is required`);
    for (const field of ["label", "boundary"]) {
      assert(typeof review.source[field] === "string" && review.source[field].trim().length >= 12,
        `${label}.review.source.${field} must be a concrete sentence`);
    }
    assert(review.artifacts && typeof review.artifacts === "object" && !Array.isArray(review.artifacts),
      `${label}.review.artifacts is required`);
    assert(equalArrays(Object.keys(review.artifacts).sort(), [...reviewArtifacts].sort()),
      `${label}.review.artifacts must contain ${reviewArtifacts.join(", ")}`);
    const reviewArtifactPaths = {};
    for (const artifact of reviewArtifacts) {
      const href = review.artifacts[artifact];
      assert(typeof href === "string" && href.startsWith("/assets/demo/"),
        `${label}.review.artifacts.${artifact} must stay under /assets/demo`);
      const artifactPath = path.join(root, href.slice(1));
      assertFile(artifactPath, `${label} review artifact ${artifact}`);
      assertTrackable(artifactPath, `${label} review artifact ${artifact}`);
      reviewArtifactPaths[artifact] = artifactPath;
    }
    validateStoryboardNarrativeContract({
      label,
      chapter,
      timeline: readJson(timeline),
      manifest: readJson(reviewArtifactPaths.manifest),
    });
    totals.narrativeContracts += 1;
    totals.reviewContracts += 1;
  }

  assert(ids.has(catalog.default_chapter), "storyboard catalog default_chapter must name a chapter");
  const discoveredIds = discoverChapterDirectories().map((directory) => path.basename(directory)).sort();
  assert(equalArrays([...ids].sort(), discoveredIds),
    "storyboard catalog must list every publishable chapter exactly once");

  const html = fs.readFileSync(path.join(storyboardRoot, "index.html"), "utf8");
  const player = fs.readFileSync(path.join(storyboardRoot, "player.js"), "utf8");
  assert(html.includes("chapter-select") && html.includes("review-point-select"),
    "storyboard player must expose chapter and review-point controls");
  assert(html.includes("guide-link"),
    "storyboard player must expose the mapped Chinese guide in review mode");
  assert(html.includes("review-sheet-open") && html.includes("review-sheet-artifacts"),
    "storyboard player must expose the chapter review sheet in production mode");
  assert(player.includes("catalog.zh-CN.json") && player.includes("review_points"),
    "storyboard player must load the catalog and timeline review points");
  assert(player.includes("guide_section") && player.includes("markdownHeadingSlug"),
    "storyboard player must resolve the mapped guide section");
  assert(player.includes("review.artifacts") && player.includes("showModal"),
    "storyboard player must render the catalog review contract");
  assert(player.includes("timelineReady") && player.includes("subtitlesVisible"),
    "storyboard player must expose export readiness and a clean subtitle-free playback mode");
  totals.catalogEntries = catalog.chapters.length;
}

function auditMediaBudget() {
  assertFile(mediaBudgetPath, "demo media budget");
  assertTrackable(mediaBudgetPath, "demo media budget");
  scanTextPrivacy(mediaBudgetPath, "demo media budget");
  const budget = readJson(mediaBudgetPath);
  assert(budget.schema_version === 1, "demo media budget schema_version must be 1");
  for (const key of [
    "max_total_media_bytes",
    "max_source_chapter_media_bytes",
    "max_still_bytes",
    "max_gif_bytes",
  ]) {
    assert(Number.isInteger(budget[key]) && budget[key] > 0,
      `demo media budget ${key} must be a positive integer`);
  }
  assert(Number.isFinite(budget.warn_at_ratio) && budget.warn_at_ratio > 0 && budget.warn_at_ratio < 1,
    "demo media budget warn_at_ratio must be between 0 and 1");
  for (const key of ["still_extensions", "gif_extensions", "forbidden_git_extensions"]) {
    assert(Array.isArray(budget[key]) && budget[key].length > 0,
      `demo media budget ${key} must be a non-empty array`);
  }

  const trackable = gitTrackableFiles("assets/demo");
  const stillExtensions = new Set(budget.still_extensions.map((value) => value.toLowerCase()));
  const gifExtensions = new Set(budget.gif_extensions.map((value) => value.toLowerCase()));
  const forbiddenExtensions = new Set(budget.forbidden_git_extensions.map((value) => value.toLowerCase()));
  const chapterBytes = new Map();

  for (const file of trackable) {
    const extension = path.extname(file).toLowerCase();
    assert(!forbiddenExtensions.has(extension),
      `rendered video or audio must not be Git-trackable: ${relative(file)}`);
    if (!stillExtensions.has(extension) && !gifExtensions.has(extension)) continue;

    const bytes = fs.statSync(file).size;
    totals.trackableMediaFiles += 1;
    totals.trackableMediaBytes += bytes;
    const limit = gifExtensions.has(extension) ? budget.max_gif_bytes : budget.max_still_bytes;
    assert(bytes <= limit,
      `${relative(file)} exceeds the ${gifExtensions.has(extension) ? "GIF" : "still image"} budget: `
      + `${formatMiB(bytes)} > ${formatMiB(limit)}`);

    const match = /^assets\/demo\/source\/([^/]+)\//.exec(relative(file));
    if (match) chapterBytes.set(match[1], (chapterBytes.get(match[1]) || 0) + bytes);
  }

  assert(totals.trackableMediaBytes <= budget.max_total_media_bytes,
    `trackable demo media exceeds the repository budget: `
    + `${formatMiB(totals.trackableMediaBytes)} > ${formatMiB(budget.max_total_media_bytes)}`);
  for (const [chapter, bytes] of chapterBytes) {
    assert(bytes <= budget.max_source_chapter_media_bytes,
      `demo source chapter ${chapter} exceeds its media budget: `
      + `${formatMiB(bytes)} > ${formatMiB(budget.max_source_chapter_media_bytes)}`);
  }
  if (totals.trackableMediaBytes / budget.max_total_media_bytes >= budget.warn_at_ratio) {
    warnings.push(
      `trackable demo media uses ${Math.round(totals.trackableMediaBytes / budget.max_total_media_bytes * 100)}% `
      + `of its ${formatMiB(budget.max_total_media_bytes)} budget`,
    );
  }
}

function discoverChapterDirectories() {
  return fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sourceRoot, entry.name))
    .filter((directory) => (
      fs.existsSync(path.join(directory, "manifest.json"))
      && fs.existsSync(path.join(directory, "video", "timeline.zh-CN.json"))
    ))
    .sort();
}

function resolveChapterDirectory(argument) {
  const absolute = path.resolve(root, argument);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) return absolute;
  if (fs.existsSync(absolute) && path.basename(absolute) === "timeline.zh-CN.json") {
    return path.dirname(path.dirname(absolute));
  }
  const byName = path.join(sourceRoot, argument);
  if (fs.existsSync(byName) && fs.statSync(byName).isDirectory()) return byName;
  throw new Error(`cannot resolve demo chapter: ${argument}`);
}

function auditChapter(chapterDir) {
  const chapterName = path.basename(chapterDir);
  const manifestPath = path.join(chapterDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const production = manifest.production || {};
  const timelinePath = resolveProductionPath(
    production.timeline,
    path.join(chapterDir, "video", "timeline.zh-CN.json"),
    `${chapterName} production.timeline`,
  );
  const narrationPath = resolveProductionPath(
    production.narration,
    path.join(chapterDir, "narration.zh-CN.md"),
    `${chapterName} production.narration`,
  );
  const subtitlePath = resolveProductionPath(
    production.subtitles,
    null,
    `${chapterName} production.subtitles`,
  );

  for (const artifact of [manifestPath, timelinePath, narrationPath, subtitlePath]) {
    assertFile(artifact, `${chapterName} production artifact`);
    assertTrackable(artifact, `${chapterName} production artifact`);
    scanTextPrivacy(artifact, chapterName);
  }

  if (typeof manifest.source?.generator === "string" && !/^https?:/i.test(manifest.source.generator)) {
    const generatorPath = path.resolve(root, manifest.source.generator);
    assertFile(generatorPath, `${chapterName} source generator`);
    assertTrackable(generatorPath, `${chapterName} source generator`);
  }
  auditReadmeGif(chapterName, production);
  assert(manifest.source?.external_requests === false, `${chapterName} must record external_requests=false`);
  assert(manifest.source?.real_credentials === false, `${chapterName} must record real_credentials=false`);

  const timeline = readJson(timelinePath);
  assert(Array.isArray(timeline.source_viewport) && timeline.source_viewport.length === 2,
    `${chapterName} timeline needs source_viewport`);
  assert(Array.isArray(timeline.resolution) && timeline.resolution.length === 2,
    `${chapterName} timeline needs resolution`);
  assert(Array.isArray(timeline.scenes) && timeline.scenes.length > 0,
    `${chapterName} timeline needs scenes`);
  auditAnnotationSequence(chapterName, timeline.scenes);

  const expectedSrt = renderSrt(timeline);
  const actualSrt = fs.readFileSync(subtitlePath, "utf8");
  assert(actualSrt === expectedSrt, `${chapterName} subtitle file is stale; regenerate it from the timeline`);

  const sourceFiles = new Set();
  for (const scene of timeline.scenes) {
    if (!scene.source_image) continue;
    assert(scene.source_image.startsWith("/assets/demo/"),
      `${chapterName} scene ${scene.id} source_image must stay under /assets/demo`);
    const sourceFile = path.join(root, scene.source_image.slice(1));
    sourceFiles.add(sourceFile);
  }
  for (const sourceFile of sourceFiles) {
    assertFile(sourceFile, `${chapterName} source image`);
    assertTrackable(sourceFile, `${chapterName} source image`);
    assertImageDimensions(sourceFile, timeline.source_viewport, `${chapterName} source image`);
    scanBinaryPrivacy(sourceFile, chapterName);
  }

  const desktopReviewDir = findReviewDirectory(chapterDir, "review-1920");
  const compactReviewDir = findReviewDirectory(chapterDir, "review-1024");
  assert(desktopReviewDir, `${chapterName} is missing a review-1920 directory`);
  assert(compactReviewDir, `${chapterName} is missing a review-1024 directory`);
  const desktopReview = listReviewFrames(desktopReviewDir);
  const compactReview = listReviewFrames(compactReviewDir);
  assert(desktopReview.length > 0, `${chapterName} review-1920 contains no review frames`);
  assert(compactReview.length > 0, `${chapterName} review-1024 contains no review frames`);
  assertSameNames(desktopReview, compactReview, `${chapterName} dual-viewport review`);

  if (Array.isArray(timeline.review_points)) {
    const expectedNames = timeline.review_points.map((point) => point.name).sort();
    const actualNames = desktopReview.map((file) => path.parse(file).name).sort();
    assert(equalArrays(expectedNames, actualNames),
      `${chapterName} review filenames must exactly match timeline.review_points`);
  } else {
    const message = `${chapterName} uses legacy review frames without timeline.review_points`;
    if (strict) throw new Error(message);
    warnings.push(message);
  }

  for (const reviewFile of [...desktopReview, ...compactReview]) {
    const expected = reviewFile.startsWith(desktopReviewDir) ? [1920, 1080] : [1024, 576];
    assertTrackable(reviewFile, `${chapterName} review frame`);
    assertImageDimensions(reviewFile, expected, `${chapterName} review frame`);
    scanBinaryPrivacy(reviewFile, chapterName);
  }

  totals.chapters += 1;
  totals.scenes += timeline.scenes.length;
  totals.subtitleCues += timeline.scenes.reduce((sum, scene) => sum + (scene.subtitle_cues?.length || 0), 0);
  totals.sourceImages += sourceFiles.size;
  totals.reviewFrames += desktopReview.length + compactReview.length;
}

function auditAnnotationSequence(chapterName, scenes) {
  const priorFocusHandoff = /(保留|渐隐|淡出|替换|退出|降(?:低|权)|交叉|消失|退场|弱化|接管|不与|只留)/;
  for (const [sceneIndex, scene] of scenes.entries()) {
    const sceneLabel = scene.id || sceneIndex + 1;
    const badges = (scene.overlays || []).filter((overlay) => overlay.type === "badge");
    if (badges.length < 2) continue;

    const delays = [];
    const labels = [];
    for (const [badgeIndex, badge] of badges.entries()) {
      assert(Number.isInteger(badge.delay_ms) && badge.delay_ms >= 0,
        `${chapterName} scene ${sceneLabel} badge ${badgeIndex + 1} needs an explicit non-negative delay_ms`);
      assert(typeof badge.label === "string" && /^\d+(?:\.\d+)?$/.test(badge.label),
        `${chapterName} scene ${sceneLabel} badge ${badgeIndex + 1} needs a numeric sequence label`);
      assert(typeof badge.draft === "string" && badge.draft.trim().length >= 12,
        `${chapterName} scene ${sceneLabel} badge ${badge.label} must document its placement and sequence`);
      if (badgeIndex > 0) {
        assert(priorFocusHandoff.test(badge.draft),
          `${chapterName} scene ${sceneLabel} badge ${badge.label} must say whether the prior focus remains, dims, or exits`);
      }
      delays.push(badge.delay_ms);
      labels.push(Number(badge.label));
    }

    assert(new Set(delays).size === delays.length,
      `${chapterName} scene ${sceneLabel} numbered badges must appear at distinct times, not all at once`);
    assert(new Set(labels).size === labels.length,
      `${chapterName} scene ${sceneLabel} numbered badges must not reuse a sequence label`);
    for (let index = 1; index < badges.length; index += 1) {
      assert(delays[index] > delays[index - 1],
        `${chapterName} scene ${sceneLabel} numbered badges must be declared in appearance order`);
      assert(delays[index] - delays[index - 1] >= minimumBadgeNarrationGapMs,
        `${chapterName} scene ${sceneLabel} numbered badges need at least ${minimumBadgeNarrationGapMs}ms of narration between appearances`);
      assert(labels[index] > labels[index - 1],
        `${chapterName} scene ${sceneLabel} numbered badges must advance with the narration`);
    }
  }
}

function auditReadmeGif(chapterName, production) {
  const keys = ["readme_gif_plan", "readme_gif", "readme_gif_generator"];
  if (!keys.some((key) => production[key])) return;
  for (const key of keys) {
    assert(typeof production[key] === "string" && production[key].trim(),
      `${chapterName} production.${key} is required when a README GIF is declared`);
  }

  const planPath = path.resolve(root, production.readme_gif_plan);
  const outputPath = path.resolve(root, production.readme_gif);
  const generatorPath = path.resolve(root, production.readme_gif_generator);
  for (const [file, label] of [
    [planPath, "README GIF plan"],
    [outputPath, "README GIF"],
    [generatorPath, "README GIF generator"],
  ]) {
    assertFile(file, `${chapterName} ${label}`);
    assertTrackable(file, `${chapterName} ${label}`);
  }
  scanTextPrivacy(planPath, chapterName);
  scanTextPrivacy(generatorPath, chapterName);
  scanBinaryPrivacy(outputPath, chapterName);

  const plan = readJson(planPath);
  assert(plan.schema_version === 1, `${chapterName} README GIF plan schema_version must be 1`);
  assert(Array.isArray(plan.resolution) && plan.resolution.length === 2,
    `${chapterName} README GIF plan needs a resolution`);
  assert(Array.isArray(plan.shots) && plan.shots.length > 1,
    `${chapterName} README GIF plan needs at least two shots`);
  assert(path.resolve(root, plan.output) === outputPath,
    `${chapterName} README GIF plan output must match production.readme_gif`);
  assert(Number.isInteger(plan.max_bytes) && plan.max_bytes > 0,
    `${chapterName} README GIF plan needs max_bytes`);
  assert(fs.statSync(outputPath).size <= plan.max_bytes,
    `${chapterName} README GIF exceeds its size gate`);
  assertImageDimensions(outputPath, plan.resolution, `${chapterName} README GIF`);

  const sourceDirectory = path.resolve(root, plan.source_directory);
  const seen = new Set();
  for (const [index, shot] of plan.shots.entries()) {
    assert(typeof shot.frame === "string" && shot.frame.length > 0,
      `${chapterName} README GIF shot ${index} needs a frame`);
    assert(!seen.has(shot.frame), `${chapterName} README GIF plan duplicates ${shot.frame}`);
    seen.add(shot.frame);
    assert(Number.isInteger(shot.hold_ms) && shot.hold_ms >= 2500,
      `${chapterName} README GIF shot ${index} must remain readable for at least 2500ms`);
    assert(typeof shot.purpose === "string" && shot.purpose.trim().length >= 8,
      `${chapterName} README GIF shot ${index} needs a concrete teaching purpose`);
    const sourceFrame = path.join(sourceDirectory, shot.frame);
    assertFile(sourceFrame, `${chapterName} README GIF reviewed source frame`);
    assertTrackable(sourceFrame, `${chapterName} README GIF reviewed source frame`);
    assertImageDimensions(sourceFrame, plan.resolution, `${chapterName} README GIF reviewed source frame`);
  }
}

function resolveProductionPath(value, fallback, label) {
  const candidate = typeof value === "string" && value.trim() ? path.resolve(root, value) : fallback;
  assert(candidate, `${label} is required`);
  return candidate;
}

function findReviewDirectory(chapterDir, name) {
  const candidates = [
    path.join(chapterDir, "recording", name),
    path.join(chapterDir, "recording", "real-cli", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || null;
}

function listReviewFrames(directory) {
  return fs.readdirSync(directory)
    .filter((name) => /\.(?:jpe?g|png)$/i.test(name) && !/^contact-sheet\./i.test(name))
    .map((name) => path.join(directory, name))
    .sort();
}

function assertSameNames(left, right, label) {
  const leftNames = left.map((file) => path.basename(file));
  const rightNames = right.map((file) => path.basename(file));
  assert(equalArrays(leftNames, rightNames), `${label} filenames differ between 1920 and 1024`);
}

function renderSrt(timeline) {
  const blocks = [];
  let cueNumber = 1;
  for (const scene of timeline.scenes) {
    const cues = scene.subtitle_cues || [];
    assert(cues.length > 0, `scene ${scene.id} needs subtitle cues`);
    const duration = scene.end_seconds - scene.start_seconds;
    assert(Number.isFinite(duration) && duration > 0, `scene ${scene.id} has invalid timing`);
    const cueDuration = duration / cues.length;
    for (const [index, cue] of cues.entries()) {
      assert(typeof cue === "string" && cue.trim(), `scene ${scene.id} has an empty subtitle cue`);
      const start = scene.start_seconds + cueDuration * index;
      const end = index === cues.length - 1
        ? scene.end_seconds
        : scene.start_seconds + cueDuration * (index + 1);
      blocks.push(`${cueNumber}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${cue.trim()}`);
      cueNumber += 1;
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function formatTimestamp(totalSeconds) {
  const totalMilliseconds = Math.round(totalSeconds * 1000);
  const milliseconds = totalMilliseconds % 1000;
  const totalWholeSeconds = Math.floor(totalMilliseconds / 1000);
  const seconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`;
}

function assertImageDimensions(file, expected, label) {
  const actual = imageDimensions(fs.readFileSync(file));
  assert(actual, `${label} has an unsupported or invalid image format: ${relative(file)}`);
  assert(actual[0] === expected[0] && actual[1] === expected[1],
    `${label} must be ${expected.join("x")}, found ${actual.join("x")}: ${relative(file)}`);
}

function imageDimensions(buffer) {
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return [buffer.readUInt16LE(6), buffer.readUInt16LE(8)];
  }
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker)) return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
    offset += length;
  }
  return null;
}

function assertTrackable(file, label) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", relative(file)], {
    cwd: root,
    stdio: "ignore",
  });
  assert(result.status !== 0, `${label} is excluded by .gitignore: ${relative(file)}`);
}

function gitTrackableFiles(directory) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", directory],
    { cwd: root, encoding: "utf8" },
  );
  assert(result.status === 0, `git ls-files failed while auditing ${directory}`);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => path.join(root, file))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

function scanTextPrivacy(file, chapterName) {
  scanPrivacy(fs.readFileSync(file, "utf8"), `${chapterName} text artifact ${relative(file)}`);
}

function scanBinaryPrivacy(file, chapterName) {
  scanPrivacy(fs.readFileSync(file).toString("latin1"), `${chapterName} image metadata ${relative(file)}`);
}

function scanPrivacy(value, label) {
  const rules = [
    [/\/Users\/[A-Za-z0-9._-]+\//, "macOS home path"],
    [/[A-Za-z]:\\Users\\[^\\\s]+\\/i, "Windows home path"],
    [/(?<![A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{16,}/, "provider-style secret"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\bBearer\s+[A-Za-z0-9._~-]{20,}/i, "Bearer credential"],
  ];
  for (const [pattern, description] of rules) {
    assert(!pattern.test(value), `${label} contains a possible ${description}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function markdownHeadings(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
    .filter(Boolean);
}

function assertFile(file, label) {
  assert(fs.existsSync(file) && fs.statSync(file).isFile(), `${label} is missing: ${relative(file)}`);
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
