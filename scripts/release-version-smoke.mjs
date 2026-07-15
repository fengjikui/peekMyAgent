import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = packageJson.version;

const verified = run(["--tag", `v${version}`]);
assert.equal(verified.status, 0, verified.stderr || verified.stdout);
assert.match(verified.stdout, new RegExp(`release version verified: v${escapeRegExp(version)}`));

const mismatched = run(["--tag", "v999.0.0"]);
assert.notEqual(mismatched.status, 0);
assert.match(mismatched.stderr, /does not match package version/);

console.log(`release version smoke passed (${version})`);

function run(args) {
  return spawnSync(process.execPath, ["scripts/verify-release-version.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
