# MVP acceptance suite and release-candidate gate

Ticket [33](../.scratch/mdwn/issues/33-mvp-acceptance-suite.md). This document
maps the buildable spec's acceptance criteria ([§12](buildable-spec.md#12-acceptance-criteria))
to the automated evidence in this repository and defines the release-candidate
gate. It is the index a reviewer or maintainer uses to decide whether a release
candidate is conformant; the linked suites remain the source of truth.

## Running the gate

A release candidate is a commit whose full gate has passed at that exact head.

```sh
# 1. Same checks CI runs at the PR head (typecheck, namespace drift, Node +
#    Workers tests, production build, fresh-D1 migration smoke, bundle-secret
#    check, Chromium/Firefox/WebKit browser suites).
npm run verify

# 2. Disposable remote Workers Free + D1 release gate. Provisions a throwaway
#    Worker and D1 on the signed-in Free account, applies the committed
#    migrations, seeds one device-bound Session, runs the remote proof, and
#    deletes everything again.
node scripts/import-proof.mjs

# 3. Migration-rollback posture on non-production data.
#    Follow docs/operations.md, "Migration rollback rehearsal".
```

CI is the merge gate: every job in the `CI` workflow must pass at the PR's
current head (`npm run verify` refuses a dirty tree or a branch behind
`origin/main` and does not replace green CI). The remote proof is required for
release candidates and whenever encryption-persistence schema changes — not for
every pull request; run it before tagging a release, and record the run in the
ticket/PR.

There is no end-to-end-security claim until an independent security review has
been completed; see [security-review.md](security-review.md).

## Acceptance evidence map

Test locations: `tests/*.test.ts` (Node unit), `tests/worker/*.test.ts`
(real `workerd` + D1 via `@cloudflare/vitest-plugin`), `tests/proof/*.test.ts`
(disposable remote Free deployment, not part of `npm test`), and
`e2e/*.spec.ts` (real built Worker in Chromium, Firefox, and WebKit).

### 12.1 Privacy and cryptography

| Criterion | Evidence |
| --- | --- |
| No private name, Markdown, front matter, Comment body, or displayed pseudonym reaches Worker/D1 plaintext | `tests/worker/acceptance-privacy.test.ts` seals a unique sentinel in every artifact, opens the stored ciphertext with browser-held capabilities, then sweeps every D1 table and every private/anonymous response for the sentinels. Per-feature ciphertext-shape checks remain in `private-tree`, `private-comments`, `public-comments`, and `signup-*` tests. |
| Passkeys cannot derive/decrypt content | `tests/worker/acceptance-privacy.test.ts` (no content envelope targets a passkey; the row stores only authentication material), `tests/signup-protocol.test.ts` (transcript has no content key), `tests/vault.test.ts` (client-generated key hierarchy). |
| Envelope contexts reject cross-purpose/object/epoch/malformed/downgrade attempts | `tests/enc-v1.test.ts`, `tests/grant-comment-keys.test.ts`, `tests/public-comment-content.test.ts`; `unexpected-epoch` is distinct from `stale-epoch` and fails closed (`tests/enc-v1.test.ts`, `tests/grant-comment-keys.test.ts`). |
| Nonce uniqueness across tabs/devices/retries/interrupted jobs | `tests/enc-v1.test.ts` ("burns a bounded sequence…", "never resumes a writer key domain…"); `e2e/enc-v1.spec.ts` (simultaneous tabs/devices, full browser restart). |
| Public fragments never reach requests/logs/errors/server state | `e2e/publications.spec.ts` (wire requests, cookies, console, all D1 tables), `tests/worker/publications.test.ts` ("never stores the fragment capability in any table"). |
| Anonymous routes never return private or Collaborators-only ciphertext/envelopes | `tests/worker/public-comments.test.ts` (anonymous epoch delivery), `tests/worker/publications.test.ts` (anonymous 404/current-only responses), `e2e/public-comments.spec.ts`. |

### 12.2 Authentication and abuse

| Criterion | Evidence |
| --- | --- |
| One-use fixed-difficulty proof of work + WebAuthn; replay fails | `tests/worker/signup-boundary.test.ts`, `tests/worker/signup-options.test.ts`, `tests/worker/webauthn-challenges.test.ts`, `tests/signup-protocol.test.ts`. |
| Exact rate-limit windows/scopes and generic failures | `tests/abuse-control-policy.test.ts` (policy table lockstep), `tests/worker/abuse-controls.test.ts` (rolling boundaries, scope independence, generic 429/503, global-first check). |
| Recovery-code consumption, set replacement, restricted session, global revocation, no override | `tests/worker/auth-recovery.test.ts`, `tests/worker/auth-lifecycle.test.ts`, `tests/worker/passkey-management.test.ts`, `e2e/auth-recovery.spec.ts`. |
| Signup bootstrap atomicity in all three browsers; no partial Account; no `crypto_jobs` | `e2e/signup.spec.ts`, `e2e/signup-integrity.spec.ts`, `tests/worker/signup-integrity.test.ts`, `tests/worker/registration-success.test.ts`, `e2e/support/signup-shape.ts` drift guard. |
| Signup rejects substituted key/transcript/challenge/replayed PoW/missing key/invalid binding | `tests/worker/signup-integrity.test.ts`, `tests/worker/signup-boundary.test.ts`, `e2e/signup-integrity.spec.ts` (missing persisted key mid-signup). |
| First private operation needs a current device proof; no unprovisioned signup Session | `tests/worker/signup-boundary.test.ts`, `tests/worker/device-lifecycle.test.ts`, `tests/worker/private-tree.test.ts` ("requires a live bound device proof…"). |
| Phrase gate blocks content creation/Import until verification | `tests/worker/private-tree.test.ts` ("keeps the signup recovery-confirmation gate ahead of any content-creating request"); `e2e/signup.spec.ts`. |
| Lost commit response rebinds by sign-in + Device proof; restart/eviction routes to recovery | `e2e/signup.spec.ts` ("a lost signup commit response…"), `e2e/signup-integrity.spec.ts`, `e2e/device-store.spec.ts`, `e2e/device-private-access.spec.ts` (missing/replaced/unreadable device → **Restore private access**). |
| Session idle/absolute expiry and passkey-linked revocation | `tests/worker/auth-lifecycle.test.ts`, `tests/worker/sessions.test.ts`, `tests/worker/passkey-management.test.ts`, `e2e/auth-sign-in.spec.ts`. |
| Raw IP/prohibited fields never persist | `tests/worker/abuse-controls.test.ts` (allowlisted Security events; no raw Session token), `tests/network-bucket.test.ts`. |
| Scheduled retention purge exercised | `tests/worker/retention.test.ts`, `tests/worker/abuse-controls.test.ts` (scheduled handler), `docs/operations.md`. |

### 12.3 Hierarchy, sharing, and concurrency

| Criterion | Evidence |
| --- | --- |
| Containment, root uniqueness, cycle prevention, node kind, entry/node agreement | `tests/worker/private-tree.test.ts` (D1 constraint and CAS tests), `tests/worker/private-tree-migration.test.ts`. |
| `mdwn/namespace-v1` byte fixtures in all engines + Worker; drift fails CI | `e2e/namespace-v1.spec.ts`, `tests/worker/namespace-v1.test.ts`, `tests/namespace-v1.test.ts`, `tests/namespace-v1-normalization.test.ts`, `npm run check:namespace`. |
| Unsafe segment/path boundaries; one-byte-over names; Unicode 17 conformance | `tests/namespace-v1.test.ts` contract vectors, `tests/import-source.test.ts`, `tests/archive.test.ts`, `tests/worker/private-tree.test.ts` (boundary vectors through the real create path). |
| Deterministic suffix placement, literal suffixes, folds, reservations, over-limit generated names | `tests/import-review.test.ts`, `tests/archive.test.ts`. |
| Same-revision two-client mutation: one commit, `409 namespace_changed`, no partial Import | `tests/worker/private-tree.test.ts` (create/delete/move/save winners), `tests/worker/import-staging.test.ts`, `e2e/tree-structure.spec.ts`. |
| Direct File Grants reveal no tree/path data | `tests/worker/shared-tree.test.ts` ("a direct File Grant exposes only the target representation…"), `tests/worker/file-capabilities.test.ts`. |
| Complete permission matrix; read-only Comment participation; direct-File structural denial | `tests/worker/effective-access.test.ts`, `tests/worker/private-comments.test.ts`. |
| Overlapping Grant union/revocation independent | `tests/worker/effective-access.test.ts`, `tests/worker/grant-expiry.test.ts`. |
| Revocation denies server access before rotation; new writes blocked until safe | `tests/worker/shared-tree.test.ts`, `tests/worker/key-rotation.test.ts`, `e2e/key-rotation.spec.ts`. |
| Conditional saves and paired Public updates; stale saves preserve the draft | `tests/worker/private-tree.test.ts`, `tests/worker/publications.test.ts` ("paired saves"), `e2e/editor-workspace.spec.ts` (stale conflict, overwrite). |
| Byte-exact source limits, 90% feedback, paste/composition rejection, `Cmd/Ctrl+S`, navigation warnings, legacy reduction, Import Replace | `e2e/editor-workspace.spec.ts`, `tests/worker/private-tree.test.ts` (512 KiB bound), `tests/import-plan.test.ts`. |

### 12.4 Publications and Comments

| Criterion | Evidence |
| --- | --- |
| Unknown/rotated/sealed paths return indistinguishable ciphertext-free 404 | `tests/worker/publications.test.ts`, `e2e/publications.spec.ts`. |
| Public pages expose only the current Public representation and allowed epochs | `tests/worker/publications.test.ts`, `tests/worker/public-comments.test.ts`, `e2e/public-comments.spec.ts`. |
| Audience transitions never disclose Collaborators-only history publicly | `tests/worker/public-comments.test.ts` ("never serves a Collaborators-only epoch…", "starts a fresh public epoch…"). |
| Signed-in but unauthorized Accounts receive no Collaborators-only data | `tests/worker/public-comments.test.ts`, `tests/worker/effective-access.test.ts`. |
| Owner/author Comment mutation rules enforced server-side | `tests/worker/private-comments.test.ts`, `tests/worker/public-comments.test.ts`. |
| Rotation preserves the logical thread; unpublish destroys it; a later Publication is fresh | `tests/worker/publication-lifecycle.test.ts`, `e2e/publications.spec.ts`. |
| Unpublishing removes only the Publication's Public-thread material; the File's Private thread survives | `tests/worker/publication-lifecycle.test.ts`, `tests/worker/comment-dependent-deletion.test.ts`. |
| Interrupted teardown stays sealed and Owner-resumable | `tests/worker/publication-lifecycle.test.ts`, `tests/worker/comment-dependent-deletion.test.ts`. |
| Pseudonym update is all-old or all-new, never mixed | `tests/worker/pseudonym-update.test.ts`, `e2e/pseudonym-update.spec.ts`. |

### 12.5 Import, export, and deletion

| Criterion | Evidence |
| --- | --- |
| Export plaintext only in the browser; owned content + defined Historical Comment data | `tests/export-collect.test.ts`, `e2e/export-owned-files.spec.ts`. |
| Every preflight/bound failure creates no session, upload, or visible row | `tests/import-source.test.ts`, `tests/import-review.test.ts`, `tests/import-plan.test.ts`, `e2e/import-preflight.spec.ts`. |
| Remote proof covers exact boundaries and one-over rejection (manifest, chunk, aggregate, chunk count, records/chunk, canonical caps, Historical Comments) | `tests/proof/import-proof.test.ts` plus the extended release-gate tests (create/save/Replace/paired Publication/stale/missing sequence), run by `scripts/import-proof.mjs`. Preflight accepts exactly 1,000 Historical Comments and rejects the 1,001st (`tests/import-source.test.ts`, `tests/import-plan.test.ts`); a legal plan cannot upload 1,000 because the 2,000-record/40-chunk ceiling binds first (`tests/import-plan.test.ts`), and the deployed `CHECK` rejects a declared 1,001 (`tests/proof/import-proof.test.ts`). |
| Worst-case upload/commit fits the D1 Free 50-statement invocation limit | A clean pass of the proof on a genuine Free account: D1 Free hard-fails above 50 queries and Workers Free reports `exceededCpu` for over-budget invocations (`docs/import.md`). |
| Retry idempotence; mismatches, missing sequences, malformed descriptors, cancellation, expiry, disconnect, stale authority, failed commit create no marker or visible data; staged Replace stays old until the marker | `tests/proof/import-proof.test.ts`, `tests/worker/import-staging.test.ts`. |
| Shared-target imports assign every new descendant to the target Owner and create no authority | `tests/worker/import-shared-target.test.ts`, `tests/worker/shared-tree.test.ts`, `tests/import-targets.test.ts`. |
| Uncommitted Import records excluded from every normal query class | `tests/worker/import-staging.test.ts`, `tests/worker/import-shared-target.test.ts` (tree listing, direct File read, owned-file scope). |
| File and ≤500-node Directory hard deletion remove every dependent record atomically | `tests/worker/private-tree.test.ts`, `tests/worker/hard-deletion-completeness.test.ts`, `tests/worker/comment-dependent-deletion.test.ts`. |
| >500-node Directory deletion changes nothing | `tests/worker/private-tree.test.ts`, `e2e/tree-structure.spec.ts`. |
| Public-participation limits cannot block export, hard deletion, unpublish, or session revocation | `tests/worker/hard-deletion-completeness.test.ts`, `tests/worker/publication-lifecycle.test.ts`, `tests/worker/public-abuse-response.test.ts`; export is browser-side and has no participation gate (`tests/export-collect.test.ts`). |

### 12.6 Delivery quality

| Criterion | Evidence |
| --- | --- |
| Typecheck, unit/integration tests, migration validation, production build pass in PRs | `.github/workflows/ci.yml`, `scripts/verify-local.mjs`, `tests/migrations.test.ts`, `scripts/smoke-db.mjs`. |
| D1 FK checks enabled; reviewed `EXPLAIN QUERY PLAN` output | `scripts/verify-db-operations.mjs`, `docs/operations/query-plans.md`, `tests/worker/query-plans.test.ts`, `tests/subtree-work-bound.test.ts`. |
| Migration rollback rehearsed on non-production data | `docs/operations.md` ("Migration rollback rehearsal"): Time Travel restore and a reordered synthetic export on a disposable remote D1. General production-sized export restoration remains open in [ticket 38](../.scratch/mdwn/issues/38-d1-export-database-restoration.md). |
| Accessibility-sensitive controls are keyboard/screen-reader usable | `e2e/accessibility.spec.ts` (keyboard-only creation, labelled regions/tabs/composer, narrow drawer) plus the role-based selectors across the browser suite. |
| Independent security review before end-to-end-security claims | [security-review.md](security-review.md) is the readiness brief and [security-review-request.md](security-review-request.md) is the engagement document (scope, access, attack checklist, deliverables); the review itself is commissioned by the maintainer and must complete before any such claim. |
| Disposable remote Free deployment release gate (maximum-source create/save, Replace/import, one-byte-excess, paired Public updates, stale conflicts, deployed D1 constraint) | `scripts/import-proof.mjs` + `tests/proof/import-proof.test.ts`, extended by ticket 33. The create/save exact case uses the maximum legal 262,144-byte Markdown source — the largest a real browser can produce; the canonical 512 KiB decoded-representation ceiling is exercised as an exact-size Import record and as a one-over save rejection. A synthesized 512 KiB private create was observed to exceed Workers Free CPU intermittently and is outside the UI-reachable path. |

## Known boundaries and follow-ups

- **Generalized D1 export restore** is not proven; ticket 38 owns it. Time
  Travel is the primary rollback mechanism and was rehearsed (ticket 31).
- **Historical Comments at exactly 1,000** cannot occur in a legal Import plan
  because the 2,000-record / 40-chunk ceiling binds first; preflight accepts
  exactly 1,000, rejects 1,001, and the deployed `CHECK` rejects a declared
  1,001. The remote proof covers the reachable boundaries and the one-over
  `CHECK`.
- **Ticket 37** (TypeScript runtime project boundaries) and **ticket 34**
  (resource-route organization) are organization/cleanup follow-ups; neither
  changes acceptance behavior.
- Browser diagnostics artifacts (`playwright-report/`, `test-results/`) can
  contain page and application details; keep them inside the repository's
  retention/access policy and never add real credentials to fixtures.
