# Playwright worker-count pilot

## Scope and launch gate

This is an **unlaunched experiment**, based on application commit
`f9d2cb81400e2f5dafcc5f0813528c478c75d338`. It does not change normal CI,
Playwright defaults, fixtures, application code, retries, or browser coverage.
The question is whether two workers improve WebKit's elapsed time on the
existing GitHub-hosted runner without new failures or resource pressure.
Two workers share one job's CPU/RAM; they do not provision a second runner.

**Get approval before publishing `experiment/playwright-workers`.** Its
branch-scoped push workflow starts the experiment. A new `workflow_dispatch`
workflow cannot be dispatched until it exists on the default branch, so this
pilot deliberately avoids modifying `main` or opening a PR merely to launch
it. Do not merge this experimental workflow into `main` as-is.
The pilot's concurrency group cannot cancel the existing `ci` workflow.
No background watcher or cancellation of the current PR run is involved.

The proposed launch is one push, producing four isolated browser jobs:

- Ubuntu / Node 24 / locked dependencies / production build, matching CI.
- Two independent samples each at `--workers=1` and `--workers=2`.
- Every job checks out the same immutable event SHA.
- At most two jobs run concurrently; jobs have a 35-minute timeout.
- All 97 WebKit tests at the baseline, with unchanged CI retry policy (one
  retry), `fullyParallel: false`, and no filters, sharding, fixtures bypassed,
  reduced coverage, sleeps, or retry wrappers. Reporting is identical in both
  arms. Chromium and Firefox remain mandatory in normal CI.

**Budget estimate, not a measurement:** the historical WebKit suite took about
20 minutes at one worker. Assuming no speedup, four jobs plus setup/comparison
would consume roughly **85–105 Linux runner-minutes**, with about **45–55 minutes
elapsed** at concurrency two, excluding queueing. The timeout ceiling is
**145 runner-minutes** (4 × 35 + 5). Actual billing/remaining allowance depends
on the private repository's account settings. Faster two-worker results could
reduce this cost; no speedup is assumed in the budget.

## Isolation evidence

Wrangler 4.135.0's harness chooses loopback port zero (OS allocation), disables
persistent storage, and creates a random per-instance temporary Miniflare
storage directory. `reset()` rebuilds only that harness's session. The existing
worker-scoped fixture obtains the current URL again for each test, applies
migrations where needed, and uses Playwright's separate test contexts.

A local, temporary two-test probe ran WebKit with two real Playwright worker
processes and no retries: **2/2 passed**. It asserted different live URLs and
process IDs, separate D1 sentinel rows, cookie/localStorage/IndexedDB isolation,
and that resetting worker A emptied A's migrated DB without changing B's row.
The probe was removed from discovery afterward: the application suite remains
97 tests. A subsequent full WebKit run with two workers and the unchanged CI
retry setting passed **97/97 with zero retries**; Node checks passed **113/113**.
These are local functional checks, **not GitHub performance measurements**.
Shared build assets are read-only; workspace fixture bundling uses `write:false`.

## Measurements and interpretation

`benchmark/run.json` contains a whitelist of commit, browser/version, runner
image/CPU/RAM/Node, worker slots used, retry policy, test-set fingerprint,
per-test timings (including attempts), elapsed test time, setup time, and
pass/failure/flaky/skipped counts. Setup time starts before checkout; test time
comes from Playwright's JSON reporter. Sum per-test timings by `file` to examine
spec costs, but do not confuse summed overlapping test durations with elapsed
wall time or infer proof-of-work attribution without separate instrumentation.

`benchmark/resources.txt` is GNU time output for the test process tree. Its
maximum RSS is **not aggregate simultaneous memory usage** of all processes.
Raw JSON and failure traces/screenshots/videos are retained for seven days in
private artifacts. They can contain fixture data and capability-bearing URLs;
do not publish them or copy URL fragments into logs/discussions. Sanitized
summaries exclude test stdout, error messages, request-URL fields, and attachment
bodies. The log stream and summary labels redact URL fragments. Exit handling
prioritizes the original test-process failure, then redaction failure, then
reporting failure—even when no valid JSON was produced. Never supply real
credentials to these fixtures.

The final job reports every sample and compares medians only if there are two
complete, clean samples per worker count on matching hardware/runtime and the
same commit, browser/version, coverage fingerprint, and execution policy.
Imported summaries must have complete metadata and consistent test counts and
fingerprints; a saved `clean` flag is not sufficient evidence. Malformed reports
are identified explicitly and block comparison, rather than being silently dropped.
Failed, flaky, skipped, interrupted, missing, underused-worker, and local-only
samples cannot produce a speedup verdict. Hardware/image mismatches make the
pilot inconclusive rather than being silently normalized away.

For downloaded artifacts, the built-in-only reporter needs no npm install:

```sh
node scripts/playwright-benchmark.mjs compare /path/to/downloaded-artifacts 2
```

Two samples per arm are a **pilot, not proof of stability**: real signup's
randomized proof-of-work adds substantial variance. If promising, propose more
paired measurements and validate Chromium/Firefox before recommending a
permanent configuration change. Any fixture seeding optimization is a separate
proposal and must preserve dedicated real-signup/security coverage.

## References

- [Playwright CI guidance](https://playwright.dev/docs/ci): recommends one worker
  for stability/reproducibility; increasing workers requires validation.
- [Playwright JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter)
- [Cloudflare harness configuration/reset](https://developers.cloudflare.com/workers/testing/test-harness/configure/)
- [Cloudflare Playwright integration](https://developers.cloudflare.com/workers/testing/test-harness/integrations/)
- [GitHub manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
