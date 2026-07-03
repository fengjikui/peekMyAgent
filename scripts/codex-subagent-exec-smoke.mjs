import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "codex-subagent-exec", "latest");
const reportPath =
  process.env.PEEK_CODEX_SUBAGENT_EXEC_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "codex-subagent-exec-smoke", "codex-subagent-exec-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const prompt = [
  "这是 peekMyAgent Codex 子代理/并行任务结构测试。",
  "请不要修改文件。",
  "如果当前 Codex CLI 模型上下文里有子代理、并行 agent、delegate、task 之类工具，请启动两个只读子任务：一个查看 package.json，一个查看 docs/user-guide.md 的开头，然后汇总。",
  "如果没有这种工具，请直接说明没有发现可用子代理工具，但仍可用普通只读命令查看这两个文件。",
].join("\n");

function runCodex(args) {
  return new Promise((resolve) => {
    const child = spawn("codex", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 240_000);
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

function summarize(run) {
  const parsed = parseJsonLines(run.stdout);
  const events = parsed.events;
  const itemTypes = {};
  const toolLikeItems = [];
  const keywordHits = [];
  for (const event of events) {
    const type = event.item?.type || event.type || "unknown";
    itemTypes[type] = (itemTypes[type] || 0) + 1;
    const text = JSON.stringify(event);
    if (/subagent|sub-agent|delegate|parallel|task|worker|agent/i.test(text)) {
      keywordHits.push({ type: event.type, item_type: event.item?.type || null, excerpt: text.slice(0, 500) });
    }
    if (event.item?.type && !["agent_message", "reasoning", "command_execution"].includes(event.item.type)) {
      toolLikeItems.push(event.item);
    }
  }
  const commandEvents = events.filter((event) => event.item?.type === "command_execution");
  const collabToolEvents = events.filter((event) => event.item?.type === "collab_tool_call");
  const agentMessages = events.filter((event) => event.item?.type === "agent_message");
  const usage = events.find((event) => event.type === "turn.completed")?.usage || null;
  const collabTools = collabToolEvents.map((event) => ({
    event_type: event.type,
    item_id: event.item.id,
    tool: event.item.tool,
    status: event.item.status,
    sender_thread_id: event.item.sender_thread_id,
    receiver_thread_ids: event.item.receiver_thread_ids || [],
    prompt_excerpt: event.item.prompt ? event.item.prompt.slice(0, 240) : null,
    agent_state_count: event.item.agents_states ? Object.keys(event.item.agents_states).length : 0,
  }));
  return {
    exit_code: run.code,
    signal: run.signal,
    event_count: events.length,
    non_json_line_count: parsed.nonJson.length,
    thread_id: events.find((event) => event.type === "thread.started")?.thread_id || null,
    item_types: itemTypes,
    command_execution_count: commandEvents.filter((event) => event.type === "item.completed").length,
    command_names: commandEvents.filter((event) => event.type === "item.completed").map((event) => event.item.command),
    collab_tool_call_count: collabToolEvents.length,
    collab_tools: collabTools,
    collab_tool_names: [...new Set(collabTools.map((tool) => tool.tool).filter(Boolean))],
    spawned_receiver_thread_ids: [
      ...new Set(
        collabTools
          .filter((tool) => tool.tool === "spawn_agent")
          .flatMap((tool) => tool.receiver_thread_ids)
          .filter(Boolean),
      ),
    ],
    agent_message_count: agentMessages.length,
    last_agent_message: agentMessages.at(-1)?.item?.text || "",
    usage,
    keyword_hit_count: keywordHits.length,
    keyword_hits: keywordHits.slice(0, 20),
    nonstandard_tool_like_items: toolLikeItems.slice(0, 20),
  };
}

function writeEvidence(run, summary) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "command.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), cwd: process.cwd(), prompt }, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "stdout.jsonl"), run.stdout);
  fs.writeFileSync(path.join(evidenceDir, "stderr.txt"), run.stderr);
  fs.writeFileSync(path.join(evidenceDir, "events.json"), `${JSON.stringify(parseJsonLines(run.stdout), null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

function writeReport(summary) {
  const lines = [];
  lines.push("# Codex 子代理/并行任务结构 smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：使用 `codex exec --json` 官方事件流，要求 Codex 在可用时启动子代理/并行子任务。这个测试不能证明 exact network request，只用于判断 Codex 官方 JSONL 事件里是否暴露类似 Claude Code `Agent` 或 OpenClaw `sessions_spawn` 的结构。");
  lines.push("");
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push(`- exit：${summary.exit_code}${summary.signal ? ` (${summary.signal})` : ""}`);
  lines.push(`- thread id：${summary.thread_id || "none"}`);
  lines.push(`- events：${summary.event_count}`);
  lines.push(`- command executions：${summary.command_execution_count}`);
  lines.push(`- collab tool calls：${summary.collab_tool_call_count}`);
  lines.push(`- collab tools：${summary.collab_tool_names.join(", ") || "none"}`);
  lines.push(`- spawned receiver threads：${summary.spawned_receiver_thread_ids.join(", ") || "none"}`);
  lines.push(`- keyword hits：${summary.keyword_hit_count}`);
  lines.push("");
  lines.push("| item/event type | count |");
  lines.push("| --- | ---: |");
  for (const [type, count] of Object.entries(summary.item_types)) lines.push(`| ${type} | ${count} |`);
  lines.push("");
  lines.push("## 关键词命中");
  lines.push("");
  if (!summary.keyword_hits.length) {
    lines.push("未在 JSONL 事件中看到 `subagent/delegate/task/worker` 等结构性关键词。");
  } else {
    for (const hit of summary.keyword_hits) lines.push(`- ${hit.type}/${hit.item_type || "none"}：${hit.excerpt.replaceAll("\n", " ").slice(0, 220)}`);
  }
  lines.push("");
  lines.push("初步结论：当前 Codex CLI 官方事件流能暴露 `spawn_agent`、`wait`、`close_agent` 这类 `collab_tool_call`，并能看到主线程和子线程 id，因此适合展示 Codex 的子代理事件树。但它仍不是 provider 请求级 capture，不能标记为 exact network request。完整 stdout JSONL 见 evidence dir。");
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const run = await runCodex(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-C", process.cwd(), prompt]);
  const summary = summarize(run);
  writeEvidence(run, summary);
  writeReport(summary);
  console.log(`Wrote ${reportPath}`);
  console.log({ summary, evidenceDir });
  if (run.code !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
