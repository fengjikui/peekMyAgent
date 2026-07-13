# Contributing to peekMyAgent

Thanks for helping make agent traces easier to inspect. This project is local-first and often handles sensitive prompts, source paths, tool output, and model traffic, so useful contributions should preserve user control and reproducibility.

Coding agents and maintainers working across multiple machines must also follow the [Coding Agent Collaboration Covenant](AGENTS.md). It defines synchronization cadence, platform validation ownership, branch rules, handoff reports, and real-machine safety.

## Development Setup

Requirements:

- Node.js 24 or newer.
- npm.
- macOS, Linux, or Windows. Windows fixes should mention the shell used: PowerShell, CMD, Git Bash, or another shell.

From a source checkout:

```bash
npm install
node scripts/install.mjs --dry-run
npm run release:check
```

For the full platform gate, run the profile that matches your host:

```bash
npm run release:check:macos
npm run release:check:linux
npm run release:check:windows
```

The release gate uses temporary state directories and temporary ports. Do not run tests against real captured sessions unless the test explicitly requires it.

## Useful Checks

Before opening a pull request, run the smallest checks that cover your change:

- CLI or platform helpers: `npm run smoke:platform`
- Install/uninstall: `npm run smoke:source-install && npm run smoke:source-uninstall`
- Dashboard startup: `npm run smoke:dashboard-open`
- Package contents: `npm run smoke:package`
- Full local gate: `npm run release:check`

Low-risk local commits may be tested and committed with focused checks, then grouped into a batch of at most three code commits. Run the full host-platform profile before pushing that batch, or immediately for any high-risk change. See the [tiered validation strategy](docs/validation-strategy.md) for the exact reset and escalation rules.

If your change affects an adapter, include the relevant smoke result and describe whether it used a fake command, a fixture, or a real agent.

## Adapter Contributions

Adapter changes should make the capture boundary explicit:

- What command or config path is used?
- Is capture wrapper-first, profile-scoped, or a global config change?
- How does the user stop or restore it?
- Which files or environment variables are read or written?
- Which smoke test proves the behavior?

Do not add broad provider-config mutation without backup, restore, and cleanup tests.

## Privacy Rules

Do not commit captured sessions, raw prompts, private source code, API keys, screenshots with secrets, or local evidence bundles. Prefer minimal fixtures and redacted samples.

When reporting a trace bug, include shape and metadata where possible instead of full request bodies.

## Pull Request Checklist

- The change is scoped to one behavior or adapter boundary.
- Relevant smoke tests pass.
- New cross-platform assumptions are documented or tested.
- User data cleanup behavior is preserved.
- User-facing copy changes update the viewer i18n dictionaries and static `data-i18n*` hooks when applicable.
- No secrets or personal local paths are committed.
