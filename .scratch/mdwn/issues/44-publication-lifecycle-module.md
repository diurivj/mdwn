# 44: Publication lifecycle module owns candidate retention, reconciliation and teardown

**What to build:** A browser-only Publication lifecycle module owns the coordination currently spread across the Files page, the Publish panel and the browser operations: retaining every prepared Public-link candidate for the File page's lifetime, matching the usable complete link to the authoritative active link, ordering overlapping state reads, and driving resumable Unpublishing teardown to final completion. UI callers stop supplying prepared-link callbacks, refresh generations and teardown steps; they render the module's state and forward the person's decisions. Publish, rotate, unpublish and teardown resumption execute through the module.

**Type:** refactor

**Status:** ready-for-agent

**Blocked by:** None (can start immediately).

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Publication implementation decisions, lifetime matrix, Publication acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Q4–Q7). This is the first of the spec's three separately reviewed changes.

- [ ] One module owns prepared-link retention, active-link matching, read ordering, the panel/File-page lifetime split and teardown sequencing. Publish and rotate no longer take a caller-supplied prepared-link callback, and the Files page no longer holds the candidate map.
- [ ] A candidate is retained before its request can commit. A lost response, a reopened panel or a losing later attempt cannot replace a winning complete link.
- [ ] The displayed complete link matches authoritative active-link identity; a failed or superseded candidate is never presented as the active Public link.
- [ ] An older active-state read cannot supersede newer state — in particular a delayed read arriving after Unpublishing.
- [ ] Closing the panel stops scheduling and aborts cancellable panel work while retaining candidates. Reopening reloads authoritative state and resumes teardown while the Publication is still deleting.
- [ ] Successful same-File revalidation retains candidates and uses current access/context. Another File, leaving the route or a full reload disposes the old lifecycle and rejects its late UI results.
- [ ] Teardown finishes only when the existing protocol reports final completion, not when remaining Comments reach zero. Immediate sealing and Owner-only resumption are unchanged.
- [ ] Complete Public links remain in browser memory only — no new persistent store, route submission, log or server-visible bearer secret.
- [ ] The React adapter keeps form inputs, confirmation rendering and clipboard interaction; the coordination module carries no React dependency and is instance-scoped, not global.
- [ ] Focused deterministic tests cross the same module interface production callers use, with controlled responses at one internal operations-adapter seam: lost responses retaining the winning link, competing candidates, delayed reads after Unpublishing, close/reopen during teardown with resumption, final completion after the zero-Comments batch, same-File revalidation, and disposal on navigation/reload.
- [ ] Existing real-browser Publication scenarios and Worker publication/privacy tests are retained and pass, including Owner/Collaborator permission checks, Public-participation policy behavior and Public-link fragment privacy.
- [ ] Before/after evidence shows caller knowledge decreased: neither the Files page nor the Publish panel names candidates, refresh generations or teardown steps.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Publication browser client and panel under `app/publications/`; the Files page under `app/tree/`.
- The coordination module belongs in the Node-visible shared layer (for example `app/shared/publications/`): `tsconfig.node.json` compiles `app/shared/**/*.ts`, while `app/publications/publications-client.ts` is feature-local and not Node-testable (`docs/testing.md`). The module must not import feature-local or Worker-only modules; the production operations adapter that wraps `publications-client.ts` stays in `app/publications/`.
- Author changes, Comment audience changes and Publication requests keep their existing panel coordination until ticket 45 unifies them; this ticket must not make that intermediate state worse.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43) as the first implementation ticket, per the confirmed delivery order Publication → Import → Comment-dependent Hard deletion.
