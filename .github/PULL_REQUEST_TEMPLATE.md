## What & why

Briefly: what does this change and why. Link the issue or `docs/` section.

## Checklist

- [ ] `npm run build` passes
- [ ] `npx vitest run` is green (added/updated tests for the change)
- [ ] New reason codes registered in the exit-code map and `docs/17 §3`
- [ ] No direct `.team/` state writes outside `writeJsonStateAtomic`
- [ ] The event-ledger append remains the commit point (no half-written state on failure)
- [ ] CHANGELOG.md updated under Unreleased
