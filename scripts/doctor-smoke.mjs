import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-doctor-"));
const fakeHome = path.join(tmpDir, "home");
const workspace = path.join(tmpDir, "workspace");
const stateDir = path.join(tmpDir, "state");
const apiPort = await freePort();
const capturePort = await freePort();

try {
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }));
  fs.writeFileSync(path.join(workspace, ".claude", "settings.local.json"), "{not json");
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    PEEKMYAGENT_STATE_DIR: stateDir,
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
  };
  const result = runCli(["doctor", "--json"], env, workspace);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runtime.node, process.version);
  assert.equal(report.runtime.node_requirement, ">=24.0.0");
  assert.equal(report.runtime.node_ok, true);
  assert.equal(typeof report.runtime.macos_privacy.protected_location, "boolean");
  assert.ok(report.checks.some((item) => item.id === "node-version" && item.status === "ok"));
  assert.equal(report.paths.state_dir, stateDir);
  assert.equal(report.paths.store_path, path.join(stateDir, "store.sqlite"));
  assert.equal(report.paths.viewer_registry_path, path.join(stateDir, "viewer.json"));
  assert.equal(report.paths.ide_registry_path, path.join(stateDir, "ide-integrations.json"));
  assert.equal(report.paths.translations_root, path.join(stateDir, "translations"));
  assert.equal(report.data.local_only, true);
  assert.equal(report.data.cleanup_commands.clear_sessions, "peekmyagent clear --all-sessions");
  assert.ok(report.data.owned_paths.some((item) => item.path === path.join(stateDir, "store.sqlite")));
  assert.ok(report.data.owned_paths.some((item) => item.path === path.join(stateDir, "viewer.json")));
  assert.equal(report.cli.invoked_path.endsWith(path.join("bin", "peekmyagent.mjs")), true);
  assert.equal(typeof report.cli.command.available, "boolean");
  assert.ok(report.checks.some((item) => item.id === "cli-command"));
  assert.equal(report.daemon.url, `http://127.0.0.1:${apiPort}`);
  assert.equal(report.daemon.capture_url, `http://127.0.0.1:${capturePort}`);
  assert.equal(report.daemon.reachable, false);
  assert.ok(Array.isArray(report.checks));
  assert.equal(report.agents.claude_code.target_base_url_source, "configured");
  assert.equal(report.agents.claude_code.default_capture.mode, "proxy");
  assert.ok(report.agents.claude_code.settings.some((item) => item.path.endsWith(path.join(".claude", "settings.json")) && item.valid_json));
  assert.ok(report.agents.claude_code.settings.some((item) => item.path.endsWith(path.join(".claude", "settings.local.json")) && item.exists && !item.valid_json));
  assert.ok(report.checks.some((item) => item.id === "claude-settings" && item.status === "warn"));
  assert.ok(report.next_actions.some((item) => /invalid Claude Code settings JSON/i.test(item)));

  const openResult = runCli(["open", "--print", "--no-open"], env, workspace);
  assert.equal(openResult.status, 0, openResult.stderr);
  const runningResult = runCli(["doctor", "--json"], env, workspace);
  assert.equal(runningResult.status, 0, runningResult.stderr);
  const runningReport = JSON.parse(runningResult.stdout);
  assert.equal(runningReport.daemon.reachable, true);
  assert.equal(runningReport.daemon.capture_url, `http://127.0.0.1:${capturePort}`);
  assert.equal(runningReport.checks.find((item) => item.id === "daemon")?.status, "ok");

  console.log("doctor smoke passed");
} finally {
  if (fs.existsSync(tmpDir)) runCli(["shutdown", "--force"], {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    PEEKMYAGENT_STATE_DIR: stateDir,
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
  }, workspace);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env, workdir) {
  return spawnSync(process.execPath, [path.join(cwd, "bin/peekmyagent.mjs"), ...args], {
    cwd: workdir,
    env,
    encoding: "utf8",
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}
