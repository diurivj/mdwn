# 56: Bounded Mac mini CI pool

Type: infrastructure
Status: ready-for-agent

## Request

Implement the maintainer's `/Users/diurivj/PLAN.md` (2026-10-10) on the actual
M4 Pro Mac mini. Preserve the original runner, start with two total listeners,
and qualify four using repeated complete CI attempts at one pinned SHA.
On 2026-10-11 the maintainer requested reuse of the existing `diurivj` account;
the pool therefore retains access to personal files rather than satisfying
the plan's dedicated-account recommendation.

## Acceptance

- Separate registrations, services, workspaces, tool/npm/browser caches, and
  temp state, with one host-wide listener budget counting the original runner.
- Route unchanged independent verification and three browser jobs through
  `mini-m4pro-ci`; retain trust/permissions/concurrency/timeout guards. Node
  Vitest uses two CI workers; Playwright remains one with its existing retry policy.
- Add nonsecret isolation diagnostics, attempt-specific browser artifacts,
  machine-readable retry counts, and timing/resource collectors.
- Provide idempotent host status/install/start/idle-stop/log-maintenance tools,
  rollback configuration, and measured service/harness isolation evidence.
- Record matched single-slot, two-slot, and (if healthy) four-slot same-SHA
  measurements and select the fastest stable capacity. Leave an explicit
  outstanding item if the full FileVault/reboot/login test is deferred.
- Complete local validation, Standards/Spec review, RR8/stack gate, and a PR;
  report the tested SHA and operational limitations. No application merge or deployment.
