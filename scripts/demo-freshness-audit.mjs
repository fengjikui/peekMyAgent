#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildDocumentationImpact,
  documentationImpactRuleIds,
} from "./documentation-consistency-audit.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = "assets/demo/storyboard/catalog.zh-CN.json";
const sharedRenderDependencies = [
  "assets/demo/storyboard/index.html",
  "assets/demo/storyboard/player.css",
  "assets/demo/storyboard/player.js",
];
const shaPattern = /^[0-9a-f]{40}$/;

export function auditDemoFreshness({ target = "HEAD", chapterIds = [], log = true } = {}) {
  const targetSha = resolveRevision(target);
  const catalog = JSON.parse(readRepoFile(catalogPath));
  assert.equal(catalog.schema_version, 5, "storyboard catalog schema_version must be 5");
  assert(Array.isArray(catalog.chapters) && catalog.chapters.length > 0,
    "storyboard catalog must contain chapters");

  const selected = chapterIds.length > 0
    ? catalog.chapters.filter((chapter) => chapterIds.includes(chapter.id))
    : catalog.chapters;
  const missing = chapterIds.filter((id) => !selected.some((chapter) => chapter.id === id));
  assert.deepEqual(missing, [], `unknown demo chapter ids: ${missing.join(", ")}`);

  const chapters = selected.map((chapter) => auditChapter({ chapter, targetSha }));
  const summary = {
    schema_version: 1,
    target_sha: targetSha,
    working_tree_dirty: git(["status", "--porcelain"]).trim().length > 0,
    chapter_count: chapters.length,
    current_count: chapters.filter((chapter) => chapter.status === "current").length,
    product_review_required_count: chapters.filter((chapter) => (
      chapter.product_evidence.status === "review-required"
    )).length,
    source_refresh_required_count: chapters.filter((chapter) => (
      chapter.source_recipe.status === "regeneration-required"
    )).length,
    render_refresh_required_count: chapters.filter((chapter) => (
      chapter.tracked_review_frames.status === "regeneration-required"
    )).length,
    chapters,
  };

  if (log) printSummary(summary);
  return summary;
}

function auditChapter({ chapter, targetSha }) {
  const manifestPath = repoPathFromAssetHref(chapter.review?.artifacts?.manifest,
    `${chapter.id} manifest`);
  const timelinePath = repoPathFromAssetHref(chapter.timeline, `${chapter.id} timeline`);
  const manifest = JSON.parse(readRepoFile(manifestPath));
  const timeline = JSON.parse(readRepoFile(timelinePath));
  const evidence = resolveEvidenceCommit(manifest, chapter.id);
  resolveRevision(evidence.sha);

  const watchedImpactIds = chapter.review?.freshness?.product_impact_ids;
  assert(Array.isArray(watchedImpactIds) && watchedImpactIds.length > 0,
    `${chapter.id} needs review.freshness.product_impact_ids`);
  assert.equal(new Set(watchedImpactIds).size, watchedImpactIds.length,
    `${chapter.id} freshness impact ids must be unique`);
  const knownImpactIds = new Set(documentationImpactRuleIds());
  for (const impactId of watchedImpactIds) {
    assert(knownImpactIds.has(impactId), `${chapter.id} has unknown impact id: ${impactId}`);
    assert.notEqual(impactId, "demo-production",
      `${chapter.id} product freshness cannot watch demo-production`);
  }

  const evidenceDiff = changedFilesBetween(evidence.sha, targetSha).filter(isProductEvidenceFile);
  const mappedImpact = buildDocumentationImpact(evidenceDiff);
  const matchedImpacts = mappedImpact.impacts.filter((impact) => watchedImpactIds.includes(impact.id));
  const productChangedFiles = uniqueSorted(matchedImpacts.flatMap((impact) => impact.changed_files));

  const sourceImages = uniqueSorted((timeline.scenes || [])
    .map((scene) => scene.source_image)
    .filter(Boolean)
    .map((href) => repoPathFromAssetHref(href, `${chapter.id} source image`)));
  const generatorPath = normalizeGeneratorPath(manifest.source?.generator, chapter.id);
  const generatorCommit = latestPathCommit(targetSha, [generatorPath], `${chapter.id} source generator`);
  const sourceCommit = latestPathCommit(targetSha, [manifestPath, ...sourceImages],
    `${chapter.id} Source evidence`);
  const sourceIncludesGenerator = commitIsAncestor(generatorCommit, sourceCommit);
  const dependencyPaths = uniqueSorted([...sharedRenderDependencies, timelinePath, ...sourceImages]);
  const reviewPaths = uniqueSorted([
    path.posix.dirname(repoPathFromAssetHref(chapter.review?.artifacts?.review_1920,
      `${chapter.id} 1920 review`)),
    path.posix.dirname(repoPathFromAssetHref(chapter.review?.artifacts?.review_1024,
      `${chapter.id} 1024 review`)),
  ]);
  const dependencyCommit = latestPathCommit(targetSha, dependencyPaths,
    `${chapter.id} render dependencies`);
  const reviewCommit = latestPathCommit(targetSha, reviewPaths, `${chapter.id} review frames`);
  const reviewIncludesDependencies = commitIsAncestor(dependencyCommit, reviewCommit);

  const productStatus = matchedImpacts.length > 0 ? "review-required" : "current";
  const sourceStatus = sourceIncludesGenerator ? "current" : "regeneration-required";
  const renderStatus = reviewIncludesDependencies ? "current" : "regeneration-required";
  const status = [productStatus, sourceStatus, renderStatus].every((item) => item === "current")
    ? "current"
    : "review-required";

  return {
    id: chapter.id,
    label: chapter.label,
    status,
    product_evidence: {
      status: productStatus,
      evidence_sha: evidence.sha,
      evidence_field: evidence.field,
      watched_impact_ids: watchedImpactIds,
      matched_impact_ids: matchedImpacts.map((impact) => impact.id),
      changed_files: productChangedFiles,
    },
    source_recipe: {
      status: sourceStatus,
      generator_path: generatorPath,
      generator_commit: generatorCommit,
      source_commit: sourceCommit,
      source_paths: uniqueSorted([manifestPath, ...sourceImages]),
    },
    tracked_review_frames: {
      status: renderStatus,
      dependency_commit: dependencyCommit,
      review_commit: reviewCommit,
      dependency_paths: dependencyPaths,
      review_paths: reviewPaths,
    },
  };
}

function resolveEvidenceCommit(manifest, chapterId) {
  const candidates = [
    ["source.verified_origin_main", manifest.source?.verified_origin_main],
    ["source.product_baseline_sha", manifest.source?.product_baseline_sha],
    ["source.viewer_source_commit", manifest.source?.viewer_source_commit],
    ["product_sha", manifest.product_sha],
    ["source.verified_worktree_head", manifest.source?.verified_worktree_head],
  ];
  const candidate = candidates.find(([, value]) => typeof value === "string" && value.trim());
  assert(candidate, `${chapterId} manifest needs an exact product evidence SHA`);
  assert.match(candidate[1], shaPattern, `${chapterId} ${candidate[0]} must be a full lowercase SHA`);
  return { field: candidate[0], sha: candidate[1] };
}

function normalizeGeneratorPath(generator, chapterId) {
  assert(typeof generator === "string" && generator.length > 0,
    `${chapterId} manifest needs source.generator`);
  const normalized = generator.replaceAll("\\", "/").replace(/^\.\//, "");
  assert(normalized.startsWith("scripts/") && !normalized.includes(".."),
    `${chapterId} source.generator must be a repository script path`);
  assert(fs.existsSync(path.join(root, normalized)), `${chapterId} source.generator does not exist`);
  return normalized;
}

function isProductEvidenceFile(file) {
  return /^(?:bin|src|integrations)\//i.test(file)
    || /^(?:package|package-lock)\.json$/i.test(file);
}

function changedFilesBetween(baseSha, targetSha) {
  const output = git(["diff", "--name-only", "--diff-filter=ACMR", baseSha, targetSha, "--"]);
  return output.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
}

function latestPathCommit(targetSha, paths, label) {
  assert(paths.length > 0, `${label} must contain at least one path`);
  const sha = git(["log", "-1", "--format=%H", targetSha, "--", ...paths]).trim();
  assert.match(sha, shaPattern, `${label} has no tracked commit at ${targetSha}`);
  return sha;
}

function commitIsAncestor(ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr || `git merge-base failed with ${result.status}`);
}

function repoPathFromAssetHref(href, label) {
  assert(typeof href === "string" && href.startsWith("/assets/demo/"),
    `${label} must stay below /assets/demo/`);
  return href.slice(1);
}

function resolveRevision(revision) {
  const sha = git(["rev-parse", "--verify", `${revision}^{commit}`]).trim();
  assert.match(sha, shaPattern, `cannot resolve commit: ${revision}`);
  return sha;
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function printSummary(summary) {
  console.log(`demo freshness target: ${summary.target_sha}`);
  for (const chapter of summary.chapters) {
    console.log(
      `${chapter.id}: ${chapter.status}; product=${chapter.product_evidence.status}; `
      + `source=${chapter.source_recipe.status}; review=${chapter.tracked_review_frames.status}`,
    );
  }
  console.log(
    `demo freshness audit: ${summary.current_count}/${summary.chapter_count} current, `
    + `${summary.product_review_required_count} product reviews, `
    + `${summary.source_refresh_required_count} Source refreshes, `
    + `${summary.render_refresh_required_count} render refreshes`,
  );
}

function parseArguments(argv) {
  const options = { target: "HEAD", chapterIds: [], json: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      options.target = requiredArgument(argv, ++index, argument);
    } else if (argument === "--chapter") {
      options.chapterIds.push(requiredArgument(argv, ++index, argument));
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--strict") {
      options.strict = true;
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      return null;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function requiredArgument(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/demo-freshness-audit.mjs [options]

Options:
  --target <revision>  Compare receipts and tracked renders at this commit (default: HEAD)
  --chapter <id>       Audit one chapter; repeat to select more chapters
  --json               Print the machine-readable receipt report
  --strict             Exit non-zero when product evidence or review frames need refresh
  -h, --help           Show this help`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  const summary = auditDemoFreshness({
    target: options.target,
    chapterIds: options.chapterIds,
    log: !options.json,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (options.strict && summary.current_count !== summary.chapter_count) process.exitCode = 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
