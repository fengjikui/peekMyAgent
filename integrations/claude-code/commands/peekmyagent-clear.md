---
description: Clear the current peekMyAgent recording
allowed-tools: Bash(peekmyagent:*)
---

Stop and clear the current Claude Code session's peekMyAgent recording entry.

Run:

```bash
peekmyagent watch-current --agent claude-code --clear --json
```

Report the returned `status`, `watch_id`, `viewer_url`, `workspace`, `conversation_id`, and `request_count` fields when present.

Do not print raw environment variables or auth tokens.
