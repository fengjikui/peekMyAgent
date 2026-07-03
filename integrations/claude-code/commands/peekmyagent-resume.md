---
description: Resume peekMyAgent recording for this session
allowed-tools: Bash(peekmyagent:*)
---

Resume peekMyAgent recording for the current Claude Code session after it was paused.

Run:

```bash
peekmyagent watch-current --agent claude-code --resume --json
```

Report the returned `status`, `watch_id`, `viewer_url`, `workspace`, `conversation_id`, `request_count`, and `skipped_while_paused` fields when present.

Do not print raw environment variables or auth tokens.
