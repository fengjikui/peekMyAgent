---
description: Pause peekMyAgent recording for this session
allowed-tools: Bash(peekmyagent:*)
---

Pause peekMyAgent recording for the current Claude Code session. Requests should continue forwarding, but peekMyAgent should stop saving request content until recording is resumed.

Run:

```bash
peekmyagent watch-current --agent claude-code --pause --json
```

Report the returned `status`, `watch_id`, `viewer_url`, `workspace`, `conversation_id`, `request_count`, and `skipped_while_paused` fields when present.

Do not print raw environment variables or auth tokens.
