## Summary

What changed?

## Validation

- [ ] Deterministic release gate or focused smoke tests passed.
- [ ] Manual integration smokes are listed separately when this depends on real Claude Code, OpenClaw, Codex, provider access, or local credentials.
- [ ] Cross-platform assumptions are documented or tested.
- [ ] No secrets, private captures, local evidence bundles, or personal paths are committed.

## Documentation And Demo Impact

- [ ] I inspected the read-only `Documentation impact` Job Summary for this PR.
- [ ] For local verification, I ran `node scripts/documentation-consistency-audit.mjs --base <base SHA> --target HEAD --json` for user-visible CLI, Viewer, capture, protocol, privacy, or Harness changes.
- Required documents (Chinese first; include English fact parity when listed):
- Required demo Sources or frames:
- If no documentation update is needed, evidence that UI copy, interaction, protocol facts, and public behavior are unchanged:
- Documentation handoff target SHA:

## Capture Boundary

If this changes an agent adapter or provider config path:

- What does peekMyAgent read or write?
- How does the user stop or restore capture?
- Which test proves cleanup or restore behavior?
