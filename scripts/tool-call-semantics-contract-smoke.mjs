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
