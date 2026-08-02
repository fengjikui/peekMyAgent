#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const timelineArg = process.argv[2];
const outputArg = process.argv[3];

if (!timelineArg) {
  throw new Error("usage: node scripts/timeline-subtitles-to-srt.mjs <timeline.json> [output.srt]");
}

const timelinePath = path.resolve(root, timelineArg);
const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
const blocks = [];
let cueNumber = 1;

for (const scene of timeline.scenes || []) {
  const cues = scene.subtitle_cues || [];
  if (!cues.length) continue;
  const duration = scene.end_seconds - scene.start_seconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`scene ${scene.id || cueNumber} has an invalid duration`);
  }
  const cueDuration = duration / cues.length;
  for (const [index, cue] of cues.entries()) {
    if (typeof cue !== "string" || !cue.trim()) {
      throw new Error(`scene ${scene.id || cueNumber} has an empty subtitle cue`);
    }
    const start = scene.start_seconds + cueDuration * index;
    const end = index === cues.length - 1
      ? scene.end_seconds
      : scene.start_seconds + cueDuration * (index + 1);
    blocks.push([
      String(cueNumber),
      `${formatTimestamp(start)} --> ${formatTimestamp(end)}`,
      cue.trim(),
    ].join("\n"));
    cueNumber += 1;
  }
}

const output = `${blocks.join("\n\n")}\n`;
if (outputArg) {
  const outputPath = path.resolve(root, outputArg);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf8");
  console.log(`wrote ${cueNumber - 1} subtitle cues: ${path.relative(root, outputPath)}`);
} else {
  process.stdout.write(output);
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

function pad(value, width) {
  return String(value).padStart(width, "0");
}
