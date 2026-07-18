#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildTimelineAssistantResponseView,
  buildTimelineResponseToolCalls,
  buildTimelineRequestIdentity,
  buildTimelineToolExchangeView,
  buildTimelineTurnInputView,
  buildTimelineUpstreamView,
  commandMessagePreview,
  formatTimelineResponseUsageMeta,
  isPrimaryTimelineRequest,
  isTimelineSemanticEvent,
  isTimelineResponseRequest,
  pairTimelineToolEvents,
  shouldShowTimelineAssistantResponse,
  shouldShowTimelineRequestContent,
  timelineMessageKindLabel,
  timelineUpstreamEntryLabel,
  timelineUpstreamEntryPreview,
  timelineUpstreamQuickSections,
} from "../src/viewer/request-card-model.js";

const labels = {
  metadataRequest: "Metadata request",
  subagentRequest: "Subagent request",
  parentSpawnRequest: "Parent spawn request",
  mainAgentRequest: "Main agent request",
  noTextSummary: "No text",
  toolResultUpstream: "Tool result return",
  toolUseUpstream: "Tool use request",
  compactMessage: "Compact prompt",
  contextCountMessage: "Context count",
  subagentResult: "Subagent result",
  taskNotification: "Task notification",
  frameworkReminder: "Framework reminder",
  agentInternal: "Agent internal",
  agentContextInherited: "Inherited parent context",
  agentContextIsolated: "Isolated context",
  nestedToolDispatchObserved: ({ tools }) => `Internal dispatch ${tools}`,
  skillLoadObserved: ({ skill }) => `Load Skill ${skill}`,
  skillInstructionReadObserved: ({ skill }) => `Read Skill instructions ${skill}`,
  resultReturnPreview: ({ count }) => `${count} tool results`,
  truncated: "truncated",
};
const translate = (key, values = {}) => {
  const value = labels[key];
  return typeof value === "function" ? value(values) : value || key;
};
const cleanText = (value) => String(value || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const preview = (value, limit) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
};
const commonOptions = {
  translate,
  cleanText,
  preview,
  serialize: (value) => JSON.stringify(value),
};

const userRequest = {
  id: "request-user",
  request_index: 4,
  source_hint: { type: "main" },
  summary: {
    current_user: "请检查磁盘使用情况",
    entry: { kind: "user_input", role: "user", text: "请检查磁盘使用情况" },
    current_tool_calls: [],
    current_tool_results: [],
    response: {
      captured: true,
      latency_ms: 1234,
      finish_reason: "tool_use",
      text: "我来检查。",
      thinking: "Need inspect disk usage.",
      thinking_preview: "Need inspect",
      tool_calls: [{ id: "call-1", name: "Bash", arguments: { command: "df -h" } }],
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 8000,
        output_tokens: 45,
      },
    },
  },
};

assert.deepEqual(buildTimelineRequestIdentity(userRequest, commonOptions), {
  title: "Main agent request",
  excerpt: "请检查磁盘使用情况",
});
assert.equal(shouldShowTimelineRequestContent(userRequest, { cleanText }), true);
assert.equal(shouldShowTimelineAssistantResponse(userRequest), true);
assert.equal(isPrimaryTimelineRequest(userRequest, { cleanText }), true);
assert.equal(isTimelineResponseRequest(userRequest), true);
assert.deepEqual(buildTimelineUpstreamView(userRequest, commonOptions), {
  requestIndex: 4,
  kindClass: "user",
  userTurn: true,
  compact: false,
  label: "User input",
  preview: "请检查磁盘使用情况",
  showInlineContent: true,
  sections: [
    { section: "system", label: "System" },
    { section: "tools", label: "Tools" },
  ],
});

const responseView = buildTimelineAssistantResponseView(userRequest, {
  ...commonOptions,
  expanded: false,
  markdownPreview: preview,
  formatCompactNumber: (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)),
  formatCharCount: (value) => `${value} chars`,
});
assert.equal(responseView.requestId, "request-user");
assert.deepEqual(responseView.meta, ["1234ms", "finish: tool_use", "input 120", "cache 8.0k", "output 45"]);
assert.deepEqual(responseView.thinking, {
  text: "Need inspect disk usage.",
  charCount: "24 chars",
  preview: "Need inspect",
});
assert.equal(responseView.toolCalls[0].name, "Bash");

const semanticSpawnCalls = buildTimelineResponseToolCalls(
  {
    trace: {
      agent_spawn_events: [
        {
          branch_id: "branch-1",
          spawn_id: "spawn-1",
          label: "context_probe",
          context_mode: "all",
          task_message_visibility: "encrypted_in_rollout",
        },
      ],
    },
  },
  [{ id: "spawn-1", name: "spawn_agent", arguments: { message: "gAAAA-secret-ciphertext" } }],
  translate,
);
assert.equal(semanticSpawnCalls[0].displayName, "spawn_agent · context_probe");
assert.equal(semanticSpawnCalls[0].suppressArguments, true);
assert.deepEqual(semanticSpawnCalls[0].displayLines, ["Inherited parent context", "agentTaskEncrypted"]);
assert.equal(JSON.stringify(semanticSpawnCalls).includes("gAAAA-secret-ciphertext"), true, "raw arguments remain available to Raw consumers");

const observedSkillRead = buildTimelineResponseToolCalls(
  {},
  [
    {
      id: "call-skill",
      name: "exec",
      arguments: "tools.exec_command({cmd:'cat /tmp/skills/review/SKILL.md'})",
      semantic: {
        kind: "skill_instruction_read",
        skill_name: "review",
        nested_tool_names: ["exec_command"],
      },
    },
  ],
  translate,
);
assert.equal(observedSkillRead[0].displayName, "exec");
assert.deepEqual(observedSkillRead[0].displayLines, [
  "Internal dispatch exec_command",
  "Read Skill instructions review",
]);
assert.equal(observedSkillRead[0].arguments.includes("SKILL.md"), true, "observed annotations never replace original arguments");

const commandRequest = {
  id: "request-command",
  source_hint: { type: "main" },
  summary: {
    command_message: { command: "/compact", body: "Please summarize the conversation <tag> now." },
    entry: { kind: "compact", text: "Injected compact prompt" },
    response: { captured: false },
  },
};
assert.deepEqual(buildTimelineRequestIdentity(commandRequest, commonOptions), {
  title: "Command /compact",
  excerpt: "/compact · Please summarize the conversation now.",
});
assert.equal(commandMessagePreview({ command: "/init" }, commonOptions), "Command /init");
assert.equal(shouldShowTimelineRequestContent(commandRequest, { cleanText }), false);
assert.equal(isPrimaryTimelineRequest(commandRequest, { cleanText }), true);
assert.equal(timelineUpstreamEntryLabel(commandRequest, commonOptions), "Command /compact");
assert.equal(buildTimelineAssistantResponseView(commandRequest, commonOptions), null);

const semanticLifecycleRequest = {
  id: "request-compaction",
  source_hint: { type: "main" },
  summary: {
    entry: {
      kind: "compact",
      text: "Window 1 compacted",
      semantic_event: { schema_version: 1, category: "context_lifecycle", type: "context_compacted" },
    },
    response: { captured: false },
  },
};
assert.equal(isPrimaryTimelineRequest(semanticLifecycleRequest, { cleanText }), true);
assert.equal(isTimelineSemanticEvent(semanticLifecycleRequest), true);
assert.equal(buildTimelineUpstreamView(semanticLifecycleRequest, commonOptions).kindClass, "semantic-event");
assert.deepEqual(timelineUpstreamQuickSections(semanticLifecycleRequest), []);

const parentSpawnRequest = {
  id: "request-parent-spawn",
  source_hint: { type: "parent_spawn" },
  summary: { current_user: "Launch delegated task" },
};
assert.deepEqual(buildTimelineRequestIdentity(parentSpawnRequest, commonOptions), {
  title: "Parent spawn request",
  excerpt: "Launch delegated task",
});
assert.equal(shouldShowTimelineRequestContent(parentSpawnRequest, { cleanText }), false);

const metadataRequest = {
  id: "request-metadata",
  source_hint: { type: "metadata", label: "Background metadata" },
  summary: {
    internal_request_preview: "Background title request",
    history_stack: [{ kind: "framework_reminder", text: "Fallback reminder" }],
    response: { captured: true, text: "hidden" },
  },
};
assert.deepEqual(buildTimelineRequestIdentity(metadataRequest, commonOptions), {
  title: "Background metadata",
  excerpt: "Background title request",
});
assert.equal(timelineUpstreamEntryPreview(metadataRequest, commonOptions), "Background title request");
assert.equal(shouldShowTimelineAssistantResponse(metadataRequest), false);
assert.equal(isTimelineResponseRequest(metadataRequest), false);
assert.equal(
  timelineUpstreamEntryPreview(
    {
      source_hint: { type: "metadata", label: "Metadata" },
      summary: { history_stack: [{ kind: "framework_reminder", text: "Fallback reminder" }] },
    },
    commonOptions,
  ),
  "Fallback reminder",
);

const taskNotification = {
  id: "request-notification",
  source_hint: { type: "main" },
  summary: {
    entry: { kind: "task_notification", text: "Agent A finished successfully" },
    current_tool_results: [{ id: "call-agent", content: "internal result" }],
    current_tool_calls: [],
  },
};
assert.equal(timelineUpstreamEntryLabel(taskNotification, commonOptions), "Task notification");
assert.equal(timelineUpstreamEntryPreview(taskNotification, commonOptions), "Agent A finished successfully");
assert.equal(shouldShowTimelineRequestContent(taskNotification, { cleanText }), false);
assert.equal(isPrimaryTimelineRequest(taskNotification, { cleanText }), false);
assert.equal(buildTimelineUpstreamView(taskNotification, commonOptions).preview, "Agent A finished successfully");
assert.deepEqual(timelineUpstreamQuickSections(taskNotification), [
  { section: "system", label: "System" },
  { section: "tools", label: "Tools" },
  { section: "tool_results", label: "tool_result" },
]);

const toolUseRequest = {
  summary: {
    entry: { kind: "assistant", text: "" },
    current_tool_calls: [{ id: "call-2", name: "Read", arguments: { file_path: "README.md" } }],
    current_tool_results: [],
  },
};
assert.equal(timelineUpstreamEntryLabel(toolUseRequest, commonOptions), "Tool use request");
assert.equal(timelineUpstreamEntryPreview(toolUseRequest, commonOptions), 'Read {"file_path":"README.md"}');
assert.deepEqual(timelineUpstreamQuickSections(toolUseRequest), [
  { section: "system", label: "System" },
  { section: "tools", label: "Tools" },
  { section: "upstream_tool_calls", label: "tool_use" },
]);

const subagentRequest = {
  id: "request-subagent",
  request_index: 8,
  is_subagent: true,
  source_hint: { type: "subagent" },
  summary: {
    current_user: "Inspect files",
    entry: { kind: "user_input", text: "Inspect files" },
    response: { captured: true, text: "done" },
  },
};
assert.equal(buildTimelineRequestIdentity(subagentRequest, commonOptions).title, "Subagent request");
assert.equal(timelineUpstreamEntryLabel(subagentRequest, commonOptions), "Subagent input");
assert.equal(shouldShowTimelineRequestContent(subagentRequest, { cleanText }), false);
assert.equal(isPrimaryTimelineRequest(subagentRequest, { cleanText }), false);
assert.equal(isTimelineResponseRequest(subagentRequest), false);

const turnInput = buildTimelineTurnInputView(
  userRequest,
  { user_input: "请检查磁盘使用情况" },
  commonOptions,
);
assert.deepEqual(turnInput, {
  requestIndex: 4,
  kindClass: "user",
  userTurn: true,
  label: "User input",
  preview: "请检查磁盘使用情况",
});

const toolExchange = buildTimelineToolExchangeView({
  summary: {
    current_tool_calls: [
      { id: "call-a", name: "Bash", arguments: { command: "pwd" } },
      { id: "call-b", name: "Read", arguments: { file_path: "README.md" } },
    ],
    current_tool_results: [
      { id: "call-a", content: "/tmp" },
      { id: "orphan", content: "orphan result" },
    ],
  },
});
assert.deepEqual(toolExchange.counts, { calls: 2, results: 2 });
assert.deepEqual(toolExchange.pairs.map((item) => item.confidence), ["id", "call_only", "result_only"]);
assert.equal(buildTimelineToolExchangeView({ summary: {} }), null);
assert.deepEqual(pairTimelineToolEvents([], [{ id: "orphan" }]), [
  { call: null, result: { id: "orphan" }, confidence: "result_only" },
]);

assert.equal(timelineMessageKindLabel("framework_reminder", "system", translate), "Framework reminder");
assert.equal(timelineMessageKindLabel("custom", "user", translate), "user");
assert.deepEqual(
  formatTimelineResponseUsageMeta({ request_units: 3, nested: { ignored: true } }),
  ["request_units 3"],
);

console.log("request card model contract smoke passed");
