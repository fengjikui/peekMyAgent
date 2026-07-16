import { execFile } from "node:child_process";
import {
  claudeCodeProxySettingsArgs,
  mergeClaudeCodeProcessEnv,
} from "../core/claude-code-settings.mjs";
import {
  childProcessSpawnConfig,
  isAccessibleDirectory,
  safeProcessCwd,
  userHome,
} from "../core/platform.mjs";

export const AGENT_SEND_LIMITS = Object.freeze({
  messageChars: 12000,
  commandArgChars: 160,
  commandArgPrefixChars: 120,
  commandArgSuffixChars: 20,
  timeoutMs: 10 * 60 * 1000,
  maxBufferBytes: 20 * 1024 * 1024,
});

export class AgentSendService {
  constructor({
    resolveWatch,
    sanitizeSourceId,
    executeCommand,
    resolveCommandCwd,
    environment,
    claudeProxySettings,
    mergeClaudeEnvironment,
    limits,
  } = {}) {
    this.resolveWatch = requiredFunction(resolveWatch, "resolveWatch");
    this.sanitizeSourceId = typeof sanitizeSourceId === "function" ? sanitizeSourceId : defaultSourceId;
    this.executeCommand = typeof executeCommand === "function" ? executeCommand : executeAgentCommand;
    this.resolveCommandCwd = typeof resolveCommandCwd === "function" ? resolveCommandCwd : agentCommandCwd;
    this.environment = typeof environment === "function" ? environment : () => process.env;
    this.claudeProxySettings = typeof claudeProxySettings === "function" ? claudeProxySettings : claudeCodeProxySettingsArgs;
    this.mergeClaudeEnvironment = typeof mergeClaudeEnvironment === "function" ? mergeClaudeEnvironment : mergeClaudeCodeProcessEnv;
    this.limits = { ...AGENT_SEND_LIMITS, ...(limits || {}) };
  }

  async send(input = {}) {
    const sourceId = this.sanitizeSourceId(input.source_id || input.id);
    const message = String(input.message || "").trim();
    if (!sourceId) throw new Error("Missing source_id");
    if (!message) throw new Error("Message is empty");
    if (message.length > this.limits.messageChars) {
      throw new Error(`Message is too long; please keep it under ${this.limits.messageChars} characters.`);
    }

    const watch = await this.resolveWatch(sourceId);
    if (!watch) throw new Error("Live Agent session not found. Start the Agent through peekMyAgent first.");
    if (watch.status === "stopped") {
      throw new Error("This Agent watch has stopped. Restart or create a new captured session before sending.");
    }

    const command = buildAgentSendCommand(watch, message, {
      resolveCommandCwd: this.resolveCommandCwd,
      environment: this.environment(),
      claudeProxySettings: this.claudeProxySettings,
      mergeClaudeEnvironment: this.mergeClaudeEnvironment,
    });
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await this.executeCommand(command, { limits: this.limits });
    } finally {
      command.cleanup?.();
    }

    return {
      ok: true,
      source_id: watch.id,
      watch_id: watch.watch_id,
      agent: watch.agent,
      status: watch.status,
      sent_at: startedAt,
      completed_at: new Date().toISOString(),
      command: {
        name: command.command,
        args: redactCommandArgs(command.args, this.limits),
        cwd: command.cwd,
      },
      delivery: command.delivery || null,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

export function buildAgentSendCommand(
  watch,
  message,
  {
    resolveCommandCwd = agentCommandCwd,
    environment = process.env,
    claudeProxySettings = claudeCodeProxySettingsArgs,
    mergeClaudeEnvironment = mergeClaudeCodeProcessEnv,
  } = {},
) {
  const cwd = resolveCommandCwd(watch.workspace);
  if (/claude/i.test(watch.agent)) {
    const args = ["-p", "--output-format", "text"];
    if (watch.conversation_id) args.push("--resume", watch.conversation_id);
    const proxySettings = claudeProxySettings({ baseUrl: watch.base_url });
    args.push(...proxySettings.args, message);
    return {
      command: "claude",
      args,
      cwd,
      env: mergeClaudeEnvironment({
        cwd: watch.workspace,
        env: environment,
        overrides: { ANTHROPIC_BASE_URL: watch.base_url },
      }),
      cleanup: proxySettings.cleanup,
      delivery: {
        mode: "detached_resume",
        terminal_echo: false,
        inherits_active_terminal_context: false,
      },
    };
  }
  if (/openclaw/i.test(watch.agent)) {
    const args = ["agent", "--local"];
    if (watch.conversation_id) args.push("--session-key", watch.conversation_id);
    args.push("--message", message);
    return {
      command: "openclaw",
      args,
      cwd,
      env: {
        ...environment,
        OPENAI_BASE_URL: watch.base_url,
        OPENCLAW_BASE_URL: watch.base_url,
        DEEPSEEK_BASE_URL: watch.base_url,
      },
      delivery: {
        mode: "detached_message",
        terminal_echo: false,
        inherits_active_terminal_context: false,
      },
    };
  }
  throw new Error(`Sending messages is not implemented for ${watch.agent}.`);
}

export function redactCommandArgs(args, limits = AGENT_SEND_LIMITS) {
  return (args || []).map((arg) => {
    const text = String(arg || "");
    if (text.length <= limits.commandArgChars) return text;
    return `${text.slice(0, limits.commandArgPrefixChars)}...${text.slice(-limits.commandArgSuffixChars)}`;
  });
}

function agentCommandCwd(workspace) {
  if (isAccessibleDirectory(workspace)) return workspace;
  const home = userHome();
  if (isAccessibleDirectory(home)) return home;
  return safeProcessCwd();
}

function executeAgentCommand({ command, args, cwd, env }, { limits = AGENT_SEND_LIMITS } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const spawnConfig = childProcessSpawnConfig(command, args, { env });
      execFile(
        spawnConfig.command,
        spawnConfig.args,
        {
          cwd,
          env,
          timeout: limits.timeoutMs,
          maxBuffer: limits.maxBufferBytes,
          ...spawnConfig.options,
        },
        (error, stdout, stderr) => {
          if (error && error.code == null && !error.killed) return reject(error);
          resolve({
            exit_code: Number.isInteger(error?.code) ? error.code : 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function defaultSourceId(value) {
  return String(value || "").trim();
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
