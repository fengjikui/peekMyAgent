import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "codex-source-comparison", "latest");
const reportPath =
  process.env.PEEK_CODEX_SOURCE_COMPARISON_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "codex-source-comparison-smoke", "codex-source-comparison-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const prompt = "这是 peekMyAgent Codex 数据源对照测试。请只作为 prompt-input 渲染，不需要真实执行。";

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, args, code, signal: signal || null, stdout, stderr });
    });
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function summarizePromptInput(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.input) ? value.input : [];
  return {
    top_level_type: Array.isArray(value) ? "array" : typeof value,
    item_count: items.length,
    roles: items.map((item) => item.role || item.type || item.kind || "unknown"),
    byte_size: Buffer.byteLength(JSON.stringify(value ?? null)),
    hash: hashJson(value),
  };
}

function pickCodexConnectivity(doctor) {
  const checks = doctor?.checks || {};
  return {
    auth: checks["auth.credentials"]?.details || {},
    config: checks["config.load"]?.details || {},
    websocket: checks["network.websocket_reachability"]?.details || {},
    reachability: checks["network.provider_reachability"]?.details || {},
  };
}

function readTextIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function redactText(text) {
  return text
    .replace(/(api[_-]?key\s*=\s*)".*?"/gi, '$1"[REDACTED]"')
    .replace(/(token\s*=\s*)".*?"/gi, '$1"[REDACTED]"')
    .replace(/(authorization\s*=\s*)".*?"/gi, '$1"[REDACTED]"');
}

function writeEvidence({ doctorRun, promptRun, doctor, promptInput, promptSummary, codexConfig }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify({ generated_at: new Date().toISOString(), cwd: process.cwd(), prompt }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "doctor-run.json"), `${JSON.stringify(doctorRun, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "doctor-redacted.json"), `${JSON.stringify(doctor, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "prompt-input-run.json"), `${JSON.stringify(promptRun, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "prompt-input.json"), `${JSON.stringify(promptInput, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "prompt-input-summary.json"), `${JSON.stringify(promptSummary, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "codex-config-redacted.txt"), redactText(codexConfig));
}

function writeReport({ doctor, promptSummary }) {
  const connectivity = pickCodexConnectivity(doctor);
  const lines = [];
  lines.push("# Codex 数据源对照报告");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：本报告对照 Codex 当前可用的官方调试输出与 peekMyAgent proxy exact capture 的可行性。报告不输出完整 prompt 正文。");
  lines.push("");
  lines.push("## 当前 Codex 连接形态");
  lines.push("");
  lines.push("| 项目 | 值 |");
  lines.push("| --- | --- |");
  lines.push(`| model | ${connectivity.config.model || ""} |`);
  lines.push(`| model provider | ${connectivity.config["model provider"] || ""} |`);
  lines.push(`| auth mode | ${connectivity.auth["stored auth mode"] || ""} |`);
  lines.push(`| stored API key | ${connectivity.auth["stored API key"] || ""} |`);
  lines.push(`| stored ChatGPT tokens | ${connectivity.auth["stored ChatGPT tokens"] || ""} |`);
  lines.push(`| wire API | ${connectivity.websocket["wire API"] || ""} |`);
  lines.push(`| supports websockets | ${connectivity.websocket["supports websockets"] || ""} |`);
  lines.push(`| websocket endpoint | ${connectivity.websocket.endpoint || ""} |`);
  lines.push(`| reachability mode | ${connectivity.reachability["reachability mode"] || ""} |`);
  lines.push("");
  lines.push("## 官方 prompt-input 摘要");
  lines.push("");
  lines.push("| items | bytes | hash | roles |");
  lines.push("| ---: | ---: | --- | --- |");
  lines.push(`| ${promptSummary.item_count} | ${promptSummary.byte_size} | ${promptSummary.hash.slice(0, 12)} | ${promptSummary.roles.join(" -> ")} |`);
  lines.push("");
  lines.push("## 结论");
  lines.push("");
  lines.push("- `codex debug prompt-input` 能给出模型可见输入列表，是官方 debug 输出，适合展示 prompt assembly。");
  lines.push("- `codex exec --json` 能给出真实会话事件、命令执行、最终回复和 usage，但不是网络层完整请求。");
  lines.push("- 当前本机 Codex 使用 ChatGPT token 登录，走 `wss://chatgpt.com/backend-api/...` WebSocket；不是可简单改 `base_url` 的 OpenAI HTTP API 形态。");
  lines.push("- 因此，peekMyAgent 现有 origin proxy 可 exact 捕获 Claude/OpenClaw 这类可配置 HTTP endpoint 的 Agent；对当前 Codex ChatGPT 登录模式，只能先标记为 `official_debug` / `event_timeline`，不能标记为 `proxy_exact`。");
  lines.push("");
  lines.push(`证据目录：${evidenceDir}`);
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const doctorRun = await run("codex", ["doctor", "--json"]);
  const promptRun = await run("codex", ["debug", "prompt-input", prompt]);
  const doctor = parseJson(doctorRun.stdout);
  const promptInput = parseJson(promptRun.stdout);
  const promptSummary = summarizePromptInput(promptInput);
  const codexConfig = readTextIfExists(path.join(process.env.HOME || "", ".codex", "config.toml"));

  writeEvidence({ doctorRun, promptRun, doctor, promptInput, promptSummary, codexConfig });
  writeReport({ doctor, promptSummary });
  console.log(`Wrote ${reportPath}`);
  console.log({
    doctorExit: doctorRun.code,
    promptInputExit: promptRun.code,
    promptSummary,
    evidenceDir,
  });
  if (promptRun.code !== 0 || !doctor || !promptInput) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
