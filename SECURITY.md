# Security Policy

peekMyAgent captures and displays local agent request data. That data may include prompts, source paths, code snippets, tool output, system prompts, model responses, and other sensitive information.

## Supported Versions

Until the first public release, security fixes apply to the main development branch.

## Reporting a Vulnerability

Do not post secrets, raw captured requests, private source code, or exploit details in a public issue.

Preferred reporting path:

1. Use GitHub private vulnerability reporting if it is enabled for the repository.
2. If private reporting is not available, open a minimal public issue that says you need a private security channel. Include the affected component, but do not include sensitive details.

Useful non-sensitive details:

- Operating system and shell.
- Node.js and npm versions.
- peekMyAgent command used.
- Whether the issue affects install, daemon startup, proxy capture, dashboard display, export, clear, or uninstall.
- Whether real user data could be exposed, retained, or deleted unexpectedly.

## Sensitive Data Guidelines

When sharing reproduction material:

- Redact API keys, bearer tokens, cookies, local usernames, private repo paths, and proprietary code.
- Prefer synthetic fixtures over real captures.
- If a raw request body is required, reduce it to the smallest shape that still reproduces the issue.

## Project Security Boundaries

peekMyAgent is local-first. It should not upload traces by default, silently proxy unrelated traffic, or modify global agent/provider configuration without an explicit user action and a restore path.

Security-sensitive changes should include tests for stop, cleanup, and restore behavior.
