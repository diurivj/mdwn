# Architecture deepening — confirmed design

The maintainer confirmed all twelve interview recommendations and the consolidated acceptance criteria, then requested a spec. This is the historical decision/evidence record; the [canonical approved spec](../../docs/architecture-deepening.md) is published through [local spec entry 43](issues/43-architecture-deepening-spec.md). Application implementation and implementation-ticket decomposition remain separate next steps.

Reference snapshot: `a827ab93596e58b7c140bd19b936cca4630d2a0b`.

## Selected candidates

1. **Publication lifecycle:** concentrate browser-owned candidate retention, state reconciliation and resumable Unpublishing behind the Publication module's interface.
2. **Import session orchestration:** concentrate preparation/open/upload/commit/cancellation and cleanup ordering behind the browser Import module's interface.
3. **Comment-dependent Hard deletion:** concentrate overlapping dependent selection and ordering while keeping each lifecycle owner's authorization, transaction markers and scheduling distinct.

Domain vocabulary comes from `CONTEXT.md`; architecture vocabulary is module, interface, depth, seam, adapter, leverage and locality.

## Confirmed decisions

The maintainer accepted all recommendations in interview round 1.

### Q1 — Behavior contract

- Preserve documented behavior, storage schemas and wire formats across all three refactors.
- Address an existing correctness gap only with explicit regression evidence.
- Keep new features and user-experience changes separate.
- Preserve the existing ADRs, including browser-held content keys, Owner-controlled Publications, parent-free File capabilities, D1 transactional enforcement, visible-atomic Import and fixed-cost constraints.

### Q2 — Publication scope

- Concentrate lifecycle coordination: retained Public-link candidates, overlapping reads, pending/error state and resumable Unpublishing.
- Keep existing cryptography, attribution and Publication request rules intact.
- Reduce protocol knowledge in UI callers; moving their code without reducing caller knowledge does not meet the goal.

### Q3 — Delivery

- Land separate reviewed PRs, starting with Publication, then Import, then Comment-dependent Hard deletion.
- Plan all three now, with separate tests and acceptance criteria.
- Do not invent blocking dependencies between otherwise independent work.
- The intended follow-up is a spec and self-contained local tickets, then implementation per ticket with Standards, Spec and separate RR8/stack review.

## Evidence retained from the architecture exploration

### Publication

- `app/tree/files-page.tsx:75–80,659–672` retains prepared Public links above the dismissible Publish panel.
- `app/publications/publish-panel.tsx:74–193` coordinates reads, candidate matching and teardown.
- `app/publications/publications-client.ts:169–237,413–486` prepares capabilities before a request may commit.
- `e2e/publications.spec.ts:131–249,391–470` covers lost responses, panel dismissal, competing candidates and bounded teardown.
- Relevant changes: `3ea6afa`, `4349145`, `f9c430a`.

### Import

- `app/import/import-control.tsx:183–246` owns stage ordering and cleanup.
- `app/shared/import/staging-client.ts:34–92` owns individual requests and retries.
- `tests/worker/import-staging.test.ts:160–186` assembles its own staging sequence rather than exercising the browser orchestration.
- Preserve the substantive planning and real Worker tests; add coverage for interrupted client orchestration rather than replacing different test promises.

### Comment-dependent Hard deletion

- `app/tree/tree.server.ts:904–1072` and `app/publications/publications.server.ts:1036–1176,1425–1442` know overlapping Comment-dependent graphs.
- `app/comments/public.server.ts:877–882` and `app/account/pseudonym-items.server.ts:4–16` already share individual delete shapes.
- Existing completeness, interrupted teardown and rollback coverage is substantial: `tests/worker/hard-deletion-completeness.test.ts`, `tests/worker/publication-lifecycle.test.ts`, `tests/worker/private-tree.test.ts`.
- This is a locality opportunity, not a claim that current deletion is incomplete.

## Publication lifetime facts

Verified against the reference snapshot; these are current behavior, not new design decisions.

- Prepared Public-link candidates survive closing/reopening the Publish panel: the map belongs to `FilesPage`, not the conditionally mounted panel (`app/tree/files-page.tsx:76–80,658–671`).
- Completed navigation from File A to File B creates a new map because the route keys `FilesPage` by File ID (`app/routes/file.tsx:35–36`). Leaving the route or fully reloading also makes the old candidates unavailable to the new UI; this does not promise immediate heap erasure.
- Successful same-File revalidation retains candidates: it preserves the route key and updates snapshot/status without resetting the map (`app/tree/files-page.tsx:124–152`).
- Closing the panel stops its browser teardown loop: cleanup marks the loop inactive and aborts its controller. This does not undo a committed Worker batch (`app/publications/publish-panel.tsx:122–146`).
- Reopening reloads authoritative state and resumes teardown when the Owner sees a Publication still in `deleting` (`app/publications/publish-panel.tsx:105–129`).
- Candidate retention and active work therefore have distinct existing lifetimes: File-page lifetime versus panel lifetime.
- The panel already shares pending/error/reload coordination across audience changes, author changes and Publication requests (`app/publications/publish-panel.tsx:149–169` and its call sites).
- Existing browser tests directly assert candidate survival after panel dismissal/lost responses, competing candidate reconciliation and bounded teardown progress. Candidate behavior across navigation/revalidation/reload and panel dismissal during teardown is code-derived, not directly asserted by the inspected tests. Tests were not run.

## Confirmed Publication ownership

The maintainer accepted both recommendations in interview round 2.

### Q4 — Implementation shape

- Use a browser-only lifecycle module with a small React adapter.
- The module owns asynchronous coordination; React renders its state and forwards decisions.
- Tests exercise the same interface with controlled response ordering.
- Add no state-management dependency.

### Q5 — Coordination ownership

- Author changes, Comment audience changes and Publication requests also use the module's pending/error/refresh coordination.
- Reuse their existing operations without changing cryptography or business rules.
- Avoid leaving a second coordination owner in the panel.
- Preserve the existing distinction between File-page-lived candidate retention and panel-lived active work described above.

## Confirmed Publication interface and testing

The maintainer accepted both recommendations in interview round 3.

### Q6 — Caller-facing decisions

- UI callers request specific Publication operations; do not expose a generic runner accepting arbitrary asynchronous callbacks as the module's interface.
- The module hides candidate retention, active-link matching, refresh ordering and teardown steps.
- Callers provide the person's choices, not the protocol sequence.
- Form inputs, confirmation rendering and clipboard interaction stay in React.

### Q7 — Test strategy

- Add focused deterministic lifecycle tests using an internal adapter seam for delayed responses, cancellation and failures.
- Tests cross the same module interface used by UI callers.
- Preserve existing real-browser and Worker tests for cryptography, authorization and persistence.
- Required lifecycle cases: lost responses retain the winning link; stale reads cannot replace newer state; panel dismissal/reopening retains candidates and resumes teardown; zero remaining Comments does not imply completion; navigation disposes the old File's lifecycle.

## Import protocol facts

Verified against the reference snapshot; these constrain outcome handling without authorizing protocol changes.

- The browser already knows the Import ID from the prepared plan before opening a session. The Worker uses that ID and rejects an already-existing ID; opening is not idempotent (`app/shared/import/staging-client.ts:34–40`, `app/import/staging.server.ts:335–354`).
- The current UI records its cleanup ID only after the open response resolves; a lost open response is therefore an important cleanup regression scenario. Unreachable staging still has the existing expiry cleanup fallback (`app/import/import-control.tsx:187–189,205–206`).
- Repeating commit for an already-committed session returns success without `entriesRevision`; repeating it for an open session attempts the commit. It is not a read-only status probe (`app/import/staging.server.ts:598–615`).
- The exposed Import routes offer no status-read operation (`app/import/staging.server.ts:1002–1014`).
- Cancellation acts only on an open session. It cannot undo a winning commit. The current browser cancellation helper ignores response status/body and suppresses thrown failures, so its resolution alone proves neither successful cancellation nor absence of commitment (`app/import/staging.server.ts:982–996`, `app/shared/import/staging-client.ts:85–92`).
- A successful commit acknowledgment proves commitment; a lost response or client abort does not prove that nothing committed. The current aborted UI path returns to idle (`app/import/import-control.tsx:205–211`).
- Chunk upload and commit retry once on thrown errors other than `ImportError`; HTTP failures and response parsing are not retried by that helper. It reuses the supplied signal but does not suppress the retry invocation after an abort. Open and cancellation have no explicit retry (`app/shared/import/staging-client.ts:34–92`).
- Follow-up inspection of `app/import/import-control.tsx:110–246` and all lifetime references confirms there is no unmount cleanup for Import execution: the only effect updates the drop-handler ref, the AbortController is created after plan preparation, and only the Cancel button aborts it. Disposing during preparation is therefore a separate regression scenario from cancelling an upload.
- No tests were executed. Possible correctness corrections still need regression evidence under Q1.

## Confirmed execution ownership

The maintainer accepted both recommendations in interview round 4.

### Q8 — Import execution scope

- Begin at the confirmed review, not a UI-assembled encrypted plan.
- The Import module coordinates replacement reads, signing, complete plan preparation, upload, commit and cleanup.
- Selection and collision choices remain in the UI; existing planning and encryption modules remain intact.
- No Import session opens before the complete plan passes validation.

### Q9 — Hard deletion execution ownership

- The shared module owns dependent selection and removal ordering, producing statements guarded by the caller's existing transaction marker.
- Authorization, transaction execution and scheduling remain with their existing owners.
- Atomic File/Directory deletion and sealed, bounded Unpublishing remain distinct.
- Add neither generic database cascades nor a shared deletion scheduler.

## Confirmed outcomes and domain scope

The maintainer accepted all three recommendations in interview round 5.

### Q10 — Uncertain Import outcome

- Retain bounded retries while the operation remains active; do not keep retrying indefinitely.
- If commitment remains unconfirmed, report uncertainty, refresh the target and tell the person to check before retrying.
- A refreshed Directory is not itself proof of this attempt's outcome.
- Never infer rollback from request cancellation, use commit as a read-only status probe, or automatically start a fresh Import.
- Add no status endpoint, schema change or wire-format change.

### Q11 — Import lifetime

- Cancellation or route disposal stops scheduling further execution stages, invalidates late UI results and attempts best-effort staging cleanup.
- In-flight browser computation may finish and be discarded; an in-flight Worker commit may still finish and cannot be undone by a client abort.
- Treat the missing disposal cleanup as a narrowly scoped correctness correction requiring regression evidence under Q1.
- Do not introduce cross-navigation background/resumable Import or persistent browser storage for the attempt.

### Q12 — Hard deletion scope

- Callers specify selected File scope or one Publication's Public-thread scope.
- The module hides dependent selection and ordering, not authorization or transaction ownership.
- Do not expose arbitrary table recipes or audience flags.
- Unpublishing must never select Private comment threads.

## Consolidated acceptance criteria — confirmed

These criteria operationalize the agreed decisions, not additional feature scope.

### Shared constraints and depth

- No new product features, endpoints, storage schemas, wire formats, cryptographic protocols, state-management dependencies or generic lifecycle/deletion frameworks.
- Existing privacy, authority, Free-tier limits, route placement and runtime separation remain intact. Browser-held capabilities never move into SSR, route submissions, logs or new persistent storage.
- Each UI or transaction caller loses protocol/dependent-graph knowledge; merely relocating code into a pass-through module does not establish depth.
- Tests cross the interface callers use and assert observable behavior. Keep existing tests for distinct cryptographic, authorization, privacy and persistence promises; retire redundant implementation-coupled tests only after equivalent behavior coverage exists.
- Preserve existing router loading, action and revalidation responsibilities. Browser cancellation does not substitute for Worker/D1 transaction enforcement.

### Publication lifecycle

- One browser-only module owns prepared candidates, active-link reconciliation, read ordering, pending/error/refresh coordination and bounded teardown sequencing. A small React adapter binds it to the existing UI; forms, confirmation rendering and clipboard interaction remain presentation work.
- All panel mutations use the same coordination owner while their existing cryptographic and business-rule operations remain unchanged.
- Preserve the lifetime matrix: closing/reopening the panel retains candidates but stops/restarts active panel work; successful same-File revalidation retains candidates; another File, leaving the route or a full reload creates a fresh lifecycle. Do not promise immediate heap erasure.
- Retain every potentially winning prepared link before its request can commit. A lost response, reopened panel or competing attempt cannot replace the winning capability with a losing candidate.
- Stale reads and results from an inactive/disposed lifecycle cannot replace current UI state. Revalidation supplies current access/context without discarding same-File candidates.
- Unpublishing remains sealed and Owner-resumable; finish only when the existing protocol reports `done`, not when the Comment count reaches zero.
- Add deterministic interface tests for response ordering, lost acknowledgments, overlapping candidates, dismissal/reopening, final teardown completion, revalidation and disposal. Preserve existing real-browser and Worker tests, including fragment privacy and Owner-only management.

### Import session orchestration

- One confirmed review drives replacement reads, signing, complete plan preparation, staging, commit and cleanup through the module's interface. Preserve the existing source/review/planning/crypto implementations and keep selection/collision choices in the UI.
- Complete validation and encryption planning precede opening a session. Invalid preparation opens no session and uploads nothing.
- Preserve the browser-known Import ID before the open response arrives so a lost acknowledgment can still lead to best-effort cleanup; retain expiry cleanup as a fallback. Do not turn non-idempotent opening into an automatic retry.
- Retries reuse the exact prepared chunk bytes and the same Import identity. Preserve bounded retry behavior while active; cancellation/disposal must not schedule another upload/commit attempt or fresh plan.
- Explicit protocol rejections remain distinct from ambiguous transport outcomes. Existing conflict/expiry behavior and fresh review requirements remain in force; never silently adjust collisions or import a subset.
- Acknowledged commitment succeeds even when an idempotent reply omits `entriesRevision`; refresh through the existing UI/router path while its context remains active.
- Lost commit responses or cancellation racing a commit cannot be reported as proof that nothing was imported. Expose an unconfirmed outcome when the protocol cannot establish the result, refresh the target while mounted and give check-before-retry guidance. Never delete committed Files as cancellation cleanup.
- Cancellation/disposal during preparation, opening, upload or commit stops further stages and invalidates late UI callbacks. Best-effort cleanup cannot mask the original outcome or claim guaranteed deletion of staging after a network failure.
- Add deterministic interface tests for preparation rejection, lost open response, exact-byte chunk retry, failed cleanup, abort during preparation/upload, disposal before commit, commit-response loss and a commit winning cancellation. Add focused real-browser/Worker regression evidence where a correctness gap is changed; preserve visible-atomic, shared-target, Replace/Publication-pairing and existing cross-engine coverage.

### Comment-dependent Hard deletion

- The shared module accepts domain scope and produces ordered removal statements guarded by the existing transaction marker. Callers no longer enumerate the overlapping Comment-dependent graph.
- Selected File scope removes its relevant Private/Public Comment dependents; Publication scope selects only its Public thread. Existing authorization and selected-graph checks remain with the transaction owners.
- Preserve atomic bounded File/Directory deletion, over-cap refusal without mutation, irreversible Publication sealing, existing teardown batch limits and the final completion step. Do not replace these with one scheduler or generic database cascades.
- Keep broader File/Publication/Share/Grant lifecycle work with its existing owner when it is not Comment-dependent. Unrelated Files, threads and surviving access paths must remain unchanged.
- Cover reports, staged Pseudonym update items, retained audience epochs, Key envelopes, Historical Comment metadata and relevant sharing/Key rotation staging as applicable to each scope; preserve explicit foreign-key-safe ordering.
- Verify through the existing migrated D1 adapter in workerd, not mocked SQL or a new database adapter. Exercise both caller-used deletion scopes with rich dependent graphs and failure injection; assert resulting records/authorization, not only generated SQL text.
- Retain `SELF.fetch` checks for authorization, suspension-independent deletion, sealed-route denial, interruption/resumption, over-cap refusal and rollback. A failed guard or late dependent failure must not partially remove the selected graph.

## Verification and delivery

- Application source and relevant tests were inspected during design; application tests have not been executed in this interview. Current edits are documentation only.
- Implement with regression-first slices for any correctness corrections, followed by focused Node/Worker/browser checks appropriate to each module. Shared portable modules must obey the existing `app/shared/` TypeScript convention; do not weaken project discovery rules for tests.
- Each candidate gets separate acceptance evidence, Standards/Spec review and a separate RR8/stack result. Follow the repository's full local preflight, issue-branch, PR and current-head CI requirements at implementation completion.
- Execution order is Publication, Import, then Comment-dependent Hard deletion. This is prioritization, not a fabricated dependency graph; split tickets further only where a real blocking dependency or independently verifiable slice requires it.
- The maintainer confirmed this shared understanding and requested the durable spec, now published as local spec entry 43. Next: decompose it into self-contained implementation tickets. Exact exported types/file allocation can be specified within the agreed seams; do not treat them as permission to expand scope.

## Domain documentation

The `Import session` definition in `CONTEXT.md` now distinguishes successful cancellation before commit from an existing Import commit marker. No new domain concept is introduced, and no existing ADR is reopened; a new ADR is unwarranted for this clarification.
