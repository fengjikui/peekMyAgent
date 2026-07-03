---
description: Show the current peekMyAgent recording status
allowed-tools: Bash(peekmyagent:*)
---

Show the current Claude Code session's peekMyAgent recording status.

Run:

```bash
peekmyagent watch-current --agent claude-code --mode single_session --json
```

Report the returned `status`, `watch_id`, `viewer_url`, `workspace`, `conversation_id`, `base_url`, `request_count`, `response_count`, and `reused` fields when present.

If the command returns a `resume_command`, explain that exact provider request capture for this same Claude Code session starts after resuming with that command, because a Bash command cannot rewrite the already-running parent Claude Code process environment.

Do not print raw environment variables or auth tokens.
