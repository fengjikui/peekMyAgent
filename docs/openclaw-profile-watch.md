# OpenClaw profile-based watch

OpenClaw should be integrated through an isolated profile, not by modifying the user's original OpenClaw config.

## Why profile-based capture

OpenClaw stores provider configuration in its config profile. Unlike Claude Code's `ANTHROPIC_BASE_URL` startup environment, OpenClaw can be run with a named profile:

```bash
openclaw --profile peekmyagent ...
```

peekMyAgent uses this property to keep the user's original OpenClaw profile untouched:

1. Copy the current OpenClaw config into an isolated profile, default `peekmyagent`.
2. Start a peekMyAgent live watch.
3. Patch only the isolated profile provider `baseUrl` to the watch proxy URL.
4. Run OpenClaw with `--profile peekmyagent`.
5. Stop or clear the watch and restore the isolated profile provider `baseUrl`.

The default OpenClaw profile is only read as a template. It is not modified.

## Start a watch

Recommended entry:

```bash
peekmyagent run openclaw -- agent --session-key agent:main:my-session --message "hello"
```

This starts or reuses the Viewer, creates a watch, patches only the isolated OpenClaw profile, runs OpenClaw, and stops the watch when OpenClaw exits.

Manual entry, when a separate Viewer is already running:

```bash
pma open --open
```

Optionally install the OpenClaw skill:

```bash
peekmyagent install-openclaw-skill --force
```

Then create and patch the isolated OpenClaw profile:

```bash
peekmyagent watch-current --agent openclaw --patch-openclaw
```

Useful options:

```bash
peekmyagent watch-current --agent openclaw --patch-openclaw --session-key agent:main:my-session
peekmyagent watch-current --agent openclaw --patch-openclaw --openclaw-profile peekmyagent
peekmyagent watch-current --agent openclaw --patch-openclaw --provider xiaomi-coding
peekmyagent watch-current --agent openclaw --patch-openclaw --refresh-profile
```

The command returns:

- `openclaw_profile`: isolated profile to use, usually `peekmyagent`.
- `openclaw_provider`: provider whose `baseUrl` was patched inside that isolated profile.
- `openclaw_command_hint`: example command for running OpenClaw through the isolated profile.
- `target_base_url`: original upstream provider URL saved for restore.
- `base_url`: peekMyAgent watch proxy URL.

## Run OpenClaw through the isolated profile

Use the command hint or run OpenClaw manually:

```bash
openclaw --profile peekmyagent agent --session-key agent:main:my-session --message "hello"
```

Only requests made through this isolated profile will be captured.

## Stop and restore

Stop but keep captured requests:

```bash
peekmyagent watch-current --agent openclaw --stop --session-key agent:main:my-session
```

Stop and remove the live watch entry:

```bash
peekmyagent watch-current --agent openclaw --clear --session-key agent:main:my-session
```

Both commands restore the isolated profile provider `baseUrl` to the saved upstream URL when the watch had patched OpenClaw config.

## Important boundary

This integration does not promise to capture a long-running OpenClaw process that was already started on another profile. For exact capture, run OpenClaw with the isolated `peekmyagent` profile after the watch is created.

The original profile remains untouched throughout the flow.
