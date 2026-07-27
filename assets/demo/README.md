# Demo Media Assets

This directory stores public-facing README and launch media.

Current files:

- `dashboard-overview.png`: clean latest-UI screenshot with a provider-native Protocol view open.
- `dashboard-overview-annotated.png`: annotated map of sessions, the tool loop, Protocol evidence, and qualified namespace leaves.
- `dashboard-overview-tour.gif`: latest-UI tour of navigation, tool flow, Protocol, namespace expansion, and lazy payloads.
- `chat-upstream-context.gif`: Protocol-order and namespace-tool walkthrough.
- `chat-upstream-context.png`: poster frame for the Protocol/namespace walkthrough.
- `tool-call-loop.gif`: linked tool-call/result plus text/image lazy-loading walkthrough.
- `tool-call-loop.png`: poster frame for the lazy-result walkthrough.

Storyboards:

| Media | One question it answers | Ordered scenes | Total duration |
| --- | --- | --- | --- |
| `dashboard-overview-tour.gif` | What can I understand from one local trace? | Select a trace -> follow the tool loop -> inspect provider-native protocol -> expand namespace leaves -> keep large payloads lazy | 17 seconds |
| `chat-upstream-context.gif` | How does PMA preserve and explain tool protocol? | Open Protocol -> compare declared/added stages -> distinguish containers from callable leaves -> inspect leaf schemas | 14 seconds |
| `tool-call-loop.gif` | How can I inspect a large tool loop without loading everything? | Link calls and results -> read placeholder metadata -> load a result on demand -> keep images local until opened | 14 seconds |

Reproduce the non-sensitive trace locally:

```bash
node scripts/readme-media-demo.mjs --port 43112
```

Capture the documented Browser states into `tmp/readme-media-frames/`, then rebuild annotations and GIFs:

```bash
python3 scripts/build-readme-media.py
```

Guidelines:

- Use non-sensitive demo sessions only.
- Keep each GIF focused on one workflow.
- Prefer one clear claim per frame and 2.8-3.8 seconds per annotated state; reading frames need more time than navigation frames.
- Keep each walkthrough between 12 and 18 seconds, with a single product question and a visible beginning-to-end story.
- Keep the 1280×720 source ratio; README renders it responsively.
- Try to keep each GIF under 8MB when practical.
