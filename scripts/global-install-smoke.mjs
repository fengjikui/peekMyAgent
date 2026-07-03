import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig, npmGlobalBinPath } from "../src/core/platform.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-global-install-"));
const prefix = path.join(tmpDir, "prefix with spaces");
const stateDir = path.join(tmpDir, "state");
const apiPort = await freePort();
const capturePort = await freePort();

try {
  const installConfig = childProcessSpawnConfig("npm", ["install", "-g", ".", "--prefix", prefix]);
  const install = spawnSync(installConfig.command, installConfig.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...installConfig.options,
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const binPath = npmGlobalBinPath(prefix, "peekmyagent");
  const aliasBinPath = npmGlobalBinPath(prefix, "pma");
  assert.equal(fs.existsSync(binPath), true, `expected installed CLI at ${binPath}`);
  assert.equal(fs.existsSync(aliasBinPath), true, `expected installed CLI alias at ${aliasBinPath}`);

  const helpConfig = childProcessSpawnConfig(binPath, ["--help"]);
  const help = spawnSync(helpConfig.command, helpConfig.args, {
    cwd: tmpDir,
    encoding: "utf8",
    ...helpConfig.options,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /peekmyagent/i);
  assert.match(help.stdout, /doctor/);

  const aliasHelpConfig = childProcessSpawnConfig(aliasBinPath, ["--help"]);
  const aliasHelp = spawnSync(aliasHelpConfig.command, aliasHelpConfig.args, {
    cwd: tmpDir,
    encoding: "utf8",
    ...aliasHelpConfig.options,
  });
  assert.equal(aliasHelp.status, 0, aliasHelp.stderr);
  assert.match(aliasHelp.stdout, /peekmyagent/i);
  assert.match(aliasHelp.stdout, /doctor/);

  const doctorEnv = {
    ...process.env,
    PEEKMYAGENT_STATE_DIR: stateDir,
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
  };
  const doctorConfig = childProcessSpawnConfig(binPath, ["doctor", "--json"], { env: doctorEnv });
  const doctor = spawnSync(doctorConfig.command, doctorConfig.args, {
    cwd: tmpDir,
    env: doctorEnv,
    encoding: "utf8",
    ...doctorConfig.options,
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.paths.state_dir, stateDir);
  assert.equal(report.package.name, "peekmyagent");

  console.log("global install smoke passed");
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
