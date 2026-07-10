import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeClaudeOtelRequestFile } from "../src/adapters/claude-otel.mjs";
import { childProcessSpawnConfig } from "../src/core/platform.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-otel-"));
const bodyDir = path.join(tmpRoot, "raw-bodies");
fs.mkdirSync(bodyDir, { recursive: true });

const reportPath =
  process.env.PEEK_CLAUDE_OTEL_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "claude-otel-smoke", "claude-otel-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const prompt = "Say only: ok";

function runClaude() {
  return new Promise((resolve) => {
    const childArgs = ["-p", "--output-format", "json", prompt];
    const childEnv = {
      ...process.env,
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "console",
      OTEL_LOG_RAW_API_BODIES: `file:${bodyDir}`,
      OTEL_LOGS_EXPORT_INTERVAL: "1000",
    };
    const spawnConfig = childProcessSpawnConfig("claude", childArgs, { env: childEnv });
    const child = spawn(spawnConfig.command, spawnConfig.args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnConfig.options,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 120_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      if (entry.isFile()) out.push(next);
    }
  }
  return out.sort();
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function detectShape(files) {
  const requestFiles = files.filter((file) => file.endsWith(".request.json"));
  const responseFiles = files.filter((file) => file.endsWith(".response.json"));
  const firstRequest = requestFiles[0] ? safeJson(requestFiles[0]) : null;
  const firstResponse = responseFiles[0] ? safeJson(responseFiles[0]) : null;
  return {
    requestFileCount: requestFiles.length,
    responseFileCount: responseFiles.length,
    hasRequestJson: Boolean(firstRequest),
    hasResponseJson: Boolean(firstResponse),
    hasModel: Boolean(firstRequest?.model),
    hasMessages: Array.isArray(firstRequest?.messages),
    hasSystem: Boolean(firstRequest?.system),
    hasTools: Array.isArray(firstRequest?.tools),
    requestTopLevelKeys: firstRequest ? Object.keys(firstRequest).sort() : [],
    responseTopLevelKeys: firstResponse ? Object.keys(firstResponse).sort() : [],
  };
}

function renderReport(result, files, shape) {
  const lines = [];
  lines.push("# Claude Code OTel raw body smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：本报告只记录文件数量和 JSON 顶层字段，不输出 prompt、messages、system prompt 或响应正文。");
  lines.push("");
  lines.push(`- 临时 raw body 目录：${bodyDir}`);
  lines.push(`- raw body 保留：${process.env.PEEK_KEEP_RAW === "1" ? "yes" : "no，报告生成后删除"}`);
  lines.push(`- claude exit code：${result.code}`);
  lines.push(`- claude signal：${result.signal || "none"}`);
  lines.push(`- raw body 文件数：${files.length}`);
  lines.push("");
  lines.push("| 检查项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(shape)) {
    const rendered = Array.isArray(value) ? value.join(", ") || "none" : value;
    lines.push(`| ${key} | ${rendered} |`);
  }
  lines.push("");
  const exact =
    shape.hasRequestJson &&
    shape.hasModel &&
    shape.hasMessages &&
    (shape.hasSystem || shape.requestTopLevelKeys.includes("system"));
  lines.push(`建议可信度：${exact ? "`exact`" : "`partial`"}`);
  lines.push("");
  if (!exact) {
    lines.push("未达到 exact 的原因可能是：未配置 telemetry logs exporter、请求失败、raw body 未写出，或 Claude Code 版本行为变化。");
    lines.push("");
  }
  lines.push("隐私提示：OTel raw body 文件可能包含完整 system prompt、历史消息和工具结果；真实产品必须默认短期保存、强脱敏、显式 opt-in。");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const result = await runClaude();
  const files = listFiles(bodyDir);
  const shape = detectShape(files);
  writeEvidence({ result, files, shape });
  fs.writeFileSync(reportPath, renderReport(result, files, shape));
  if (process.env.PEEK_KEEP_RAW !== "1") {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(`Wrote ${reportPath}`);
  console.log(shape);
  if (!shape.hasRequestJson) {
    console.error(result.stderr.split("\n").slice(0, 20).join("\n"));
    process.exitCode = 1;
  }
}

function writeEvidence({ result, files, shape }) {
  if (process.env.PEEK_WRITE_EVIDENCE !== "1") return;
  const evidenceDir = process.env.PEEK_EVIDENCE_DIR || path.join(process.cwd(), "tmp", "smoke-evidence", "claude-otel", "latest");
  const rawDir = path.join(evidenceDir, "raw-bodies");
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const requestFiles = files.filter((file) => file.endsWith(".request.json"));
  const normalized = requestFiles.map((file) => normalizeClaudeOtelRequestFile(file));
  for (const file of files) {
    fs.copyFileSync(file, path.join(rawDir, path.basename(file)));
  }

  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        cwd: process.cwd(),
        prompt,
        claude_args: ["-p", "--output-format", "json", prompt],
        telemetry_env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_LOGS_EXPORTER: "console",
          OTEL_LOG_RAW_API_BODIES: `file:${bodyDir}`,
          OTEL_LOGS_EXPORT_INTERVAL: "1000",
        },
        tmp_raw_body_dir: bodyDir,
        evidence_raw_body_dir: rawDir,
        note: "Claude Code smoke test 会调用真实 claude CLI。raw-bodies 可能包含完整 system、tools、messages。",
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "shape.json"), `${JSON.stringify(shape, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "normalized.json"), `${JSON.stringify(normalized, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "claude-stdout.txt"), result.stdout);
  fs.writeFileSync(path.join(evidenceDir, "claude-stderr.txt"), result.stderr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
