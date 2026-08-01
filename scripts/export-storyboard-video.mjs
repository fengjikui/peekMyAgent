#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { launchChromiumPage } from "./lib/chromium-cdp.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "assets", "demo", "storyboard", "catalog.zh-CN.json");
const storyboardPath = "/assets/demo/storyboard/index.html";
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const catalog = readJson(catalogPath);
const chapter = catalog.chapters?.find((candidate) => candidate.id === options.chapter);
assert(chapter, `unknown storyboard chapter: ${options.chapter}`);
const timelinePath = repoPathFromHref(chapter.timeline, "chapter timeline");
const timeline = readJson(timelinePath);
validateTimeline(timeline);

const startSeconds = options.startSeconds;
const availableSeconds = timeline.duration_seconds - startSeconds;
const requestedSeconds = options.durationSeconds ?? availableSeconds;
assert(startSeconds >= 0 && startSeconds < timeline.duration_seconds,
  `--start-seconds must stay inside the ${timeline.duration_seconds}s timeline`);
assert(requestedSeconds > 0 && requestedSeconds <= availableSeconds,
  `--duration-seconds must be positive and end by ${timeline.duration_seconds}s`);
const totalFrames = Math.round(requestedSeconds * options.fps);
const renderedSeconds = totalFrames / options.fps;
assert(totalFrames > 0, "the selected range contains no video frames");

const outputPath = options.output || defaultOutputPath(options.chapter, options.includeSubtitles);
assert(path.extname(outputPath).toLowerCase() === ".mp4", "--output must end in .mp4");
if (fs.existsSync(outputPath) && !options.force) {
  throw new Error(`output already exists; pass --force to replace it: ${outputPath}`);
}
const renderManifestPath = outputPath.toString().replace(/\.mp4$/i, ".render.json");

await main();

async function main() {
  requireCommands(["ffmpeg", "ffprobe"]);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryOutput = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath, ".mp4")}.tmp-${process.pid}.mp4`,
  );
  const server = createStaticServer();
  let page;
  let encoder;
  let receivedFrames = 0;
  let latestFrame = null;
  let interruptedSignal = null;
  let unsubscribe = () => {};
  const handleSignal = (signal) => {
    interruptedSignal = signal;
    if (encoder?.exitCode === null) encoder.kill("SIGTERM");
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;
    const browserEnv = { ...process.env };
    if (options.browser) browserEnv.PEEKMYAGENT_BROWSER_PATH = options.browser;
    page = await launchChromiumPage({ env: browserEnv, timeoutMs: options.timeoutMs });
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1920,
      screenHeight: 1080,
    });

    const startPoint = resolveStartPoint(timeline, startSeconds);
    const targetUrl = buildPlaybackUrl(origin, chapter.timeline, startPoint, options.includeSubtitles);
    await page.navigate(targetUrl, { timeoutMs: options.timeoutMs });
    await waitForStoryboard(page, timeline, startPoint.scene, options.timeoutMs);

    let resolveFirstFrame;
    const firstFrame = new Promise((resolve) => { resolveFirstFrame = resolve; });
    unsubscribe = page.on("Page.screencastFrame", (event) => {
      void page.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      const bytes = Buffer.from(event.data, "base64");
      latestFrame = bytes;
      receivedFrames += 1;
      if (receivedFrames === 1) resolveFirstFrame(bytes);
    });
    await page.send("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1,
    });
    const initialFrame = await withTimeout(firstFrame, options.timeoutMs, "first browser video frame");
    assert.deepEqual(readJpegDimensions(initialFrame), { width: 1920, height: 1080 },
      "browser screencast did not produce an exact 1920x1080 frame");

    encoder = startEncoder(temporaryOutput, options.fps, totalFrames, options.crf);
    await page.evaluate(`(() => {
      const toggle = document.querySelector('[data-action="toggle"]');
      if (!toggle || document.body.dataset.timelineReady !== '1') return false;
      if (document.body.dataset.playing !== '1') toggle.click();
      return document.body.dataset.playing === '1';
    })()`);
    await page.waitFor("document.body.dataset.playing === '1'", {
      timeoutMs: options.timeoutMs,
      description: "storyboard playback to start",
    });

    const recordingStarted = process.hrtime.bigint();
    let maximumLatenessMs = 0;
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (interruptedSignal) throw new Error(`video export interrupted by ${interruptedSignal}`);
      const targetNanoseconds = recordingStarted
        + BigInt(Math.round((frameIndex * 1_000_000_000) / options.fps));
      await waitUntil(targetNanoseconds);
      const latenessMs = Number(process.hrtime.bigint() - targetNanoseconds) / 1_000_000;
      maximumLatenessMs = Math.max(maximumLatenessMs, latenessMs);
      assert(maximumLatenessMs < 1500,
        `video encoder fell ${maximumLatenessMs.toFixed(0)}ms behind real time; lower --quality or --fps`);
      assert(latestFrame, "browser stopped providing video frames");
      await writeFrame(encoder.stdin, latestFrame);
      if ((frameIndex + 1) % (options.fps * 10) === 0 || frameIndex + 1 === totalFrames) {
        const progressSeconds = (frameIndex + 1) / options.fps;
        console.log(`video export: ${progressSeconds.toFixed(0)}s / ${renderedSeconds.toFixed(0)}s`);
      }
    }

    await delay(80);
    const finalPlaybackState = await page.evaluate(`(() => ({
      absoluteMs: Number(document.body.dataset.absoluteMs),
      playing: document.body.dataset.playing,
      sceneIndex: Number(document.body.dataset.sceneIndex)
    }))()`);
    const expectedEndMs = (startSeconds + renderedSeconds) * 1000;
    assert(Number.isFinite(finalPlaybackState.absoluteMs), "storyboard did not expose a final playback time");
    assert(Math.abs(finalPlaybackState.absoluteMs - expectedEndMs) <= 250,
      `storyboard ended at ${finalPlaybackState.absoluteMs}ms instead of the requested ${expectedEndMs}ms`);
    await page.evaluate(`(() => {
      const toggle = document.querySelector('[data-action="toggle"]');
      if (document.body.dataset.playing === '1') toggle?.click();
    })()`);
    await page.send("Page.stopScreencast");
    unsubscribe();
    encoder.stdin.end();
    const exitCode = encoder.exitCode ?? (await once(encoder, "exit"))[0];
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with ${exitCode}\n${encoder.stderrText}`);
    }
    await verifyVideo(temporaryOutput, options.fps, totalFrames, renderedSeconds);
    page.assertNoRuntimeExceptions();

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(temporaryOutput, outputPath);
    const workingTreeDirty = gitWorkingTreeDirty();
    const fullTimeline = startSeconds === 0
      && Math.abs(renderedSeconds - timeline.duration_seconds) <= 1 / options.fps;
    const renderManifest = {
      schema_version: 1,
      chapter: options.chapter,
      source_timeline: relative(timelinePath),
      source_commit: gitHead(),
      source_worktree_dirty: workingTreeDirty,
      capture: "Chrome DevTools Page.startScreencast",
      browser: browserVersion(page.executable),
      ffmpeg: commandVersion("ffmpeg", ["-version"]),
      resolution: [1920, 1080],
      fps: options.fps,
      start_seconds: startSeconds,
      duration_seconds: renderedSeconds,
      encoded_frames: totalFrames,
      browser_frames_received: receivedFrames,
      browser_final_absolute_ms: finalPlaybackState.absoluteMs,
      maximum_encoder_lateness_ms: Number(maximumLatenessMs.toFixed(3)),
      subtitles_visible: options.includeSubtitles,
      audio: false,
      external_requests: false,
      publishable_picture_master: !workingTreeDirty && fullTimeline && !options.includeSubtitles,
      privacy: "Only repository-local storyboard assets were served through a loopback-only temporary server.",
    };
    writeJsonAtomically(renderManifestPath, renderManifest);

    console.log([
      "storyboard video export passed:",
      options.chapter,
      `${renderedSeconds.toFixed(3)}s,`,
      `${totalFrames} frames,`,
      `${receivedFrames} browser frames,`,
      "1920x1080",
    ].join(" "));
    console.log(`video: ${outputPath}`);
    console.log(`render manifest: ${renderManifestPath}`);
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    unsubscribe();
    if (encoder?.exitCode === null) {
      encoder.stdin.destroy();
      encoder.kill("SIGTERM");
      await Promise.race([once(encoder, "exit"), delay(2_000)]).catch(() => {});
    }
    if (page) await page.close();
    await closeServer(server);
    if (fs.existsSync(temporaryOutput)) fs.unlinkSync(temporaryOutput);
  }
}

function parseArguments(args) {
  const parsed = {
    browser: process.env.PMA_STORYBOARD_BROWSER || null,
    chapter: null,
    crf: 19,
    durationSeconds: null,
    force: false,
    fps: 30,
    help: false,
    includeSubtitles: false,
    output: null,
    quality: 88,
    startSeconds: 0,
    timeoutMs: 12_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--browser") parsed.browser = requiredValue(args, ++index, argument);
    else if (argument === "--crf") parsed.crf = Number.parseInt(requiredValue(args, ++index, argument), 10);
    else if (argument === "--duration-seconds") parsed.durationSeconds = Number(requiredValue(args, ++index, argument));
    else if (argument === "--force") parsed.force = true;
    else if (argument === "--fps") parsed.fps = Number.parseInt(requiredValue(args, ++index, argument), 10);
    else if (argument === "--include-subtitles") parsed.includeSubtitles = true;
    else if (argument === "--output") parsed.output = path.resolve(root, requiredValue(args, ++index, argument));
    else if (argument === "--quality") parsed.quality = Number.parseInt(requiredValue(args, ++index, argument), 10);
    else if (argument === "--start-seconds") parsed.startSeconds = Number(requiredValue(args, ++index, argument));
    else if (argument === "--timeout-ms") parsed.timeoutMs = Number.parseInt(requiredValue(args, ++index, argument), 10);
    else if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    else if (parsed.chapter) throw new Error(`unexpected argument: ${argument}`);
    else parsed.chapter = argument;
  }
  if (!parsed.help) assert(parsed.chapter, "a storyboard chapter id is required");
  assert(Number.isInteger(parsed.fps) && parsed.fps >= 12 && parsed.fps <= 60,
    "--fps must be an integer between 12 and 60");
  assert(Number.isInteger(parsed.quality) && parsed.quality >= 40 && parsed.quality <= 100,
    "--quality must be an integer between 40 and 100");
  assert(Number.isInteger(parsed.crf) && parsed.crf >= 14 && parsed.crf <= 30,
    "--crf must be an integer between 14 and 30");
  assert(Number.isFinite(parsed.startSeconds) && parsed.startSeconds >= 0,
    "--start-seconds must be non-negative");
  assert(parsed.durationSeconds === null || (Number.isFinite(parsed.durationSeconds) && parsed.durationSeconds > 0),
    "--duration-seconds must be positive");
  assert(Number.isInteger(parsed.timeoutMs) && parsed.timeoutMs >= 1_000 && parsed.timeoutMs <= 60_000,
    "--timeout-ms must be between 1000 and 60000");
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/export-storyboard-video.mjs <chapter-id> [options]

Options:
  --output <file.mp4>       Output path (default: tmp/storyboard-video/<chapter>/...)
  --include-subtitles       Keep the webpage subtitle layer for an internal preview
  --start-seconds <number>  Begin at an absolute timeline offset (default: 0)
  --duration-seconds <n>    Export only this many seconds (default: remainder of timeline)
  --fps <12-60>             Constant output frame rate (default: 30)
  --quality <40-100>        Browser JPEG stream quality (default: 88)
  --crf <14-30>             H.264 quality; lower is larger (default: 19)
  --browser <path>          Chrome, Chromium, or Edge executable
  --timeout-ms <ms>         Browser readiness timeout (default: 12000)
  --force                   Replace an existing output only after the new file verifies
  -h, --help                Show this help

The default is a silent, subtitle-free 1920x1080 picture master. Browser discovery
also honors PMA_STORYBOARD_BROWSER. Outputs under tmp/ are Git-ignored.`);
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function defaultOutputPath(chapterId, includeSubtitles) {
  const suffix = includeSubtitles ? "captioned-preview" : "picture";
  return path.join(root, "tmp", "storyboard-video", chapterId, `pma-${chapterId}-${suffix}.mp4`);
}

function validateTimeline(value) {
  assert(Number.isFinite(value.duration_seconds) && value.duration_seconds > 0,
    "timeline duration_seconds must be positive");
  assert(Array.isArray(value.scenes) && value.scenes.length > 0, "timeline scenes must not be empty");
  assert.deepEqual(value.resolution, [1920, 1080], "video export requires a 1920x1080 timeline");
}

function resolveStartPoint(value, absoluteSeconds) {
  const scene = value.scenes.findIndex((candidate) => (
    absoluteSeconds >= candidate.start_seconds && absoluteSeconds < candidate.end_seconds
  ));
  const sceneIndex = scene === -1 ? value.scenes.length - 1 : scene;
  return {
    scene: sceneIndex,
    atMs: Math.round((absoluteSeconds - value.scenes[sceneIndex].start_seconds) * 1000),
  };
}

function buildPlaybackUrl(origin, timelineHref, startPoint, includeSubtitles) {
  const url = new URL(storyboardPath, origin);
  url.searchParams.set("timeline", timelineHref);
  url.searchParams.set("present", "1");
  url.searchParams.set("autoplay", "0");
  url.searchParams.set("subtitles", includeSubtitles ? "1" : "0");
  url.searchParams.set("scene", String(startPoint.scene));
  url.searchParams.set("at_ms", String(startPoint.atMs));
  return url.href;
}

async function waitForStoryboard(page, value, sceneIndex, timeoutMs) {
  const expectedScene = `${sceneIndex + 1}/${value.scenes.length}`;
  await page.waitFor(`(() => {
    const image = document.querySelector('.product-frame:not([hidden])');
    return document.body.dataset.timelineReady === '1'
      && document.body.classList.contains('present')
      && document.querySelector('.scene-number')?.textContent?.trim() === ${JSON.stringify(expectedScene)}
      && (!image || (image.complete && image.naturalWidth > 0));
  })()`, { timeoutMs, description: "storyboard picture and timeline to become ready" });
}

function startEncoder(output, fps, frameCount, crf) {
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "mjpeg", "-i", "pipe:0",
    "-frames:v", String(frameCount), "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart",
    output,
  ], { cwd: root, stdio: ["pipe", "ignore", "pipe"] });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => {
    child.stderrText = `${child.stderrText}${chunk}`.slice(-16_000);
  });
  return child;
}

async function writeFrame(stream, frame) {
  if (stream.destroyed) throw new Error("ffmpeg input closed before video export completed");
  if (!stream.write(frame)) await once(stream, "drain");
}

async function verifyVideo(file, fps, frameCount, expectedDuration) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames",
    "-of", "json", file,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `ffprobe failed\n${result.stderr || result.stdout}`);
  const metadata = JSON.parse(result.stdout);
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  assert(video, "exported MP4 has no video stream");
  assert.equal(video.codec_name, "h264", "exported MP4 must use H.264");
  assert.deepEqual([video.width, video.height], [1920, 1080], "exported MP4 must be 1920x1080");
  assert.equal(video.r_frame_rate, `${fps}/1`, `exported MP4 must be ${fps} fps`);
  assert.equal(Number(video.nb_frames), frameCount, "exported MP4 frame count differs from the requested range");
  assert.equal(metadata.streams.filter((stream) => stream.codec_type !== "video").length, 0,
    "picture master must not contain audio or subtitle streams");
  assert(Math.abs(Number(metadata.format.duration) - expectedDuration) <= 1 / fps + 0.01,
    "exported MP4 duration differs from the requested range");
}

function createStaticServer() {
  return http.createServer((request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(root, relativePath);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": stat.size,
        "Content-Type": contentType(filePath),
      });
      fs.createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    }
  });
}

function contentType(file) {
  return {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function repoPathFromHref(href, label) {
  assert(typeof href === "string" && href.startsWith("/"), `${label} must be root-relative`);
  const resolved = path.resolve(root, href.slice(1));
  assert(resolved.startsWith(`${root}${path.sep}`), `${label} escapes the repository`);
  return resolved;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomically(destination, value) {
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (fs.existsSync(destination)) fs.unlinkSync(destination);
  fs.renameSync(temporary, destination);
}

function requireCommands(commands) {
  for (const command of commands) {
    const result = spawnSync(command, ["-version"], { stdio: "ignore" });
    assert.equal(result.status, 0, `${command} is required for storyboard video export`);
  }
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return String(result.stdout || result.stderr || "").split(/\r?\n/)[0].trim();
}

function browserVersion(executable) {
  return commandVersion(executable, ["--version"]);
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, "could not resolve the source commit");
  return result.stdout.trim();
}

function gitWorkingTreeDirty() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, "could not inspect the source worktree");
  return result.stdout.trim().length > 0;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function readJpegDimensions(bytes) {
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, "browser video frame is not JPEG");
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    assert(length >= 2, "browser JPEG contains an invalid segment");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error("browser JPEG has no readable size marker");
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => { throw new Error(`timed out waiting for ${label}`); }),
  ]);
}

async function waitUntil(targetNanoseconds) {
  while (true) {
    const remainingMs = Number(targetNanoseconds - process.hrtime.bigint()) / 1_000_000;
    if (remainingMs <= 0) return;
    await delay(Math.max(1, Math.min(remainingMs, 20)));
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
