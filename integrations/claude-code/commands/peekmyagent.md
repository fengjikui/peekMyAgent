---
description: Open the peekMyAgent dashboard
allowed-tools: Bash(peekmyagent:*)
---

Open the shared peekMyAgent dashboard for this machine.

Related commands users can autocomplete separately:

- `/peekmyagent-status`
- `/peekmyagent-pause`
- `/peekmyagent-resume`
- `/peekmyagent-stop`
- `/peekmyagent-clear`

Run:

```bash
peekmyagent open --print
```

Report the returned dashboard URL. If the user explicitly asks you to open the browser, run:

```bash
peekmyagent open
```

Do not print raw environment variables or auth tokens. This command only opens or reports the dashboard; use the dedicated `/peekmyagent-*` commands for recording control.
