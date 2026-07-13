import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";

const packConfig = childProcessSpawnConfig("npm", ["pack", "--dry-run", "--json"]);
const result = spawnSync(packConfig.command, packConfig.args, {
  cwd: process.cwd(),
  encoding: "utf8",
  ...packConfig.options,
});

assert.equal(result.status, 0, result.stderr);
const packs = JSON.parse(result.stdout);
assert.equal(packs.length, 1);
const files = new Set(packs[0].files.map((file) => file.path));
const packageFiles = [...files].sort();
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.match(packageJson.description || "", /agent|request|dashboard/i);
assert.ok(packageJson.keywords?.includes("agent"));
assert.ok(packageJson.keywords?.includes("observability"));
assert.equal(packageJson.repository?.type, "git");
assert.match(packageJson.repository?.url || "", /github\.com[:/]fengjikui\/peekMyAgent/i);
assert.match(packageJson.bugs?.url || "", /github\.com\/fengjikui\/peekMyAgent\/issues/i);
assert.match(packageJson.homepage || "", /github\.com\/fengjikui\/peekMyAgent/i);
assert.equal(packageJson.engines?.node, ">=24.0.0");
assert.notEqual(packageJson.private, true, "package must not be private before npm distribution");
assert.equal(packageJson.bin?.peekmyagent, "./bin/peekmyagent.mjs");
assert.equal(packageJson.bin?.pma, "./bin/peekmyagent.mjs");

for (const required of [
  "README.md",
  "package.json",
  "bin/peekmyagent.mjs",
  "src/viewer/server.mjs",
  "src/viewer/api-client.js",
  "src/viewer/client-store.js",
  "src/viewer/client.js",
  "src/viewer/markdown.js",
  "src/viewer/message-view-model.js",
  "src/viewer/messages-renderer.js",
  "src/viewer/raw-inspector-renderer.js",
  "src/viewer/raw-search-controller.js",
  "src/viewer/raw-search-model.js",
  "src/viewer/raw-view-model.js",
  "src/viewer/request-detail-cache.js",
  "src/viewer/translation-renderer.js",
  "src/viewer/translation-view-model.js",
  "src/viewer/trace-timeline-model.js",
  "src/viewer/turn-rail.js",
  "src/core/platform.mjs",
  "src/core/otel-events.mjs",
  "src/core/provenance.mjs",
  "src/core/source-identifiers.mjs",
  "src/server/http.mjs",
  "src/server/file-source-provider.mjs",
  "src/server/imported-trace-source-provider.mjs",
  "src/server/live-source-provider.mjs",
  "src/server/persisted-source-provider.mjs",
  "src/server/source-capture-reader.mjs",
  "src/server/source-lifecycle-service.mjs",
  "src/server/source-repository.mjs",
  "src/server/source-metadata.mjs",
  "src/server/source-text.mjs",
  "src/server/trace-bundle-service.mjs",
  "src/server/viewer-static-assets.mjs",
  "src/trace/message-equivalence.mjs",
  "src/trace/context-delta.mjs",
  "src/trace/turn-timeline.mjs",
  "src/trace/subagent-graph.mjs",
  "src/persistence/migrations/index.mjs",
  "src/persistence/migrations/runner.mjs",
  "src/translation/blocks.mjs",
  "src/translation/hash.mjs",
  "src/translation/materials.mjs",
  "src/translation/service.mjs",
  "integrations/claude-code/commands/peekmyagent.md",
  "integrations/openclaw/skills/peek-watch/SKILL.md",
  "scripts/install.mjs",
  "scripts/lib/source-script-common.mjs",
  "scripts/uninstall.mjs",
  "scripts/extract-translation-materials.mjs",
  "scripts/translate-materials-zh.mjs",
]) {
  assert.ok(files.has(required), `expected ${required} in npm package`);
}

for (const excluded of [
  ".github/workflows/release-check.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/pull_request_template.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "scripts/release-check.mjs",
  "scripts/governance-smoke.mjs",
  "scripts/source-install-smoke.mjs",
  "scripts/source-uninstall-smoke.mjs",
  "scripts/global-install-smoke.mjs",
  "scripts/run-claude-wrapper-smoke.mjs",
]) {
  assert.equal(files.has(excluded), false, `did not expect ${excluded} in npm package`);
}

const deniedPatterns = [
  /^docs\//,
  /^tmp\//,
  /^\.github\//,
  /^\.local\//,
  /^handovers?\//i,
  /(^|\/)(private|resume|memory|drafts?)(\/|$)/i,
  /(^|\/)\.env(?:\.|$)/,
  /\.(?:sqlite|db|jsonl|log|zip|tar|tgz|gz|mp4|mov|webm|gif|png|jpe?g)$/i,
];
const deniedFiles = packageFiles.filter((file) => deniedPatterns.some((pattern) => pattern.test(file)));
assert.deepEqual(deniedFiles, [], `npm package includes release-unsafe files: ${deniedFiles.join(", ")}`);

const MAX_PACKAGE_ENTRIES = 96;
const MAX_PACKED_BYTES = 250_000;
const MAX_UNPACKED_BYTES = 1_100_000;
assert.ok(packs[0].entryCount <= MAX_PACKAGE_ENTRIES, `npm package contains too many files: ${packs[0].entryCount}/${MAX_PACKAGE_ENTRIES}`);
assert.ok(packs[0].size <= MAX_PACKED_BYTES, `npm package is too large when packed: ${packs[0].size}/${MAX_PACKED_BYTES} bytes`);
assert.ok(
  packs[0].unpackedSize <= MAX_UNPACKED_BYTES,
  `npm package is too large when unpacked: ${packs[0].unpackedSize}/${MAX_UNPACKED_BYTES} bytes`,
);

console.log("package smoke passed");
