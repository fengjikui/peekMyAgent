import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";
import { readTrackedSnapshot, trackedSnapshotChanged } from "./lib/tracked-snapshot.mjs";

const profiles = [
  ["linux", "Linux host release gate"],
  ["macos", "macOS host release gate"],
  ["windows", "Windows host gate"],
];

for (const [profile, description] of profiles) {
  const spawnConfig = childProcessSpawnConfig(process.execPath, ["scripts/release-check.mjs", "--profile", profile, "--list"]);
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...spawnConfig.options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`release-check profile: ${profile}`));
  assert.match(result.stdout, new RegExp(description));
  assert.match(result.stdout, /npm run smoke:platform/);
  assert.match(result.stdout, /npm run smoke:source-install/);
  assert.match(result.stdout, /npm run smoke:source-uninstall/);
  assert.match(result.stdout, /npm run smoke:release-version/);
  assert.match(result.stdout, /npm run smoke:cli/);
  assert.match(result.stdout, /npm run smoke:normalize/);
  assert.match(result.stdout, /npm run smoke:watch-current/);
  assert.match(result.stdout, /npm run smoke:watch-pause-resume/);
  assert.match(result.stdout, /npm run smoke:daemon-claude/);
  assert.match(result.stdout, /npm run smoke:release-workflow/);
  assert.match(result.stdout, /npm run smoke:release-environment/);
  assert.match(result.stdout, /npm run smoke:governance/);
  assert.match(result.stdout, /npm run smoke:proxy-openai/);
  assert.match(result.stdout, /npm run smoke:proxy-anthropic/);
  assert.match(result.stdout, /npm run smoke:proxy-attribution/);
  assert.match(result.stdout, /npm run smoke:response-capture/);
  assert.match(result.stdout, /npm run smoke:raw-search-browser/);
  assert.match(result.stdout, /npm run smoke:tool-exchange-delta/);
  assert.match(result.stdout, /npm run smoke:timeline-display/);
  assert.match(result.stdout, /npm run smoke:claude-internal-turn/);
  assert.match(result.stdout, /npm run smoke:suggestion-mode/);
  assert.match(result.stdout, /npm run smoke:agent-trace-view/);
  assert.match(result.stdout, /npm run smoke:translation-contract/);
  assert.match(result.stdout, /npm run smoke:persistence-migrations/);
  assert.match(result.stdout, /npm run smoke:sqlite-capture-read-repository/);
  assert.match(result.stdout, /npm run smoke:capture-response-transaction/);
  assert.match(result.stdout, /npm run smoke:persistence-store/);
  assert.match(result.stdout, /npm run smoke:project-source-actions/);
  assert.match(result.stdout, /npm run smoke:request-tree/);
  assert.match(result.stdout, /npm run smoke:shared-proxy-auto-restore/);
}

if (process.platform !== "win32") {
  const wrongHostConfig = childProcessSpawnConfig(process.execPath, ["scripts/release-check.mjs", "--profile", "windows"]);
  const wrongHost = spawnSync(wrongHostConfig.command, wrongHostConfig.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...wrongHostConfig.options,
  });
  assert.notEqual(wrongHost.status, 0);
  assert.match(wrongHost.stderr, /must be run on win32/);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-release-check-guard-"));
try {
  const runGit = (args) => {
    const spawnConfig = childProcessSpawnConfig("git", args);
    return spawnSync(spawnConfig.command, spawnConfig.args, {
      cwd: tmpDir,
      encoding: "utf8",
      ...spawnConfig.options,
    });
  };
  assert.equal(runGit(["init"]).status, 0);
  fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "staged version\n");
  assert.equal(runGit(["add", "tracked.txt"]).status, 0);
  fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "dirty version one\n");
  const before = readTrackedSnapshot({ cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "tracked.txt"), "dirty version two\n");
  const after = readTrackedSnapshot({ cwd: tmpDir });
  assert.equal(before.status, after.status, "status-only guard would miss this change");
  assert.equal(trackedSnapshotChanged(before, after), true, "diff hash guard should detect same-status tracked changes");
  assert.equal(trackedSnapshotChanged(before, after, { allowTrackedChanges: true }), false);

  const statOnlyBefore = { ...before, status: "" };
  const statOnlyAfter = { ...before, status: " M tracked.txt" };
  assert.equal(
    trackedSnapshotChanged(statOnlyBefore, statOnlyAfter),
    false,
    "status-only changes with identical Git diffs should not fail the release gate",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("release check smoke passed");
