#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeVersion, assertRepoRoot, hasFlag, MIN_NODE_VERSION, optionValue, runScriptStep } from "./lib/source-script-common.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = hasFlag(args, "--dry-run");
const json = hasFlag(args, "--json");
const skipData = hasFlag(args, "--skip-data");
const skipNpm = hasFlag(args, "--skip-npm");
const removeData = hasFlag(args, "--remove-data");
const keepData = hasFlag(args, "--keep-data") || !removeData;
let installPrefix = null;
const steps = [];

try {
  installPrefix = optionValue(args, "--prefix");
  assertNodeVersion();
  assertRepoRoot(repoRoot, "scripts/uninstall.mjs");
  if (removeData && hasFlag(args, "--keep-data")) throw new Error("Use only one of --keep-data or --remove-data.");
  if (!skipData) addStep("Remove peekMyAgent helpers/data", process.execPath, [path.join(repoRoot, "bin", "peekmyagent.mjs"), "uninstall", removeData ? "--remove-data" : "--keep-data", "--keep-cli", "--json"]);
  if (!skipNpm) addStep("Uninstall peekmyagent CLI", "npm", ["uninstall", "-g", "peekmyagent", ...prefixArgs()]);

  const result = {
    ok: steps.every((step) => step.ok),
    dry_run: dryRun,
    repo_root: repoRoot,
    platform: process.platform,
    node: process.version,
    node_requirement: MIN_NODE_VERSION,
    install_prefix: installPrefix || null,
    data: removeData ? "removed" : keepData ? "kept" : "unchanged",
    steps,
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

function writeResult(result) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.ok) {
    console.log(dryRun ? "peekMyAgent uninstall plan is valid." : "\npeekMyAgent source uninstall complete.");
    for (const step of result.steps) console.log(`- ${step.skipped ? "would run" : "ran"}: ${step.command}`);
  } else {
    console.error(`peekMyAgent uninstall failed: ${result.error || "unknown error"}`);
    for (const step of result.steps) console.error(`- ${step.ok ? "ok" : "failed"}: ${step.command}`);
  }
}
