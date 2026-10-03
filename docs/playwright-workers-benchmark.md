# Playwright worker-count pilot and rollout

## Completed pilot

The [WebKit pilot](https://github.com/diurivj/mdwn/actions/runs/37086725720)
ran commit `dc654f3a28a4dc45eded056f716761e0624a3a83`. All four runs passed
all 97 tests with no retries, flakes, skips, or failures.

| Sample | One worker | Two workers | Interpretation |
| --- | --- | --- | --- |
| 1 | 12m15s | 11m13s | Same recorded CPU model/runtime; 8.4% lower suite time |
| 2 | 15m04s | 9m29s | Different CPU models; not a controlled comparison |

Times exclude installation and build. The second one-worker runner used
AMD EPYC 7763; the other three used AMD EPYC 9V74. All exposed two vCPUs with
matching RAM, image, Node, and Playwright versions. The comparison correctly
rejected the pooled result: **a repeatable 24% speedup was not established**.
The matched pair saved about one minute, but one pair is not a stability or
performance guarantee; real signup's randomized proof-of-work also adds variance.

The [one-worker normal CI baseline](https://github.com/diurivj/mdwn/actions/runs/37086738861)
passed 334 Node/Workers tests and 97 tests in each browser, with no browser
retries. Its slowest job was Firefox at 19m32s, versus WebKit at 18m44s and
Chromium at 10m12s. Improving only WebKit would not shorten that critical path.

## Authorized two-worker trial

The maintainer approved trying two workers in the **existing CI**, rather than
requiring another full benchmark. `playwright.config.ts` now selects two
workers when `CI` is set, for Chromium, Firefox, and WebKit. Local worker
selection, `fullyParallel: false`, the one-retry CI policy, all application
fixtures, and every application test remain unchanged.

Each worker has its own Wrangler harness and temporary binding storage. A local
two-process probe verified separate ports, D1 and browser state, and that
resetting one harness left the other's data intact. The two successful
GitHub WebKit runs support the trial; they do not establish cross-engine safety.

The temporary branch-only workflow, reporter, and its 25 tooling-only tests
have been retired. The unchanged application Node/Workers baseline is therefore
309 tests (88 Node + 221 Workers); browser coverage remains 97 tests per engine.
The pilot tooling remains available in commit `dc654f3` if needed for a separate,
explicitly approved future investigation. There is no automatic benchmark run.

The next push triggers only the normal PR CI workflow. Before accepting this
configuration, inspect **all three browser jobs** for failures, retry-recovered
flakes, and runtime regressions; a green workflow alone can hide retries.
Keep the PR draft until that run is assessed. If stability or runtime regresses,
restore the CI worker count to one instead of weakening tests or retry limits.
No automatic merge or background watcher is part of this trial.

## Outcome: rolled back to one worker

The trial regressed Firefox stability, so CI is back to one worker per
browser job, following the rule above.

- The [trial PR run](https://github.com/diurivj/mdwn/actions/runs/37089788657)
  was green only through a retry: Firefox's over-cap Directory deletion test
  failed once, and its `shared-file.spec.ts` recipient tests took 27–31.5s
  against the 30s test timeout.
- The [post-merge `main` run](https://github.com/diurivj/mdwn/actions/runs/37090627340)
  and the [next PR run](https://github.com/diurivj/mdwn/actions/runs/37097307023)
  failed the same three Firefox tests on both attempts. The two file-recipient
  `shared-file.spec.ts` tests exceeded the 30s timeout in their final steps,
  and the over-cap test's 500-child folder did not render within the 5s
  assertion timeout after reload. Traces show no hang or wrong state.
- With one worker the same Firefox tests took 15–17s and 27s. With two
  workers sharing two vCPUs, the two browsers and Wrangler harnesses roughly
  doubled the CPU-bound crypto tests. WebKit also needed a retry for the
  over-cap test.

The Firefox job saved about two minutes (17m32s with two workers against
19m32s with one), which does not justify the flakes.
