import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-audit-sources-"));

try {
  const home = path.join(tmpDir, "home");
  const reportPath = path.join(tmpDir, "audit-report.md");
  const claudeProjectDir = path.join(home, ".claude", "projects", "demo");
  const openclawLogDir = path.join(home, ".openclaw", "logs");
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(openclawLogDir, { recursive: true });

  fs.writeFileSync(
    path.join(claudeProjectDir, "session.jsonl"),
    [
      JSON.stringify({
        session_id: "session-1",
        timestamp: "2026-06-28T00:00:00.000Z",
        role: "user",
        model: "fake-model",
        messages: [{ role: "system", content: "system text" }],
        tool_use: { name: "Bash" },
      }),
      JSON.stringify({ role: "assistant", type: "message", content: "assistant text" }),
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(openclawLogDir, "gateway.log"),
    `${JSON.stringify({ event: "request", body: { messages: [{ role: "user", content: "hi" }] } })}\n`,
  );

  const auditConfig = childProcessSpawnConfig(process.execPath, ["scripts/audit-data-sources.mjs"]);
  const result = spawnSync(auditConfig.command, auditConfig.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PEEK_AUDIT_HOME: home,
      PEEK_AUDIT_REPORT: reportPath,
      PEEK_AUDIT_MAX_FILES: "10",
      PEEK_AUDIT_MAX_LINES: "20",
    },
    ...auditConfig.options,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(reportPath), true);
  const report = fs.readFileSync(reportPath, "utf8");
  assert.match(report, /Claude Code \/ claude-project-jsonl/);
  assert.match(report, /OpenClaw \/ openclaw-gateway-logs/);
  assert.match(report, /session_id/);
  assert.doesNotMatch(report, /system text|assistant text/);

  const defaultReport = path.join(process.cwd(), "tmp", "audit", "data-source-audit-report.md");
  fs.rmSync(defaultReport, { force: true });
  const defaultAuditConfig = childProcessSpawnConfig(process.execPath, ["scripts/audit-data-sources.mjs"]);
  const defaultResult = spawnSync(defaultAuditConfig.command, defaultAuditConfig.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PEEK_AUDIT_HOME: home,
      PEEK_AUDIT_MAX_FILES: "10",
      PEEK_AUDIT_MAX_LINES: "20",
    },
    ...defaultAuditConfig.options,
  });
  assert.equal(defaultResult.status, 0, defaultResult.stderr || defaultResult.stdout);
  assert.match(defaultResult.stdout, /tmp[/\\]audit[/\\]data-source-audit-report\.md/);
  assert.equal(fs.existsSync(defaultReport), true);

  console.log("audit data sources smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
