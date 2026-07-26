---
name: peekMyAgent
description: A quiet observatory for understanding coding-agent traces.
colors:
  canvas: "oklch(98.2% 0.004 255)"
  surface: "oklch(99.5% 0.002 255)"
  surface-subtle: "oklch(96.7% 0.006 255)"
  surface-raised: "oklch(100% 0 0)"
  ink: "oklch(24% 0.014 270)"
  ink-muted: "oklch(49% 0.014 270)"
  ink-faint: "oklch(64% 0.012 270)"
  line: "oklch(88.5% 0.009 260)"
  line-soft: "oklch(93.5% 0.006 260)"
  accent: "oklch(56% 0.2 258)"
  accent-soft: "oklch(94% 0.03 258)"
  response: "oklch(52% 0.12 155)"
  response-soft: "oklch(96% 0.025 155)"
  reasoning: "oklch(55% 0.13 302)"
  reasoning-soft: "oklch(96% 0.025 302)"
  tool: "oklch(57% 0.13 75)"
  tool-soft: "oklch(96% 0.03 75)"
  danger: "oklch(54% 0.19 27)"
  danger-soft: "oklch(96% 0.025 27)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.35
    letterSpacing: "0"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
rounded:
  xs: "3px"
  sm: "5px"
  md: "7px"
  lg: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 11px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px"
---

# Design System: peekMyAgent

## Overview

**Creative North Star: "The Quiet Observatory"**

peekMyAgent is a working instrument for reading complex evidence, not a dashboard
that performs complexity. The visual system uses a calm, lightly tinted canvas,
crisp white evidence surfaces, compact type, and restrained semantic colors. Long
sessions should remain comfortable while important state changes are immediately
legible.

The three panes have distinct jobs: the left pane locates a session, the center
explains the causal story, and the right pane inspects exact evidence. Their visual
weight must follow that order. The center pane is primary; the other panes support it
and can collapse without changing the product's mental model.

The system explicitly rejects card stacking, decorative chrome, oversized metrics,
custom ornamental scrollbars, and a terminal-themed dark interface.

**Key Characteristics:**

- compact, aligned, and readable at professional desktop densities;
- flat surfaces separated mainly by spacing and hairlines;
- semantic color reserved for interaction, evidence role, and status;
- stable pane geometry with responsive collapse behavior;
- consistent controls across every harness and every evidence section.

## Colors

The palette is a cool-neutral working surface with a precise cobalt interaction
accent and independent semantic hues for responses, reasoning, tools, and risk.

### Primary

- **Instrument Cobalt** (`oklch(56% 0.2 258)`): current selection, primary action,
  focus ring, active timeline marker, and links.
- **Cobalt Wash** (`oklch(94% 0.03 258)`): selected navigation rows and focused
  request context.

### Semantic

- **Response Green** (`oklch(52% 0.12 155)`): model-response identity and completed
  states, never generic decoration.
- **Reasoning Violet** (`oklch(55% 0.13 302)`): reasoning content and reasoning-only
  markers.
- **Tool Amber** (`oklch(57% 0.13 75)`): tool calls, results, and caution states.
- **Evidence Red** (`oklch(54% 0.19 27)`): destructive actions and verified errors.

### Neutral

- **Trace Canvas** (`oklch(98.2% 0.004 255)`): application background.
- **Evidence Surface** (`oklch(99.5% 0.002 255)`): primary reading surfaces.
- **Quiet Surface** (`oklch(96.7% 0.006 255)`): sidebars, controls, and secondary
  regions.
- **Graphite Ink** (`oklch(24% 0.014 270)`): primary text.
- **Hairline** (`oklch(88.5% 0.009 260)`): structural boundaries.

Color never acts alone. Every semantic hue is paired with a label, icon, shape, or
position.

### Appearance themes

Themes change the viewing environment, not the information grammar. Every theme
uses the same semantic role tokens for canvas, surfaces, ink, dividers, focus,
status, code, selection, and syntax. Feature CSS must consume those tokens instead
of introducing theme-specific selectors or literal light-only backgrounds.

- **Light** is the neutral reference theme for daylight work and screenshots.
- **Dark** is a low-luminance graphite workspace. It avoids pure black, preserves
  visible hairlines, and keeps semantic colors subordinate to evidence.
- **Studio** is a restrained blue-green editorial surface for long reading
  sessions. It changes temperature without turning the product into a branded
  color wash.
- **System** follows the operating-system appearance while preserving the same
  Light and Dark contracts.

All themes must retain visible keyboard focus, readable code and JSON syntax, and
distinguishable interactive states. Theme choice is a global user preference; it
must not alter capture data, provenance, layout ownership, or translation language.

## Typography

Use the native system sans stack for speed, familiarity, and correct rendering
across macOS, Windows, and Linux. Use the system monospace stack only for identifiers,
paths, payloads, timestamps, and code.

- Page title: 20px / 1.2 / 650.
- Section title: 15px / 1.3 / 650.
- Body: 14px / 1.55 / 400.
- UI label: 12px / 1.35 / 550.
- Dense metadata: 11px / 1.35 / 500.
- Raw and code: 12px / 1.55 / 400.

Do not scale type with viewport width. Use weight and spacing before introducing
another size. Prose content is capped near 72 characters per line where possible;
structured data may run wider.

## Elevation

The interface is mostly flat. Hierarchy comes from pane topology, surface tone,
spacing, and 1px hairlines.

- Sticky headers use one subtle ambient shadow only while content scrolls beneath.
- Popovers and menus may use a compact shadow plus a full border.
- Selected rows use background tint and focus outline, not lift.
- Request and response groups are not individually floated above the page.

## Semantic Ledger Grammar

The Viewer expresses ownership as a readable ledger, not as nested containers.
Choose the lightest sufficient signal in this order:

1. document order and shared alignment;
2. whitespace and indentation;
3. a 1px divider or vertical ancestry guide;
4. a compact role, status, or provenance marker;
5. a quiet tonal surface;
6. a full frame only when the region is independently interactive or must preserve
   an atomic payload.

A turn owns one primary rail. Requests, responses, tool exchanges, and internal
events are sibling rows on that rail. The evidence inspector uses an outline tree;
translation views use technical-document sections; multi-agent views use a branch
ledger. Code, JSON arguments, editable fields, menus, and the message composer may
retain frames because their boundaries carry operational meaning.

Do not add a second box merely to restate a relationship already communicated by
position, indentation, a divider, or a semantic marker.

## Components

### App shell

Three resizable panes with a center-first priority. Default desktop widths are
approximately 252px for sessions, a flexible center with a 640px practical minimum,
and 400-460px for evidence. At narrower widths, the evidence pane becomes an overlay
before the center timeline is allowed to become cramped.

### Buttons

Primary toolbar controls use a 30px height; dense inline actions use a 24-26px height.
Compact buttons use an 8px radius, normal-weight labels, and visible focus rings. Icon-only
controls are square, include tooltips, and use familiar symbols. Primary fill is
reserved for one dominant action in a local context.

Use the shared Lucide line-icon vocabulary for compact shell controls: `SunMoon` for
appearance, `Funnel` for filters, `ListEnd` for latest-turn mode, and
`ChartNoAxesColumn` for session statistics. A chevron appears only when the control
selects among options; commands and detail-panel triggers do not use one. Keep the
corner hierarchy stable: 8px for compact controls, 10px for floating panels, and 14px
for the user-message bubble. The softer geometry follows modern coding tools without
turning dense trace content into pill-shaped decoration.

Icon-only commands expose an immediate hover and keyboard-focus label. When the
evidence pane collapses, both real pane toggles join the toolbar grid instead of being
imitated by a guessed padding offset or placeholder. The remaining toolbar reflows from the right and stays
on one row whenever its available width permits.

### Tabs and filters

Tabs are a text-first horizontal rail with a selected underline or quiet tint.
Filters are compact segmented controls. Both remain stable when content scrolls.
Do not style every label as an outlined pill.

### Session rows

Rows emphasize title first, then one quiet metadata line. Live, pinned, imported,
exact, and reconstructed states use compact icons or short badges. Menus appear on
hover and focus without shifting the row.

### Timeline events

The center pane reads top-to-bottom as a causal story. User input, model output,
tool exchange, harness injection, and subagent events share one event grammar:

- sequence index and role;
- concise primary content;
- essential metadata;
- contextual actions aligned consistently;
- expandable detail only when needed.

Use tonal regions and small role markers rather than nested bordered cards.

### Evidence inspector

The section tabs, search, and original/translated switch remain sticky while the
inspector title scrolls away. The content area owns scrolling. Exact, reconstructed,
inferred, cached, and translated provenance is stated once near the inspector title
and repeated only when a block's provenance differs.

### Feedback states

Loading uses skeleton rows that preserve final geometry. Empty states explain the
next useful action in one sentence. Errors keep the failed context visible and offer
a direct retry where retry is safe.

## Do's and Don'ts

### Do

- Let the timeline dominate the visual hierarchy.
- Keep raw evidence reachable without forcing it into the main narrative.
- Align repeated metadata into predictable columns and baselines.
- Use whitespace to group related facts before adding another border.
- Preserve scroll position and pane proportions across ordinary interactions.
- Test every state in Chinese and English with realistic long content.
- Respect `prefers-reduced-motion` and visible keyboard focus.

### Don't

- Do not put cards inside cards.
- Do not turn all metadata or actions into rounded outline pills.
- Do not let an empty inspector permanently starve the center timeline.
- Do not use color as decoration or as the only status indicator.
- Do not introduce gradients, glass effects, glowing borders, or terminal cosplay.
- Do not hide evidence provenance behind a tooltip.
- Do not invent a different component vocabulary for each harness.
