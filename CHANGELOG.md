# Changelog

All notable changes to peekMyAgent are documented in this file. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from the first public alpha.

## [Unreleased]

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

### Compatibility

- This is a public alpha. Trace and translation cache migrations are forward-only; older binaries reject unsupported future database versions.
- Node.js 24 or newer is required.
- Claude Code and OpenClaw are the primary integrated Agents. Provider-specific model and reasoning options may still affect Agent behavior independently of capture fidelity.

[Unreleased]: https://github.com/fengjikui/peekMyAgent/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/fengjikui/peekMyAgent/releases/tag/v0.1.0-alpha.1
