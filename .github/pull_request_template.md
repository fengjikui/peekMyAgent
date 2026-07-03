## Summary

What changed?

## Validation

- [ ] Deterministic release gate or focused smoke tests passed.
- [ ] Manual integration smokes are listed separately when this depends on real Claude Code, OpenClaw, Codex, provider access, or local credentials.
- [ ] Cross-platform assumptions are documented or tested.
- [ ] No secrets, private captures, local evidence bundles, or personal paths are committed.

## Capture Boundary

If this changes an agent adapter or provider config path:

- What does peekMyAgent read or write?
- How does the user stop or restore capture?
- Which test proves cleanup or restore behavior?
