# Viewer UI/UX Redesign

Status: active implementation plan  
Branch: `codex/viewer-uiux-redesign`  
Design context: [PRODUCT.md](../PRODUCT.md), [DESIGN.md](../DESIGN.md)

## Objective

Rebuild the Viewer as a calm, high-density Agent Trace observatory without changing
capture semantics, evidence provenance, translation behavior, persistence, or
adapter contracts.

The redesign is successful when a first-time user can understand a normal chat,
tool loop, and subagent flow from the center timeline, while an expert can reach the
exact upstream or downstream evidence in one action.

## Baseline Audit

Representative trace: Claude Code, 84 request/response pairs, three observed
subagents. Baseline viewport: 1440 x 900.

Measured pane allocation:

| Region | Width | Observation |
| --- | ---: | --- |
| Session navigation | 292px | Metadata and project chrome compete with titles. |
| Main timeline | 646px | Primary task receives less than half the viewport. |
| Evidence inspector | 490px | Consumes one third of the viewport even when empty. |

The first loaded page rendered 32 request cards and 318 buttons. The timeline already
has strong semantic projection and progressive loading, but the presentation exposes
too many equally weighted controls.

### What already works

- Clear three-pane mental model with resizable and collapsible panes.
- Mature evidence contracts and exact/reconstructed provenance.
- Progressive timeline loading for large traces.
- Search, translation, raw inspection, and multi-harness adapters.
- Keyboard-operable resizers and extensive deterministic Viewer tests.

### Primary problems

1. **The supporting panes overpower the story.** The main timeline is too narrow at
   common laptop and desktop widths.
2. **Weak hierarchy inside events.** Borders, cards, chips, and metadata carry
   similar visual weight.
3. **Control inflation.** Repeated outlined buttons and badges make request content
   harder to scan.
4. **Fragmented component language.** Similar actions use slightly different sizes,
   weights, hover treatments, and radii.
5. **Card nesting.** Request, response, tool, summary, and detail surfaces frequently
   stack containers inside containers.
6. **Evidence mode is visually detached.** The right pane is powerful but feels like
   a separate JSON application rather than the detail view for the selected event.
7. **Multi-agent comprehension remains costly.** The graph exposes evidence but does
   not yet make ownership, parallelism, and return flow effortless to understand.
8. **Responsive behavior protects panes more than the user's primary task.**

## Information Architecture

### Left: Locate

- Harness selector
- Project groups
- Session title and state
- Import, archive, rename, delete, and project-level actions

Do not repeat trace-level analytics here.

### Center: Understand

- Session identity and compact status
- Search and meaningful filters
- Turn-by-turn causal timeline
- Inline multi-agent overview attached to the parent turn
- Optional send composer

This is the primary task surface.

### Right: Verify

- Selected event identity and provenance
- Upstream or downstream evidence sections
- Search, original/translation mode, copy, and refresh
- Structured summary plus exact raw representation

The right pane answers “show me the proof”, not “repeat the timeline”.

## Delivery Phases

### Phase 1: Foundation

- Introduce a complete design-token layer.
- Normalize typography, spacing, controls, focus states, and semantic colors.
- Rebalance pane defaults and compact the application chrome.
- Preserve existing DOM contracts where tests depend on them.

### Phase 2: Navigation and shell

- Simplify session rows and project groups.
- Make the top bar a compact session command surface.
- Add skeleton and empty states that preserve geometry.
- Verify collapse and resize behavior at desktop breakpoints.

### Phase 3: Causal timeline

- Replace nested-card rhythm with a unified event grammar.
- Clarify turn headers and tool-loop storytelling.
- Reduce repeated metadata and action weight.
- Keep exact request and response evidence one action away.

### Phase 4: Evidence inspector

- Unify sticky navigation, search, translation, and provenance.
- Improve structured/raw mode hierarchy.
- Make the empty inspector yield space or provide an immediately useful state.
- Keep large raw trees performant.

### Phase 5: Multi-agent and advanced flows

- Rework the branch overview around ownership, parallel execution, and return flow.
- Attach child evidence to the parent turn without hiding chronological order.
- Validate slash commands, compaction, harness injection, and imported traces.

### Phase 6: Hardening

- Chinese and English layout checks.
- 1280px, 1440px, 1728px, 200% zoom, and reduced-motion checks.
- Keyboard navigation and contrast audit.
- Real large-trace performance and scroll-position checks.
- Focused Viewer smokes, then the host release profile at the final checkpoint.

## Acceptance Scenarios

1. **Normal chat:** identify user input, reasoning availability, final answer, and
   exact evidence.
2. **Tool loop:** follow model tool request, harness result, and final response with
   no ambiguity about direction.
3. **Multi-agent:** identify parent request, each child, parallel order, completion,
   and returned result.
4. **Large trace:** first useful content appears quickly; searching and opening the
   inspector do not freeze or reset position.
5. **Translation:** original and target-language content remain clearly paired and
   searchable.
6. **Provenance:** exact, reconstructed, inferred, and translated content cannot be
   mistaken for one another.
7. **Pane behavior:** collapsing or resizing a pane reallocates useful space without
   stale geometry or hidden controls.

## Non-goals

- Replacing the zero-dependency Viewer with a frontend framework.
- Changing capture, storage, or adapter evidence semantics.
- Turning the Viewer into a monitoring or aggregate analytics dashboard.
- Shipping a decorative dark theme as part of this redesign.
