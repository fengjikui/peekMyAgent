---
name: peekmyagent-control
description: Use this skill when the user asks to open, inspect, pause, resume, stop, clear, or check the current peekMyAgent recording from Claude Code.
allowed-tools: Bash(peekmyagent:*)
---

# peekMyAgent Claude Code Control

Use this skill as an auxiliary control surface for peekMyAgent inside Claude Code.

The recommended exact-capture path is still to start Claude Code with:

```bash
peekmyagent claude <claude args>
```

That prepares the proxy before the Claude Code process starts. Slash commands and this skill are for opening the dashboard and controlling an already connected recording.

## Commands

- Open dashboard:

  ```bash
  peekmyagent open --print
  ```

- Show current recording status:

  ```bash
  peekmyagent watch-current --agent claude-code --mode single_session --json
  ```

- Pause recording:

  ```bash
  peekmyagent watch-current --agent claude-code --pause --json
  ```

- Resume recording:

  ```bash
  peekmyagent watch-current --agent claude-code --resume --json
  ```

- Stop recording but keep captured data:

  ```bash
  peekmyagent watch-current --agent claude-code --stop --json
  ```

- Clear the current recording entry:

  ```bash
  peekmyagent watch-current --agent claude-code --clear --json
  ```

## Reporting

Read JSON responses and report only these fields when present:

- `status`
- `watch_id`
- `viewer_url`
- `workspace`
- `conversation_id`
- `base_url`
- `resume_command`
- `request_count`
- `response_count`
- `skipped_while_paused`
- `reused`

If a `resume_command` is present, explain the exact-capture boundary:

- The current Claude Code session id was detected from `CLAUDE_CODE_SESSION_ID`.
- A Bash tool call cannot modify the already-running parent Claude Code process.
- Exact provider request capture for this same session starts after resuming or starting Claude Code with the proxy base URL.

Do not print raw environment variables or auth tokens.

## Failure Handling

- If the CLI says no dashboard is running, tell the user to run `peekmyagent open` in another terminal, then retry.
- If `peekmyagent` is not found, tell the user the CLI needs to be installed or linked before this skill can control recording.
- If no `conversation_id` is detected, still register/check the recording and explain that peekMyAgent will group by its local recording id until an Agent-native session id is available.
