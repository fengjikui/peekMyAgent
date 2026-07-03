import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

// Smoke for the request-card "current entry" classifier (summary.entry). Guards
// two real rendering bugs:
//  1. A sub-agent completion <task-notification> turn must be labeled as a
//     sub-agent result, not "User input",
//     and must not pollute current_user / the turn title with its raw XML.
//  2. A real user turn whose latest message is a role:"system" reminder must
//     still surface the user's text under the entry (so the header isn't blank).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "current-entry-smoke-"));
const dumpDir = path.join(tmp, "dump");
fs.mkdirSync(dumpDir, { recursive: true });
const storePath = path.join(tmp, "store.sqlite");
const meta = { user_id: JSON.stringify({ session_id: "sess-current-entry" }) };

function dump(name, t, payload) {
  const f = path.join(dumpDir, name);
  fs.writeFileSync(f, JSON.stringify(payload));
  fs.utimesSync(f, t, t);
}

const SYS = [{ type: "text", text: "S-base" }];
const TOOLS = [{ name: "Bash" }, { name: "Agent" }];
const taskNote =
  "<task-notification>\n<task-id>aa86c1dda68d27332</task-id>\n<tool-use-id>toolu_016T</tool-use-id>\n<status>completed</status>\n<summary>Agent \"计算斐波那契\" finished</summary>\n<result>第 15 项的值为 610</result>\n</task-notification>";
const compactPrompt =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests.\nWrap your analysis in <analysis> tags then provide a <summary> block.";

// req1: real user prompt that spawns a sub-agent
dump("r1.request.json", 1000, {
  model: "claude-opus-4-8", system: SYS, tools: TOOLS, metadata: meta,
  messages: [{ role: "user", content: "请帮忙展示一个子 Agent 调用的过程。" }],
});
// req2: latest message is a task-notification (must NOT be "User input")
dump("r2.request.json", 2000, {
  model: "claude-opus-4-8", system: SYS, tools: TOOLS, metadata: meta,
  messages: [
    { role: "user", content: "请帮忙展示一个子 Agent 调用的过程。" },
    { role: "assistant", content: [{ type: "text", text: "好的" }, { type: "tool_use", id: "toolu_016T", name: "Agent", input: {} }] },
    { role: "user", content: taskNote },
  ],
});
// req3: real user input followed by an appended role:"system" reminder
dump("r3.request.json", 3000, {
  model: "claude-opus-4-8", system: SYS, tools: TOOLS, metadata: meta,
  messages: [
    { role: "user", content: "请帮忙展示一个子 Agent 调用的过程。" },
    { role: "assistant", content: "完成" },
    { role: "user", content: "请你帮忙发起多个工具调用。" },
    { role: "system", content: "The task tools haven't been used recently. Consider using TaskCreate..." },
  ],
});

// req4: /compact prompt riding in the SAME user message as 5 tool_results
dump("r4.request.json", 4000, {
  model: "claude-opus-4-8", system: SYS, tools: TOOLS, metadata: meta,
  messages: [
    { role: "user", content: "请帮忙展示一个子 Agent 调用的过程。" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "text", text: compactPrompt },
      ],
    },
  ],
});

// req5: a ToolSearch result — tool_result block + trailing "Tool loaded." text.
// Must stay a tool-result continuation (NOT a new user turn), so current_user
// falls back to the real prior prompt rather than the tool_reference payload.
dump("r5.request.json", 5000, {
  model: "claude-opus-4-8", system: SYS, tools: TOOLS, metadata: meta,
  messages: [
    { role: "user", content: "请问今天北京天气如何" },
    { role: "assistant", content: [{ type: "tool_use", id: "ts1", name: "ToolSearch", input: { query: "select:WebSearch" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "ts1", content: [{ type: "tool_reference", tool_name: "WebSearch" }] }, { type: "text", text: "Tool loaded." }] },
  ],
});

// req6: Claude Code may append the compact prompt beside a prior real user
// request when /compact is invoked. The card should surface this as a compact
// event, not as a fresh user turn.
dump("r6.request.json", 6000, {
  model: "claude-opus-4-8", system: SYS, tools: TOOLS, metadata: meta,
  messages: [
    { role: "user", content: "请帮忙查看一下我的当前目录下有哪些文件。" },
    { role: "assistant", content: "当前目录有 demo.py 和 test_demo.py。" },
    { role: "user", content: [{ type: "text", text: "请帮我写一个五百字的小故事，要求有趣幽默。\n" }, { type: "text", text: compactPrompt }] },
  ],
});

process.env.PEEKMYAGENT_STATE_DIR = tmp;
const viewer = await startViewerServer({ cwd: process.cwd(), storePath });
let failed = false;
try {
  const ingest = await (await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir: dumpDir, watch_id: "claude-code-currententry", agent: "Claude Code", workspace: tmp }),
  })).json();
  assert.equal(ingest.ok, true);

  const view = await (await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(ingest.source_id)}`)).json();
  const byIndex = new Map(view.requests.map((r) => [r.request_index, r]));

  const r1 = byIndex.get(1).summary;
  assert.equal(r1.entry.kind, "user_input", "plain user prompt -> user_input");

  const r2 = byIndex.get(2).summary;
  assert.equal(r2.entry.kind, "subagent_result", "sub-agent completion notification -> subagent_result kind");
  assert.equal(r2.entry.label, "子 Agent 结果回流", "sub-agent completion labeled 子 Agent 结果回流");
  assert.ok(/finished|completed|610/.test(r2.entry.text), "task-notification preview is human-readable, not raw XML");
  assert.equal(r2.entry.subagent.name, "计算斐波那契", "sub-agent name is parsed from task notification summary");
  assert.ok(!/<task-notification/.test(r2.current_user), "current_user is not the raw task-notification XML");
  assert.ok(r2.current_user.includes("子 Agent"), "current_user falls back to the real prior prompt");
  const tnStack = r2.history_stack.find((m) => m.kind === "subagent_result");
  assert.ok(tnStack, "history stack marks the sub-agent result message");

  const r3 = byIndex.get(3).summary;
  assert.equal(r3.entry.kind, "user_input", "user input + trailing system reminder -> user_input");
  assert.equal(r3.entry.text, "请你帮忙发起多个工具调用。", "real user text surfaced in entry despite trailing system message");
  assert.equal(r3.current_user, "请你帮忙发起多个工具调用。", "current_user is the real user text");

  const r4 = byIndex.get(4).summary;
  assert.equal(r4.entry.kind, "compact", "compact prompt bundled with tool_results -> compact kind (not tool_result)");
  assert.ok(/压缩|compact/i.test(r4.entry.label), "compact entry labeled as compaction");
  assert.ok(!/create a detailed summary/i.test(r4.current_user), "compact prompt does not leak into current_user as user input");
  assert.ok(r4.history_stack.some((m) => m.kind === "compact"), "history stack marks the compact message even though it carries tool_results");

  const r5 = byIndex.get(5).summary;
  assert.equal(r5.entry.kind, "tool_result", "ToolSearch result (tool_result + trailing 'Tool loaded.') stays a tool-result continuation");
  assert.ok(!/tool_reference/.test(r5.current_user), "tool_reference payload does not leak into current_user");
  assert.equal(r5.current_user, "请问今天北京天气如何", "current_user falls back to the real prior prompt, so it stays in the same turn");

  const r6 = byIndex.get(6).summary;
  assert.equal(r6.entry.kind, "compact", "real user text plus compact prompt -> compact event");
  assert.ok(/压缩|compact/i.test(r6.entry.label), "compact event keeps a compact label");
  assert.equal(r6.current_user, "", "compact event does not reuse the adjacent prior user prompt as current_user");
  assert.ok(!/detailed summary|<analysis>/i.test(r6.current_user), "compact instruction does not leak into current_user");

  console.log("current-entry smoke: OK (compact + task_notification + tool_result-with-trailing-text classified, current_user clean, user input surfaced past system reminder)");
} catch (error) {
  failed = true;
  console.error("current-entry smoke FAILED:", error.message);
} finally {
  await viewer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
