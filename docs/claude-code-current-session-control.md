# Claude Code Current Session Control

## What was verified

Claude Code exposes the current interactive session to Bash tool calls through environment variables:

- `CLAUDE_CODE_SESSION_ID`: stable current Claude Code session id.
- `PWD`: current workspace directory.
- `CLAUDECODE=1`: useful agent detection signal.

This means a Claude Code skill or slash command can identify the current session and associate it with peekMyAgent.

Do not print the full environment while debugging this path. The same environment can include provider auth tokens.

## Product behavior

The natural workflow is:

1. Start the peekMyAgent viewer:

   ```bash
   pma open --open
   ```

2. Install the Claude Code integration once:

   ```bash
   peekmyagent install-claude-skill --commands
   ```

   By default this installs the skill into `~/.claude/skills/peekmyagent-control/SKILL.md` and, with `--commands`, the slash-command templates into `~/.claude/commands/peekmyagent*.md`. Use `--scope project` to install into the current project's `.claude` directory instead.

3. Inside Claude Code, invoke the installed skill or slash command:

   ```text
   /peekmyagent-status
   ```

4. The command runs:

   ```bash
   peekmyagent watch-current --agent claude-code --mode single_session --json
   ```

5. peekMyAgent associates the current session using:
   - `workspace` from `PWD`
   - `conversation_id` from `CLAUDE_CODE_SESSION_ID`
   - `started_by=agent-command`

6. The viewer shows the new live session in the left sidebar.

Running the same command again from the same Claude Code session reuses the existing active recording instead of creating duplicate left-sidebar entries. Pass `--new` only when a separate recording is intentionally needed.

Autocomplete-friendly slash commands:

```text
/peekmyagent
/peekmyagent-status
/peekmyagent-pause
/peekmyagent-resume
/peekmyagent-stop
/peekmyagent-clear
```

Pause and resume use the same local recording entry. Requests still forward while paused, but peekMyAgent does not save request content until recording is resumed.

To stop monitoring but keep captured requests:

```bash
peekmyagent watch-current --agent claude-code --stop
```

To stop monitoring and remove the live entry from the viewer:

```bash
peekmyagent watch-current --agent claude-code --clear
```

The Viewer exposes the same choices on a live recording: "仅停止监听" keeps the captured evidence, while "停止并清空" removes the recording entry.

## Exact capture boundary

The command can identify and register the current session, but it cannot rewrite the environment of the already-running Claude Code parent process. Therefore exact proxy capture starts when Claude Code is launched or resumed with the proxy base URL:

```bash
ANTHROPIC_BASE_URL=<watch-proxy-base-url> claude --resume <CLAUDE_CODE_SESSION_ID>
```

The CLI prints this command as `resume_command` when it detects a Claude Code session id.

## Integration files

- `integrations/claude-code/skills/peekmyagent-control/SKILL.md`
- `integrations/claude-code/commands/peekmyagent.md`
- `integrations/claude-code/commands/peekmyagent-status.md`
- `integrations/claude-code/commands/peekmyagent-pause.md`
- `integrations/claude-code/commands/peekmyagent-resume.md`
- `integrations/claude-code/commands/peekmyagent-stop.md`
- `integrations/claude-code/commands/peekmyagent-clear.md`

The skill is the preferred current Claude Code format. The command files are slash-command templates for local or plugin packaging.
