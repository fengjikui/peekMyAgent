#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const timelineArg = process.argv[2] || "assets/demo/source/claude-skill/video/timeline.zh-CN.json";
const timelinePath = path.resolve(root, timelineArg);
const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));

assertPositivePair(timeline.resolution, "resolution");
assertPositivePair(timeline.source_viewport, "source_viewport");
assert(["codex", "claude", "codex-and-claude"].includes(timeline.theme),
  "theme must be codex, claude, or codex-and-claude");
assert(Number.isFinite(timeline.duration_seconds) && timeline.duration_seconds > 0, "duration_seconds must be positive");
assert(Array.isArray(timeline.scenes) && timeline.scenes.length > 0, "scenes must not be empty");

if (timeline.review_points !== undefined) {
  assert(Array.isArray(timeline.review_points) && timeline.review_points.length > 0, "review_points must be a non-empty array when present");
  const reviewNames = new Set();
  for (const [index, point] of timeline.review_points.entries()) {
    const label = `review_points[${index}]`;
    assert(typeof point.name === "string" && point.name.length > 0, `${label} needs a name`);
    assert(!reviewNames.has(point.name), `${label} duplicates review point name ${point.name}`);
    reviewNames.add(point.name);
    assert(Number.isInteger(point.scene) && point.scene >= 0 && point.scene < timeline.scenes.length, `${label}.scene is out of range`);
    const scene = timeline.scenes[point.scene];
    const sceneDurationMs = (scene.end_seconds - scene.start_seconds) * 1000;
    assert(Number.isFinite(point.at_ms) && point.at_ms >= 0 && point.at_ms < sceneDurationMs, `${label}.at_ms must stay inside scene ${scene.id}`);
  }
}

let expectedStart = 0;
for (const [index, scene] of timeline.scenes.entries()) {
  const label = `scenes[${index}] (${scene.id || "missing id"})`;
  assert(typeof scene.id === "string" && scene.id.length > 0, `${label} needs an id`);
  assert(typeof scene.title === "string" && scene.title.length > 0, `${label} needs a title`);
  assert(scene.start_seconds === expectedStart, `${label} must start at ${expectedStart}`);
  assert(Number.isFinite(scene.end_seconds) && scene.end_seconds > scene.start_seconds, `${label} needs a positive duration`);
  assert(scene.end_seconds - scene.start_seconds >= 8, `${label} must remain readable for at least 8 seconds`);
  expectedStart = scene.end_seconds;

  assert(typeof scene.narration === "string" && scene.narration.length > 0, `${label} needs narration`);
  assert(Array.isArray(scene.subtitle_cues) && scene.subtitle_cues.length > 0, `${label} needs subtitle cues`);
  for (const [cueIndex, cue] of scene.subtitle_cues.entries()) {
    assert(typeof cue === "string" && cue.trim().length > 0, `${label}.subtitle_cues[${cueIndex}] is empty`);
    assert([...cue].length <= 42, `${label}.subtitle_cues[${cueIndex}] is too long for a single display cue`);
  }

  if (scene.source_image) {
    assert(scene.source_image.startsWith("/assets/demo/"), `${label}.source_image must stay under /assets/demo`);
    const sourcePath = path.join(root, scene.source_image.slice(1));
    assert(fs.existsSync(sourcePath), `${label}.source_image does not exist: ${sourcePath}`);
  } else {
    assert(scene.card && typeof scene.card.headline === "string", `${label} without source_image needs a title card`);
  }

  if (scene.card) validateTitleCard(scene.card, `${label}.card`);

  if (scene.transition) {
    const serialized = JSON.stringify(scene.transition).toLowerCase();
    assert(!serialized.includes("black"), `${label} must not transition through black`);
  }

  for (const [overlayIndex, overlay] of (scene.overlays || []).entries()) {
    const overlayLabel = `${label}.overlays[${overlayIndex}]`;
    assert(typeof overlay.draft === "string" && overlay.draft.length >= 24, `${overlayLabel} needs an arrow/layout draft`);
    assert(["callout", "badge", "focus", "click"].includes(overlay.type), `${overlayLabel}.type is unsupported`);
    if (overlay.type === "callout" || overlay.type === "badge") {
      assert(typeof overlay.label === "string" && overlay.label.length > 0, `${overlayLabel} needs a label`);
      assertBox(overlay.label_box, `${overlayLabel}.label_box`);
    }
    if (overlay.type === "focus") assertBox(overlay.focus, `${overlayLabel}.focus`);
    if (overlay.type === "click") assertPoint(overlay.click, `${overlayLabel}.click`);
    if (overlay.focus) assertBox(overlay.focus, `${overlayLabel}.focus`);
    if (overlay.focus_padding !== undefined) {
      assert(overlay.focus, `${overlayLabel}.focus_padding requires a focus box`);
      assertPadding(overlay.focus_padding, `${overlayLabel}.focus_padding`);
      assertExpandedBox(overlay.focus, overlay.focus_padding, `${overlayLabel}.focus with padding`);
    }
    if (overlay.focus_style !== undefined) {
      assert(["control", "stacked", "spotlight"].includes(overlay.focus_style),
        `${overlayLabel}.focus_style must be control, stacked, or spotlight`);
    }
    if (overlay.route) {
      assert(Array.isArray(overlay.route) && overlay.route.length >= 2, `${overlayLabel}.route needs at least two points`);
      for (const [pointIndex, point] of overlay.route.entries()) {
        assertPoint(point, `${overlayLabel}.route[${pointIndex}]`);
      }
    }
    assert((overlay.delay_ms || 0) < (scene.end_seconds - scene.start_seconds) * 1000, `${overlayLabel}.delay_ms exceeds scene duration`);
    if (overlay.dim_ms !== undefined) {
      assert(Number.isFinite(overlay.dim_ms), `${overlayLabel}.dim_ms must be finite`);
      assert(overlay.dim_ms > (overlay.delay_ms || 0), `${overlayLabel}.dim_ms must be after delay_ms`);
      assert(overlay.dim_ms < (scene.end_seconds - scene.start_seconds) * 1000, `${overlayLabel}.dim_ms must stay inside the scene`);
      if (overlay.end_ms !== undefined) {
        assert(overlay.dim_ms < overlay.end_ms, `${overlayLabel}.dim_ms must be before end_ms`);
      }
    }
    if (overlay.end_ms !== undefined) {
      assert(Number.isFinite(overlay.end_ms), `${overlayLabel}.end_ms must be finite`);
      assert(overlay.end_ms > (overlay.delay_ms || 0), `${overlayLabel}.end_ms must be after delay_ms`);
      assert(overlay.end_ms <= (scene.end_seconds - scene.start_seconds) * 1000, `${overlayLabel}.end_ms exceeds scene duration`);
    }
  }

  const numberedOverlays = (scene.overlays || [])
    .filter((overlay) => overlay.type === "badge" && /^\d+(?:\.\d+)?$/.test(overlay.label || ""))
    .sort((left, right) => (left.delay_ms || 0) - (right.delay_ms || 0));
  for (let numberedIndex = 1; numberedIndex < numberedOverlays.length; numberedIndex += 1) {
    const previous = numberedOverlays[numberedIndex - 1];
    const current = numberedOverlays[numberedIndex];
    const previousDelay = previous.delay_ms || 0;
    const currentDelay = current.delay_ms || 0;
    assert(currentDelay > previousDelay,
      `${label} numbered badges ${previous.label} and ${current.label} must appear progressively, not at the same time`);

    const handoffOverlapMs = Number.isFinite(previous.end_ms)
      ? previous.end_ms - currentDelay
      : Number.POSITIVE_INFINITY;
    const previousPersistsBeyondHandoff = handoffOverlapMs > 1000;
    if (previousPersistsBeyondHandoff) {
      assert(Number.isFinite(previous.dim_ms) && previous.dim_ms <= currentDelay,
        `${label} numbered badge ${previous.label} persists after ${current.label} appears and must dim first`);
    }
  }
}

assert(expectedStart === timeline.duration_seconds, "last scene must end at duration_seconds");
const reviewSummary = Array.isArray(timeline.review_points) ? `, ${timeline.review_points.length} review points` : "";
console.log(`demo storyboard smoke passed: ${path.relative(root, timelinePath)} (${timeline.scenes.length} scenes, ${timeline.duration_seconds}s${reviewSummary})`);

function assertPositivePair(value, label) {
  assert(Array.isArray(value) && value.length === 2, `${label} must be a pair`);
  assert(value.every((item) => Number.isFinite(item) && item > 0), `${label} values must be positive`);
}

function assertBox(value, label) {
  assert(Array.isArray(value) && value.length === 4, `${label} must be [x, y, width, height]`);
  const [x, y, width, height] = value;
  assert([x, y, width, height].every(Number.isFinite), `${label} values must be finite`);
  assert(x >= 0 && y >= 0 && width > 0 && height > 0, `${label} must be positive and start inside the frame`);
  assert(x + width <= 100 && y + height <= 100, `${label} must stay inside the frame`);
}

function assertPoint(value, label) {
  assert(Array.isArray(value) && value.length === 2, `${label} must be [x, y]`);
  assert(value.every((item) => Number.isFinite(item) && item >= 0 && item <= 100), `${label} must stay inside the frame`);
}

function assertPadding(value, label) {
  assert(Array.isArray(value) && value.length === 2, `${label} must be [horizontal, vertical]`);
  assert(value.every((item) => Number.isFinite(item) && item >= 0), `${label} values must be non-negative`);
}

function assertExpandedBox([x, y, width, height], [paddingX, paddingY], label) {
  assert(x - paddingX >= 0 && y - paddingY >= 0, `${label} must start inside the frame`);
  assert(x + width + paddingX <= 100 && y + height + paddingY <= 100,
    `${label} must stay inside the frame`);
}

function validateTitleCard(card, label) {
  assertShortText(card.eyebrow, 40, `${label}.eyebrow`);
  assertShortText(card.headline, 34, `${label}.headline`);
  assert(Array.isArray(card.steps) && card.steps.length >= 1 && card.steps.length <= 4,
    `${label}.steps must contain one to four launch-style beats`);
  for (const [index, step] of card.steps.entries()) {
    assertShortText(step, 30, `${label}.steps[${index}]`);
  }
  if (card.footer !== undefined) assertShortText(card.footer, 68, `${label}.footer`);
}

function assertShortText(value, maximumCharacters, label) {
  assert(typeof value === "string" && value.trim().length > 0, `${label} must be non-empty text`);
  assert(!value.includes("\n"), `${label} must stay on one authored line`);
  assert([...value].length <= maximumCharacters,
    `${label} exceeds the ${maximumCharacters}-character launch-card limit`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
