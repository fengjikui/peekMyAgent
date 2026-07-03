import assert from "node:assert/strict";
import fs from "node:fs";

const requiredFiles = [
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/agent_adapter_request.yml",
  ".github/ISSUE_TEMPLATE/trace_display_bug.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
];

for (const file of requiredFiles) {
  assert.equal(fs.existsSync(file), true, `expected ${file}`);
}

const contributing = fs.readFileSync("CONTRIBUTING.md", "utf8");
assert.match(contributing, /Node\.js 24/i);
assert.match(contributing, /release:check/);
assert.match(contributing, /Do not commit captured sessions/i);
assert.match(contributing, /Adapter Contributions/);

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

console.log("governance smoke passed");
