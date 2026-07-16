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
assert.match(checkWorkflow, /permissions:\s*\n\s+contents:\s*read/);
assert.match(checkWorkflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(checkWorkflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(checkWorkflow, /persist-credentials:\s*false/);
assert.match(checkWorkflow, /node-version:\s*24/);
assert.match(checkWorkflow, /package-manager-cache:\s*false/);
assert.match(checkWorkflow, /fail-fast:\s*false/);
assert.match(checkWorkflow, /run:\s*npm ci/);

for (const [os, command] of requiredPairs) {
  assert.ok(checkWorkflow.includes(`os: ${os}`), `expected ${os} in release-check workflow`);
  assert.ok(checkWorkflow.includes(`command: ${command}`), `expected ${command} in release-check workflow`);
  assert.ok(publishWorkflow.includes(`os: ${os}`), `expected ${os} in publish workflow`);
  assert.ok(publishWorkflow.includes(`command: ${command}`), `expected ${command} in publish workflow`);
}

assert.equal((checkWorkflow.match(/command:\s*npm run release:check:/g) || []).length, requiredPairs.length);
assert.equal((publishWorkflow.match(/command:\s*npm run release:check:/g) || []).length, requiredPairs.length);

assert.match(publishWorkflow, /^name:\s*Publish npm package/m);
assert.match(publishWorkflow, /release:\s*\n\s+types:\s*\[published\]/);
assert.match(publishWorkflow, /cancel-in-progress:\s*false/);
assert.match(publishWorkflow, /needs:\s*release-check/);
assert.match(publishWorkflow, /environment:\s*npm/);
assert.match(publishWorkflow, /contents:\s*read/);
assert.match(publishWorkflow, /id-token:\s*write/);
assert.match(publishWorkflow, /runs-on:\s*ubuntu-latest/);
assert.match(publishWorkflow, /ref:\s*\$\{\{ github\.event\.release\.tag_name \}\}/);
assert.match(publishWorkflow, /persist-credentials:\s*false/);
assert.match(publishWorkflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(publishWorkflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(publishWorkflow, /node-version:\s*24/);
assert.match(publishWorkflow, /registry-url:\s*https:\/\/registry\.npmjs\.org/);
assert.match(publishWorkflow, /package-manager-cache:\s*false/);
assert.match(publishWorkflow, /npm install --global npm@11\.18\.0/);
assert.equal((publishWorkflow.match(/run:\s*npm ci/g) || []).length, 2);
assert.equal((publishWorkflow.match(/release:verify-version -- --tag=/g) || []).length, 2);
assert.match(publishWorkflow, /echo "tag=next"/);
assert.match(publishWorkflow, /echo "tag=latest"/);
assert.match(publishWorkflow, /npm publish --provenance --access public --tag=/);
assert.doesNotMatch(publishWorkflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);

console.log("release workflow smoke passed");
