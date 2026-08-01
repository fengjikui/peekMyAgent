import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  buildDocumentationHandoff,
  buildDocumentationImpact,
  runDocumentationConsistencyAudit,
} from "./documentation-consistency-audit.mjs";

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

const validationStrategy = fs.readFileSync("docs/validation-strategy.md", "utf8");
assert.match(validationStrategy, /Level 0/);
assert.match(validationStrategy, /Level 1/);
assert.match(validationStrategy, /Level 2/);
assert.match(validationStrategy, /最多 3 个低风险代码提交/);
assert.match(validationStrategy, /一次 PR 托管三平台矩阵/);
assert.match(validationStrategy, /main.*不重复已经通过的同树三平台矩阵/);

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
assert.match(prTemplate, /Documentation handoff target SHA/);

const documentationSummary = runDocumentationConsistencyAudit();
assert.equal(documentationSummary.documents, 14);
assert.equal(documentationSummary.demoMappings, 6);
assert.equal(documentationSummary.demoReviews, 6);
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
