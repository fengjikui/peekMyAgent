import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectCodexDesktopInstallation,
  managedCodexDesktopLaunchSpec,
  requestCodexDesktopQuit,
  waitForCodexDesktopExit,
} from "../src/adapters/codex-desktop-installation.mjs";
import { processHasAncestor, runningPidsForExecutable } from "../src/core/process-tools.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-codex-installation-"));
const bundlePath = path.join(tmpDir, "ChatGPT.app");
const appExecutable = path.join(bundlePath, "Contents", "MacOS", "ChatGPT");
const embeddedCodexPath = path.join(bundlePath, "Contents", "Resources", "codex");
const asarPath = path.join(bundlePath, "Contents", "Resources", "app.asar");
const launcher = path.join(tmpDir, "open");
for (const filePath of [appExecutable, embeddedCodexPath, asarPath, launcher]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, filePath === asarPath ? `prefix-CODEX_APP_SERVER_WS_URL-suffix` : "fixture");
}

try {
  const env = {
    PEEKMYAGENT_CODEX_DESKTOP_BUNDLE: bundlePath,
    PEEKMYAGENT_CODEX_DESKTOP_LAUNCHER: launcher,
  };
  const installation = inspectCodexDesktopInstallation({
    env,
    platform: "darwin",
    spawnSyncImpl(command) {
      if (command === "/usr/bin/plutil") return { status: 0, stdout: "26.707.72221\n", stderr: "" };
      if (command === embeddedCodexPath) return { status: 0, stdout: "codex-cli 0.144.2\n", stderr: "" };
      throw new Error(`Unexpected command: ${command}`);
    },
  });
  assert.equal(installation.supported, true);
  assert.equal(installation.app_version, "26.707.72221");
  assert.equal(installation.codex_version, "codex-cli 0.144.2");

  const launch = managedCodexDesktopLaunchSpec({
    installation,
    workspace: tmpDir,
    appServerWsUrl: "ws://127.0.0.1:43210/pma/" + "b".repeat(64),
    env,
  });
  assert.equal(launch.command, appExecutable);
  assert.deepEqual(launch.args, [tmpDir]);
  assert.match(launch.env.CODEX_APP_SERVER_WS_URL, /^ws:\/\/127\.0\.0\.1:43210\/pma\//);

  const processLookup = runningPidsForExecutable(appExecutable, {
    platform: "darwin",
    spawnSyncImpl() {
      return {
        status: 0,
        stdout: `100 1 ${appExecutable}\n101 100 ${appExecutable} --type=renderer\n200 1 /usr/bin/zsh\n`,
        stderr: "",
      };
    },
  });
  assert.deepEqual(processLookup.pids, [100, 101]);
  const failedProcessLookup = runningPidsForExecutable(appExecutable, {
    platform: "darwin",
    spawnSyncImpl() {
      return { status: 1, stdout: "", stderr: "process table denied" };
    },
  });
  assert.equal(failedProcessLookup.supported, false);
  assert.equal(failedProcessLookup.error, "process table denied");
  assert.equal(
    processHasAncestor(300, [100], {
      processes: [
        { pid: 100, ppid: 1 },
        { pid: 250, ppid: 100 },
        { pid: 300, ppid: 250 },
      ],
    }),
    true,
  );

  const quit = requestCodexDesktopQuit({
    installation,
    platform: "darwin",
    spawnSyncImpl(command, args) {
      assert.equal(command, "/usr/bin/osascript");
      assert.match(args[1], /com\.openai\.codex/);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(quit.ok, true);

  let polls = 0;
  const exit = await waitForCodexDesktopExit(installation, {
    timeoutMs: 500,
    pollMs: 10,
    processLookup() {
      polls += 1;
      return { supported: true, pids: polls < 3 ? [100] : [] };
    },
  });
  assert.equal(exit.exited, true);
  assert.equal(polls, 3);
  console.log("Codex Desktop installation and process safety smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
