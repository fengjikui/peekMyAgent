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
assert.notEqual(packageJson.version, "0.0.0", "package must use a real release version before npm distribution");
assert.match(packageJson.version || "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(packageJson.publishConfig?.access, "public");
assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org/");
assert.equal(packageJson.bin?.peekmyagent, "./bin/peekmyagent.mjs");
assert.equal(packageJson.bin?.pma, "./bin/peekmyagent.mjs");

for (const required of [
  "CHANGELOG.md",
  "README.md",
  "package.json",
  "bin/peekmyagent.mjs",
  "src/viewer/server.mjs",
  "src/viewer/active-source-controller.js",
  "src/viewer/agent-composer-controller.js",
  "src/viewer/agent-composer-model.js",
  "src/viewer/agent-composer-renderer.js",
  "src/viewer/agent-graph-model.js",
  "src/viewer/agent-graph-renderer.js",
  "src/viewer/upstream-detail-model.js",
  "src/viewer/upstream-detail-renderer.js",
  "src/viewer/api-client.js",
  "src/viewer/client-store.js",
  "src/viewer/client.js",
  "src/viewer/language-preferences-controller.js",
  "src/viewer/markdown.js",
  "src/viewer/message-view-model.js",
  "src/viewer/messages-renderer.js",
  "src/viewer/pane-layout-controller.js",
  "src/viewer/pane-layout-model.js",
  "src/viewer/raw-inspector-controller.js",
  "src/viewer/raw-inspector-renderer.js",
  "src/viewer/raw-search-controller.js",
  "src/viewer/raw-search-model.js",
  "src/viewer/raw-view-model.js",
  "src/viewer/request-card-model.js",
  "src/viewer/request-card-renderer.js",
  "src/viewer/request-detail-cache.js",
  "src/viewer/source-timeline-controller.js",
  "src/viewer/timeline-entity-store.js",
  "src/viewer/session-navigator-controller.js",
  "src/viewer/session-navigator-model.js",
  "src/viewer/session-navigator-renderer.js",
  "src/viewer/system-diff-model.js",
  "src/viewer/system-diff-renderer.js",
  "src/viewer/translation-action-controller.js",
  "src/viewer/translation-action-model.js",
  "src/viewer/translation-cache-controller.js",
  "src/viewer/translation-generation-operation.js",
  "src/viewer/translation-language-catalog.js",
  "src/viewer/translation-renderer.js",
  "src/viewer/translation-view-model.js",
  "src/viewer/trace-timeline-controller.js",
  "src/viewer/trace-timeline-model.js",
  "src/viewer/trace-timeline-renderer.js",
  "src/viewer/ui-i18n.js",
  "src/viewer/turn-rail.js",
  "src/core/platform.mjs",
  "src/core/otel-events.mjs",
  "src/core/provenance.mjs",
  "src/core/source-identifiers.mjs",
  "src/adapters/codex-desktop-discovery.mjs",
  "src/adapters/codex-desktop-session.mjs",
  "src/server/http.mjs",
  "src/contracts/viewer-api.mjs",
  "src/server/viewer-router.mjs",
  "src/server/viewer-translation-adapter.mjs",
  "src/server/watch-runtime-service.mjs",
  "src/server/file-source-provider.mjs",
  "src/server/imported-trace-source-provider.mjs",
  "src/server/agent-send-service.mjs",
  "src/server/json-array-file-index.mjs",
  "src/server/live-source-provider.mjs",
  "src/server/otel-ingest-service.mjs",
  "src/server/codex-pending-capture-reader.mjs",
  "src/server/persisted-source-provider.mjs",
  "src/server/source-capture-reader.mjs",
  "src/server/source-lifecycle-service.mjs",
  "src/server/source-repository.mjs",
  "src/server/source-metadata.mjs",
  "src/server/source-text.mjs",
  "src/server/trace-bundle-service.mjs",
  "src/server/timeline-view-projector.mjs",
  "src/server/timeline-cursor-service.mjs",
  "src/server/timeline-page-assembler.mjs",
  "src/server/viewer-static-assets.mjs",
  "src/server/viewer-trace-projector.mjs",
  "src/trace/message-equivalence.mjs",
  "src/trace/context-delta.mjs",
  "src/trace/content-parts.mjs",
  "src/trace/message-semantics.mjs",
  "src/trace/request-profile.mjs",
  "src/trace/request-composition.mjs",
  "src/trace/model-response-normalizer.mjs",
  "src/trace/turn-timeline.mjs",
  "src/trace/subagent-graph.mjs",
  "src/persistence/migrations/index.mjs",
  "src/persistence/migrations/runner.mjs",
  "src/persistence/repositories/sqlite-capture-read-repository.mjs",
  "src/translation/blocks.mjs",
  "src/translation/hash.mjs",
  "src/translation/materials.mjs",
  "src/translation/service.mjs",
  "integrations/claude-code/commands/peekmyagent.md",
  "integrations/openclaw/skills/peek-watch/SKILL.md",
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
  "scripts/install.mjs",
  "scripts/lib/source-script-common.mjs",
  "scripts/uninstall.mjs",
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

const allowedPatterns = [
  /^(?:CHANGELOG\.md|LICENSE|README\.md|README\.zh-CN\.md|package\.json)$/,
  /^bin\//,
  /^src\//,
  /^integrations\//,
  /^scripts\/(?:extract-translation-materials|translate-materials-zh)\.mjs$/,
];
const unexpectedFiles = packageFiles.filter((file) => !allowedPatterns.some((pattern) => pattern.test(file)));
assert.deepEqual(unexpectedFiles, [], `npm package includes files outside the release allowlist: ${unexpectedFiles.join(", ")}`);

const MAX_PACKAGE_ENTRIES = 140;
// Codex capture and Agent-scoped translation are shipped runtime code. Keep a
// narrow post-feature budget while the path allowlist continues to prevent
// fixtures, design docs, captures, and other release-unsafe files from leaking
// into the package.
const MAX_PACKED_BYTES = 290_000;
// Windows npm pack reports the CRLF checkout representation, so this limit
// includes the observed cross-platform line-ending delta as well.
const MAX_UNPACKED_BYTES = 1_260_000;
assert.ok(packs[0].entryCount <= MAX_PACKAGE_ENTRIES, `npm package contains too many files: ${packs[0].entryCount}/${MAX_PACKAGE_ENTRIES}`);
assert.ok(packs[0].size <= MAX_PACKED_BYTES, `npm package is too large when packed: ${packs[0].size}/${MAX_PACKED_BYTES} bytes`);
assert.ok(
  packs[0].unpackedSize <= MAX_UNPACKED_BYTES,
  `npm package is too large when unpacked: ${packs[0].unpackedSize}/${MAX_UNPACKED_BYTES} bytes`,
);

console.log("package smoke passed");
