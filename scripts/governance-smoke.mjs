import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  buildDocumentationHandoff,
  buildDocumentationImpact,
  runDocumentationConsistencyAudit,
} from "./documentation-consistency-audit.mjs";
import {
  renderDocumentationImpactSummary,
  validateDocumentationImpactPayload,
} from "./documentation-impact-summary.mjs";

const requiredFiles = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/validation-strategy.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/agent_adapter_request.yml",
  ".github/ISSUE_TEMPLATE/trace_display_bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  "assets/demo/media-budget.json",
  "scripts/capture-storyboard-review-frames.mjs",
  "scripts/export-storyboard-video.mjs",
  "scripts/generate-storyboard-review-index.mjs",
  "scripts/documentation-impact-summary.mjs",
];

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `expected ${file}`);
}

const contributing = fs.readFileSync("CONTRIBUTING.md", "utf8");
assert.match(contributing, /Node\.js 24/i);
assert.match(contributing, /release:check/);
assert.match(contributing, /Do not commit captured sessions/i);
assert.match(contributing, /Adapter Contributions/);
assert.match(contributing, /tiered validation strategy/i);
assert.match(contributing, /Documentation impact/);

const validationStrategy = fs.readFileSync("docs/validation-strategy.md", "utf8");
assert.match(validationStrategy, /Level 0/);
assert.match(validationStrategy, /Level 1/);
assert.match(validationStrategy, /Level 2/);
assert.match(validationStrategy, /最多 3 个低风险代码提交/);
assert.match(validationStrategy, /一次 PR 托管三平台矩阵/);
assert.match(validationStrategy, /main.*不重复已经通过的同树三平台矩阵/);
assert.match(validationStrategy, /Documentation impact/);

const security = fs.readFileSync("SECURITY.md", "utf8");
assert.match(security, /Do not post secrets/i);
assert.match(security, /GitHub private vulnerability reporting/i);
assert.match(security, /local-first/i);

const bugTemplate = fs.readFileSync(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8");
assert.match(bugTemplate, /Operating system/);
assert.match(bugTemplate, /Shell/);
assert.match(bugTemplate, /Node and npm versions/);
assert.match(bugTemplate, /peekmyagent doctor --json/);

const adapterTemplate = fs.readFileSync(".github/ISSUE_TEMPLATE/agent_adapter_request.yml", "utf8");
assert.match(adapterTemplate, /How is the model endpoint configured/);
assert.match(adapterTemplate, /Stop or restore behavior/);
assert.match(adapterTemplate, /Platforms you can test/);

const traceTemplate = fs.readFileSync(".github/ISSUE_TEMPLATE/trace_display_bug.yml", "utf8");
assert.match(traceTemplate, /Sub-agent/);
assert.match(traceTemplate, /Redacted request or response shape/);

const prTemplate = fs.readFileSync(".github/pull_request_template.md", "utf8");
assert.match(prTemplate, /Deterministic release gate or focused smoke tests passed/);
assert.match(prTemplate, /Manual integration smokes are listed separately/);
assert.match(prTemplate, /Capture Boundary/);
assert.match(prTemplate, /Documentation And Demo Impact/);
assert.match(prTemplate, /documentation-consistency-audit\.mjs --base/);
assert.match(prTemplate, /--target HEAD/);
assert.match(prTemplate, /Documentation impact.*Job Summary/);
assert.match(prTemplate, /Documentation handoff target SHA/);

const documentationSummary = runDocumentationConsistencyAudit();
assert.equal(documentationSummary.documents, 14);
assert.equal(documentationSummary.demoMappings, 10);
assert.equal(documentationSummary.demoReviews, 10);
const documentationImpact = buildDocumentationImpact([
  "bin/peekmyagent.mjs",
  "src/viewer/agent-graph-view.js",
  "src/viewer/raw-inspector-controller.js",
]);
assert.deepEqual(
  documentationImpact.impacts.map((impact) => impact.id),
  ["cli-and-lifecycle", "subagents", "protocol-and-raw"],
);
assert(
  documentationImpact.impacts
    .find((impact) => impact.id === "subagents")
    .required_docs.includes("docs/user-guide/subagents.md"),
);
const documentationHandoff = buildDocumentationHandoff(documentationImpact);
assert.match(documentationHandoff.target_sha, /^[0-9a-f]{40}$/);
assert.equal(documentationHandoff.requires_documentation_review, true);
assert.deepEqual(documentationHandoff.impact_ids, ["cli-and-lifecycle", "subagents", "protocol-and-raw"]);
assert(documentationHandoff.required_docs.includes("docs/user-guide/subagents.md"));
assert(documentationHandoff.required_demos.includes("协议视图、Raw Inspector 与脱敏 JSON"));
assert.equal(documentationHandoff.validation_commands.at(-1), "git diff --check");
const mechanismImpact = buildDocumentationImpact([
  "src/trace/context-delta.mjs",
  "scripts/claude-compact-real-cli-probe.mjs",
  "src/viewer/turn-story-model.js",
  "scripts/claude-planning-real-cli-probe.mjs",
]);
assert.deepEqual(
  mechanismImpact.impacts.map((impact) => impact.id),
  ["timeline-navigation", "request-context", "context-lifecycle", "agent-planning"],
);
assert(mechanismImpact.impacts
  .find((impact) => impact.id === "context-lifecycle")
  .required_demos.includes("Claude Code 上下文压缩 Source 与双尺寸审阅帧"));
assert(mechanismImpact.impacts
  .find((impact) => impact.id === "agent-planning")
  .required_demos.includes("Claude Code 多步规划 Source 与双尺寸审阅帧"));
const impactPayload = {
  summary: documentationSummary,
  handoff: documentationHandoff,
  impact: documentationImpact,
};
const impactMarkdown = renderDocumentationImpactSummary(impactPayload, {
  expectedTarget: documentationHandoff.target_sha,
});
assert.match(impactMarkdown, /^# Documentation and demo impact/m);
assert.match(impactMarkdown, /Review required/);
assert.match(impactMarkdown, /docs\/user-guide\/subagents\.md/);
assert.match(impactMarkdown, /协议视图、Raw Inspector 与脱敏 JSON/);
assert.match(impactMarkdown, /does not publish documentation/);
assert.throws(
  () => validateDocumentationImpactPayload(impactPayload, { expectedTarget: "0".repeat(40) }),
  /target mismatch/,
);

const noImpact = buildDocumentationImpact(["src/core/internal-only-refactor.mjs"]);
const noImpactMarkdown = renderDocumentationImpactSummary({
  summary: documentationSummary,
  handoff: buildDocumentationHandoff(noImpact),
  impact: noImpact,
});
assert.match(noImpactMarkdown, /No mapped boundary/);
assert.match(noImpactMarkdown, /not proof that documentation is unaffected/);

const escapedImpact = buildDocumentationImpact(["src/core/<script>alert(1)</script>.mjs"]);
const escapedMarkdown = renderDocumentationImpactSummary({
  summary: documentationSummary,
  handoff: buildDocumentationHandoff(escapedImpact),
  impact: escapedImpact,
});
assert.doesNotMatch(escapedMarkdown, /<script>/);
assert.match(escapedMarkdown, /&lt;script&gt;/);

const exactRange = spawnSync(process.execPath, [
  "scripts/documentation-consistency-audit.mjs",
  "--base",
  "HEAD",
  "--target",
  "HEAD",
  "--json",
], { encoding: "utf8" });
assert.equal(exactRange.status, 0, `exact range audit failed:\n${exactRange.stderr}`);
const exactRangePayload = JSON.parse(exactRange.stdout);
assert.deepEqual(exactRangePayload.impact.changed_files, []);
assert.equal(exactRangePayload.handoff.target_sha, documentationHandoff.target_sha);
assert.equal(exactRangePayload.handoff.base_sha, documentationHandoff.target_sha);

const reviewCaptureHelp = spawnSync(process.execPath, [
  "scripts/capture-storyboard-review-frames.mjs",
  "--help",
], { encoding: "utf8" });
assert.equal(reviewCaptureHelp.status, 0, `storyboard capture help failed:\n${reviewCaptureHelp.stderr}`);
assert.match(reviewCaptureHelp.stdout, /<chapter-id>/);
assert.match(reviewCaptureHelp.stdout, /--output-root/);
assert.match(reviewCaptureHelp.stdout, /PMA_STORYBOARD_BROWSER/);

const videoExportHelp = spawnSync(process.execPath, [
  "scripts/export-storyboard-video.mjs",
  "--help",
], { encoding: "utf8" });
assert.equal(videoExportHelp.status, 0, `storyboard video export help failed:\n${videoExportHelp.stderr}`);
assert.match(videoExportHelp.stdout, /<chapter-id>/);
assert.match(videoExportHelp.stdout, /--include-subtitles/);
assert.match(videoExportHelp.stdout, /1920x1080 picture master/);

const reviewIndexHelp = spawnSync(process.execPath, [
  "scripts/generate-storyboard-review-index.mjs",
  "--help",
], { encoding: "utf8" });
assert.equal(reviewIndexHelp.status, 0, `storyboard review index help failed:\n${reviewIndexHelp.stderr}`);
assert.match(reviewIndexHelp.stdout, /--require-videos/);
assert.match(reviewIndexHelp.stdout, /--video-root/);
assert.match(reviewIndexHelp.stdout, /--check/);
assert.match(reviewIndexHelp.stdout, /localStorage/);
assert.match(reviewIndexHelp.stdout, /never updates catalog/);

const reviewIndexCheck = spawnSync(process.execPath, [
  "scripts/generate-storyboard-review-index.mjs",
  "--check",
], { encoding: "utf8" });
assert.equal(reviewIndexCheck.status, 0,
  `storyboard review index check failed:\n${reviewIndexCheck.stdout}${reviewIndexCheck.stderr}`);
assert.match(reviewIndexCheck.stdout, /10 chapters/);

const reviewIndexEmptyCheck = spawnSync(process.execPath, [
  "scripts/generate-storyboard-review-index.mjs",
  "--check",
  "--video-root",
  "tmp/storyboard-review-index-empty",
], { encoding: "utf8" });
assert.equal(reviewIndexEmptyCheck.status, 0,
  `empty storyboard review index check failed:\n${reviewIndexEmptyCheck.stdout}${reviewIndexEmptyCheck.stderr}`);
assert.match(reviewIndexEmptyCheck.stdout, /0 local videos, 0 verified picture masters/);

const demoProductionImpact = buildDocumentationImpact([
  "scripts/generate-storyboard-review-index.mjs",
]);
assert.deepEqual(demoProductionImpact.impacts.map((impact) => impact.id), ["demo-production"]);
assert(demoProductionImpact.impacts[0].required_docs.includes("docs/demo-chapter-production.zh-CN.md"));
assert(demoProductionImpact.impacts[0].required_demos.some((item) => item.includes("本地审片首页")));

const demoProduction = spawnSync(process.execPath, ["scripts/demo-production-audit.mjs"], {
  encoding: "utf8",
});
assert.equal(
  demoProduction.status,
  0,
  `demo production audit failed:\n${demoProduction.stdout}${demoProduction.stderr}`,
);
process.stdout.write(demoProduction.stdout);

console.log("governance smoke passed");
