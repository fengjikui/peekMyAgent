# Changelog

All notable changes to peekMyAgent are documented in this file. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from the first public alpha.

## [Unreleased]

## [0.1.0-alpha.4] - 2026-07-31

### Added

- `pma observe` adds a process-local OpenAI/Anthropic capture bridge for custom Harnesses.
- `pma codebuddy` adds exact capture and native session reuse for CodeBuddy Code 2.130.0.

### Fixed

- CodeBuddy keeps provider credentials in `models.json`; translation reuses the captured model instead of Viewer credentials.

### Changed

- Validation now declares risk and focused scope before escalating to a full host profile.

## [0.1.0-alpha.3] - 2026-07-30

### Fixed

- npm package CLI mappings now use registry-compatible relative paths, and the package smoke rejects npm metadata auto-corrections that would remove the `pma` and `peekmyagent` commands. `0.1.0-alpha.2` was stopped before registry publication after this warning was detected.

## [0.1.0-alpha.2] - 2026-07-30

### Added

- `pma codex` now opens Codex Desktop for the current project, exposes a waiting Source immediately, and binds that stable Source to the next new workspace thread without copying rollout history into peekMyAgent SQLite.
- Codex XML-like Harness blocks now use a conservative tag registry for runtime, capability, policy, lifecycle, internal, and subagent presentation, with multilingual block translation through the shared cache pipeline.
- `pma opencode` now starts one OpenCode CLI/TUI process behind an exact, reversible proxy overlay, preserves native session attribution, and reuses the shared Trace, tool-loop, subagent, command-injection, compaction, and same-Harness translation pipeline.
- `pma observe` now gives custom Harness authors a child-process-only OpenAI/Anthropic base-URL bridge with exact request/response capture, protocol auto-detection, redacted authentication evidence, direct Trace links, and deterministic cleanup without a Harness-specific adapter.

### Changed

- Viewer source summaries, single-request details, and complete/compact/cursor timeline responses now use one versioned runtime DTO contract enforced at the Server and browser API boundaries.
- System, tool-schema, and Harness translation materials now use one browser/Node request projector while server-side hashing, occurrences, and safety limits remain isolated in the Collector.
- Public installation documentation is npm-first, and package publishing is pinned to the official npm registry so local mirror configuration cannot redirect a release.

## [0.1.0-alpha.1] - 2026-07-15

### Added

- Local-first Agent Trace capture through a loopback Capture Proxy and Claude Code OTel raw-body events.
- A three-pane Trace Viewer for requests, responses, System prompts, tool schemas, messages, tool exchanges, metadata, and Raw JSON.
- Parent/subagent grouping, turn reconstruction, context deltas, response normalization, and provenance/confidence evidence.
- Block-addressed storage for repeated request content and translation caches, plus cursor-based loading for large traces.
- Structured System, Harness, message, and tool-schema views with on-demand multilingual translation.
- Portable, redacted Trace export and read-only import for sharing debugging evidence.
- Cross-platform CLI wrappers, daemon lifecycle, install/uninstall diagnostics, and deterministic macOS, Windows, and Linux release profiles.
- Exact-tag GitHub Release validation and npm OIDC trusted publishing with provenance and prerelease dist-tag protection.

### Security

- Dashboard, control APIs, OTel ingest, and Capture Proxy default to loopback-only access.
- Browser-origin, method, upgrade, hop-header, secret-redaction, archive-limit, and path-traversal boundaries are covered by deterministic release checks.
- Deterministic release checks scrub host provider credentials so browser and translation fixtures cannot call real models.

### Compatibility

- This is a public alpha. Trace and translation cache migrations are forward-only; older binaries reject unsupported future database versions.
- Node.js 24 or newer is required.
- Claude Code and OpenClaw are the primary integrated Agents. Provider-specific model and reasoning options may still affect Agent behavior independently of capture fidelity.

[Unreleased]: https://github.com/fengjikui/peekMyAgent/compare/v0.1.0-alpha.4...HEAD
[0.1.0-alpha.4]: https://github.com/fengjikui/peekMyAgent/compare/v0.1.0-alpha.3...v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/fengjikui/peekMyAgent/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/fengjikui/peekMyAgent/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/fengjikui/peekMyAgent/releases/tag/v0.1.0-alpha.1
