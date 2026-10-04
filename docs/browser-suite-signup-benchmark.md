# Browser signup reduction (ticket 36)

## Scope and counts

Starting commit: `9d939d389c1ca413d2d12ff05744644999f72e53`.
The starting checkout contained 112 browser tests per engine, not the 100 in the
original ticket. Removing seven server-only cases leaves **105 per engine**
(315 across Chromium, Firefox and WebKit). No engine selection changed.

Real signup attempts fall from **23 to 4 per engine** (69 to 12 total):

- Atomic signup and lost commit response: two in `signup.spec.ts`.
- Lost persisted private key during signup: one in `signup-integrity.spec.ts`.
- Signup → signed private Directories/Files golden path: one in
  `private-tree-flow.spec.ts`.

Thirteen existing-Account cases now seed production crypto and use real passkey
sign-in. Six server-only signup rejection cases moved to Workers, together with
the security-shell HTML case. The Worker helper's successful unaltered signup
is an additional validity control, not additional browser coverage.

## CI before and after

[Exact starting-commit run 37169504199](https://github.com/diurivj/mdwn/actions/runs/37169504199)
ran **112 tests per engine**, using one worker, with no failures, flakes, or
retries. These are the Playwright-reported suite times (exclude install/build),
rather than job times. [After run 37171407154](https://github.com/diurivj/mdwn/actions/runs/37171407154)
at implementation commit `84ef022043065f09140acd0cd8ac6a337fc0a6de` passed all
**105 tests per engine**, also with one worker and no failures, flakes, skips,
or retries. All four CI jobs succeeded, including typecheck, tests, build,
migration smoke and bundle-secret checks.

| Engine | Before | After | Reduction |
| --- | --- | --- | --- |
| Chromium | 10.5 min | 6.2 min | 4.3 min (41%) |
| Firefox | 18.5 min | 9.8 min | 8.7 min (47%) |
| WebKit | 17.2 min | 11.8 min | 5.4 min (31%) |

The ticket's older [baseline run 37086738861](https://github.com/diurivj/mdwn/actions/runs/37086738861)
had only 97 tests per engine and reported 9.1/18.3/17.1 minutes respectively;
use the exact starting-commit run above for this change's comparison.
CI configuration, worker count and retry policy are unchanged. Both runs qualify
without retries; reductions above use the rounded Playwright-reported times. A single before/after pair is not a performance
or variance guarantee: runner differences and randomized proof of work remain.

## Assertion adjustments

- The seeded Account itself creates no Session. Each converted test needing one
  signs in through the real route first. The sign-out/sign-in test therefore
  still requires exactly two bound Sessions; recovery still proves revocation
  of a genuine original Session. No Session-count assertion was removed.
- Recovery identifier, phrase and codes come from production-generated fixture
  material rather than scraping signup UI. Their use, single-use/replacement,
  rotation and privacy assertions remain in the real recovery flows.
- The exact persisted signup shape is shared by atomic signup and seeded
  sign-out/sign-in. The fixture does not import that expectation to build rows.
- Playwright's credential copy API transfers keys but resets its assertion
  counter to zero. Seeded setup now includes one real sign-in (unlike signup),
  so `primeSyncedPasskey` makes one local assertion in the copied authenticator
  before candidate sign-in. This restores the starting counter, not server
  authority: no D1 counter is reset and no failed-request retry is added.
  Existing approval counter catch-up and enrollment assertions remain unchanged.

## Local verification

Production build and typecheck passed. `npm test` passed all **127 Node + 304
Workers tests**. Full browser suites ran sequentially, each with
`--workers=1 --retries=0`:

| Engine | Passed | Playwright suite time |
| --- | --- | --- |
| Chromium | 105 | 3.6 min |
| Firefox | 105 | 3.7 min |
| WebKit | 105 | 4.4 min |

All **315** passed, with no skipped tests, failures or retries. No flakes were
observed in these runs. The first converted-flow run exposed deterministic
copied-counter failures in four enrollment cases in every engine (12 failures,
not flakes). The single-case Chromium red/green run confirmed the fix described
above; the focused 21-test enrollment/provisioning run and all full suites then
passed. Local timings are not substituted for CI measurements.
