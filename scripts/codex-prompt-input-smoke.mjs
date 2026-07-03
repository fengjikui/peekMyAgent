import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "codex-prompt-input", "latest");
const reportPath =
  process.env.PEEK_CODEX_PROMPT_INPUT_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "codex-prompt-input-smoke", "codex-prompt-input-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });

const prompts = [
  {
    label: "turn-1",
    prompt: "我们做一个 peekMyAgent Codex prompt-input 测试。请观察当前项目，并说明你会先读取哪些文件。",
  },
  {
    label: "turn-2",
    prompt: "这是第二轮。请基于第一轮的目标，说明如果要展示 Agent 请求，应如何折叠 system/tools 和历史消息。",
  },
  {
    label: "turn-3",
    prompt: "这是第三轮。请说明 Codex 的 debug prompt-input 和 proxy exact capture 在可信度上有什么差别。",
  },
];

function runCodexPromptInput(prompt) {
  return new Promise((resolve) => {
    const args = ["debug", "prompt-input", prompt];
    const child = spawn("codex", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ args, code, signal: signal || null, stdout, stderr });
    });
  });
}

function parsePromptInput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function summarize(value) {
  const input = Array.isArray(value) ? value : Array.isArray(value?.input) ? value.input : [];
  const items = input.length ? input : Array.isArray(value?.messages) ? value.messages : [];
  const roles = items.map((item) => item.role || item.type || item.kind || "unknown");
  const serialized = JSON.stringify(value ?? null);
  const userish = items.filter((item) => /user|message|input/i.test(item.role || item.type || item.kind || ""));
  return {
    top_level_type: Array.isArray(value) ? "array" : typeof value,
    top_level_keys: value && !Array.isArray(value) && typeof value === "object" ? Object.keys(value).sort() : [],
    item_count: items.length,
    roles,
    byte_size: Buffer.byteLength(serialized),
    hash: hashJson(value),
    latest_userish_size: userish.length ? Buffer.byteLength(JSON.stringify(userish[userish.length - 1])) : 0,
  };
}

function compare(summaries) {
  const first = summaries[0] || {};
  return {
    request_count: summaries.length,
    stable_hash: summaries.every((summary) => summary.hash === first.hash),
    item_counts: summaries.map((summary) => summary.item_count),
    byte_sizes: summaries.map((summary) => summary.byte_size),
    latest_userish_sizes: summaries.map((summary) => summary.latest_userish_size),
    top_level_types: summaries.map((summary) => summary.top_level_type),
    role_sequences: summaries.map((summary) => summary.roles.join(" -> ")),
  };
}

function writeEvidence({ runs, parsed, summaries, comparison }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify({ generated_at: new Date().toISOString(), cwd: process.cwd(), prompts }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "runs.json"), `${JSON.stringify(runs, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "prompt-inputs.json"), `${JSON.stringify(parsed, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "summaries.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "stable-vs-changing.json"), `${JSON.stringify(comparison, null, 2)}\n`);
}

function writeReport({ runs, summaries, comparison }) {
  const lines = [];
  lines.push("# Codex debug prompt-input smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用 `codex debug prompt-input` 渲染 Codex 模型可见输入。它是官方 debug 输出，不等同于网络层 exact proxy capture，但非常适合观察 Codex 组装给模型的 prompt input 结构。报告不输出完整正文。");
  lines.push("");
  lines.push(`- turn exits：${runs.map((run) => run.code).join(", ")}`);
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("| turn | items | bytes | latest_userish_size | hash | roles |");
  lines.push("| ---: | ---: | ---: | ---: | --- | --- |");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.turn_index} | ${summary.item_count} | ${summary.byte_size} | ${summary.latest_userish_size} | ${summary.hash.slice(0, 12)} | ${summary.roles.join(" -> ")} |`,
    );
  }
  lines.push("");
  lines.push("| 对比项 | 结果 |");
  lines.push("| --- | --- |");
  for (const [key, value] of Object.entries(comparison)) lines.push(`| ${key} | ${Array.isArray(value) ? value.join(" / ") : value} |`);
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const runs = [];
  const parsed = [];
  for (const item of prompts) {
    const run = await runCodexPromptInput(item.prompt);
    runs.push({ ...item, ...run });
    parsed.push({ label: item.label, prompt: item.prompt, value: parsePromptInput(run.stdout) });
  }
  const summaries = parsed.map((entry, index) => ({ turn_index: index + 1, label: entry.label, ...summarize(entry.value) }));
  const comparison = compare(summaries);
  writeEvidence({ runs, parsed, summaries, comparison });
  writeReport({ runs, summaries, comparison });
  console.log(`Wrote ${reportPath}`);
  console.log({ exits: runs.map((run) => run.code), summaries, evidenceDir });
  if (runs.some((run) => run.code !== 0) || parsed.some((entry) => !entry.value)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
