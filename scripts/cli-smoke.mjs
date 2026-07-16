import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const bin = path.join(root, "bin", "peekmyagent.mjs");
const outDir = path.join(root, "tmp", "cli-smoke");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const openclawOut = path.join(outDir, "openclaw.normalized.json");
const claudeOut = path.join(outDir, "claude.normalized.json");
const openclawAssignmentOut = path.join(outDir, "openclaw.assignment.normalized.json");

const quickHelp = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
assert.equal(quickHelp.status, 0, quickHelp.stderr);
assert.match(quickHelp.stdout, /pma open/);
assert.match(quickHelp.stdout, /pma claude -c/);
assert.match(quickHelp.stdout, /--dangerously-skip-permissions/);
assert.doesNotMatch(quickHelp.stdout, /normalize openclaw-capture/);
assert.doesNotMatch(quickHelp.stdout, /pma daemon/);

const advancedHelp = spawnSync(process.execPath, [bin, "help", "--all"], { encoding: "utf8" });
assert.equal(advancedHelp.status, 0, advancedHelp.stderr);
assert.match(advancedHelp.stdout, /normalize openclaw-capture/);
assert.match(advancedHelp.stdout, /pma daemon/);
assert.doesNotMatch(advancedHelp.stdout, /pma \[--reuse\|--new/);

const removedNewShortcut = spawnSync(process.execPath, [bin, "--new", "claude"], { encoding: "utf8" });
assert.equal(removedNewShortcut.status, 1);
assert.match(removedNewShortcut.stderr, /--new shortcut was removed/);
const removedNewWrapperFlag = spawnSync(process.execPath, [bin, "run", "claude", "--new", "--"], { encoding: "utf8" });
assert.equal(removedNewWrapperFlag.status, 1);
assert.match(removedNewWrapperFlag.stderr, /--new wrapper flag was removed/);
const removedWatchCurrentNewFlag = spawnSync(process.execPath, [bin, "watch-current", "--new"], { encoding: "utf8" });
assert.equal(removedWatchCurrentNewFlag.status, 1);
assert.match(removedWatchCurrentNewFlag.stderr, /--new flag was removed/);

run(["normalize", "openclaw-capture", path.join(root, "fixtures", "openclaw-chat-completions-capture.json"), "--out", openclawOut]);
run(["normalize", "openclaw-capture", path.join(root, "fixtures", "openclaw-chat-completions-capture.json"), `--out=${openclawAssignmentOut}`]);
run(["normalize", "claude-otel", path.join(root, "fixtures", "claude-otel-request.json"), "--out", claudeOut]);
const missingOut = spawnSync(process.execPath, [bin, "normalize", "openclaw-capture", path.join(root, "fixtures", "openclaw-chat-completions-capture.json"), "--out", "--delete-raw-after-import"], { encoding: "utf8" });
assert.equal(missingOut.status, 1);
assert.match(missingOut.stderr, /--out requires a value/);

const openclaw = JSON.parse(fs.readFileSync(openclawOut, "utf8"));
const openclawAssignment = JSON.parse(fs.readFileSync(openclawAssignmentOut, "utf8"));
const claude = JSON.parse(fs.readFileSync(claudeOut, "utf8"));

assert.equal(openclaw.adapter_name, "openclaw-openai-proxy");
assert.equal(openclawAssignment.adapter_name, "openclaw-openai-proxy");
assert.equal(openclaw.capture_confidence, "exact");
assert.equal(openclaw.source.headers.authorization, "[REDACTED:header]");
assert.equal(claude.adapter_name, "claude-code-otel-raw-body");
assert.equal(claude.capture_confidence, "exact");
assert.equal(claude.system[0].role, "system");
assert.equal(claude.provenance.transport, "otel_raw_body_file");

const devViewerStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-cli-dev-view-"));
const devViewer = await startDevViewer(["dev", "view", "--port", "0"], {
  ...process.env,
  PEEKMYAGENT_STATE_DIR: devViewerStateDir,
});
try {
  const sources = await getJson(`${devViewer.url}/api/sources`);
  assert.deepEqual(sources, []);
} finally {
  await stopChild(devViewer.child);
  fs.rmSync(devViewerStateDir, { recursive: true, force: true });
}

const reportPath = process.env.PEEK_CLI_SMOKE_REPORT_PATH || path.join(outDir, "cli-smoke-report.md");
const report = [
  "# CLI smoke report",
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| Command | Output | Adapter | Confidence |",
  "| --- | --- | --- | --- |",
  `| normalize openclaw-capture | ${openclawOut} | ${openclaw.adapter_name} | ${openclaw.capture_confidence} |`,
  `| normalize claude-otel | ${claudeOut} | ${claude.adapter_name} | ${claude.capture_confidence} |`,
  "",
  "结论：最小 CLI 已能把 OpenClaw proxy capture 和 Claude OTel request 文件规范化为统一 JSON。",
  "",
].join("\n");
fs.writeFileSync(reportPath, report);
console.log(`Wrote ${reportPath}`);

function run(args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`command failed: ${args.join(" ")}`);
  }
}

function startDevViewer(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`dev viewer timed out: ${stderr || stdout}`));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/peekMyAgent dev viewer:\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1], stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`dev viewer exited early ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function stopChild(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 1000);
  });
}
