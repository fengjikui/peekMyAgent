import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig } from "../../src/core/platform.mjs";

export function readTrackedSnapshot({ cwd = process.cwd(), allowTrackedChanges = false } = {}) {
  if (allowTrackedChanges) return null;
  refreshGitIndex({ cwd });
  const status = runGit(["status", "--porcelain", "--untracked-files=no"], { cwd });
  const worktreeDiff = runGit(["diff", "--no-ext-diff", "--binary"], { cwd });
  const indexDiff = runGit(["diff", "--cached", "--no-ext-diff", "--binary"], { cwd });
  if (!status || !worktreeDiff || !indexDiff) return null;
  return {
    status: status.stdout.trim(),
    worktree_diff_hash: sha256(worktreeDiff.stdout),
    index_diff_hash: sha256(indexDiff.stdout),
  };
}

export function trackedSnapshotChanged(before, after, { allowTrackedChanges = false } = {}) {
  if (allowTrackedChanges) return false;
  if (before == null || after == null) return false;
  return before.worktree_diff_hash !== after.worktree_diff_hash || before.index_diff_hash !== after.index_diff_hash;
}

export function formatTrackedSnapshot(snapshot) {
  if (!snapshot) return "(unavailable)";
  return JSON.stringify(snapshot);
}

function refreshGitIndex({ cwd }) {
  const spawnConfig = childProcessSpawnConfig("git", ["update-index", "--refresh"]);
  spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...spawnConfig.options,
  });
}

function runGit(gitArgs, { cwd }) {
  const spawnConfig = childProcessSpawnConfig("git", gitArgs);
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...spawnConfig.options,
  });
  if (result.status !== 0 || result.error) return null;
  return { stdout: String(result.stdout || "") };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}
