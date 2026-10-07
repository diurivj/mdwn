# 46: Import session module owns confirmed-review execution

**What to build:** A browser module owns execution from the confirmed Import review through replacement reads, signing, complete encrypted plan preparation, session opening, chunk upload, commit and cleanup. The Import control keeps selection, target choice and collision controls and becomes an adapter that reports progress and outcomes; it no longer assembles the staging sequence. Behavior is preserved: invalid preparation opens no session and uploads nothing; retries stay bounded and reuse exact prepared bytes and the Import identity; the browser retains the known Import ID before the open response arrives; explicit conflict/expiry/authority rejections keep their fresh-review behavior.

**Type:** refactor

**Status:** ready-for-agent

**Blocked by:** None (can start immediately).

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 1–13, Import acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Q8, Import protocol facts). This is the second of the spec's three separately reviewed changes.

- [x] One module owns the confirmed-review execution path and the attempt's abort/lifetime; callers provide the confirmed review, not staging steps.
- [x] Preparation completes replacement reads, signing, validation and complete encryption planning before any session opens. Invalid or nonconforming preparation opens no session, uploads nothing, and never imports a valid subset or rebuilds a different plan.
- [x] The browser-known Import ID is retained before the open acknowledgment. A lost acknowledgment leads to best-effort cleanup using that ID and never an automatic open retry; expiry cleanup remains the fallback.
- [x] Chunk retries reuse identical prepared bytes and the same Import identity. Retry stays at the existing single automatic retry at eligible failure points while the attempt is active — no indefinite polling, fresh encryption, new sessions or silent conflict repair.
- [x] An acknowledged commit refreshes the active view through its existing revalidation path. Explicit stale-target, Grant, Owner, expiry and revision responses keep their existing fresh-review behavior.
- [x] Staging and Replace visibility remain all-or-nothing, and target-Owner assignment, Historical Comment and paired Publication behavior are unchanged.
- [x] Deterministic tests cross the module interface with controlled outcomes at one internal operations seam: preparation rejection, lost open acknowledgment with cleanup, exact-byte chunk retry, and cleanup ordering. The tests exercise production orchestration, not a separate test-only open/upload/commit sequence.
- [x] Existing source/review/plan/codec Node tests, Worker staging tests (pre-commit invisibility, retry identity, target owner, atomic Replace/Publication pairing, Historical Comments, expiry) and browser preflight flows are retained and pass.
- [x] Before/after evidence shows the Import control no longer names staging stages.
- [ ] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import control under `app/import/`; the execution module belongs in `app/shared/import/` beside the existing shared planning, source, review and staging modules, which the Node test target already compiles (`docs/testing.md`).
- Keep the substantive source, review, planning and cryptographic implementations; do not flatten them into orchestration or move selection/collision choices out of the UI.
- No new endpoint, schema, wire format or background/resumable Import feature.
- Exact exported names and file allocation fit the agreed seams without reopening scope.

## Comments

- 2026-10-06: Published from the approved spec (43). Behavior-preserving extraction; the agreed Import correctness corrections are tickets 47 and 48, which depend on this module.
- 2026-10-07: Implemented on `issue/46-import-session-execution-module` at `e85d3d1`. `ImportExecution` (`app/shared/import/execution.ts`) owns everything after a settled review: replacement reads, device signing, complete `prepareImportPlan` validation/encryption, session opening, chunk upload, the single automatic retry at eligible failure points, the commit and best-effort cleanup. `app/import/import-operations.ts` binds it to the existing browser reads and one-request staging transport; `import-control.tsx` now only settles the review, constructs the attempt and renders progress/outcome. The browser-known `plan.importId` is retained before `openSession`, so a lost open acknowledgment cleans up with that ID and never reopens the session; the acknowledgment must echo the plan ID. The chunk/commit retry moved from `staging-client.ts` into the module so each transport call is one exact request. Before/after: the control went 600 → 553 lines and from 18 staging-name references to zero (`prepareImportPlan`, session/chunk/commit/cancel calls, replacement reads and signers all gone).
- 2026-10-07: Evidence: 11 focused Node tests through `ImportExecution` with controlled operations outcomes (preparation rejection at both the reads and the plan-validation stage, lost open ack with cleanup using the plan ID and exactly one open call, exact-byte/same-identity chunk retry, commit retry, protocol rejection without retry, cleanup failure not masking the primary failure, cancellation cleanup, acknowledged commit without `entriesRevision`, and no cleanup when no session could exist). `npm test` passed (288 Node + 374 Workers, including the retained import source/review/plan/codec, Worker staging and shared-target suites); `npm run typecheck` and Biome passed; the Chromium `import-preflight` spec passed 5/5.
- 2026-10-07: Reviews on `main...4a5a428`: **Standards: Pass** with the earlier judgement calls addressed (signer contract moved beside `PrepareImportPlanOptions`, precise `ImportUploadProgress` name, documented outcome null/cancel semantics, open-ack identity check); one non-exhaustive test index noted in `docs/import.md` ("Verification seams" already omitted `tests/import-staging.test.ts`). **Spec: Pass** — no code gaps; preparation-before-open ordering, ID retention/cleanup and bounded retry verified; the retry-after-abort and unconfirmed-commit corrections remain untouched for tickets 47/48. Separate **RR8/stack: Pass** on the same diff — browser-only private-fetch flow, no route/loader/action/Worker/D1 boundary changed, revalidation stays on the existing `revalidator.revalidate()` path, and Worker import proofs remain green. The final checkbox stays unticked until `npm run verify` and current-head `CI` are green at the PR.
