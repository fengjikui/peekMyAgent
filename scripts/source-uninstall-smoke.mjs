import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { npmGlobalBinPath } from "../src/core/platform.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-source-uninstall-"));
const prefix = path.join(tmpDir, "prefix with spaces");
const stateDir = path.join(tmpDir, "state");
const binPath = npmGlobalBinPath(prefix, "peekmyagent");
const apiPort = await freePort();
const capturePort = await freePort();
const isolatedEnv = {
  ...process.env,
  PEEKMYAGENT_STATE_DIR: stateDir,
  PEEKMYAGENT_DAEMON_PORT: String(apiPort),
  PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
};

try {
  const dryRun = spawnSync(process.execPath, ["scripts/uninstall.mjs", "--dry-run", "--json", "--prefix", prefix, "--remove-data"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunReport = JSON.parse(dryRun.stdout);
  assert.equal(dryRunReport.ok, true);
  assert.equal(dryRunReport.dry_run, true);
  assert.equal(dryRunReport.install_prefix, prefix);
  assert.match(dryRunReport.steps[0]?.command || "", /peekmyagent\.mjs"? uninstall --remove-data --json/i);
  assert.match(dryRunReport.steps[1]?.command || "", /npm uninstall -g peekmyagent --prefix /i);

  const missingPrefixValue = spawnSync(process.execPath, ["scripts/uninstall.mjs", "--dry-run", "--json", "--prefix", "--keep-data"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(missingPrefixValue.status, 1);
  const missingPrefixValueReport = JSON.parse(missingPrefixValue.stdout);
  assert.equal(missingPrefixValueReport.ok, false);
  assert.match(missingPrefixValueReport.error || "", /--prefix requires a value/);

  const assignmentDryRun = spawnSync(process.execPath, ["scripts/uninstall.mjs", "--dry-run", "--json", `--prefix=${prefix}`, "--keep-data"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(assignmentDryRun.status, 0, assignmentDryRun.stderr);
  const assignmentDryRunReport = JSON.parse(assignmentDryRun.stdout);
  assert.equal(assignmentDryRunReport.install_prefix, prefix);
  assert.match(assignmentDryRunReport.steps[1]?.command || "", /npm uninstall -g peekmyagent --prefix /i);

  const install = spawnSync(process.execPath, ["scripts/install.mjs", "--json", "--skip-deps", "--prefix", prefix], {
    cwd: process.cwd(),
    env: isolatedEnv,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.equal(fs.existsSync(binPath), true, `expected installed CLI at ${binPath}`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "store.sqlite"), "store");

  const uninstall = spawnSync(process.execPath, ["scripts/uninstall.mjs", "--json", "--prefix", prefix, "--remove-data"], {
    cwd: process.cwd(),
    env: isolatedEnv,
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  const report = JSON.parse(uninstall.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.dry_run, false);
  assert.equal(report.install_prefix, prefix);
  assert.equal(report.data, "removed");
  assert.equal(report.steps[0]?.exit_code, 0);
  assert.equal(report.steps[1]?.exit_code, 0);
  assert.equal(fs.existsSync(binPath), false, `expected uninstalled CLI to be removed at ${binPath}`);
  assert.equal(fs.existsSync(stateDir), false, "expected remove-data to remove the owned empty state dir");

  console.log("source uninstall smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
