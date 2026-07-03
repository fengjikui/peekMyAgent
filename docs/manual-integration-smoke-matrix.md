# Manual Integration Smoke Matrix

Updated: 2026-06-28

This file separates the deterministic release gate from smoke tests that need real Agent binaries, local credentials, provider access, or platform-specific manual setup.

## Default Release Gate

Use these before proposing release-facing changes:

```bash
npm run release:check
npm run release:check:linux
npm run release:check:macos
npm run release:check:windows
```

The platform-specific gates are deterministic by design. They use temporary state roots, fake Agent commands, mock upstreams, and ignored `tmp/` report paths. They should not require Claude Code, OpenClaw, Codex, provider API keys, or real user session data.

## Manual Smoke Classes

| Class | Commands | Requires | Why not in release gate | Expected artifact |
| --- | --- | --- | --- | --- |
| Claude Code OTel raw body capture | `npm run smoke:claude-otel`, `npm run smoke:claude-otel-multiturn` | Real `claude` command and a model config that can answer | Exercises Claude Code runtime behavior and may depend on installed version/provider config | Redacted report plus temporary raw-body evidence |
| Claude Code proxy resume/subagent | `npm run smoke:claude-proxy-resume`, `npm run smoke:claude-subagent-proxy`, `npm run smoke:claude-local-command-input` | Real Claude Code, proxy-compatible model config, local command execution | Validates exact proxy capture against a real Agent loop; provider/model errors should not fail the core release gate | Redacted report under docs or `tmp/smoke-evidence/...` |
| Claude OTel vs proxy comparison | `npm run smoke:claude-otel-vs-proxy` | Real Claude Code plus both OTel and proxy routes | Compares two capture sources; sensitive to Claude Code internals and provider availability | Comparison report and evidence bundle |
| Codex official debug/exec source | `npm run smoke:codex-prompt-input`, `npm run smoke:codex-exec`, `npm run smoke:codex-source-comparison`, `npm run smoke:codex-subagent-exec` | Installed Codex and usable authentication | Codex source availability depends on login mode and CLI version; current ChatGPT-token mode is not an exact network proxy source | Redacted official debug or event-chain reports |
| OpenClaw exact integration | `npm run smoke:openclaw-proxy`, `npm run smoke:openclaw-subagent`, `npm run smoke:openclaw-multiturn` | Real `openclaw` command, isolated profile support, local test workspace | Validates a real OpenClaw session/profile rather than a fake wrapper; output can vary by OpenClaw version | Redacted report and `tmp/smoke-evidence/...` |

## Rules For Running Manual Smokes

- Run them from a non-sensitive test project.
- Prefer a temporary `PEEKMYAGENT_STATE_DIR` unless intentionally validating real user state.
- Never paste real provider keys into issue reports; use redacted logs.
- Treat provider/model failures as environment findings first, not release-gate failures.
- Clean assistant-created watch/capture sessions before handing the machine back.

## When To Promote A Manual Smoke Into The Release Gate

Only promote a smoke when all are true:

- it uses fake commands or fixtures instead of real external Agent binaries;
- it uses mock upstreams instead of real model providers;
- it writes reports only to ignored `tmp/` paths by default;
- it runs on macOS, Linux, and Windows without shell-specific assumptions;
- `npm run release:check:macos` and `npm run release:check:windows` can run it without touching real user config.

If a manual smoke reveals a stable invariant, extract that invariant into a fixture-based or fake-command smoke first, then add the extracted smoke to `scripts/release-check.mjs`.
