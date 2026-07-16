#!/usr/bin/env node
import assert from "node:assert/strict";
import { AgentSendService } from "../src/server/agent-send-service.mjs";

const watches = new Map([
  [
    "claude-source",
    {
      id: "live-claude-watch",
      watch_id: "claude-watch",
      agent: "Claude Code",
      status: "watching",
      workspace: "/workspace/claude",
      conversation_id: "conversation-claude",
      base_url: "http://127.0.0.1:43111/watch/claude-watch",
    },
  ],
  [
    "openclaw-source",
    {
      id: "live-openclaw-watch",
      watch_id: "openclaw-watch",
      agent: "OpenClaw",
      status: "paused",
      workspace: "/workspace/openclaw",
      conversation_id: "conversation-openclaw",
      base_url: "http://127.0.0.1:43111/watch/openclaw-watch",
    },
  ],
  ["stopped-source", { id: "live-stopped", watch_id: "stopped", agent: "Claude Code", status: "stopped" }],
  ["unsupported-source", { id: "live-other", watch_id: "other", agent: "Other Agent", status: "watching" }],
]);

const executions = [];
let cleanupCalls = 0;
const service = new AgentSendService({
  resolveWatch: async (sourceId) => watches.get(sourceId) || null,
  sanitizeSourceId: (value) => String(value || "").trim().toLowerCase(),
  executeCommand: async (command, { limits }) => {
    executions.push(command);
    assert.equal(limits.messageChars, 12000);
    return { exit_code: 0, stdout: "agent output", stderr: "" };
  },
  resolveCommandCwd: (workspace) => `/resolved${workspace}`,
  environment: () => ({ PATH: "/test/bin", SHARED: "base" }),
  claudeProxySettings: ({ baseUrl }) => ({
    args: ["--settings", `/tmp/${encodeURIComponent(baseUrl)}.json`],
    cleanup() {
      cleanupCalls += 1;
    },
  }),
  mergeClaudeEnvironment: ({ cwd, env, overrides }) => ({ ...env, ...overrides, MERGED_CWD: cwd }),
});

const claudeResult = await service.send({
  source_id: " CLAUDE-SOURCE ",
  message: " hello from dashboard ",
});
assert.equal(claudeResult.ok, true);
assert.equal(claudeResult.source_id, "live-claude-watch");
assert.equal(claudeResult.watch_id, "claude-watch");
assert.equal(claudeResult.command.name, "claude");
assert.equal(claudeResult.command.cwd, "/resolved/workspace/claude");
assert.deepEqual(executions[0].args.slice(0, 5), ["-p", "--output-format", "text", "--resume", "conversation-claude"]);
assert.equal(executions[0].args.at(-1), "hello from dashboard");
assert.equal(executions[0].env.ANTHROPIC_BASE_URL, watches.get("claude-source").base_url);
assert.equal(executions[0].env.MERGED_CWD, "/workspace/claude");
assert.deepEqual(claudeResult.delivery, {
  mode: "detached_resume",
  terminal_echo: false,
  inherits_active_terminal_context: false,
});
assert.equal(cleanupCalls, 1, "temporary Claude proxy settings are released after execution");

const openclawResult = await service.send({ id: "openclaw-source", message: "inspect the session" });
assert.equal(openclawResult.command.name, "openclaw");
assert.deepEqual(executions[1].args, [
  "agent",
  "--local",
  "--session-key",
  "conversation-openclaw",
  "--message",
  "inspect the session",
]);
assert.equal(executions[1].env.OPENAI_BASE_URL, watches.get("openclaw-source").base_url);
assert.equal(executions[1].env.OPENCLAW_BASE_URL, watches.get("openclaw-source").base_url);
assert.equal(executions[1].env.DEEPSEEK_BASE_URL, watches.get("openclaw-source").base_url);
assert.equal(openclawResult.delivery.mode, "detached_message");

const longMessage = `${"prefix ".repeat(30)}private-tail`;
const redactedResult = await service.send({ source_id: "claude-source", message: longMessage });
assert.equal(executions[2].args.at(-1), longMessage, "the Agent receives the complete message");
assert.notEqual(redactedResult.command.args.at(-1), longMessage, "the public command DTO truncates long arguments");
assert.ok(redactedResult.command.args.at(-1).endsWith("private-tail"));

await assert.rejects(() => service.send({ message: "hello" }), /Missing source_id/);
await assert.rejects(() => service.send({ source_id: "claude-source", message: "   " }), /Message is empty/);
await assert.rejects(
  () => service.send({ source_id: "claude-source", message: "x".repeat(12001) }),
  /under 12000 characters/,
);
await assert.rejects(() => service.send({ source_id: "missing-source", message: "hello" }), /session not found/);
await assert.rejects(() => service.send({ source_id: "stopped-source", message: "hello" }), /watch has stopped/);
await assert.rejects(() => service.send({ source_id: "unsupported-source", message: "hello" }), /not implemented/);
assert.throws(() => new AgentSendService(), /resolveWatch is required/);

let failureCleanupCalls = 0;
const failingService = new AgentSendService({
  resolveWatch: () => watches.get("claude-source"),
  executeCommand: async () => {
    throw new Error("spawn failed");
  },
  resolveCommandCwd: (workspace) => workspace,
  claudeProxySettings: () => ({
    args: [],
    cleanup() {
      failureCleanupCalls += 1;
    },
  }),
  mergeClaudeEnvironment: ({ env, overrides }) => ({ ...env, ...overrides }),
});
await assert.rejects(
  () => failingService.send({ source_id: "claude-source", message: "hello" }),
  /spawn failed/,
);
assert.equal(failureCleanupCalls, 1, "temporary settings are also released when process execution fails");

console.log("Agent send service contract smoke passed");
