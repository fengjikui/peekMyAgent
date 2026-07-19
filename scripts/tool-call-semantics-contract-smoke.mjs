#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  analyzeToolCallSemantics,
  extractNestedToolNames,
  extractSkillInstructionRead,
} from "../src/trace/tool-call-semantics.mjs";

assert.deepEqual(
  analyzeToolCallSemantics({ name: "Skill", arguments: { skill: "frontend-design", args: "audit" } }),
  {
    schema_version: 1,
    kind: "skill_load",
    skill_name: "frontend-design",
    nested_tool_names: [],
    evidence: { source: "tool_name", confidence: "explicit" },
  },
);

assert.deepEqual(
  analyzeToolCallSemantics({
    name: "exec",
    arguments:
      'const r = await tools.exec_command({cmd:"sed -n 1,220p /tmp/.agents/skills/using-superpowers/SKILL.md"}); text(r);',
  }),
  {
    schema_version: 1,
    kind: "skill_instruction_read",
    skill_name: "using-superpowers",
    nested_tool_names: ["exec_command"],
    evidence: { source: "tool_arguments", confidence: "high" },
  },
);

const encryptedSpawn = analyzeToolCallSemantics({
  name: "spawn_agent",
  arguments: {
    task_name: "/root/context_probe",
    fork_turns: "all",
    message: "gAAAAAB-encrypted-rollout-task",
  },
});
assert.deepEqual(encryptedSpawn, {
  schema_version: 1,
  kind: "subagent_spawn",
  agent_label: "/root/context_probe",
  subagent_type: null,
  context_mode: "all",
  task_message_visibility: "encrypted_in_rollout",
  prompt_preview: "",
  nested_tool_names: [],
  evidence: { source: "tool_arguments", confidence: "high" },
});
assert.equal(JSON.stringify(encryptedSpawn).includes("encrypted-rollout-task"), false);

assert.deepEqual(
  analyzeToolCallSemantics({
    name: "Agent",
    arguments: { description: "Review storage", prompt: "Inspect the storage boundary.", subagent_type: "Explore" },
  }),
  {
    schema_version: 1,
    kind: "subagent_spawn",
    agent_label: "Review storage",
    subagent_type: "Explore",
    context_mode: null,
    task_message_visibility: "visible",
    prompt_preview: "Inspect the storage boundary.",
    nested_tool_names: [],
    evidence: { source: "tool_arguments", confidence: "high" },
  },
);

assert.deepEqual(
  analyzeToolCallSemantics({
    name: "exec",
    arguments: 'const r = await tools.web__run({weather:[{location:"Jiaxing"}]}); text(r);',
  }),
  {
    schema_version: 1,
    kind: "nested_tool_dispatch",
    skill_name: null,
    nested_tool_names: ["web__run"],
    evidence: { source: "tool_arguments", confidence: "high" },
  },
);

assert.deepEqual(extractNestedToolNames("tools.alpha(); tools.alpha(); tools.beta ({});"), ["alpha", "beta"]);
assert.deepEqual(extractSkillInstructionRead("C:\\Users\\demo\\.codex\\skills\\review\\SKILL.md"), {
  kind: "skill_instruction_read",
  skill_name: "review",
  source: "tool_arguments",
  confidence: "high",
});
assert.equal(analyzeToolCallSemantics({ name: "Read", arguments: { file_path: "README.md" } }), null);
assert.equal(extractSkillInstructionRead("The documentation mentions SKILL.md without a skill path."), null);

console.log("tool call semantics contract smoke passed");
