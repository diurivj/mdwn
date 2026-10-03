# 36: Cut unneeded signups and server-only checks from the browser suite

**What to build:** Make the browser suite create an Account through real signup only when signup is the behavior under test. Every other browser test that only needs an existing Account should start from a seeded Account built with the production crypto code. Move checks whose assertions are entirely server-side out of the browser suite and into the Workers test suite through `SELF.fetch`. This changes tests only: no application, protocol, or proof-of-work change is in scope.

**Type:** test infrastructure

**Status:** ready-for-agent

**Blocked by:** None.

**Related:** [33: MVP acceptance suite](33-mvp-acceptance-suite.md). Its cross-browser bullets still require recovery, routine enrollment, and multi-device flows in Chromium, Firefox, and WebKit; this ticket keeps those flows in every engine and changes only how their starting Account is created. `docs/testing.md` describes the Worker/browser harnesses. `docs/playwright-workers-benchmark.md` records why adding Playwright workers did not help.

## Why

The browser suite is the merge bottleneck. In the one-worker CI baseline ([run 37086738861](https://github.com/diurivj/mdwn/actions/runs/37086738861)), the Firefox job spent 18.4 minutes in browser tests. The files that perform real signup took 11.3 of the 17.9 minutes of summed test time (63%).

- 23 tests per engine perform a full browser signup: 69 per CI run. Each signup runs the whole ceremony: key generation, the recovery phrase and codes UI, the 18-bit proof of work, and the WebAuthn registration.
- The proof of work's randomized cost dominates and varies widely. The current solver measured 2.6–4.8 s expected per signup on a fast Mac, depending on the engine (p90 6–11 s). CI runners are several times slower: `signup-integrity.spec.ts` averaged 22.2 s per test on CI Firefox against 3.5 s locally.
- Only 4 of those 23 tests per engine need a real signup. Thirteen only need an Account to exist. Six assert server behavior (a tampered or honeypot signup leaves no Account) and use the browser only to produce a valid request.

Estimated effect, to be measured rather than assumed: removing about 19 signups per engine should save roughly 5–7 minutes of the Firefox job and remove much of its timing variance.

## Test-by-test plan

Real signup is kept only where signup itself is under test, plus one end-to-end golden path.

| Test | Today | Plan |
| --- | --- | --- |
| `signup.spec.ts` › signs up atomically with a bound device… | real signup | **Keep real signup** (signup is the subject) |
| `signup.spec.ts` › a lost signup commit response signs in with the persisted device… | real signup | **Keep real signup** |
| `signup-integrity.spec.ts` › losing a persisted private key before passkey registration… | real signup | **Keep real signup** (browser storage changes mid-signup) |
| `private-tree-flow.spec.ts` › creates and opens signed private Directories and Files… | real signup | **Keep real signup** as the single signup → Files golden path |
| `signup.spec.ts` › sign-out preserves the device keys for a later private-capable sign-in | real signup | Seeded Account |
| `signup-integrity.spec.ts` › sign-in with {bad binding proof, stale registry, revoked device, tombstoned device} stays unprovisioned (4) | real signup | Seeded Account |
| `device-enrollment.spec.ts` › synced Passkey QR approval; lost candidate keys/expiry/stale registry; approval tampering/freshness/removed approver (3) | real signup | Seeded Account; the passkey is still synced into the candidate context |
| `grant-provisioning.spec.ts` › all 3 tests, via `signup()` in `e2e/support/provisioning-fixtures.ts` | real signup | Seeded Account; `enroll()` and `recover()` keep working unchanged |
| `auth-recovery.spec.ts` › a used code adds a replacement Passkey… | real signup | Seeded Account with recovery codes |
| `vault-recovery.spec.ts` › a recovery code, replacement Passkey, fresh assertion and phrase… | real signup | Seeded Account with a recovery capsule sealed from a known phrase |
| `signup-integrity.spec.ts` › rejects altered {candidate key, capsule digest, registration challenge, binding signature, transport proof} with no Account (5) | real signup + request tampering | **Move to Workers tests** |
| `signup.spec.ts` › rejects honeypot and consumed registration/PoW challenges… | real signup + request tampering | **Move to Workers tests**. The consumed-PoW half is already covered by `tests/worker/signup-boundary.test.ts`, so move only the honeypot and replay half. |
| `auth-sign-in.spec.ts` › server-renders only the Account security shell… | seeded sign-in, then an HTML-only check | **Move to Workers tests** (it asserts response HTML only), unless an existing Workers test already covers it |

Result per engine: 4 real signups instead of 23, and 93 browser tests instead of 100. Every Workers test added replaces a browser test that is deleted.

## Acceptance criteria

- [ ] **Seeded Account fixture** (for example `e2e/support/seeded-account.ts`). It produces an Account indistinguishable, for these tests, from one created by real signup, with no ceremony or proof of work:
  - device keys created in the test browser through the production device store (`app/device/store`, as `e2e/workspace-fixture.ts` already does), at registry epoch 1;
  - the vault key hierarchy, device-enrollment envelope, Account profile, recovery capsule, and recovery-code set built with the production functions (`createVaultKeyHierarchy`, `sealDeviceEnrollmentEnvelope`, `sealAccountProfile`, `createRecoveryMaterial`, `prepareRecoveryCodeSet`);
  - a real virtual-authenticator passkey whose COSE public key is stored in `passkeys`, following the existing `signInSeededAccount` pattern in `e2e/auth-sign-in.spec.ts`;
  - the same D1 rows real signup commits, inserted at the storage boundary.

  The fixture returns what the tests read today: the context, page, Account ID, device ID, root Directory ID, recovery phrase, recovery codes, and passkey. Callers that need a signed-in Session get one through the real passkey sign-in route, which involves no proof of work.
- [ ] **Drift guard.** The kept atomic-signup test already asserts the exact rows signup writes (account profile, passkey, encryption identity, device, 2 key envelopes, recovery capsule, 10 recovery codes, Session). Share that expected shape so a test also asserts the seeded fixture produces it. A change to signup's committed rows must then fail until the fixture is updated.
- [ ] **Convert the seeded-Account tests** in the table without weakening any assertion. Keep each test's subject, real routes, and real browser crypto. Adjust only assertions that counted signup's own side effects (for example the signup Session), and explain each adjustment in the PR.
- [ ] **Move the server-only checks** to `tests/worker/**/*.test.ts` through `SELF.fetch`, then delete the browser copies. Build a Worker-side helper that produces a valid signup `verify` request:
  - transcript and material from the same production crypto functions, with in-memory keys instead of the browser device store;
  - the proof of work solved with the app's existing `solveProofOfWork`;
  - the transport proof and binding signature computed as `commitSignup` does;
  - a software WebAuthn registration response with `none` attestation, built with `@simplewebauthn/server/helpers` (`isoCBOR`, `cose`).

  Each moved scenario asserts the server's rejection and that no Account, Session, or challenge reuse results, matching the browser assertions it replaces. Prove the helper is valid by committing one unaltered request successfully in the same file.
- [ ] **Do not change the challenge.** The signup proof of work (18-bit difficulty, protocol, and the browser solver in `app/signup/protocol.ts`) and the signup UI stay exactly as they are. No application code changes, production test routes, or new test-only server endpoints.
- [ ] **Keep engine coverage.** Every browser test that remains still runs in Chromium, Firefox, and WebKit; ticket 33's cross-browser flows stay cross-browser.
- [ ] **Measure.** Record real-signup counts and the per-engine browser-test times before and after, from CI runs with one worker and no retries needed. Note any test that became flaky, and confirm the suite is green in all three engines with `--retries=0` locally.
- [ ] **Update `docs/testing.md`.** Explain when a browser test may use real signup (only when signup is under test, or the single golden path) versus the seeded fixture, and say that server-only assertions belong in the Workers suite.
- [ ] Run typecheck, `npm test`, and the full browser suite. Then complete the Standards/Spec review and the RR8 post-review gate (`AGENTS.md`) before committing, pushing, and opening the PR.

## Implementation pointers

- `e2e/auth-sign-in.spec.ts`: `signInSeededAccount` and `coseP256PublicKey` (seeded passkey and real sign-in), ready to extract into `e2e/support/`.
- `e2e/workspace-fixture.ts` and `e2e/support/workspace-entry.ts`: production device store and vault crypto run inside the test browser; D1 seeding at the storage boundary.
- `e2e/support/provisioning-fixtures.ts`: `signup()`, `enroll()`, and `recover()`. `signup()` becomes the seeded variant with the same return shape.
- `auth-recovery.spec.ts` › "an expired recovery Session…" already seeds an Account and recovery-code hash directly in D1.
- `app/signup/bootstrap.ts`: `prepareSignup()` and `commitSignup()` are the reference for what a valid signup produces. They depend on IndexedDB and `localStorage`, so the Worker helper reuses the crypto functions they call rather than the functions themselves.
- `tests/worker/signup-options.test.ts` and `tests/worker/signup-boundary.test.ts`: existing Worker tests that already go through `/api/signup/challenge` and `/api/signup/options`, including `solveProofOfWork`.
- `tests/worker/auth-fixtures.ts`: `seedAccount`, `seedNormalSession`, and `signedCookie` for the Account-security HTML check.

## Out of scope

- Any change to the signup proof of work: its difficulty, protocol, or browser solver.
- CI changes: sharding the browser matrix, gating `deploy` on CI, or worker counts.
- Running engine-agnostic browser tests in a single engine.
- Reducing the per-test cost of `e2e/workspace-fixture.ts`.

## Comments

- 2026-10-03: Written after the Firefox CI timeouts from the two-worker trial (rolled back in PR #28). The maintainer approved removing unneeded signups and moving server-only browser checks, and asked not to change the challenge (proof of work).
