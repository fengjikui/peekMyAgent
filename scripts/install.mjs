#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmGlobalBinPath } from "../src/core/platform.mjs";
import { assertNodeVersion, assertRepoRoot, hasFlag, MIN_NODE_VERSION, optionValue, runScriptStep } from "./lib/source-script-common.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = hasFlag(args, "--dry-run");
const json = hasFlag(args, "--json");
const skipDeps = hasFlag(args, "--skip-deps");
const skipLink = hasFlag(args, "--skip-link");
const skipDoctor = hasFlag(args, "--skip-doctor");
let installPrefix = null;

const steps = [];

try {
  installPrefix = optionValue(args, "--prefix");
  assertNodeVersion();
  assertRepoRoot(repoRoot, "scripts/install.mjs");
  if (!skipDeps) addStep("Install dependencies", "npm", ["install"]);
  if (!skipLink) addStep("Install peekmyagent CLI", "npm", ["install", "-g", ".", ...prefixArgs()]);
  if (!skipDoctor) addStep("Run doctor", ...doctorCommand());

  const result = {
    ok: steps.every((step) => step.ok),
    dry_run: dryRun,
    repo_root: repoRoot,
    platform: process.platform,
    node: process.version,
    node_requirement: MIN_NODE_VERSION,
    install_prefix: installPrefix || null,
    steps,
    next: "Run pma open, then start an Agent with pma claude -c or pma openclaw ...",
  };
  writeResult(result);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  writeResult({ ok: false, dry_run: dryRun, repo_root: repoRoot, platform: process.platform, node: process.version, node_requirement: MIN_NODE_VERSION, install_prefix: installPrefix || null, steps, error: error.message });
  process.exit(1);
}

function addStep(label, command, commandArgs) {
  const step = runScriptStep({ label, command, args: commandArgs, cwd: repoRoot, dryRun, json });
  steps.push(step);
  if (!step.ok) throw new Error(`${label} failed with exit code ${step.exit_code}${step.error ? `: ${step.error}` : ""}`);
}

function prefixArgs() {
  return installPrefix ? ["--prefix", installPrefix] : [];
}

function doctorCommand() {
  if (installPrefix && !skipLink) return [npmGlobalBinPath(installPrefix, "peekmyagent"), ["doctor"]];
  return [process.execPath, [path.join(repoRoot, "bin", "peekmyagent.mjs"), "doctor"]];
}

function writeResult(result) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.ok) {
    console.log(dryRun ? "peekMyAgent install plan is valid." : "\npeekMyAgent source install complete.");
    for (const step of result.steps) console.log(`- ${step.skipped ? "would run" : "ran"}: ${step.command}`);
    console.log(result.next);
  } else {
    console.error(`peekMyAgent install failed: ${result.error || "unknown error"}`);
    for (const step of result.steps) console.error(`- ${step.ok ? "ok" : "failed"}: ${step.command}`);
  }
}
