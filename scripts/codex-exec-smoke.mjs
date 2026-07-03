import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "codex-exec", "latest");
const reportPath =
  process.env.PEEK_CODEX_EXEC_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "codex-exec-smoke", "codex-exec-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });

const prompt1 =
  "这是 peekMyAgent Codex 真实执行 smoke。请不要修改文件，只读取 package.json 和 docs/user-guide.md 的开头，然后用一句话说明这个项目当前有哪些 smoke 测试。";

function runCodex(args) {
  return new Promise((resolve) => {
    const child = spawn("codex", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ args, code, signal: signal || null, stdout, stderr });
    });
  });
}

function parseJsonLines(text) {
  const events = [];
  const nonJson = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      nonJson.push(line);
    }
  }
  return { events, nonJson };
}

function summarizeRun(run, turnIndex) {
  const { events, nonJson } = parseJsonLines(run.stdout);
  const threadId = events.find((event) => event.type === "thread.started")?.thread_id || null;
  const commandEvents = events.filter((event) => event.item?.type === "command_execution");
  const agentMessages = events.filter((event) => event.item?.type === "agent_message");
  const usage = events.find((event) => event.type === "turn.completed")?.usage || null;
  return {
    turn_index: turnIndex,
    exit_code: run.code,
    thread_id: threadId,
    event_count: events.length,
    non_json_line_count: nonJson.length,
    command_execution_count: commandEvents.filter((event) => event.type === "item.completed").length,
    command_names: commandEvents
      .filter((event) => event.type === "item.completed")
      .map((event) => event.item.command),
    agent_message_count: agentMessages.length,
    last_agent_message: agentMessages.at(-1)?.item?.text || "",
    usage,
  };
}

function writeReport(summaries) {
  const lines = [];
  lines.push("# Codex exec JSONL smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用 `codex exec --json` 跑真实 Codex 非交互会话，并保存 stdout JSONL 事件。它能证明 Codex 会话事件、工具执行和 usage，但不是 exact network request capture。");
  lines.push("");
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("| turn | exit | thread_id | events | command_exec | agent_messages | input_tokens | cached_input | output_tokens |");
  lines.push("| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.turn_index} | ${summary.exit_code} | ${summary.thread_id || "none"} | ${summary.event_count} | ${summary.command_execution_count} | ${summary.agent_message_count} | ${summary.usage?.input_tokens ?? ""} | ${summary.usage?.cached_input_tokens ?? ""} | ${summary.usage?.output_tokens ?? ""} |`,
    );
  }
  lines.push("");
  lines.push("完整 stdout/stderr 和解析后的 events 见 evidence dir。");
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

function writeEvidence(runs, summaries) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "command.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), cwd: process.cwd(), prompt1 }, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "runs.json"), `${JSON.stringify(runs, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "summaries.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  for (const [index, run] of runs.entries()) {
    fs.writeFileSync(path.join(evidenceDir, `turn-${index + 1}.stdout.jsonl`), run.stdout);
    fs.writeFileSync(path.join(evidenceDir, `turn-${index + 1}.stderr.txt`), run.stderr);
    fs.writeFileSync(path.join(evidenceDir, `turn-${index + 1}.events.json`), `${JSON.stringify(parseJsonLines(run.stdout), null, 2)}\n`);
  }
}

async function main() {
  const runs = [];
  const run1 = await runCodex(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-C", process.cwd(), prompt1]);
  runs.push(run1);
  const summary1 = summarizeRun(run1, 1);

  if (summary1.thread_id && run1.code === 0) {
    const prompt2 = [
      "这是第二轮。请基于上一轮你实际读取的文件结果继续，不要修改文件。",
      "请用一句话说明：如果 peekMyAgent 展示 Codex 会话，应该如何区分用户轮次、命令执行事件和最终回复。",
    ].join("\n");
    const run2 = await runCodex(["exec", "resume", "--json", "--skip-git-repo-check", summary1.thread_id, prompt2]);
    runs.push(run2);
  }

  const summaries = runs.map((run, index) => summarizeRun(run, index + 1));
  writeEvidence(runs, summaries);
  writeReport(summaries);
  console.log(`Wrote ${reportPath}`);
  console.log({ summaries, evidenceDir });
  if (runs.some((run) => run.code !== 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
