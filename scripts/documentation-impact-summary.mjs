#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const shaPattern = /^[0-9a-f]{40}$/;

export function validateDocumentationImpactPayload(payload, {
  expectedTarget = null,
  expectedBase = null,
} = {}) {
  assertRecord(payload, "payload");
  assertRecord(payload.summary, "payload.summary");
  assertRecord(payload.handoff, "payload.handoff");
  assertRecord(payload.impact, "payload.impact");

  const { handoff, impact } = payload;
  assertSha(handoff.target_sha, "payload.handoff.target_sha");
  if (handoff.base_sha !== null) assertSha(handoff.base_sha, "payload.handoff.base_sha");
  assertBoolean(handoff.working_tree_dirty, "payload.handoff.working_tree_dirty");
  assertBoolean(handoff.requires_documentation_review,
    "payload.handoff.requires_documentation_review");
  for (const field of [
    "changed_files",
    "impact_ids",
    "required_docs",
    "required_demos",
    "required_demo_chapters",
    "validation_commands",
    "sensitive_data_restrictions",
  ]) {
    assertStringArray(handoff[field], `payload.handoff.${field}`);
  }

  assertStringArray(impact.changed_files, "payload.impact.changed_files");
  assertStringArray(impact.demo_chapters, "payload.impact.demo_chapters");
  if (!Array.isArray(impact.impacts)) throw new Error("payload.impact.impacts must be an array");
  for (const [index, item] of impact.impacts.entries()) {
    const label = `payload.impact.impacts[${index}]`;
    assertRecord(item, label);
    assertNonEmptyString(item.id, `${label}.id`);
    assertNonEmptyString(item.label, `${label}.label`);
    assertStringArray(item.changed_files, `${label}.changed_files`);
    assertStringArray(item.required_docs, `${label}.required_docs`);
    assertStringArray(item.required_demos, `${label}.required_demos`);
  }

  if (!equalArrays(handoff.changed_files, impact.changed_files)) {
    throw new Error("payload handoff and impact changed_files must match");
  }
  const impactIds = impact.impacts.map((item) => item.id);
  if (!equalArrays(handoff.impact_ids, impactIds)) {
    throw new Error("payload handoff impact_ids must match mapped impacts");
  }
  const requiredDocs = uniqueSorted(impact.impacts.flatMap((item) => item.required_docs));
  if (!equalArrays(handoff.required_docs, requiredDocs)) {
    throw new Error("payload handoff required_docs must match mapped impacts");
  }
  const requiredDemos = uniqueSorted(impact.impacts.flatMap((item) => item.required_demos));
  if (!equalArrays(handoff.required_demos, requiredDemos)) {
    throw new Error("payload handoff required_demos must match mapped impacts");
  }
  if (!equalArrays(handoff.required_demo_chapters, impact.demo_chapters)) {
    throw new Error("payload handoff required_demo_chapters must match mapped demo chapters");
  }
  const changedFileSet = new Set(impact.changed_files);
  for (const item of impact.impacts) {
    if (item.changed_files.some((file) => !changedFileSet.has(file))) {
      throw new Error(`payload mapped impact ${item.id} contains an unreported changed file`);
    }
  }
  if (handoff.requires_documentation_review !== (impact.impacts.length > 0)) {
    throw new Error("payload review status must match mapped impact count");
  }
  if (expectedTarget !== null && handoff.target_sha !== expectedTarget) {
    throw new Error(
      `documentation impact target mismatch: expected ${expectedTarget}, got ${handoff.target_sha}`,
    );
  }
  if (expectedBase !== null && handoff.base_sha !== expectedBase) {
    throw new Error(
      `documentation impact base mismatch: expected ${expectedBase}, got ${handoff.base_sha}`,
    );
  }
  return payload;
}

export function renderDocumentationImpactSummary(payload, options = {}) {
  const validated = validateDocumentationImpactPayload(payload, options);
  const { handoff, impact } = validated;
  const mappedCount = impact.impacts.length;
  const lines = [
    "# Documentation and demo impact",
    "",
    "> Read-only advisory generated from repository rules. It does not publish documentation, comment on the PR, create an issue, or replace manual Viewer review.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Target commit | ${inlineCode(handoff.target_sha)} |`,
    `| Base commit | ${handoff.base_sha ? inlineCode(handoff.base_sha) : "Not supplied"} |`,
    `| Working tree | ${handoff.working_tree_dirty ? "Dirty" : "Clean"} |`,
    `| Mapped boundaries | ${mappedCount} |`,
    "",
    "## Result",
    "",
  ];

  if (handoff.requires_documentation_review) {
    lines.push(
      `**Review required.** ${mappedCount} user-documentation ${mappedCount === 1 ? "boundary was" : "boundaries were"} matched. Update the listed artifacts or record concrete evidence that public behavior did not change.`,
    );
  } else {
    lines.push(
      "**No mapped boundary.** This is not proof that documentation is unaffected; the author must still assess changed copy, interactions, protocol facts, and public behavior.",
    );
  }

  lines.push("", "## Consolidated handoff", "", "### Required documents", "");
  appendList(lines, handoff.required_docs, { empty: "No document was selected by the current mapping." });
  lines.push("", "### Affected demo chapters", "");
  appendList(lines, handoff.required_demo_chapters, {
    empty: "No concrete demo chapter was selected by the current mapping.",
  });
  lines.push("", "### Required demo Sources or frames", "");
  appendList(lines, handoff.required_demos, { empty: "No demo artifact was selected by the current mapping." });

  if (mappedCount > 0) {
    lines.push("", "## Mapped boundaries", "");
    for (const item of impact.impacts) {
      lines.push(
        `### ${escapeText(item.label)} (${inlineCode(item.id)})`,
        "",
        "Changed in this boundary:",
        "",
      );
      appendList(lines, item.changed_files, { limit: 40 });
      lines.push("", "Required documents:", "");
      appendList(lines, item.required_docs);
      lines.push("", "Required demo Sources or frames:", "");
      appendList(lines, item.required_demos);
      lines.push("");
    }
  }

  lines.push(
    "<details>",
    `<summary>Changed files (${impact.changed_files.length})</summary>`,
    "",
  );
  appendList(lines, impact.changed_files, { empty: "No changed files were reported.", limit: 80 });
  lines.push("", "</details>", "", "## Validation commands", "");
  appendList(lines, handoff.validation_commands);
  lines.push("", "## Privacy restrictions", "");
  appendList(lines, handoff.sensitive_data_restrictions);
  lines.push("");

  return lines.join("\n");
}

function appendList(lines, values, { empty = "None.", limit = Number.POSITIVE_INFINITY } = {}) {
  if (values.length === 0) {
    lines.push(`- ${escapeText(empty)}`);
    return;
  }
  const shown = values.slice(0, limit);
  for (const value of shown) lines.push(`- ${inlineCode(value)}`);
  if (values.length > shown.length) {
    lines.push(`- ${values.length - shown.length} additional entries omitted from this summary.`);
  }
}

function inlineCode(value) {
  return `<code>${escapeText(value)}</code>`;
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function parseArguments(argv) {
  const options = {
    input: null,
    output: null,
    expectedTarget: null,
    expectedBase: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      options.input = requiredArgument(argv, ++index, argument);
    } else if (argument === "--output") {
      options.output = requiredArgument(argv, ++index, argument);
    } else if (argument === "--expected-target") {
      options.expectedTarget = requiredArgument(argv, ++index, argument);
    } else if (argument === "--expected-base") {
      options.expectedBase = requiredArgument(argv, ++index, argument);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.input) throw new Error("--input is required");
  if (options.expectedTarget !== null) assertSha(options.expectedTarget, "--expected-target");
  if (options.expectedBase !== null) assertSha(options.expectedBase, "--expected-base");
  return options;
}

function requiredArgument(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const payload = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
  const markdown = renderDocumentationImpactSummary(payload, options);
  const output = options.output || process.env.GITHUB_STEP_SUMMARY || null;
  if (output) fs.appendFileSync(path.resolve(output), markdown, "utf8");

  const mappedCount = payload.impact.impacts.length;
  const status = payload.handoff.requires_documentation_review ? "review required" : "no mapped boundary";
  console.log(`documentation impact summary: ${status} (${mappedCount} mapped boundaries)`);
  if (process.env.GITHUB_ACTIONS === "true" && payload.handoff.requires_documentation_review) {
    console.log(
      `::notice title=Documentation review required::${mappedCount} mapped user-documentation boundaries; inspect the job summary.`,
    );
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
