# 45: Unify all Publish panel mutations under the Publication lifecycle module

**What to build:** Author changes, Comment audience changes and Publication requests stop using the panel's own pending/error/reload coordination and run through the lifecycle module created in ticket 44, so the panel has no second coordination owner. Their existing cryptographic and business-rule operations are reused unchanged; form inputs, confirmation rendering and clipboard interaction stay in React.

**Type:** refactor

**Status:** ready-for-agent

**Blocked by:** 44 (Publication lifecycle module owns candidate retention, reconciliation and teardown) — this ticket extends that module and removes the panel coordination it leaves in place.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Publication implementation decision 3, acceptance evidence for shared pending/error/refresh); `.scratch/mdwn/architecture-deepening-design.md` (Q5).

- [ ] Author declaration/removal, Comment audience changes, Publication request/withdrawal, and the Owner's publish/rotate/unpublish requests share one pending/error/refresh coordination owned by the module.
- [ ] The panel no longer calls a local busy/message/reload wrapper or drives refresh ordering for those operations.
- [ ] Cryptographic and business-rule behavior is unchanged: same requests, same error codes and messages, same authority checks, same Public-participation suspension behavior, same clipboard and confirmation interactions.
- [ ] Stale or late results from a disposed or superseded lifecycle cannot update the current panel.
- [ ] Focused deterministic tests cover shared pending/error/refresh for audience, author and Publication-request operations, including a failure path that must not replace newer state.
- [ ] Existing real-browser Publication and public-comment scenarios still pass.
- [ ] Before/after evidence shows the panel no longer coordinates these mutations.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Publish panel and Publication browser client under `app/publications/`; the lifecycle module from ticket 44.
- Reuse the existing operations unchanged; do not move cryptography, attribution rules or Publication-request rules into the module.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43). Split from ticket 44 so the ordering/lifetime extraction can be reviewed on its own before the remaining mutation coordination is folded in.
