# peekMyAgent

[中文 README](README.zh-CN.md)

peekMyAgent is a local-first dashboard for inspecting what coding agents send to model providers.

It helps you understand how tools such as Claude Code, Codex, OpenCode, and OpenClaw assemble system prompts, user messages, tool definitions, tool results, history, model parameters, and raw request bodies before they reach the remote model.

peekMyAgent is not meant to "steal hidden prompts". It is an observability tool for your own local agent sessions, in environments where you explicitly choose to record and inspect the traffic.

## Visual Overview

![peekMyAgent dashboard feature tour](assets/demo/dashboard-overview-tour.gif)

<p>
  <strong>Upstream Context Walkthrough</strong><br>
  Inspect the exact System, Tools, Messages, and Response slices sent around a normal chat request.
</p>

<p>
  <img src="assets/demo/chat-upstream-context.gif" alt="Upstream context walkthrough" width="960">
</p>

<p>
  <strong>Tool Call Loop Walkthrough</strong><br>
  Follow a basic <code>tool_use</code> -> <code>tool_result</code> -> final answer loop from the model request timeline.
</p>

<p>
  <img src="assets/demo/tool-call-loop.gif" alt="Tool call loop walkthrough" width="960">
</p>

See the [visual usage guide](docs/visual-usage-guide.zh-CN.md) for the annotated screenshot, upstream-context walkthrough, tool-call loop walkthrough, and README recording plan.

## What You Can Do Today

- Open a local dashboard at `http://127.0.0.1:43110`.
- Start Claude Code through `pma claude ...` and capture its model requests.
- Use the native Codex Desktop UI with managed exact Responses capture on supported macOS builds, fall back explicitly to zero-copy rollout observation, or start Codex CLI behind the exact proxy.
- Start OpenCode through `pma opencode ...` and capture only that CLI/TUI process through an exact, reversible proxy overlay.
- Start OpenClaw through `pma openclaw ...` and capture its model requests.
- Switch the sidebar's observed Agent so Codex, Claude Code, OpenCode, OpenClaw, and imported traces stay separate.
- Inspect requests as a timeline with user input, system summaries, tools, tool calls, tool results, responses, token usage, and raw JSON.
- Inspect Claude Code subagent traffic and group child-agent requests.
- Open the dashboard from inside Claude Code with `/peekmyagent`.
- Pause, resume, stop, or clear a current recording from Claude Code slash commands.
- Send a message to a watched Agent directly from the dashboard.

## Requirements

- macOS, Windows, or Linux.
- Node.js 24 or newer. peekMyAgent currently uses Node's built-in `node:sqlite` runtime for its local store.
- Claude Code, Codex, OpenCode, and/or OpenClaw already installed and working for the integration you want to use.
- Your model provider configuration should already work in the terminal where you run the Agent.

If `claude` does not work by itself, fix that first:

```bash
claude --version
claude -p --output-format text "Reply OK"
```

## Install

Install the public alpha globally from npm:

```bash
npm install --global peekmyagent@next
```

This installs both `pma` and `peekmyagent`; the examples use the shorter `pma` command. Verify the installation:

```bash
pma doctor
pma --help
```

Run the same npm command again to update to the newest public alpha. After the first stable release, `npm install --global peekmyagent` will install and update the stable channel.

If your npm client uses a mirror that has not synchronized the package yet, target the official registry explicitly:

```bash
npm install --global peekmyagent@next --registry=https://registry.npmjs.org/
```

### Install From Source

Contributors can clone the repository and run the source installer:

```bash
git clone https://github.com/fengjikui/peekMyAgent.git
cd peekMyAgent
node scripts/install.mjs
```

The source installer runs:

```bash
npm install
npm install -g .
pma doctor
```

To preview the source-install plan without changing your machine:

```bash
node scripts/install.mjs --dry-run
```

For active development, `npm link` is still available. You can also run the CLI without installing it globally:

```bash
node bin/peekmyagent.mjs --help
```

All examples below use `pma`. The full `peekmyagent` command remains available and behaves the same.

## Quick Start With Claude Code

Open the dashboard:

```bash
pma open
```

Start Claude Code through peekMyAgent:

```bash
cd <your-project>
pma claude -c
```

Then use Claude Code normally. Captured requests will appear in the dashboard.

Claude Code capture uses `auto` mode by default: peekMyAgent uses proxy capture when Claude Code has a configurable upstream base URL, and falls back to OTel raw-body capture for subscription/OAuth sessions. Advanced users can force a mode with `pma --proxy claude ...`, `pma --otel claude ...`, or `pma --capture otel claude ...`.

If you intentionally want to run Claude Code with permission prompts disabled, put Claude Code's flag after `claude`:

```bash
pma claude -c --dangerously-skip-permissions
```

Use this only in repositories you trust. The flag belongs to Claude Code, not peekMyAgent, and it bypasses Claude Code's normal permission checks.

To open the dashboard again later:

```bash
pma open
```

To print the dashboard URL without opening a browser:

```bash
pma open --print
```

Check the local installation and resolved cross-platform paths:

```bash
pma doctor
pma doctor --json
```

The dashboard runs locally by default:

```text
http://127.0.0.1:43110
```

## Quick Start With Codex

From the project you want to inspect, start Codex behind a one-process exact proxy:

```bash
cd <your-project>
pma codex
```

Send messages in the Codex TUI in that terminal. The dashboard shows the verbatim request/response, tool schemas, calls, and results. PMA does not edit `~/.codex/config.toml` or depend on a persisted rollout.

Pass ordinary Codex arguments directly:

```bash
pma codex resume --last
pma codex exec "Inspect this repository"
pma codex --dangerously-bypass-approvals-and-sandbox
```

The last command bypasses approvals and sandboxing; use it only in a trusted isolated environment. In Codex CLI, `-c` means config override, not continue.

To keep the native Codex Desktop interaction surface and inspect the exact wire request on a supported macOS build, run this command from an **external Terminal**:

```bash
cd <your-project>
pma codex desktop
```

If Codex Desktop is already running, PMA explains that active tasks will stop and asks before one graceful restart. It then starts the embedded, version-matched Codex App Server and injects a temporary capture-provider definition only into the first new thread created in the current workspace. The App Server's global configuration and every other Desktop thread remain untouched. PMA reuses the existing Codex/ChatGPT login in memory and does not rewrite `~/.codex/config.toml`, install a certificate, or persist authentication values.

Do not start the restart flow from a Terminal embedded in the Codex Desktop task being captured. PMA detects that self-interruption case and refuses it. To pre-approve the restart in a script, use `pma codex desktop --capture exact --restart`.

Use semantic rollout observation when you do not want to restart or when managed exact capture is unavailable on the host:

```bash
pma codex desktop --capture rollout
pma codex desktop -c
pma codex desktop --select
```

`desktop -c` observes the current directory's latest session, while `--select` lists selectable sessions from that directory; `--resume` and `--list` remain advanced history tools. Rollout mode is read-only semantic evidence, not a complete wire request, and PMA does not copy rollout text into SQLite. `pma codex capture -- ...` remains a compatibility alias for exact Codex CLI capture.

To capture an existing Desktop session exactly, select it explicitly and open that conversation after the managed restart so Codex cold-resumes it through the capture provider:

```bash
pma codex desktop --resume <thread-id> --capture exact
pma codex desktop --select --capture exact
```

An already loaded thread cannot switch provider in place. PMA reports whether the selected thread was actually cold-resumed and routed; it never labels an untouched thread as exact capture.

## Quick Start With OpenCode

From the project you want to inspect, start OpenCode behind a process-local exact proxy:

```bash
cd <your-project>
pma opencode
```

Continue using the native OpenCode TUI in that terminal. PMA preserves OpenCode's normal stdin/stdout and passes its arguments through:

```bash
pma opencode --continue
pma opencode --session <session-id>
pma opencode --model <provider/model>
```

PMA only overrides the wrapped process's `baseURL`; it does not change config, read `auth.json`, or capture other sessions. An explicit `baseURL` is required.

## Resume A Claude Code Session

Resume a specific Claude Code session:

```bash
pma claude -r <session-id>
```

Continue the last Claude Code session:

```bash
pma claude -c
```

When Claude Code uses `-c/--continue` or `-r/--resume`, peekMyAgent may find an existing recording for the same project/session. In an interactive terminal it asks whether to reuse that recording or create a new one. Pressing Enter accepts option 1 and continues writing to the same recording in both proxy and OTel capture modes; choose option 2 when a separate recording is intentional.

Use these flags to choose explicitly:

```bash
pma --reuse claude -c
pma --ask claude -r <session-id>
```

## Install Claude Code Slash Commands

Install the Claude Code skill and slash-command templates:

```bash
pma install-claude-skill --commands
```

This installs:

- `~/.claude/skills/peekmyagent-control/SKILL.md`
- `~/.claude/commands/peekmyagent.md`
- `~/.claude/commands/peekmyagent-status.md`
- `~/.claude/commands/peekmyagent-pause.md`
- `~/.claude/commands/peekmyagent-resume.md`
- `~/.claude/commands/peekmyagent-stop.md`
- `~/.claude/commands/peekmyagent-clear.md`

Inside Claude Code you can then run:

```text
/peekmyagent
/peekmyagent-status
/peekmyagent-pause
/peekmyagent-resume
/peekmyagent-stop
/peekmyagent-clear
```

Command meaning:

- `/peekmyagent`: open or print the dashboard URL.
- `/peekmyagent-status`: associate the current Claude Code session with the dashboard and print capture instructions.
- `/peekmyagent-pause`: keep forwarding requests but stop saving request bodies.
- `/peekmyagent-resume`: resume saving request bodies.
- `/peekmyagent-stop`: stop the current recording and keep existing captures.
- `/peekmyagent-clear`: stop and remove the current recording from the dashboard list.

Important: slash commands cannot retroactively change the environment of an already-running Claude Code process. For exact provider request capture, start or resume Claude Code through `pma claude ...`.

## Clear Or Uninstall

Shrink older stored traces without deleting sessions. This removes duplicate full raw request bodies when the same request can be reconstructed from block-cache blobs, then compacts the SQLite file:

```bash
pma compact
```

`pma compact` briefly stops the local dashboard daemon to avoid concurrent writes. The dashboard can be opened again with `pma open`.

Remove stored captured sessions after stopping the local daemon:

```bash
pma clear --all-sessions
```

Uninstall the `pma` / `peekmyagent` CLI, remove peekMyAgent-installed Claude Code helpers, and stop the daemon while keeping local capture data:

```bash
pma uninstall --keep-data
```

Uninstall the CLI, remove helpers, and delete peekMyAgent-owned local state:

```bash
pma uninstall --remove-data
```

If you installed from a cloned source tree, you can run the source uninstaller from that clone. It performs the same cleanup and then removes the global npm link:

```bash
node scripts/uninstall.mjs --keep-data
node scripts/uninstall.mjs --remove-data
```

`uninstall` removes the global CLI plus peekMyAgent-owned helpers and data. `--remove-data` deletes known peekMyAgent files such as the session store, viewer registry, IDE integration registry, and translation cache; it only removes the state directory when it becomes empty. It does not rewrite Agent provider configuration; future global proxy takeover adapters must provide their own explicit restore flow.

## Dashboard Layout

The dashboard has three main areas:

- Left sidebar: projects, sessions, live watches, and evidence packages.
- Center timeline: user inputs, Agent requests, assistant responses, tool calls, tool results, subagent flow, token usage, and collapsible summaries.
- Right raw panel: the original captured JSON body and normalized sections.

Useful buttons:

- `展开上行`: show the full upstream request area for one request.
- `System`: inspect system prompt blocks.
- `Tools`: inspect tool descriptions and schemas.
- `Tool calls`: inspect tool calls sent by the model.
- `Tool results`: inspect tool results returned to the model.
- `Response`: inspect captured model responses.
- `Raw`: inspect the original captured JSON.

If the source is a live Claude Code or OpenClaw watch, the bottom composer can send a message to the watched Agent:

- Press `Enter` to send.
- Press `Shift + Enter` for a new line.

## OpenClaw

Start OpenClaw through peekMyAgent:

```bash
pma openclaw agent --session-key agent:main:my-session --message "hello"
```

If no OpenClaw subcommand is passed, peekMyAgent runs:

```bash
openclaw --profile peekmyagent chat
```

OpenClaw integration uses an isolated `peekmyagent` profile instead of patching your main profile directly.

For more details, see [docs/openclaw-profile-watch.md](docs/openclaw-profile-watch.md).

## Demo Viewer

You can open built-in evidence packages without running a real Agent:

```bash
npm run demo:view
```

Or choose a specific demo:

```bash
node bin/peekmyagent.mjs dev view --demo openclaw-subagent --open
node bin/peekmyagent.mjs dev view --demo openclaw-multiturn --open
node bin/peekmyagent.mjs dev view --demo claude-subagent --open
node bin/peekmyagent.mjs dev view --demo claude-proxy-resume --open
```

This is useful for demos, screenshots, and UI review.

## Privacy And Safety

peekMyAgent is local-first, but captured data can still be sensitive.

Captured requests may include:

- User messages.
- System prompts and developer instructions.
- Tool descriptions and tool schemas.
- Tool results.
- File paths.
- Project context.
- Model parameters.
- Raw provider request bodies.

Recommendations:

- Start with a non-sensitive project when trying the tool.
- Do not share dashboard screenshots that include private code, secrets, or proprietary prompts.
- Exported Trace bundles are sanitized for common token/API-key patterns by default, but they can still include private prompts, code snippets, file paths, or tool output. Review exported files before sharing.
- Do not expose the local dashboard to the public internet.
- Use `/peekmyagent-pause` before entering sensitive content.
- Use `/peekmyagent-clear` when a recording should be removed from the local dashboard list.

## Troubleshooting

### `peekmyagent` command not found

Run this in the repository:

```bash
node scripts/install.mjs
```

Or use the direct path:

```bash
node /path/to/peekMyAgent/bin/peekmyagent.mjs open
```

### Port 43110 is already in use

First check what is already listening:

```bash
pma doctor
```

If it is your peekMyAgent daemon, restart it:

```bash
pma restart --print --no-open
```

If another app owns the port, either stop that app yourself or choose another port with `PEEKMYAGENT_DAEMON_PORT`.

### Claude Code says the selected model cannot be used

First verify Claude Code without peekMyAgent:

```bash
claude -p --output-format text "Reply OK"
```

If this fails, fix the provider/model configuration first.

If it works in your shell but fails from the dashboard composer, restart peekMyAgent from the same shell environment where your provider variables are available:

```bash
pma restart --print --no-open
```

On macOS/Linux, reload your shell profile first if your provider variables live there. On Windows, restart PowerShell or set the variables in that PowerShell session before running `pma restart`.

Then start Claude Code through the wrapper again:

```bash
pma claude -c
```

### Slash commands show a session but no new requests are captured

This usually means Claude Code was already running before peekMyAgent configured the provider base URL.

For exact capture, exit Claude Code and restart through peekMyAgent:

```bash
pma claude -r <session-id>
```

### Subagent requests look different from normal requests

Claude Code subagents can create child-agent requests with their own internal identifiers. peekMyAgent uses available request headers and trace hints to group those requests, but provider/model compatibility can still affect whether subagent calls succeed.

## Development Checks

Core release gate:

```bash
npm run release:check
```

Maintainers should follow the [release manual](docs/releasing.md) for exact-tag three-platform validation, first-package bootstrap, and npm OIDC trusted publishing.

Platform-specific release gates:

```bash
npm run release:check:linux
npm run release:check:macos
npm run release:check:windows
```

To print platform gates from another platform:

```bash
npm run release:check:linux:list
npm run release:check:macos:list
npm run release:check:windows:list
```

Useful deterministic smoke tests for focused local debugging:

```bash
npm run smoke:cli
npm run smoke:dashboard-open
npm run smoke:agent-send
npm run smoke:daemon-claude
npm run smoke:run-claude
npm run smoke:agent-trace-view
npm run smoke:timeline-display
```

Smoke tests that need real Claude Code, OpenCode, OpenClaw, Codex, provider access, or local credentials are listed separately in the [manual integration smoke matrix](docs/manual-integration-smoke-matrix.md). They are useful before a release, but they are not part of the deterministic release gate.

Run a syntax check on the dashboard client:

```bash
node --check src/viewer/client.js
```

## More Documentation

- [User guide](docs/user-guide.md)
- [Visual usage guide](docs/visual-usage-guide.zh-CN.md)
- [Current architecture](docs/architecture.md)
- [Refactoring roadmap](docs/refactoring-roadmap.md)
- [Roadmap](docs/roadmap.md)
- [Privacy and retention strategy](docs/privacy-retention-strategy.md)
- [Security and performance audit notes](docs/security-performance-audit.md)
- [Manual integration smoke matrix](docs/manual-integration-smoke-matrix.md)
- [Claude Code current-session control](docs/claude-code-current-session-control.md)
- [OpenCode CLI adaptation plan and evidence](docs/opencode-cli-adaptation-plan.md)
- [OpenClaw profile watch](docs/openclaw-profile-watch.md)
