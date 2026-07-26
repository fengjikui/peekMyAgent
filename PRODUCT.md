# Product

## Register

product

## Users

peekMyAgent serves people who want to understand how coding-agent harnesses actually
work:

- developers debugging a Claude Code, Codex, OpenCode, or OpenClaw session;
- harness engineers comparing context assembly, tool protocols, and compaction
  behavior;
- agent researchers and maintainers investigating regressions or preserving a trace
  as reproducible evidence;
- curious power users learning from real prompts, messages, tools, subagents, and
  model responses.

They usually arrive with a concrete question, a suspicious request, or a long trace.
They need to move quickly from the conversation story to the exact evidence without
losing their place.

## Product Purpose

peekMyAgent is a local-first Agent Trace observatory. It captures or imports the
complete evidence available for a coding-agent session, then turns that evidence
into a navigable causal story.

Success means a user can answer all three questions without reading an entire raw
payload:

1. What happened in this turn?
2. Why did the harness or model do that?
3. Where is the exact source evidence?

The product must preserve source fidelity and provenance while making large,
multi-turn, multi-agent traces comfortable to inspect.

## Brand Personality

**Precise, calm, humane.**

The interface should feel like a well-made scientific instrument: trustworthy under
scrutiny, quiet during long sessions, and satisfying because every control behaves
predictably. It can have character, but never at the expense of the evidence.

## Anti-references

peekMyAgent must not become:

- a dark security-operations dashboard full of glowing charts and alarm colors;
- a marketing-style SaaS page with hero metrics, oversized headings, or decorative
  cards;
- terminal cosplay that makes structured information harder to scan;
- a raw JSON viewer with a thin timeline bolted on;
- a metrics-first analytics dashboard where counts overpower the request story;
- a different visual language for every supported harness.

Avoid card nesting, chip soup, decorative gradients, novelty controls, gratuitous
motion, and color used without semantic meaning.

## Design Principles

### Story first, evidence one gesture away

The timeline explains the causal sequence. Exact upstream and downstream evidence
must remain available in the inspector without replacing the story.

### Dense, never cramped

Use compact information design to keep related events visible together. Density
must come from alignment, typography, and progressive disclosure, not tiny text or
crowded borders.

### Provenance is a product feature

Exact capture, semantic reconstruction, inference, translation, and cached content
must remain visibly distinguishable. Never make inferred structure look like wire
evidence.

### Stable space preserves understanding

Pane resizing, opening the inspector, filtering, and expanding long content should
not unexpectedly move the user's point of reference. Preserve scroll position and
spatial continuity.

### One grammar, harness-specific vocabulary

Claude Code, Codex, OpenCode, and future harnesses share one interaction and visual
grammar. Adapter-specific concepts keep their native names and evidence semantics.

### Delight through fluency

The rewarding feeling should come from fast loading, excellent search, useful
defaults, precise hover and focus feedback, and details appearing exactly when
needed. Decoration is not a substitute for fluency.

### Local trust is visible

Privacy boundaries, capture mode, live status, and destructive actions should be
clear at the moment they matter, without turning every screen into a warning page.

## Accessibility & Inclusion

- Target WCAG 2.2 AA for text, focus states, keyboard operation, and semantics.
- Never use color as the only carrier of role, status, or evidence confidence.
- Respect reduced-motion preferences and avoid motion that is required to understand
  a state change.
- Keep the interface usable at 200% zoom and with long translated labels.
- Support Chinese and English UI copy as equal first-class layouts.
- Preserve native browser controls and familiar interaction patterns where they
  improve assistive-technology support.
