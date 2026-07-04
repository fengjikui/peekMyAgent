import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

// Smoke for body-only subagent reconstruction under OTel (subscription) capture.
// OTel dumps no headers, so x-claude-code-agent-id / debug source are gone. The
// view must instead link a subagent to its parent by matching the subagent's
// first user prompt to a parent Agent tool_use prompt, group multi-round
// subagents by that prompt, and nest them in the parent's turn (no phantom
// turns).

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-otel-smoke-"));
const dumpDir = path.join(tmp, "dump");
fs.mkdirSync(dumpDir, { recursive: true });
const storePath = path.join(tmp, "store.sqlite");
const meta = { user_id: JSON.stringify({ session_id: "sess-subagent-otel" }) };

function dump(name, t, payload) {
  const f = path.join(dumpDir, name);
  fs.writeFileSync(f, JSON.stringify(payload));
  fs.utimesSync(f, t, t);
}

const SYS = [{ type: "text", text: "Base system prompt." }];
const FIB = "请计算斐波那契数列的前 15 项，并说明第 15 项的值。";
const EXPLORE = "请查看当前工作目录并简要总结其内容。";

// req1 (parent): user asks for a subagent demo; response spawns two Agent tools.
dump("p1.request.json", 1000, {
  model: "claude-opus-4-8", system: SYS, metadata: meta,
  tools: [{ name: "Bash" }, { name: "Read" }, { name: "Agent" }],
  messages: [{ role: "user", content: "请帮忙展示两个子 Agent 调用的过程。" }],
});
dump("p1.response.json", 1001, {
  id: "resp_p1", role: "assistant", stop_reason: "tool_use",
  content: [
    { type: "tool_use", id: "ag1", name: "Agent", input: { description: "计算斐波那契", prompt: FIB, subagent_type: "general-purpose" } },
    { type: "tool_use", id: "ag2", name: "Agent", input: { description: "探查目录", prompt: EXPLORE, subagent_type: "Explore" } },
  ],
  usage: { input_tokens: 10, output_tokens: 20 },
});
// req2: general-purpose subagent (first user message == FIB prompt)
dump("c1.request.json", 2000, {
  model: "claude-opus-4-8", system: SYS, metadata: meta, tools: [{ name: "Bash" }],
  messages: [{ role: "user", content: `<system-reminder>ctx</system-reminder>\n${FIB}` }],
});
// req3 + req4: Explore subagent across two rounds (same first prompt == EXPLORE)
dump("c2.request.json", 3000, {
  model: "claude-haiku-4-5-20251001", system: SYS, metadata: meta, tools: [{ name: "Bash" }],
  messages: [{ role: "user", content: `<system-reminder>ctx</system-reminder>\n${EXPLORE}` }],
});
dump("c3.request.json", 4000, {
  model: "claude-haiku-4-5-20251001", system: SYS, metadata: meta, tools: [{ name: "Bash" }],
  messages: [
    { role: "user", content: `<system-reminder>ctx</system-reminder>\n${EXPLORE}` },
    { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] },
  ],
});
// req5 (parent continuation): not a subagent
dump("p2.request.json", 5000, {
  model: "claude-opus-4-8", system: SYS, metadata: meta,
  tools: [{ name: "Bash" }, { name: "Read" }, { name: "Agent" }],
  messages: [
    { role: "user", content: "请帮忙展示两个子 Agent 调用的过程。" },
    { role: "assistant", content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { prompt: FIB, subagent_type: "general-purpose" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "ag1", content: "610" }] },
  ],
});

process.env.PEEKMYAGENT_STATE_DIR = tmp;
const viewer = await startViewerServer({ cwd: process.cwd(), storePath });
let failed = false;
try {
  const ingest = await (await fetch(`${viewer.url}/api/capture/otel`, {
    method: "POST", headers: { "content-type": "application/json", "x-peekmyagent-intent": "otel-ingest" },
    body: JSON.stringify({ dir: dumpDir, watch_id: "claude-code-subotel", agent: "Claude Code", workspace: tmp }),
  })).json();
  assert.equal(ingest.ok, true);

  const view = await (await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(ingest.source_id)}`)).json();
  const byIndex = new Map(view.requests.map((r) => [r.request_index, r]));

  // #2 = general-purpose subagent; #3/#4 = same Explore instance.
  assert.equal(byIndex.get(2).is_subagent, true, "child #2 detected as subagent (no headers)");
  assert.equal(byIndex.get(2).subagent_type, "general-purpose", "subagent_type from parent Agent tool_use");
  assert.equal(byIndex.get(3).is_subagent, true, "child #3 detected as subagent");
  assert.equal(byIndex.get(4).is_subagent, true, "child #4 detected as subagent");
  assert.equal(byIndex.get(3).trace.claude_agent_id, byIndex.get(4).trace.claude_agent_id, "same Explore instance shares one synthetic agent id");
  assert.notEqual(byIndex.get(2).trace.claude_agent_id, byIndex.get(3).trace.claude_agent_id, "different subagents get different instance ids");
  assert.equal(byIndex.get(1).is_subagent ?? false, false, "parent request is not a subagent");

  // Branches: two, typed, spawned at the parent.
  const branches = view.agent_trace?.branches || [];
  assert.equal(branches.length, 2, "two subagent branches reconstructed");
  const explore = branches.find((b) => b.agent_type === "Explore");
  assert.ok(explore, "Explore branch present");
  assert.deepEqual(explore.request_indexes, [3, 4], "Explore branch groups its two rounds");
  assert.equal(explore.spawn?.parent_request_index, 1, "branch linked back to the spawning parent request");

  // Turn grouping: children nest into the parent turn, no phantom turns.
  const subagentTurns = (view.turns || []).filter((t) => (t.request_indexes || []).some((i) => [2, 3, 4].includes(i)));
  assert.equal(subagentTurns.length, 1, "subagent requests do not spawn their own turns");
  assert.ok((subagentTurns[0].agent_branches || []).length === 2, "the parent turn carries both branches");

  console.log("subagent-otel smoke: OK (body-only attribution, instance grouping, parent-turn nesting, no phantom turns)");
} catch (error) {
  failed = true;
  console.error("subagent-otel smoke FAILED:", error.stack || error.message);
} finally {
  await viewer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
