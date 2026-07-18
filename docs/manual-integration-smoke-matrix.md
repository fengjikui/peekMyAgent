# Manual Integration Smoke Matrix

Updated: 2026-07-18

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

The fake Claude wrapper gate covers normal and non-zero child exits, missing-watch idempotency, capture preservation, and stopped-watch cleanup on every host. On macOS and Linux it also sends `SIGINT` to the wrapper and requires signal forwarding, exit code `130`, and cleanup before the wrapper exits. Windows console control events are not equivalent to POSIX signals, so release candidates still verify interactive `Ctrl+C` once on a real Windows terminal.

## Manual Smoke Classes

| Class | Commands | Requires | Why not in release gate | Expected artifact |
| --- | --- | --- | --- | --- |
| Claude Code OTel raw body capture | `npm run smoke:claude-otel`, `npm run smoke:claude-otel-multiturn` | Real `claude` command and a model config that can answer | Exercises Claude Code runtime behavior and may depend on installed version/provider config；检查 raw-body 文件外，还应确认 `api_request_body` / `api_response_body` 是否带共同 trace/span correlation | Redacted report plus temporary raw-body evidence |
| Claude Code proxy resume/subagent | `npm run smoke:claude-proxy-resume`, `npm run smoke:claude-subagent-proxy`, `npm run smoke:claude-local-command-input` | Real Claude Code, proxy-compatible model config, local command execution | Validates exact proxy capture against a real Agent loop; provider/model errors should not fail the core release gate | Redacted report under docs or `tmp/smoke-evidence/...` |
| Claude OTel vs proxy comparison | `npm run smoke:claude-otel-vs-proxy` | Real Claude Code plus both OTel and proxy routes | Compares two capture sources; sensitive to Claude Code internals and provider availability | Comparison report and evidence bundle |
| Claude Code project memory injection | Manual procedure below | Real Claude Code, a disposable project, and a unique non-sensitive `MEMORY.md` fact | Memory loading is Claude Code runtime/version behavior and may appear in top-level `system`, a `<system-reminder>` message, a lazy file read, or nowhere in the model request | Redacted request-location report naming Claude Code version and exact capture mode |
| Codex Desktop-first rollout observation | From a disposable project run `pma codex`, create one new Desktop chat, send a non-sensitive message, and confirm the waiting Source binds in place; also check `pma codex -c` and `--resume <thread-id>`; deterministic coverage: `npm run smoke:run-codex-desktop`, `npm run smoke:codex-rollout-capture`, and `npm run smoke:codex-viewer-integration` | Installed Codex Desktop and one disposable workspace | Real rollout events and catalog layout vary by Codex version; Desktop has no safe process-scoped exact-provider override, so this evidence is semantic rather than an exact wire request | Redacted pending-to-bound report naming Codex version, stable Source ID, selected thread, and tag/translation result |
| Codex exact Responses capture | `pma codex capture -- exec -c 'model_reasoning_effort="xhigh"' "<non-sensitive tool-loop prompt>"`; deterministic coverage: `npm run smoke:codex-exact-proxy`, `npm run smoke:codex-exact-viewer-integration`, and `npm run smoke:run-codex-capture` | Installed Codex CLI and usable ChatGPT subscription authentication | Exercises the private first-party Codex route and real authentication; route/client behavior may change independently of peekMyAgent | Redacted multiround/tool-loop report naming Codex version and validated route shape |
| OpenClaw exact integration | `npm run smoke:openclaw-proxy`, `npm run smoke:openclaw-subagent`, `npm run smoke:openclaw-multiturn` | Real `openclaw` command, isolated profile support, local test workspace | Validates a real OpenClaw session/profile rather than a fake wrapper; output can vary by OpenClaw version | Redacted report and `tmp/smoke-evidence/...` |

## Claude Code Project Memory Injection Check

This remains a runtime hypothesis until a real capture proves it. Do not assume that project memory belongs to the top-level System prompt merely because Claude Code describes it as a `<system-reminder>`.

1. Use a disposable project and add one unique, non-sensitive sentence to the project memory file that cannot be confused with `CLAUDE.md`, chat history, or the user prompt.
2. Record the Claude Code version, capture mode (`proxy` or `OTel`), project path shape, and the exact memory file path.
3. Start a genuinely new session in that project and capture its first model request before explicitly mentioning the sentence.
4. Search the complete request in all relevant surfaces: top-level `system`, Harness-extracted content, `messages`, `<system-reminder>` blocks, tool activity, and Raw reconstructed request.
5. Repeat once with `resume`, then once after `/compact`; do not compare each request only with the globally previous capture when subagents or background requests are interleaved.
6. Classify the result as `top_level_system`, `message_system_reminder`, `lazy_file_read`, `not_transmitted`, or `inconclusive`. Preserve the exact evidence location and confidence separately from the interpretation.

If the memory is absent, first rule out a wrong project-memory path, a session started before the write, version-specific memory settings, and capture fidelity before reporting a product bug. Never commit the real memory content or an unredacted capture.

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
