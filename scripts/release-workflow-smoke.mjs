import assert from "node:assert/strict";
import fs from "node:fs";

const workflowPath = ".github/workflows/release-check.yml";
const workflow = fs.readFileSync(workflowPath, "utf8");

const requiredPairs = [
  ["ubuntu-latest", "npm run release:check:linux"],
  ["macos-latest", "npm run release:check:macos"],
  ["windows-latest", "npm run release:check:windows"],
];

assert.match(workflow, /^name:\s*Release Check/m);
assert.match(workflow, /pull_request:/);
assert.match(workflow, /actions\/checkout@v4/);
assert.match(workflow, /actions\/setup-node@v4/);
assert.match(workflow, /node-version:\s*24/);
assert.match(workflow, /fail-fast:\s*false/);

for (const [os, command] of requiredPairs) {
  assert.ok(workflow.includes(`os: ${os}`), `expected ${os} in release workflow`);
  assert.ok(workflow.includes(`command: ${command}`), `expected ${command} in release workflow`);
}

assert.equal((workflow.match(/command:\s*npm run release:check:/g) || []).length, requiredPairs.length);

console.log("release workflow smoke passed");
