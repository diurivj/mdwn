# Mac mini CI pool

The M4 Pro host has 24 GiB RAM and 12 cores. `mini-m4pro-ci` routes trusted
repository jobs to independent native ARM64 registrations. The original
`Diegos-Mac-mini` (runner 21) stays at `/Users/diurivj/actions-runner` as slot
`mdwn-01`; added slots live under `/Users/diurivj/ci/runners/`.
Each job owns its checkout, build, `.wrangler`, D1 state, reports, tool cache,
npm/browser caches, and temporary files. Separate paths provide state
isolation, not a security sandbox or a CPU/memory reservation.

The maintainer requested the existing `diurivj` account. Trusted CI code can
access that account's personal files and credentials. Registration uses a
fresh short-lived token held in the configuration process's environment;
tokens are absent from service files and argv. Prefer a dedicated account
without personal/deployment credentials if this trust arrangement changes.

## Configuration and commands

The authoritative nonsecret host configuration is
`/Users/diurivj/ci/config/runner-pool.json`. Its `maxActiveSlots` is a total
host budget, including other repositories; `activeSlots` lists services that
may be started. Begin with one for the matched baseline, then qualify two,
and four only with resource headroom. The checked-in
[example](ci-runner-pool.example.json) shows the two-slot trial.
Inventory every physical-host listener and service before adding another
repository to this same configuration. Manually starting runners or bypassing
the controller can violate the budget; labels and matrix limits cannot enforce it.

Run the controller as `diurivj`, from a trusted checkout of this repository:

```sh
node scripts/runner-pool.mjs inventory /Users/diurivj/ci/config/runner-pool.json
node scripts/runner-pool.mjs status /Users/diurivj/ci/config/runner-pool.json
node scripts/runner-pool.mjs install /Users/diurivj/ci/config/runner-pool.json mdwn-02
node scripts/runner-pool.mjs start /Users/diurivj/ci/config/runner-pool.json
node scripts/runner-pool.mjs stop /Users/diurivj/ci/config/runner-pool.json mdwn-02
node scripts/runner-pool.mjs trim-logs /Users/diurivj/ci/config/runner-pool.json mdwn-02
```

`install` verifies the published SHA-256 of the current official `osx-arm64`
release, registers a unique repository runner, uses its bundled macOS `svc.sh`,
and leaves the service stopped. It preserves automatic updates and refuses to
replace existing registration metadata. `service ... mdwn-01` installs the
original registration's service after an idle check. Gracefully stop its
terminal listener with `stop-terminal ... mdwn-01` before starting that service. All service changes require
a quiet maintenance window. `start` serializes management commands and counts
all local listeners plus loaded service reservations, including foreign slots.
It restores the common label removed by `stop`.
The controller also counts loaded runner services in the system domain and
every local login account's launchd domains, failing closed if it cannot inspect
one. Foreign reservations are conservative and may consume a second budget
unit alongside a live foreign listener until their paths are inventoried.

The generated templates in `ci/config/<slot>-service.plist.template` extend
the installed official template, retain `runsvc.sh`, add explicit nonsecret
environment paths, and throttle launchd restarts to 30 seconds. `.path` uses
an explicit host PATH; HOME remains the account's actual home. They set
`SessionCreate` to `false`: the bundled template's separate security session
reproducibly caused WebKit `DataCloneError` when storing nonextractable
CryptoKeys in IndexedDB on this host. The browser needs the existing GUI
login security session; this changes no keychain password, login, or FileVault
policy. With this personal-account arrangement, CI must be trusted with that
session as well as the account's files. The WebKit CI job runs
`node scripts/probe-ci-webkit-storage.mjs` after browser installation to check
the actual service's nonextractable CryptoKey round trip before the full
suite. Test this after any service/template change, not just listener availability. Job diagnostics
check the effective tool cache under the slot's `_work`, rather than assuming
a service setting took effect. Independent checkouts and the existing
download-only Playwright preload remain essential.

## Maintenance and recovery

Use a quiet window and prevent new assignments before service changes. `stop`
removes the common label, checks GitHub busy state and local Runner.Worker
processes, and stops only that service. Label removal is not a drain lock:
older workflow revisions using default labels can still match. If a job is
busy, let it finish and retry. Never stop all workerd/browser processes on the host.

Management commands hold `ci/config/.pool.lock/owner.json`, which records the
owner PID, command, and start time. A crash or reboot can leave this lock behind.
Recover only in a quiet management window: read that file, check the recorded
PID with `ps -p PID -o pid=,comm=`, and confirm no pool controller is running.
If the owner has exited, remove only the exact `owner.json` file, then the
empty `/Users/diurivj/ci/config/.pool.lock` directory with `rmdir`; retry the
command. If a crash preceded the owner-file write, remove only the empty lock
after the same process check. A live or reused PID requires investigation.

Inspect status for failed/offline services, queued work while matching slots
are idle, disk pressure, and sustained swap growth. Run `trim-logs` on a
stopped idle slot during planned weekly maintenance: it keeps the latest 60
runner diagnostic logs and all logs from the last 30 days, and rotates service
stdout/stderr above 10 MiB with one previous copy. Failed job reports and the
workspace are retained; remove other stale files only after identifying their
owning job and preserving required diagnostics. Service logs and `_diag` can
grow between maintenance windows, so monitor their size.

Services are user LaunchAgents at
`/Users/diurivj/Library/LaunchAgents/actions.runner.diurivj-mdwn.<runner-name>.plist`.
They do not depend on an open terminal, but require this account's GUI login
after restart. FileVault is enabled and requires a preboot unlock. An actual
reboot/unlock/login/browser test is a separate outstanding check until recorded
in the host evidence. Existing login and encryption policy remain unchanged.
AC idle sleep was already zero; power settings require no change. The display
may sleep and the screen may lock.

## Qualification and evidence

Pin the candidate commit and use the ordinary PR CI workflow. Include the
two-worker Node Vitest cap in the single-slot baseline. Finish each attempt
before rerunning the complete workflow. Cold-cache smoke runs establish
stability; compare three completed warm attempts per topology separately.

```sh
node scripts/sample-ci-host.mjs /Users/diurivj/ci/config/runner-pool.json /Users/diurivj/ci/evidence/host-samples.jsonl 3600 10
gh run rerun RUN_ID --repo diurivj/mdwn
node scripts/collect-ci-timing.mjs diurivj/mdwn RUN_ID ATTEMPT /Users/diurivj/ci/evidence
```

The timing collector paginates attempt-specific jobs and saves workflow
metadata, intervals, runner IDs, results, and steps. It computes actual overlap;
terminal job timestamps determine completion, never workflow `updated_at`.
Rerun timing starts at that attempt's `run_started_at`. Inspect the downloaded
`playwright-summary.json` artifacts for each browser/attempt, including retries,
timeouts, failures, and skipped tests. Keep redacted reports outside checkouts
in `ci/evidence/` so subsequent jobs cannot replace them.

Require all checks at the pinned SHA, distinct runner IDs with overlap matching
the topology, no new unexplained retries/timeouts/skips/collisions/orphans,
and a two-slot median at least 30% below the matched baseline. Investigate
per-job median slowdowns over 20%. Retain four only if faster than the healthy
lower-slot topology. Reject sustained warning/critical memory pressure or
continuing swap growth over 1 GiB. Keep at least 50 GB or 15% of the volume free,
whichever is larger. Report median and worst duration, not an unsupported p95.
Then exercise two trusted refs and cancellation, recording aggregate capacity
and cleanup. The pool supplies no project-level scheduling fairness.

## Rollback

Reduce `activeSlots` and `maxActiveSlots` to the last healthy topology after
draining and stopping added services using the commands above. Preserve the
original registration, installation, and common label so workflow routing
still has a target. Keep stopped installations/evidence until recovery is
verified. `ci/config/<slot>-original/` contains the original nonsecret `.path`,
`.env`, `.service`, and service plist when present. Stop the targeted service
before restoring those files. `snapshot.json` records original presence and
absence before the first environment change; later reconfiguration never
backs up newly generated service files as originals. A legacy backup without
this marker requires an explicit migration using its initial inventory; do
not infer original presence from a currently installed service. Preserve
post-setup files separately when correcting such a backup. The original terminal entry point remains
`/Users/diurivj/actions-runner/run.sh` if launchd must be rolled back.
Revert workflow/worker-limit changes independently if they caused a regression.
There is no power-setting rollback because the existing settings were retained.

Platform references: [official macOS service installer](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/darwin.svc.sh.template),
[official plist template](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/actions.runner.plist.template),
[registration API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-a-registration-token-for-a-repository),
and [Playwright JSON reports](https://playwright.dev/docs/test-reporters#json-reporter).
