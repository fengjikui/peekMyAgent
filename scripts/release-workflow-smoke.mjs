import assert from "node:assert/strict";
import fs from "node:fs";

const checkWorkflowPath = ".github/workflows/release-check.yml";
const publishWorkflowPath = ".github/workflows/publish.yml";
const checkWorkflow = fs.readFileSync(checkWorkflowPath, "utf8");
const publishWorkflow = fs.readFileSync(publishWorkflowPath, "utf8");

const requiredPairs = [
  ["ubuntu-latest", "npm run release:check:linux"],
  ["macos-latest", "npm run release:check:macos"],
  ["windows-latest", "npm run release:check:windows"],
];

assert.match(checkWorkflow, /^name:\s*Release Check/m);
assert.match(checkWorkflow, /pull_request:/);
assert.match(checkWorkflow, /workflow_dispatch:/);
assert.match(checkWorkflow, /permissions:\s*\n\s+contents:\s*read/);
assert.match(checkWorkflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(checkWorkflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(checkWorkflow, /persist-credentials:\s*false/);
assert.match(checkWorkflow, /node-version:\s*24/);
assert.match(checkWorkflow, /package-manager-cache:\s*false/);
assert.match(checkWorkflow, /fail-fast:\s*false/);
assert.match(checkWorkflow, /run:\s*npm ci/);
assert.match(checkWorkflow, /if:\s*github\.event_name != 'push'/);
assert.match(checkWorkflow, /main-integrity:/);
assert.match(checkWorkflow, /if:\s*github\.event_name == 'push'/);
assert.match(checkWorkflow, /name:\s*Main merge integrity/);
for (const command of [
  "npm run smoke:release-version",
  "npm run smoke:package",
  "npm run smoke:release-workflow",
  "npm run smoke:governance",
]) {
  assert.ok(checkWorkflow.includes(`run: ${command}`), `expected ${command} in the main integrity job`);
}

for (const [os, command] of requiredPairs) {
  assert.ok(checkWorkflow.includes(`os: ${os}`), `expected ${os} in release-check workflow`);
  assert.ok(checkWorkflow.includes(`command: ${command}`), `expected ${command} in release-check workflow`);
}

assert.equal((checkWorkflow.match(/command:\s*npm run release:check:/g) || []).length, requiredPairs.length);
assert.equal((publishWorkflow.match(/command:\s*npm run release:check:/g) || []).length, 0);
assert.doesNotMatch(publishWorkflow, /matrix:/);

assert.match(publishWorkflow, /^name:\s*Publish npm package/m);
assert.match(publishWorkflow, /release:\s*\n\s+types:\s*\[published\]/);
assert.match(publishWorkflow, /cancel-in-progress:\s*false/);
assert.match(publishWorkflow, /environment:\s*npm/);
assert.match(publishWorkflow, /contents:\s*read/);
assert.match(publishWorkflow, /id-token:\s*write/);
assert.match(publishWorkflow, /runs-on:\s*ubuntu-latest/);
assert.match(publishWorkflow, /ref:\s*\$\{\{ github\.event\.release\.tag_name \}\}/);
assert.match(publishWorkflow, /fetch-depth:\s*0/);
assert.match(publishWorkflow, /persist-credentials:\s*false/);
assert.match(publishWorkflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(publishWorkflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(publishWorkflow, /node-version:\s*24/);
assert.match(publishWorkflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
assert.match(publishWorkflow, /package-manager-cache:\s*false/);
assert.match(publishWorkflow, /npm install --global npm@11\.18\.0/);
assert.equal((publishWorkflow.match(/run:\s*npm ci/g) || []).length, 1);
assert.equal((publishWorkflow.match(/release:verify-version -- --tag=/g) || []).length, 1);
assert.match(publishWorkflow, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/);
assert.match(publishWorkflow, /git merge-base --is-ancestor HEAD origin\/main/);
assert.match(publishWorkflow, /run:\s*npm run smoke:package/);
assert.match(publishWorkflow, /echo "tag=next"/);
assert.match(publishWorkflow, /echo "tag=latest"/);
assert.match(publishWorkflow, /npm publish --provenance --access public --tag=/);
assert.doesNotMatch(publishWorkflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);

console.log("release workflow smoke passed");
