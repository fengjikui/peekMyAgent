import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig, shellQuote } from "../../src/core/platform.mjs";

export const MIN_NODE_MAJOR = 24;
export const MIN_NODE_VERSION = ">=24.0.0";

export function assertNodeVersion() {
  const major = nodeMajorVersion(process.version);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`peekMyAgent requires Node.js ${MIN_NODE_VERSION}; current runtime is ${process.version}. The app uses node:sqlite for its local store.`);
  }
}

export function assertRepoRoot(repoRoot, scriptName) {
  const packagePath = path.join(repoRoot, "package.json");
  const binPath = path.join(repoRoot, "bin", "peekmyagent.mjs");
  if (!fs.existsSync(packagePath) || !fs.existsSync(binPath)) {
    throw new Error(`${scriptName} could not resolve the peekMyAgent source tree. Resolved root: ${repoRoot}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (packageJson.name !== "peekmyagent") {
    throw new Error(`Unexpected package name in ${packagePath}: ${packageJson.name || "missing"}`);
  }
}

export function runScriptStep({ label, command, args, cwd, dryRun, json }) {
  const step = {
    label,
    command: formatCommand(command, args),
    ok: true,
    skipped: dryRun,
    exit_code: dryRun ? null : 0,
  };
  if (dryRun) return step;

  if (!json) {
    console.log(`\n==> ${label}`);
    console.log(`$ ${step.command}`);
  }
  const spawnConfig = childProcessSpawnConfig(command, args);
  const result = spawnSync(spawnConfig.command, spawnConfig.args, {
    cwd,
    stdio: json ? "pipe" : "inherit",
    encoding: "utf8",
    ...spawnConfig.options,
  });
  step.exit_code = Number.isInteger(result.status) ? result.status : 1;
  step.ok = step.exit_code === 0;
  if (json) {
    step.stdout = result.stdout || "";
    step.stderr = result.stderr || "";
  }
  if (result.error) {
    step.ok = false;
    step.error = result.error.message;
  }
  return step;
}

export function formatCommand(command, args, { platform = process.platform } = {}) {
  return [command, ...args].map((part) => (needsShellQuoting(part) ? shellQuote(part, { platform }) : String(part))).join(" ");
}

export function hasFlag(args, name) {
  return args.includes(name);
}

export function optionValue(args, name) {
  const index = args.indexOf(name);
  const assignmentPrefix = `${name}=`;
  const assignment = args.find((arg) => String(arg).startsWith(assignmentPrefix));
  if (assignment) {
    const value = assignment.slice(assignmentPrefix.length);
    if (!value) throw new Error(`${name} requires a value.`);
    return value;
  }
  if (index === -1) return null;
  const value = args[index + 1] || "";
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value.`);
  return value;
}

function nodeMajorVersion(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function needsShellQuoting(value) {
  const text = String(value);
  return text.length === 0 || /\s/.test(text);
}
