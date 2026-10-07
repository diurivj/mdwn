# 45: Unify all Publish panel mutations under the Publication lifecycle module

**What to build:** Author changes, Comment audience changes and Publication requests stop using the panel's own pending/error/reload coordination and run through the lifecycle module created in ticket 44, so the panel has no second coordination owner. Their existing cryptographic and business-rule operations are reused unchanged; form inputs, confirmation rendering and clipboard interaction stay in React.

**Type:** refactor

**Status:** done

**Blocked by:** 44 (Publication lifecycle module owns candidate retention, reconciliation and teardown) — this ticket extends that module and removes the panel coordination it leaves in place.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Publication implementation decision 3, acceptance evidence for shared pending/error/refresh); `.scratch/mdwn/architecture-deepening-design.md` (Q5).

- [x] Author declaration/removal, Comment audience changes, Publication request/withdrawal, and the Owner's publish/rotate/unpublish requests share one pending/error/refresh coordination owned by the module.
- [x] The panel no longer calls a local busy/message/reload wrapper or drives refresh ordering for those operations.
- [x] Cryptographic and business-rule behavior is unchanged: same requests, same error codes and messages, same authority checks, same Public-participation suspension behavior, same clipboard and confirmation interactions.
- [x] Stale or late results from a disposed or superseded lifecycle cannot update the current panel.
- [x] Focused deterministic tests cover shared pending/error/refresh for audience, author and Publication-request operations, including a failure path that must not replace newer state.
- [x] Existing real-browser Publication and public-comment scenarios still pass.
- [x] Before/after evidence shows the panel no longer coordinates these mutations.
- [x] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Publish panel and Publication browser client under `app/publications/`; the lifecycle module from ticket 44.
- Reuse the existing operations unchanged; do not move cryptography, attribution rules or Publication-request rules into the module.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43). Split from ticket 44 so the ordering/lifetime extraction can be reviewed on its own before the remaining mutation coordination is folded in.
- 2026-10-07: Implemented on `issue/45-publish-panel-mutations-unified` at `5f605c0` (PR #52). The panel's own `busy`/`message` state, AbortController lifetime, `run` wrapper, `loadFile` reads and `publications-client` imports are gone; audience, self/collaborator author, author removal, request and withdrawal all call lifecycle methods that share one `run` pending/error/refresh path. The operations adapter reuses the browser client's request bodies, fresh-`loadFile` identity check, error codes and fallback ordering unchanged; complete-link matching and the pasted-link fallback moved into the module (`linkFor`). Capability readiness is module state (`canOperate`), so `PublishPanel` takes only `{lifecycle, fileReady}` and FilesPage no longer passes the File context. Before/after: `publish-panel.tsx` net -99 lines (29 insertions / 128 deletions) and no longer names `busy`, `message`, `run` or any browser client function.
- 2026-10-07: Evidence: 22 focused Node tests through the lifecycle interface cover retained-vs-pasted link resolution, shared pending/error/refresh across all six mutations, a second mutation refused while one is pending, disposal rejecting late results, and a superseded failed refresh that cannot replace newer state. `npm test` (275 Node + 374 Workers), `npm run typecheck`, Biome and `npm run build` pass; the Chromium `publications` and `public-comments` specs pass (11/11) and `npm run verify` passed at `5f605c0` (all three engines, 374 browser tests). Reviews on `main...5f605c0`: **Standards: Pass** with two judgement calls addressed (named operations inputs, module-owned link fallback); **Spec: Pass** with test-coverage gaps for request/self-author mutations closed; separate **RR8/stack gate: first run caught the stale `retainedLinkFor` adapter call after the input rename — fixed — then Pass** on the amended diff. The final bullet stays unticked until current-head `CI` is green at PR #52.
- 2026-10-07: Merged as PR #52 at `58a3982`; current-head CI passed. Final checkbox closed.
