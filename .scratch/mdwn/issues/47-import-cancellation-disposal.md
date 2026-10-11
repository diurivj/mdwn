# 47: Stop Import stages and retries after cancellation or disposal

**What to build:** Cancellation or route disposal gives an Import attempt one coherent lifetime: no later stage or retry is scheduled, late UI results are ignored, and best-effort cleanup is attempted without masking the original result. Cancellation during preparation must prevent later staging — today a browser calculation can finish and start an Import the person stopped — and route disposal currently has no cleanup at all. Regression evidence comes first: a failing test for each corrected behavior, then the fix.

**Type:** bug

**Status:** done

**Implementation:** complete — merged on `main` via PR #54 (merge `8a9d633`).

**Blocked by:** None — 46 is completed; its Import execution module owns the attempt lifetime.

**Related:** [43: Architecture deepening specification](43-architecture-deepening-spec.md); `docs/architecture-deepening.md` (Import implementation decisions 6–7 and 11, Import acceptance evidence); `.scratch/mdwn/architecture-deepening-design.md` (Import protocol facts, Q11). The spec requires regression evidence before changing this behavior.

- [x] Regression tests reproduce the current gaps first: cancellation during preparation, and route disposal during preparation, upload and commit, each showing that a later stage runs or late results land today.
- [x] After the correction, cancellation or disposal during preparation, opening, upload or commit schedules no subsequent stage or retry attempt. An in-flight browser calculation may finish and be discarded without starting an Import.
- [x] Late progress, success and refresh callbacks from a disposed or superseded attempt cannot reach a new view.
- [x] Cleanup is best effort: it never deletes committed Files to simulate cancellation and never claims guaranteed staging deletion after a network failure.
- [x] Cleanup failure cannot mask the original outcome or become a false cancellation acknowledgment.
- [x] Focused deterministic tests cover abort during preparation, upload and commit, and disposal before commit. Real-browser regression evidence is added where the behavior is user-visible.
- [x] Existing Import Worker, browser and preflight tests remain green. No new endpoint, schema, wire format, persistent attempt storage or cross-navigation/resumable Import behavior is introduced.
- [x] Before/after evidence shows the corrected lifetime at the module interface.
- [x] `npm run verify` passes; the change lands on its issue branch with a PR and current-head `CI` green before merge, with Standards/Spec review and a separate RR8/stack result on the same pinned diff.

## Scope and pointers

- The Import execution module from ticket 46 and its React adapter.
- A browser abort is not proof of domain cancellation: the distinction between successful cancellation before commit and an existing Import commit marker is the domain meaning recorded in `CONTEXT.md`.
- Preserve bounded retry behavior; do not expand it into polling or fresh sessions.

## Comments

- 2026-10-06: Published from the approved spec (43). One of the two narrowly approved Import correctness corrections, each requiring regression evidence before the behavior changes.
- 2026-10-08: Implementation on `issue/47-import-cancellation-disposal`, based on `c28d191`. Regression evidence preceded each correction: cancellation during replacement reads, signer acquisition and encrypted planning incorrectly returned `committed`; upload/commit cancellation made a second transport attempt; late open/upload acknowledgments advanced to commit; an abort during failed cleanup replaced the original `staging-changed` rejection with `cancelled`. Real Chromium regressions reproduced route-disposed preparation starting a new session, un-aborted opening/upload, a late real commit acknowledgment refreshing the new route, and the missing Cancel Import command during encrypted preparation. Logs are local `/tmp/mdwn-47-*-red-*.log` artifacts, not committed credentials or application data.
- 2026-10-08: `ImportExecution` now checks cancellation before/after preparation and staging boundaries, and before any bounded retry. The React adapter invalidates the attempt before route-disposal cancellation, cancels a superseded execution and guards progress/outcome delivery by attempt identity. Before/after at the module seam: held preparation resumes into `cancelled` with zero open/upload calls instead of `committed`; an aborted upload/commit has one request instead of two; a late open/upload acknowledgment triggers only best-effort cleanup, never another chunk or commit. Genuine commit acknowledgments remain successful, without deleting committed Files; uncertainty classification is still ticket 48.
- 2026-10-08: Focused evidence: 20 execution-module tests; 63 retained execution/source/review/plan/codec tests; 12 real-Workers staging/shared-target tests; 32 passing browser lifetime/preflight cases across Chromium, Firefox and WebKit (one existing synthetic WebKit drop skip). Browser cases include preparation cancellation, disposal at all four stages, late committed acknowledgment with no stale refresh, and a superseded attempt unable to clear newer success. Typecheck and Biome pass. Standards/Spec review, separate RR8/stack gate, full clean-tree `npm run verify`, and PR/CI/merge evidence are still pending; the final acceptance checkbox intentionally remains open.
- 2026-10-08: Final reviewed implementation is `ec3590a` (after `23e7542` and the review-nit/ticket reconciliation follow-up), pinned diff `c28d191...ec3590a`. **Standards: Pass** — zero hard findings or remaining heuristic nits; the shared Cancel Import action, `cancelAttempt`, test operation gate and cleanup predicate address all four initial judgement calls. **Spec: Pass** — zero missing/wrong/scope-creep findings, and stale-ticket corrections keep remaining work open. **Separate RR8/stack: Pass** on the same pinned diff: browser-only `ImportControl` → `ImportExecution` → device-proof staging transport → unchanged resource action/Worker/D1 boundary; native private `clientLoader`/public fallback and existing active-view `revalidator.revalidate()` remain intact. Disposal invalidates result delivery before abort, while a late genuine commit acknowledgment cannot refresh another route. Installed RR/adapter 8.4.0 types plus current client-data/fetcher/race-condition docs were checked; no new route, loader, action, server import, binding, schema or persistent store. Executed evidence includes real workerd routes and all three browser engines, not a claim that client abort rolls back D1.
- 2026-10-08: Full clean-tree `npm run verify` **passed at `ec3590a`**: lint/format, typecheck, namespace drift, 297 Node tests, 374 Workers tests, production Worker build, fresh-D1 migration smoke, local D1 export/restore round trip, client secret scan, and 392 passing Chromium/Firefox/WebKit browser cases (one existing synthetic WebKit-drop skip; no retries). The Mac mini runner was confirmed online and the CI workflow active before publication. The subsequent evidence commit changes only tickets; application/test code is the reviewed and verified `ec3590a` state. Current-head CI and merge remain delivery gates, so the compound final acceptance checkbox stays unchecked. Ticket 48's unconfirmed-commit presentation is not completed by this correction.
- 2026-10-11: Status reconciled to **done**: the reviewed and locally verified work merged on `main` via PR #54 (merge `8a9d633`, 2026-10-08) after current-head `CI` passed. This reconciliation changed only the stale `Status:`/`Implementation:` lines and the compound acceptance checkbox; application and test code are unchanged.
