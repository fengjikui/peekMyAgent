---
description: Stop peekMyAgent recording but keep captured data
allowed-tools: Bash(peekmyagent:*)
---

Stop peekMyAgent recording for the current Claude Code session, while keeping the captured data in the local dashboard.

Run:

```bash
peekmyagent watch-current --agent claude-code --stop --json
```

Report the returned `status`, `watch_id`, `viewer_url`, `workspace`, `conversation_id`, and `request_count` fields when present.

Do not print raw environment variables or auth tokens.
