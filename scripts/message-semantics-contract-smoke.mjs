import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyMessageKind,
  classifyCurrentEntry,
  cleanTitleText,
  compactInjectionText,
  displayMessageText,
  extractCodexHarnessBlocks,
  isFrameworkReminderMessage,
  isSuggestionModeMessage,
  isToolResultMessage,
  lastRealUserMessage,
  parseCommandMessage,
  realUserVisibleText,
  stripCodexHarnessBlocks,
  taskNotificationSummary,
  userVisibleText,
} from "../src/trace/message-semantics.mjs";

const compactPrompt = "Create a detailed summary of the conversation so far. Respond with TEXT ONLY using <analysis> and <summary>.";
const reminder = "<system-reminder>Injected by the harness.</system-reminder>";
const taskNotification = `<task-notification>
<task-id>task-1</task-id>
<status>completed</status>
<summary>Agent "检查磁盘" finished</summary>
<result>磁盘剩余 120 GB</result>
</task-notification>`;

assert.equal(classifyCurrentEntry([{ role: "user", content: "你好" }]).kind, "user_input");
assert.equal(classifyMessageKind({ role: "user", content: "你好" }), "message");
assert.equal(
  classifyCurrentEntry([
    { role: "user", content: "真正的问题" },
    { role: "user", content: reminder },
  ]).text,
  "真正的问题",
);
assert.equal(isFrameworkReminderMessage({ role: "user", content: reminder }), true);
assert.equal(isFrameworkReminderMessage({ role: "assistant", content: reminder }), false);

const taskEntry = classifyCurrentEntry([{ role: "user", content: taskNotification }]);
assert.equal(taskEntry.kind, "subagent_result");
assert.equal(taskEntry.subagent.name, "检查磁盘");
assert.match(taskEntry.text, /120 GB/);
assert.equal(taskNotificationSummary({ role: "user", content: taskNotification }).taskId, "task-1");
assert.match(displayMessageText({ role: "user", content: taskNotification }), /子 Agent 结果回流/);

const compactMessage = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "call-1", content: "ok" },
    { type: "text", text: compactPrompt },
  ],
};
assert.equal(classifyCurrentEntry([compactMessage]).kind, "compact");
assert.equal(classifyMessageKind(compactMessage), "compact");
assert.equal(compactInjectionText(compactMessage), compactPrompt);
assert.equal(realUserVisibleText(compactMessage), "");

const skillMessage = { role: "user", content: "Base directory for this skill: /tmp/example\n\n# Example Skill" };
assert.equal(classifyCurrentEntry([skillMessage]).kind, "harness_injection");
assert.equal(classifyMessageKind(skillMessage), "harness_injection");
assert.equal(realUserVisibleText(skillMessage), "");

const toolResult = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "call-2", content: "loaded" },
    { type: "text", text: "Tool loaded." },
  ],
};
assert.equal(isToolResultMessage(toolResult), true);
assert.equal(classifyCurrentEntry([toolResult]).kind, "tool_result");
assert.equal(classifyMessageKind(toolResult), "tool_result");
assert.equal(realUserVisibleText(toolResult), "");

const mixedCommand = {
  role: "user",
  content: `<local-command-caveat>Local output.</local-command-caveat>
<command-name>/model</command-name>
<command-message>model</command-message>
<command-args></command-args>
<local-command-stdout>Set model to test</local-command-stdout>

请演示工具调用`,
};
assert.equal(realUserVisibleText(mixedCommand), "请演示工具调用");
assert.equal(classifyCurrentEntry([mixedCommand]).kind, "user_input");

const commandOnly = { role: "user", content: "<command-name>/context</command-name><command-message>context</command-message>" };
assert.equal(parseCommandMessage(commandOnly).command, "/context");
assert.equal(userVisibleText(commandOnly), "Command /context");
assert.equal(classifyCurrentEntry([commandOnly]).kind, "command");
assert.equal(classifyMessageKind(commandOnly), "command_message");

const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "call-3", name: "Read", input: { file_path: "/tmp/a" } }] };
assert.equal(classifyMessageKind(toolUse), "tool_use");

const suggestion = { role: "user", content: "[SUGGESTION MODE: suggest what the user might type next]" };
assert.equal(isSuggestionModeMessage(suggestion), true);
assert.equal(lastRealUserMessage([suggestion]), null);

const messages = [
  { role: "user", content: "first" },
  toolResult,
  { role: "user", content: reminder },
];
assert.equal(lastRealUserMessage(messages).content, "first");
assert.equal(cleanTitleText(`<session>标题</session> ${reminder}`), "标题");

const codexHarnessMessage = {
  role: "user",
  content: `<codex_internal_context>Objective: inspect the active thread.</codex_internal_context>
<subagent_notification>worker-2 completed</subagent_notification>`,
};
const codexHarnessBlocks = extractCodexHarnessBlocks(codexHarnessMessage.content);
assert.deepEqual(codexHarnessBlocks.map((block) => block.kind), ["harness_codex_internal", "harness_codex_subagent"]);
assert.deepEqual(codexHarnessBlocks.map((block) => block.category), ["internal", "subagent"]);
assert.equal(classifyMessageKind(codexHarnessMessage), "harness_injection");
assert.equal(classifyCurrentEntry([codexHarnessMessage]).kind, "harness_injection");
assert.equal(realUserVisibleText(codexHarnessMessage), "", "known Codex harness blocks are never presented as user input");
assert.match(displayMessageText(codexHarnessMessage), /Codex 内部目标/);

const mixedCodexHarnessMessage = {
  role: "user",
  content: "<environment_context><cwd>/tmp/project</cwd></environment_context>\n请检查项目。",
};
assert.equal(realUserVisibleText(mixedCodexHarnessMessage), "请检查项目。", "stripping a harness block preserves adjacent real user text");

const nestedCodexHarnessExample = `<collaboration_mode>
The active mode changes only when instructions contain a different
<collaboration_mode>Plan</collaboration_mode> wrapper.
Continue in the selected mode.
</collaboration_mode>
Developer remainder.`;
const nestedCodexHarnessBlocks = extractCodexHarnessBlocks(nestedCodexHarnessExample);
assert.equal(nestedCodexHarnessBlocks.length, 1, "a same-name tag example remains inside its outer harness block");
assert.match(nestedCodexHarnessBlocks[0].text, /Continue in the selected mode\./);
assert.equal(stripCodexHarnessBlocks(nestedCodexHarnessExample), "Developer remainder.");

const source = fs.readFileSync(new URL("../src/trace/message-semantics.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /viewer\/|server\/|node:(fs|http|child_process)|process\.env|fetch\s*\(/);

console.log("message semantics contract smoke passed");
