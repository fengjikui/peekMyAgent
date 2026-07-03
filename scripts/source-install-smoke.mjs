import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig, npmGlobalBinPath, shellQuote } from "../src/core/platform.mjs";
import { formatCommand } from "./lib/source-script-common.mjs";

const result = spawnSync(process.execPath, ["scripts/install.mjs", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
});

assert.equal(result.status, 0, result.stderr);
const report = JSON.parse(result.stdout);
assert.equal(report.ok, true);
assert.equal(report.dry_run, true);
assert.equal(report.platform, process.platform);
assert.equal(report.node, process.version);
assert.equal(report.node_requirement, ">=24.0.0");
assert.equal(report.install_prefix, null);
assert.match(path.basename(report.repo_root).toLowerCase(), /^peekmyagent/);
assert.equal(fs.existsSync(path.join(report.repo_root, "package.json")), true);
assert.equal(report.steps[0]?.command, "npm install");
assert.equal(report.steps[1]?.command, "npm install -g .");
assert.match(report.steps[2]?.command || "", /peekmyagent\.mjs doctor$/i);
assert.ok(report.steps.every((step) => step.skipped === true && step.ok === true));

const noLink = spawnSync(process.execPath, ["scripts/install.mjs", "--dry-run", "--json", "--skip-link"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
assert.equal(noLink.status, 0, noLink.stderr);
const noLinkReport = JSON.parse(noLink.stdout);
assert.equal(noLinkReport.steps.length, 2);
assert.equal(noLinkReport.steps[0]?.command, "npm install");
assert.match(noLinkReport.steps[1]?.command || "", /peekmyagent\.mjs doctor$/i);

const missingPrefixValue = spawnSync(process.execPath, ["scripts/install.mjs", "--dry-run", "--json", "--prefix", "--skip-link"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
assert.equal(missingPrefixValue.status, 1);
const missingPrefixValueReport = JSON.parse(missingPrefixValue.stdout);
assert.equal(missingPrefixValueReport.ok, false);
assert.match(missingPrefixValueReport.error || "", /--prefix requires a value/);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-source-install-"));
const prefix = path.join(tmpDir, "prefix with spaces");
const stateDir = path.join(tmpDir, "state");
const apiPort = await freePort();
const capturePort = await freePort();
const isolatedEnv = {
  ...process.env,
  PEEKMYAGENT_STATE_DIR: stateDir,
  PEEKMYAGENT_DAEMON_PORT: String(apiPort),
  PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
};
try {
  assert.equal(formatCommand("npm", ["install", "--prefix", "/tmp/prefix with spaces"], { platform: "linux" }), "npm install --prefix '/tmp/prefix with spaces'");
  assert.equal(formatCommand("npm", ["install", "--prefix", "C:\\Temp\\prefix with spaces"], { platform: "win32" }), "npm install --prefix 'C:\\Temp\\prefix with spaces'");

  const realInstall = spawnSync(process.execPath, ["scripts/install.mjs", "--json", "--skip-deps", "--prefix", prefix], {
    cwd: process.cwd(),
    env: isolatedEnv,
    encoding: "utf8",
  });
  assert.equal(realInstall.status, 0, realInstall.stderr || realInstall.stdout);
  const realReport = JSON.parse(realInstall.stdout);
  assert.equal(realReport.ok, true);
  assert.equal(realReport.dry_run, false);
  assert.equal(realReport.install_prefix, prefix);
  assert.equal(realReport.steps[0]?.command, `npm install -g . --prefix ${quoteIfNeeded(prefix)}`);
  assert.match(realReport.steps[1]?.command || "", /'?peekmyagent(?:\.cmd)?'? doctor$/i);

  const binPath = npmGlobalBinPath(prefix, "peekmyagent");
  const aliasBinPath = npmGlobalBinPath(prefix, "pma");
  assert.equal(fs.existsSync(binPath), true, `expected installed CLI at ${binPath}`);
  assert.equal(fs.existsSync(aliasBinPath), true, `expected installed CLI alias at ${aliasBinPath}`);
  const installedDoctorEnv = {
    ...isolatedEnv,
    PEEKMYAGENT_STATE_DIR: path.join(tmpDir, "installed-state"),
  };
  const installedDoctorConfig = childProcessSpawnConfig(binPath, ["doctor", "--json"], { env: installedDoctorEnv });
  const installedDoctor = spawnSync(installedDoctorConfig.command, installedDoctorConfig.args, {
    cwd: tmpDir,
    env: installedDoctorEnv,
    encoding: "utf8",
    ...installedDoctorConfig.options,
  });
  assert.equal(installedDoctor.status, 0, installedDoctor.stderr);
  const installedReport = JSON.parse(installedDoctor.stdout);
  assert.equal(installedReport.package.name, "peekmyagent");

  const aliasHelpConfig = childProcessSpawnConfig(aliasBinPath, ["--help"], { env: isolatedEnv });
  const aliasHelp = spawnSync(aliasHelpConfig.command, aliasHelpConfig.args, {
    cwd: tmpDir,
    env: isolatedEnv,
    encoding: "utf8",
    ...aliasHelpConfig.options,
  });
  assert.equal(aliasHelp.status, 0, aliasHelp.stderr);
  assert.match(aliasHelp.stdout, /doctor/);

  const assignmentDryRun = spawnSync(process.execPath, ["scripts/install.mjs", "--dry-run", "--json", "--skip-deps", `--prefix=${prefix}`], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(assignmentDryRun.status, 0, assignmentDryRun.stderr);
  const assignmentDryRunReport = JSON.parse(assignmentDryRun.stdout);
  assert.equal(assignmentDryRunReport.install_prefix, prefix);
  assert.equal(assignmentDryRunReport.steps[0]?.command, `npm install -g . --prefix ${quoteIfNeeded(prefix)}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("source install smoke passed");

function quoteIfNeeded(value) {
  return /\s/.test(value) ? shellQuote(value) : value;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
