import { extractContentText } from "./content-parts.mjs";

export function lastMessage(messages, role) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return messages[index];
  }
  return null;
}

export function lastRealUserMessage(messages) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (isSuggestionModeMessage(message) || isFrameworkReminderMessage(message) || isTaskNotificationMessage(message)) continue;
    if (realUserVisibleText(message) || parseCommandMessage(message)) return message;
  }
  return null;
}

export function isFrameworkReminderMessage(message) {
  if (!message || message.role !== "user") return false;
  const text = extractContentText(message.content);
  return (hasFrameworkReminderBlock(text) && !stripFrameworkReminderBlocks(text)) || isKnownFrameworkReminderText(text);
}

export function isSuggestionModeMessage(message) {
  if (!message) return false;
  return /^\[SUGGESTION MODE:/i.test(extractContentText(message.content).trim());
}

export function isTaskNotificationMessage(message) {
  if (!message || message.role !== "user") return false;
  return /^\s*<task-notification[\s>]/i.test(extractContentText(message.content));
}

export function taskNotificationSummary(message) {
  const text = extractContentText(message?.content);
  const tag = (name) => (text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i")) || [])[1]?.trim() || "";
  const taskId = tag("task-id");
  const status = tag("status");
  const summary = tag("summary");
  const result = tag("result").replace(/\s+/g, " ").trim();
  const subagent = subagentResultFromTaskNotification({ summary, status, result });
  const headline = [summary, status && `(${status})`].filter(Boolean).join(" ");
  const preview = textPreview([headline, result].filter(Boolean).join(" — "), 420)
    || textPreview(text.replace(/<\/?[a-z-]+>/gi, " ").replace(/\s+/g, " ").trim(), 420);
  return { taskId, status, summary, result, preview, subagent };
}

export function isCompactInjectionText(text) {
  const value = String(text || "");
  return (
    /create a detailed summary of the conversation so far/i.test(value) ||
    (/Respond with TEXT ONLY/i.test(value) && /<analysis>[\s\S]*<summary>/i.test(value))
  );
}

export function isCompactInjectionMessage(message) {
  return Boolean(compactInjectionText(message));
}

export function isSkillInjectionText(text) {
  const value = String(text || "").trim();
  return /^Base directory for this skill:\s*\S+/i.test(value) || /^Skill base directory:\s*\S+/i.test(value);
}

export function isSkillInjectionMessage(message) {
  return Boolean(skillInjectionText(message));
}

export function isToolResultMessage(message) {
  if (message?.role === "tool") return true;
  const content = message?.content;
  if (Array.isArray(content) && content.length) return content.some((part) => part?.type === "tool_result");
  return content?.type === "tool_result";
}

export function classifyMessageKind(message) {
  if (isTaskNotificationMessage(message)) return taskNotificationSummary(message).subagent ? "subagent_result" : "task_notification";
  if (isFrameworkReminderMessage(message)) return "framework_reminder";
  if (isSuggestionModeMessage(message)) return "agent_internal";
  if (isCompactInjectionMessage(message)) return "compact";
  if (isSkillInjectionMessage(message)) return "harness_injection";
  if (message?.role === "user" && realUserVisibleText(message)) return "message";
  if (parseCommandMessage(message)) return "command_message";
  if (isToolResultMessage(message)) return "tool_result";
  const parts = Array.isArray(message?.content) ? message.content : [];
  if (parts.some((part) => part?.type === "tool_use")) return "tool_use";
  return "message";
}

export function classifyCurrentEntry(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message) continue;
    if (isFrameworkReminderMessage(message)) continue;
    if (message.role === "system") continue;
    if (isTaskNotificationMessage(message)) {
      const { taskId, preview, subagent } = taskNotificationSummary(message);
      if (subagent) {
        return {
          kind: "subagent_result",
          label: "子 Agent 结果回流",
          text: subagent.preview || preview,
          task_id: taskId,
          subagent,
        };
      }
      return { kind: "task_notification", label: "任务通知", text: preview, task_id: taskId };
    }
    if (isCompactInjectionMessage(message)) {
      return { kind: "compact", label: "上下文压缩 (/compact)", text: "请求模型把前文压缩成 <analysis> + <summary> 结构化总结（注入提示词，非用户真话）" };
    }
    if (isSkillInjectionMessage(message)) {
      return { kind: "harness_injection", label: "Skill / Harness 注入", text: textPreview(skillInjectionText(message), 1200) };
    }
    if (message.role === "user") {
      const real = realUserVisibleText(message);
      if (real) return { kind: "user_input", label: "User input", text: textPreview(real, 1200) };
    }
    if (isToolResultMessage(message)) return { kind: "tool_result", label: "Tool result 回传", text: "" };
    const parts = Array.isArray(message.content) ? message.content : [];
    if (parts.some((part) => part?.type === "tool_use")) return { kind: "tool_use", label: "Tool use 上行", text: "" };
    if (isSuggestionModeMessage(message)) return { kind: "agent_internal", label: "Agent 内部建议", text: "" };
    const commandMessage = parseCommandMessage(message);
    if (commandMessage) return { kind: "command", label: `Command ${commandMessage.command}`, text: commandMessage.preview || "" };
    if (message.role === "user") continue;
  }
  return { kind: "unknown", label: "未识别输入", text: "" };
}

export function displayMessageText(message) {
  const text = extractContentText(message?.content);
  if (isCompactInjectionMessage(message)) return "上下文压缩指令：请求模型把前文压缩成 <analysis> + <summary> 总结（harness 注入）";
  if (isSkillInjectionMessage(message)) return `Skill / Harness 注入\n${skillInjectionText(message)}`;
  if (isFrameworkReminderMessage(message)) return "Claude Code 框架自动补充提醒";
  if (isTaskNotificationMessage(message)) {
    const { taskId, preview, subagent } = taskNotificationSummary(message);
    if (subagent) return taskId ? `子 Agent 结果回流 · ${taskId}\n${subagent.preview || preview}` : `子 Agent 结果回流\n${subagent.preview || preview}`;
    return taskId ? `后台任务通知 · ${taskId}\n${preview}` : `后台任务通知\n${preview}`;
  }
  return text;
}

export function userVisibleText(message) {
  const realText = realUserVisibleText(message);
  if (realText) return realText;
  const commandMessage = parseCommandMessage(message);
  if (commandMessage) return commandUserVisibleText(commandMessage);
  return "";
}

export function realUserVisibleText(message) {
  if (!message) return "";
  const rawText = extractContentText(message.content);
  const textAfterLocalCommands = userTextAfterLocalCommandBlocks(rawText);
  if (textAfterLocalCommands) return textAfterLocalCommands;
  const text = realUserVisibleTextFromContent(message.content);
  if (parseCommandMessage(message)) return "";
  return stripDisplayWrapperTags(stripFrameworkReminderBlocks(text));
}

export function extractCodexHarnessBlocks(text) {
  const value = String(text || "");
  const output = [];
  const tagged = codexTaggedHarnessRegex();
  let match;
  while ((match = tagged.exec(value))) {
    const content = String(match[2] || "").trim();
    if (content) output.push({ tag: match[1] || "codex-context", text: content });
  }
  const permissions = codexPermissionsHarnessRegex();
  while ((match = permissions.exec(value))) {
    const content = String(match[1] || "").trim();
    if (content) output.push({ tag: "permissions instructions", text: content });
  }
  return output;
}

export function parseCommandMessage(messageOrText) {
  const text =
    typeof messageOrText === "string"
      ? messageOrText
      : messageOrText?.role === "user"
        ? extractContentText(messageOrText.content)
        : "";
  if (!text || !/<command-(?:message|name)\b/i.test(text)) return null;
  const commandName = firstTagValue(text, commandNameRegex());
  const commandMessage = firstTagValue(text, commandMessageRegex());
  const command = normalizeSlashCommand(commandName || commandMessage);
  if (!command) return null;
  const body = text
    .replace(commandMessageRegex(), "")
    .replace(commandNameRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    type: "claude_command",
    command,
    name: commandName ? normalizeSlashCommand(commandName) : command,
    message: commandMessage || command.replace(/^\//, ""),
    body,
    preview: textPreview(body || `Claude Code command ${command}`, 1200),
  };
}

export function commandUserVisibleText(commandMessage) {
  const prefix = `Command ${commandMessage.command}`;
  return commandMessage.body ? `${prefix}\n${commandMessage.body}` : prefix;
}

export function commandPreviewText(commandMessage) {
  return commandMessage.body ? `${commandMessage.command} · ${commandMessage.body}` : commandMessage.command;
}

export function cleanTitleText(text) {
  return String(text || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(commandMessageRegex(), "$1")
    .replace(commandNameRegex(), "$1")
    .replace(frameworkReminderRegex(), "")
    .replace(/\s*Write the title in [\s\S]*?Keep technical terms and code identifiers in their original form\.?\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isKnownFrameworkReminderText(text) {
  const value = String(text || "").trimStart();
  if (!/^The user stepped away and is coming back\./i.test(value.slice(0, 80))) return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  return /^The user stepped away and is coming back\. Recap in under 40 words,\s*1-2 plain sentences,\s*no markdown\./i.test(normalized);
}

function subagentResultFromTaskNotification({ summary, status, result }) {
  const match = String(summary || "").match(/^Agent\s+"([^"]+)"\s+finished/i);
  if (!match) return null;
  return {
    name: match[1],
    status: status || null,
    result: result || "",
    preview: textPreview(`子 Agent「${match[1]}」${status ? ` ${status}` : "完成"} — ${result || summary}`, 420),
  };
}

export function compactInjectionText(message) {
  if (!message) return "";
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: extractContentText(message?.content) }];
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "";
    if (isCompactInjectionText(text)) return text;
  }
  return "";
}

function skillInjectionText(message) {
  if (!message) return "";
  const parts = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: extractContentText(message?.content) }];
  for (const part of parts) {
    const text = typeof part === "string" ? part : part?.type === "text" ? part.text || "" : "";
    if (isSkillInjectionText(text)) return text;
  }
  return "";
}

function realUserVisibleTextFromContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: "text", text: extractContentText(content) }];
  return parts
    .map((part) => realUserVisibleTextPart(part))
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function realUserVisibleTextPart(part) {
  if (part == null) return "";
  if (typeof part === "string") return cleanRealUserTextPart(part);
  if (part.type === "tool_result" || part.type === "tool_use" || part.type === "thinking" || part.type === "reasoning") return "";
  const text = part.type === "text" ? part.text || "" : part.text || extractContentText(part.content);
  return cleanRealUserTextPart(text);
}

function cleanRealUserTextPart(text) {
  let value = stripCodexHarnessBlocks(stripFrameworkReminderBlocks(String(text || "")));
  if (/<local-command-|<command-(?:name|message|args)\b/i.test(value)) value = userTextAfterLocalCommandBlocks(value);
  else value = stripDisplayWrapperTags(value);
  if (!value) return "";
  if (isCompactInjectionText(value)) return "";
  if (isSkillInjectionText(value)) return "";
  if (isLocalCommandOnlyText(value)) return "";
  if (/^Tool loaded\.\s*$/i.test(value)) return "";
  return value;
}

function stripFrameworkReminderBlocks(text) {
  return String(text || "").replace(frameworkReminderRegex(), "").trim();
}

function stripDisplayWrapperTags(text) {
  return String(text || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(commandMessageRegex(), "$1")
    .replace(commandNameRegex(), "$1")
    .trim();
}

export function stripCodexHarnessBlocks(text) {
  let value = String(text || "");
  for (const regex of codexHarnessBlockRegexes()) value = value.replace(regex, "");
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function codexHarnessBlockRegexes() {
  return [codexTaggedHarnessRegex(), codexPermissionsHarnessRegex()];
}

function codexTaggedHarnessRegex() {
  return /<(environment_context|in-app-browser-context|app-context|skills_instructions|apps_instructions|plugins_instructions|recommended_plugins|collaboration_mode)\b[^>]*>([\s\S]*?)<\/\1>/gi;
}

function codexPermissionsHarnessRegex() {
  return /<permissions instructions\b[^>]*>([\s\S]*?)<\/permissions instructions>/gi;
}

function userTextAfterLocalCommandBlocks(text) {
  const value = String(text || "");
  if (!/<local-command-|<command-(?:name|message|args)\b/i.test(value)) return "";
  return stripFrameworkReminderBlocks(stripLocalCommandGeneratedMarkdown(value))
    .replace(localCommandCaveatRegex(), "")
    .replace(localCommandStdoutRegex(), "")
    .replace(localCommandStderrRegex(), "")
    .replace(commandArgsRegex(), "")
    .replace(commandMessageRegex(), "")
    .replace(commandNameRegex(), "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(stripAnsiRegex(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripLocalCommandGeneratedMarkdown(text) {
  let value = String(text || "");
  if (/<command-name\b[^>]*>\s*\/?context\s*<\/command-name>/i.test(value)) {
    value = value.replace(/(^|\n)## Context Usage[\s\S]*?(?=\n\s*<local-command-caveat\b|\n\s*<command-name\b|$)/gi, "\n");
  }
  return value;
}

function isLocalCommandOnlyText(text) {
  const value = String(text || "");
  if (!/<local-command-|<command-(?:name|message|args)\b/i.test(value)) return false;
  return !userTextAfterLocalCommandBlocks(value);
}

function hasFrameworkReminderBlock(text) {
  return frameworkReminderRegex().test(String(text || ""));
}

function frameworkReminderRegex() {
  return /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi;
}

function firstTagValue(text, regex) {
  const match = regex.exec(String(text || ""));
  return match?.[1]?.trim() || "";
}

function commandMessageRegex() {
  return /<command-message\b[^>]*>([\s\S]*?)<\/command-message>/gi;
}

function commandNameRegex() {
  return /<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi;
}

function commandArgsRegex() {
  return /<command-args\b[^>]*>[\s\S]*?<\/command-args>/gi;
}

function localCommandCaveatRegex() {
  return /<local-command-caveat\b[^>]*>[\s\S]*?<\/local-command-caveat>/gi;
}

function localCommandStdoutRegex() {
  return /<local-command-stdout\b[^>]*>[\s\S]*?<\/local-command-stdout>/gi;
}

function localCommandStderrRegex() {
  return /<local-command-stderr\b[^>]*>[\s\S]*?<\/local-command-stderr>/gi;
}

function stripAnsiRegex() {
  return /\x1B\[[0-?]*[ -/]*[@-~]/g;
}

function normalizeSlashCommand(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+/)[0].replace(/^\/+/, "");
  if (!first) return "";
  return `/${first}`;
}

function textPreview(text, limit) {
  const normalized = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}
