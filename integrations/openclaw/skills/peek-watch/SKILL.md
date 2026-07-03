---
name: peek-watch
description: Use when the user asks to start, stop, clear, or inspect peekMyAgent capture for the current OpenClaw workflow. Trigger for phrases like "start peekMyAgent", "monitor this OpenClaw session", "开始捕获", "监控当前会话", "停止捕获", or "清空监听".
---

# peekMyAgent OpenClaw Watch

Use this skill as an auxiliary command for peekMyAgent OpenClaw capture. The recommended capture path is to start OpenClaw with `peekmyagent run openclaw -- <openclaw args>`, because that command itself is the user's explicit capture intent and it prepares the isolated profile before OpenClaw starts.

## Start Capture

If the user wants to start a new captured OpenClaw process, recommend:

```bash
peekmyagent run openclaw -- agent --session-key '<session-key>' --message '<message>'
```

For manual watch setup, run:

```bash
peekmyagent watch-current --agent openclaw --patch-openclaw --json
```

If the current OpenClaw workflow has a known session key, pass it explicitly:

```bash
peekmyagent watch-current --agent openclaw --patch-openclaw --session-key '<session-key>' --json
```

Report these fields when present:

- `watch_id`
- `viewer_url`
- `base_url`
- `openclaw_profile`
- `openclaw_provider`
- `openclaw_command_hint`
- `conversation_id`
- `status`
- `reused`

Explain that OpenClaw requests must run through the reported isolated profile, usually `peekmyagent`, for exact capture. The original OpenClaw profile is not modified.

## Stop Capture

To stop capture but keep the watch entry and captured requests:

```bash
peekmyagent watch-current --agent openclaw --stop --json
```

To stop capture and remove the live watch entry:

```bash
peekmyagent watch-current --agent openclaw --clear --json
```

Stop and clear commands restore the isolated profile provider `baseUrl` to the original upstream URL saved by the watch.

## Safety

- Do not print OpenClaw config files or secret values.
- Do not modify the user's original OpenClaw profile.
- Use `--openclaw-profile <name>` only when the user asks for a non-default isolated profile.
- If `peekmyagent` says no dashboard is running, tell the user to run `peekmyagent open` first.
