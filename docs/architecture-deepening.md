# Architecture deepening: Publication, Import and Comment-dependent Hard deletion

Approved design, synthesized from the maintainer's twelve confirmed interview decisions and final acceptance confirmation. The three changes preserve the product contract while reducing the knowledge required at each module's interface.

Reference application snapshot: `a827ab93596e58b7c140bd19b936cca4630d2a0b`.

## Problem Statement

Publication management, Import and Hard deletion already perform substantial work correctly, but their callers must understand too much of that work's sequencing and lifetime.

For an Owner, a lost Publication response or overlapping read must not lose the usable Public link or show obsolete state. Today, candidate retention, active-link matching, request ordering and Unpublishing progress are coordinated across the Files page, Publish panel and browser operations. Repeated fixes have required changes across those locations.

For an importing Account, interrupted work must not become duplicate work, misleading success or a false promise of cancellation. The Import UI currently coordinates preparation, session creation, chunk upload, commit and cleanup while lower-level browser operations own retries. Its execution controller does not cover preparation or route disposal. A lost commit response is particularly important: the existing protocol cannot always tell the browser whether the Import committed.

For an Account deleting content, every relevant dependent record must disappear without damaging unrelated content. File/Directory Hard deletion and Publication teardown already have distinct, intentional transaction and scheduling rules, but both callers know overlapping Comment-dependent graphs. Sharing individual delete shapes has not concentrated the selection and ordering of the larger graph.

The maintenance problem is limited locality: understanding or changing one lifecycle requires following its protocol across callers. The goal is greater depth at the existing domain seams, not fewer files or a wholesale rewrite.

## Solution

Deepen three domain-specific modules in separately reviewed changes:

1. **Publication lifecycle:** one browser-only module owns candidate retention, reconciliation, asynchronous ordering and management progress; a small React adapter connects it to the existing UI.
2. **Import session orchestration:** one browser module owns execution from a confirmed review through preparation, staging, commit and cleanup, with explicit handling of unconfirmed outcomes.
3. **Comment-dependent Hard deletion:** one shared module owns domain-scoped dependent selection and ordered removal statements inside the existing callers' authorized transactions.

The person continues to use the same Files, Publish and Import flows. Existing cryptography, authorization, storage schemas, wire formats, limits and privacy promises remain unchanged. The narrowly approved correctness work prevents further Import stages after cancellation/disposal and avoids presenting an unconfirmed commit as a definite non-commit; it must be supported by regression evidence.

Success is visible at the callers: UI callers no longer coordinate protocol steps, and deletion callers no longer enumerate the overlapping Comment-dependent graph. Each module offers more leverage through its interface, and maintenance and verification gain locality.

## User Stories

### Publication lifecycle

1. As an Owner, I want publishing to use the existing saved File and cryptographic rules, so that restructuring the browser code does not change what becomes public.
2. As an Owner, I want the complete Public link retained before a publishing request can commit, so that a lost response does not lose the capability for a successful Publication.
3. As an Owner, I want closing and reopening the Publish panel to retain prepared link candidates, so that panel dismissal does not discard a potentially committed Public link.
4. As an Owner, I want every potentially winning candidate retained when attempts overlap, so that an earlier winning request can still be reconciled after a later attempt loses.
5. As an Owner, I want the displayed complete link matched to the current active link, so that a failed or superseded candidate is never presented as usable.
6. As an Owner, I want older state reads prevented from replacing newer state, so that a delayed active-state response cannot reverse the UI's view of Unpublishing.
7. As an Owner, I want link rotation to preserve the existing Publication and eligible Comment history, so that lifecycle deepening does not change the cryptographic rotation contract.
8. As an Owner, I want author changes and Comment audience changes to share coherent pending, error and refresh handling, so that the Publish panel does not have competing coordination owners.
9. As a Collaborator, I want Publication requests to retain their existing request and cancellation rules, so that shared coordination does not grant Publication-management authority.
10. As an Owner, I want Unpublishing to keep its irreversible confirmation and immediate seal, so that no public access returns during interrupted cleanup.
11. As an Owner, I want teardown progress to continue until the final completion acknowledgment, so that zero remaining Comments is not mistaken for removal of all public material.
12. As an Owner, I want closing the Publish panel to stop that panel's browser work, so that retaining link candidates does not silently introduce hidden background teardown.
13. As an Owner, I want reopening a still-deleting Publication to reload authoritative state and resume cleanup, so that an interrupted teardown remains usable without restoring public access.
14. As an Account, I want successful same-File revalidation to retain prepared candidates, so that refreshing route data does not discard the current page's capabilities.
15. As an Account, I want navigation to another File, leaving the route or a full reload to start a fresh Publication lifecycle, so that old File state cannot update the new view.
16. As an Account, I want complete Public links kept only in the existing browser-memory scope, so that this refactor creates no new persistent or server-visible bearer-secret store.

### Import session orchestration

17. As an importing Account, I want selection and collision choices to remain in the existing review flow, so that the refactor does not change how I choose an Import target or resolve Name collisions.
18. As an importing Account, I want confirmation to execute exactly the reviewed Import, so that a later UI change cannot silently substitute a different target or plan.
19. As an importing Account, I want replacement reads, signing and complete plan validation to finish before a session opens, so that invalid preparation uploads nothing.
20. As a Collaborator importing into an eligible Directory, I want existing target authority and target-Owner assignment preserved, so that Import does not create new sharing or ownership authority.
21. As an importing Account, I want safe chunk retries to reuse the exact prepared bytes and Import identity, so that a lost response does not duplicate records or produce a mismatched replay.
22. As an importing Account, I want retries to remain bounded, so that a failing operation does not keep making requests indefinitely.
23. As an importing Account, I want the browser to retain the known Import ID before receiving the open response, so that it can attempt cleanup after a lost acknowledgment without opening another session automatically.
24. As an importing Account, I want cancellation during preparation to prevent later staging, so that finishing an already-running browser calculation does not start an Import I stopped.
25. As an importing Account, I want cancellation or route disposal to stop scheduling further upload and commit stages, so that abandoned UI work does not keep advancing the protocol.
26. As an importing Account, I want late progress and results excluded from a disposed or superseded view, so that an old attempt cannot overwrite the current UI.
27. As an importing Account, I want cleanup attempted without masking the original result, so that a second network failure does not replace the useful explanation of what happened.
28. As an importing Account, I want a confirmed commit treated as success even when its idempotent response omits an optional listing revision, so that a successful retry is not misclassified as failure.
29. As an importing Account, I want an unconfirmed commit reported honestly, so that I am not told nothing was imported when the Worker may have committed it.
30. As an importing Account, I want the target refreshed and check-before-retry guidance when the outcome remains unconfirmed, so that I can inspect the latest Files before deliberately starting another Import.
31. As an importing Account, I want cancellation racing a commit distinguished from confirmed cancellation, so that stopping a browser request is not presented as rollback.
32. As an importing Account, I want stale target, authority or revision responses to preserve existing rejection and fresh-review behavior, so that the browser never silently adjusts collisions or retries a changed plan.
33. As an importing Account, I want staging and Replace visibility to remain all-or-nothing, so that interrupted work never exposes a partial hierarchy or prematurely replaces a File.
34. As an importing Account, I want existing Historical Comment and paired Publication behavior preserved, so that orchestration deepening does not change the contents or authority of a valid Import.

### Comment-dependent Hard deletion

35. As an Account authorized to delete a File, I want its applicable Private and Public Comment dependents removed with it, so that deleting content leaves no retained application-level Comment graph.
36. As an Account authorized to delete a bounded Directory subtree, I want its complete selected graph removed atomically, so that I never receive a partially deleted hierarchy.
37. As an Account attempting an over-cap Directory deletion, I want the existing refusal to leave everything unchanged, so that this refactor does not expand the deletion envelope.
38. As an Owner unpublishing a File, I want only the Publication's Public thread selected, so that my File and its Private comment thread remain intact.
39. As an Owner, I want reports, attributions, staged Pseudonym update items and applicable Historical Comment metadata removed with their selected Comment context, so that secondary records do not survive their subject.
40. As an Owner, I want retained Comment audience epochs and their applicable Key envelopes and staging dependents removed in the correct order, so that teardown leaves neither orphaned material nor foreign-key failures.
41. As an Account, I want unrelated Files, threads and surviving access paths left unchanged, so that shared deletion logic cannot widen an authorized scope.
42. As an Account, I want a failed authorization/transaction guard or late dependent-removal failure to leave the attempted atomic batch unchanged, so that deeper composition does not weaken rollback.
43. As an Owner, I want interrupted Unpublishing to stay sealed and resume in its existing bounded batches, so that sharing dependent-removal knowledge does not merge distinct scheduling rules.
44. As an Account under a Public-participation suspension, I want existing Hard deletion and Unpublishing rights preserved, so that the refactor does not turn an abuse restriction into retained-content lockout.

### Maintainability and verification

45. As a maintainer, I want callers to express Publication decisions rather than supply arbitrary asynchronous recipes, so that sequencing knowledge stays inside the module.
46. As a maintainer, I want Import callers to provide the confirmed review rather than assemble staging steps, so that retries, cancellation and cleanup can be understood and verified together.
47. As a maintainer, I want deletion callers to express domain scope rather than table recipes, so that a dependent-graph change has one implementation owner.
48. As a maintainer, I want deterministic tests through the same browser module interfaces that production callers use, so that rare ordering and failure cases are reproducible without testing private helpers.
49. As a maintainer, I want real-browser and real-D1 coverage retained for their distinct promises, so that convenient test adapters cannot conceal integration, authorization or privacy regressions.
50. As a maintainer, I want these changes delivered independently with explicit acceptance evidence, so that a risky refactor does not require one combined release or invent dependencies between unrelated modules.

## Implementation Decisions

### Shared constraints

1. Treat this as three behavior-preserving deepening changes, with only the explicitly agreed, regression-backed Import correctness corrections. Do not bundle new product features or cosmetic UI redesign.
2. Preserve existing ADRs and domain meanings. Browser-held content keys, Owner-controlled Publication management, parent-free File capabilities, visible-atomic Import, explicit Hard deletion and fixed-cost deployment remain constraints.
3. Introduce no schema migration, endpoint, wire-format change, cryptographic protocol change, state-management dependency, alternate database adapter or generic lifecycle/deletion framework.
4. Preserve native router loading, mutation and revalidation responsibilities, public SSR shells, browser-only private data and the existing separation between portable, browser and Worker code. Client cancellation is not transaction enforcement.
5. Use the existing browser operations and D1 integration wherever possible. New internal seams exist only to support real variation in execution or deterministic failure scheduling, not hypothetical future consumers.
6. An acceptable refactor removes protocol or dependent-graph knowledge from callers. Merely moving functions behind an equally complicated interface, or reducing file counts without gaining depth, does not satisfy this spec.

### Publication module

1. Use a browser-only lifecycle module with a small React adapter. The module owns asynchronous coordination; React renders its state and forwards the person's decisions.
2. Expose specific Publication operations rather than a generic runner accepting arbitrary asynchronous callbacks. Callers must not coordinate prepared-link callbacks, active-link matching, refresh generations or teardown steps.
3. Route all panel mutations through the same pending/error/refresh coordination, including author changes, Comment audience changes and Publication requests. Reuse their current cryptographic and business-rule operations unchanged.
4. Keep form inputs, confirmation rendering and clipboard interaction in React. Moving coordination does not move complete Public links into router submissions or server-visible state.
5. Preserve separate candidate-retention and active-work lifetimes:

   | Event | Prepared candidates | Active panel work |
   | --- | --- | --- |
   | Close Publish panel | Retained for the current File page | Stop scheduling work and abort cancellable requests |
   | Reopen Publish panel | Reuse retained candidates | Reload authoritative state; resume teardown if still required |
   | Successful same-File revalidation | Retained | Use current access/context; prevent stale results from replacing current state |
   | Another File, leaving the route or full reload | Fresh lifecycle; no recovery from new storage | Dispose the old lifecycle and reject its late UI results |

6. Retain every potentially winning prepared link before its request can commit. Do not replace a candidate collection with a single latest candidate: an earlier request can win after a panel is reopened or a later attempt fails.
7. Derive the usable complete link by matching a retained candidate to authoritative active-link identity. Never present a failed or superseded candidate as the active Public link.
8. Keep browser-memory ownership instance-scoped rather than global. Disposal prevents later use by a new view; it does not promise immediate heap erasure or recall of a copied Public link.
9. Preserve ordering rules across initial load, explicit refresh, mutation completion, mutation failure and teardown completion. An older active-state read cannot supersede newer deleting/completed state; old activation results cannot update a reopened or different lifecycle.
10. Preserve immediate Publication sealing, Owner-only resumption, existing batch limits and irreversible teardown. The browser finishes only after the existing protocol reports final completion, not merely when the remaining Comment count reaches zero.

### Import module

1. Begin orchestration at the confirmed review. The module coordinates replacement reads, signing, complete encrypted plan preparation, opening, chunk upload, commit and cleanup; callers do not assemble these stages.
2. Keep local selection, target choice and collision controls in the UI. Retain the substantive source, review, planning and cryptographic implementations rather than flattening them into orchestration.
3. Execute the reviewed target and choices as one attempt. Invalid or nonconforming preparation opens no Import session and uploads nothing; do not automatically import a valid subset or rebuild a different plan.
4. Retain the browser-generated Import ID before the open response arrives. Opening is not idempotent under the existing protocol: do not add an automatic open retry when the response is lost. Use the known ID for best-effort cleanup where applicable, with existing expiry cleanup as the fallback.
5. Reuse exact prepared chunk bytes and the same Import identity on retry. Preserve the existing bounded retry behavior—at most its current one automatic retry at eligible chunk-upload/commit failure points—while the attempt remains active. Do not expand retry into indefinite polling, fresh encryption, automatic new sessions or silent conflict repair.
6. Give preparation and every later stage one coherent attempt lifetime. Cancellation or route disposal stops scheduling subsequent stages and retry attempts, invalidates late UI results and attempts best-effort cleanup. An in-flight browser calculation may finish and be discarded; an already-sent Worker request may still commit.
7. Distinguish cleanup from rollback. Cleanup can remove unreachable staging but must never delete committed Files to simulate cancellation. A cleanup request that fails, loses its response or returns without establishing cancellation must not be treated as proof of non-commit.
8. Keep outcome handling evidence-based:

   | Evidence | Required handling |
   | --- | --- |
   | Preparation fails before any session-open attempt | Preserve safe local failure detail; state that nothing was uploaded |
   | Existing protocol gives an explicit, non-ambiguous rejection | Preserve the applicable conflict, expiry, authority and fresh-review behavior |
   | Commit is acknowledged, including idempotent success | Treat the Import as committed; an optional listing revision is not required for success |
   | A commit may have run but its result remains unconfirmed | Report uncertainty; do not claim success, rollback or that nothing was imported |
   | Cancellation is requested while commit may already be in flight | Stop further client work, but classify the outcome from evidence rather than the abort itself |

9. If bounded retries cannot establish commitment, expose an unconfirmed outcome, refresh the target through the existing router/UI path while that context remains active, and tell the person to inspect the latest Files before retrying. A refreshed Directory is not itself proof of this attempt's outcome. Do not start another Import automatically.
10. Do not use commit as a read-only status probe. Repeating commit can commit an open session; the existing protocol exposes no status-read operation. Add neither a status endpoint nor a persistent recovery mechanism in this work.
11. Never let cleanup failure mask the primary outcome. Preserve explicit stale-target, Grant, Owner, expiry and revision handling; changed circumstances require the existing fresh review rather than automatic collision adjustment or replay of newly encrypted material.
12. Success refreshes the active view through its existing revalidation path. Disposed or superseded attempts cannot deliver progress, success or refresh callbacks to a new view.
13. Preserve Import bounds, shared-target ownership, all-or-nothing visibility, staged Replace behavior, paired Public representation updates and Historical Comment semantics. No Worker commit or storage protocol redesign is authorized by this spec.

### Comment-dependent Hard deletion module

1. Accept domain scope: selected Files, or one Publication's Public thread. Do not expose arbitrary table lists, caller-authored dependent-removal recipes or audience-selection flags.
2. Own the applicable dependent selection and removal ordering, producing statements guarded by the caller's existing transaction marker. Every dependent mutation must remain conditional on the authorized operation winning its guard.
3. Leave authorization, selected-graph validation, transaction execution and scheduling with their existing owners. The module does not authorize a deletion or open its own independently committing transaction.
4. Preserve two distinct execution contexts: atomic File/bounded-Directory deletion, and immediately sealed Unpublishing with bounded Comment batches followed by final cleanup. Share graph knowledge, not a scheduler.
5. File scope includes its relevant Private and Public Comment dependents. Publication scope selects only that Publication's Public thread; it cannot remove the File's Private comment thread.
6. Preserve explicit, foreign-key-safe removal of the applicable reports, Comments, thread attributions, staged Pseudonym update items, retained Comment audience epochs, Key envelopes, Historical Comment metadata and sharing/Key rotation staging. Existing small helpers may become implementation details where that improves locality; do not delete substantive behavior or replace it with cascades.
7. Keep broader File, Publication, Share and Grant lifecycle work with its current owner when it is not Comment-dependent. Unrelated Files, threads, staging and surviving access paths remain unchanged.
8. Preserve the existing 500-node Directory deletion limit, no-mutation over-cap refusal, 200-Comment Unpublishing batch limit, Owner-only teardown resumption and final completion step. Do not introduce a per-record request/transaction loop or a larger operational envelope.
9. Keep privacy-sensitive foreign keys restrictive and deletion explicit. A failed marker guard or late dependent failure cannot leave a partially applied atomic batch. Earlier successfully committed Unpublishing batches remain deleted and the Publication remains sealed if a later batch fails.
10. Use the current Drizzle/D1 adapter and migrated workerd test environment. A generic repository or alternative-database adapter is not justified by this work.

## Testing Decisions

### Agreed seams and test quality

The maintainer confirmed these seams during the design interview and final acceptance review; no additional seam-selection interview is required.

1. **Publication:** test through the caller-used browser lifecycle interface, with controlled asynchronous responses at one internal operation/transport adapter seam. Keep the real-browser and Worker entry-point tests for the assembled flow.
2. **Import:** test through the caller-used confirmed-review execution interface, with controlled outcomes at its internal operation/transport adapter seam. Keep existing source/review/plan/codec tests and real-browser/Worker Import flows.
3. **Hard deletion:** prefer the existing authorized Worker routes as the highest seam exercising each deletion owner and the shared module. Supplement with real-D1 module integration tests for atomic storage invariants and failure injection where route coverage cannot isolate the invariant; do not introduce test-only production routes.

These are three different domain modules, not justification for a common lifecycle framework. Existing public seams stay in place. Internal test seams must not become extra protocol knowledge in production callers.

A good test:

- crosses the interface used by a real caller and asserts observable state, results, requests or persisted effects;
- deterministically controls ordering and failure rather than relying on sleeps, retries of a flaky test or incidental timing;
- survives changes to private helper structure;
- does not inspect hidden lifecycle state or assert only a particular SQL string;
- does not fake the authorization, encryption or D1 behavior that its test claims to prove.

Focused browser-coordination tests may use a deterministic test adapter instead of the production browser-operation adapter. That does not replace existing real cryptographic, browser-storage, route, privacy or D1 tests. Keep independently valuable tests; remove redundant implementation-coupled tests only after equivalent behavior coverage exists at the caller-used interface.

### Publication acceptance evidence

- Exercise successful publish/rotation plus lost responses after real commitment in the existing browser flow.
- Prove the winning complete link survives panel dismissal and a later losing attempt; candidates must be retained before any request can commit.
- Delay older reads past newer responses, especially active-state reads arriving after Unpublishing, and assert that visible state and teardown progress do not regress.
- Close/reopen during teardown, verify resumption from authoritative state and require final completion after the zero-Comments batch.
- Verify same-File revalidation retains candidates and uses current context; another File, route disposal and full reload create a fresh lifecycle with no late updates from the old one.
- Cover shared pending/error/refresh coordination for audience, author and Publication-request operations without changing their business rules.
- Retain Owner/Collaborator permission checks, Public-participation policy behavior and Public-link-fragment privacy assertions.

Prior art includes the existing browser scenarios for lost publish responses, collapsed panels, competing prepared candidates and observable bounded teardown, plus Worker coverage for sealed Publications, authorization and idempotent final completion.

### Import acceptance evidence

- Reject invalid preparation before session creation or any upload; preserve complete-plan bounds and no-subset behavior.
- Lose the open acknowledgment and verify best-effort cleanup uses the browser-known ID without automatically reopening the session.
- Lose a chunk response and verify retry reuses identical bytes and identity without duplicate logical records.
- Cancel or dispose during preparation, opening, upload and commit; assert that no later stage/retry is scheduled, late UI results are ignored and any cleanup remains best effort.
- Verify cleanup failure does not mask the primary result or become a false cancellation acknowledgment.
- Lose commit acknowledgments, including an in-flight commit winning a cancellation race; assert unconfirmed-outcome handling where the protocol cannot establish the result, rather than a claim of non-commit.
- Acknowledge an already-committed attempt without the optional listing revision and verify success plus active-context revalidation.
- Retain explicit conflict/expiry/authority handling and fresh review requirements; verify no automatic fresh plan, new session, collision repair or subset Import follows a failure.
- Retain real Worker proofs of pre-commit invisibility, atomic Replace/Publication pairing, target-Owner assignment, exact-byte idempotency, mismatched replay failure and cleanup; preserve cross-engine browser Import coverage.

Prior art includes the existing source/review/plan/codec tests, staging and shared-target Worker tests, and browser preflight-to-commit flows. The focused orchestration tests must exercise production orchestration rather than reproduce a separate test-only open/upload/commit sequence.

The disposal and outcome corrections require regression evidence before changing behavior. This spec records source-derived risks; it does not claim those new tests have already run or passed.

### Hard deletion acceptance evidence

- Exercise both File and Directory removal with rich Private/Public Comment graphs, and Publication-only removal with a Private thread that must survive.
- Cover reports, staged Pseudonym update items, retained public and Collaborators-only epochs, applicable envelopes, Historical Comment metadata and relevant sharing/Key rotation staging.
- Include unrelated Files, threads and access paths in fixtures and prove they remain unchanged.
- Fail the transaction guard and inject a late dependent-removal failure; verify the attempted atomic batch leaves the selected graph, parent state and proof/authority effects unchanged as required by its existing contract.
- Preserve over-cap Directory refusal, suspension-independent deletion and real route authorization checks.
- Interrupt Unpublishing after a committed batch; prove all Public routes stay sealed, only the Owner can resume, remaining work stays bounded and final completion removes the selected public material without reviving it.
- Preserve restrictive foreign keys, explicit removal ordering and real-D1 rollback behavior; mock SQL execution is not sufficient evidence.

Prior art includes the existing rich hard-deletion completeness fixtures, public-report and Pseudonym-update dependent checks, sealed/interrupted Publication teardown tests, Directory-cap tests and injected late-failure rollback tests in workerd.

### Completion checks

Each independently delivered change must provide:

1. Before/after evidence that caller knowledge decreased at the chosen interface.
2. Focused test results for its affected module and regression cases, plus retained integration/privacy evidence appropriate to the change.
3. The repository's applicable lint, format, TypeScript, Node, Worker and cross-engine browser checks and full local preflight.
4. Separate Standards and Spec review results, followed by the RR8/stack gate against the same pinned diff.
5. Its issue-branch commit and PR, with current-head CI passing before merge under the repository's merge discipline.

Keep portable coordination tests within the documented runtime/source layout rather than weakening TypeScript project rules. Do not replace real workerd/D1 or browser tests with Node stand-ins. Preserve the existing deployed Import proof gate: any otherwise-approved change to staging schema, bounds or the Worker commit path must trigger its required proof; those changes are not part of this spec's planned scope.

## Out of Scope

- New product features or a redesigned Files, Publish or Import experience.
- New cryptography, capability formats, authorization policy, storage schemas, migrations, endpoints or wire formats.
- A new Import status endpoint, unbounded retry/polling, automatic conflict repair, automatic fresh Imports or cross-navigation/persistent Import resumption.
- Recalling a completed Import through cancellation, deleting committed Files as cleanup or guaranteeing rollback because a browser request was aborted.
- Keeping Public-link candidates beyond the existing File-page lifetime, persistent bearer-secret storage, or hidden Publication teardown after the panel closes.
- Rewriting author attribution, Publication-request rules, Public Comment reading/pagination or the underlying source/review/planning algorithms.
- A shared generic lifecycle engine, state-management dependency, deletion scheduler, generic repository, alternative database adapter or generic foreign-key cascade.
- Changing Directory deletion caps, teardown batch limits, Import bounds or the Free-tier deployment commitment.
- General cleanup of neighboring modules, operational D1 restoration, unrelated bugs, or a single combined implementation PR.

## Further Notes

### Delivery

Implement Publication first, then Import, then Comment-dependent Hard deletion, each as a separately reviewed change. This is prioritization, not a blocking dependency between all three. Ticket decomposition may introduce real blocking edges within a candidate, but must not manufacture cross-candidate dependencies for convenience.

This document is the canonical approved specification. The local tracker entry publishes it as `ready-for-agent`; implementation tickets are a separate next step. The design discussion confirmed the interfaces' responsibilities, lifetime rules, test seams and acceptance criteria, not exact exported type names or file allocation. Those details must fit the agreed seams without reopening scope.

### Domain and architecture records

The Import session definition now distinguishes successful cancellation before commit from an existing Import commit marker. A browser abort is not proof of domain cancellation. This clarification introduces no new domain concept and reopens no ADR; a new ADR is unwarranted.

Primary local references:

- [Domain vocabulary](../CONTEXT.md)
- [MVP buildable specification](buildable-spec.md)
- [Publication protocol and lifetime behavior](publications.md)
- [Import protocol and operational proof](import.md)
- [Testing across runtimes and browsers](testing.md)
- [Serving and security model](serving-and-security.md)
- [Confirmed design decisions and pinned source evidence](../.scratch/mdwn/architecture-deepening-design.md)
- ADRs for [content privacy](adr/0001-end-to-end-content-privacy.md), [Workers and D1](adr/0002-cloudflare-workers-and-d1.md), [client-held keys](adr/0003-client-held-content-keys-and-capabilities.md), [Owner-controlled sharing](adr/0004-owner-controlled-sharing.md), [abuse controls](adr/0005-privacy-preserving-abuse-controls.md), [visible-atomic Import](adr/0006-visible-atomic-staged-imports.md) and [parent-free File capabilities](adr/0008-parent-free-file-capabilities.md).

During design, application code and relevant existing tests were inspected, but no application tests were executed. The source snapshot and recorded evidence are a starting point, not a substitute for rechecking the actual implementation branch or producing the required regression results.
