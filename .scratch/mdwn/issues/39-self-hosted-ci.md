# 39: Resume CI on the Mac mini self-hosted runner

**Type:** infrastructure

**Status:** ready-for-agent

## Request

The maintainer has registered the Mac mini runner and asked to point the paused CI workflow at it and resume CI. Runner discovery reports `Diegos-Mac-mini` online with labels `self-hosted`, `macOS`, and `ARM64`.

## Acceptance criteria

- Both the verification job and Chromium/Firefox/WebKit jobs select the registered self-hosted macOS ARM64 runner, retaining all existing checks and browser coverage.
- Browser installation is appropriate for macOS. Jobs have bounded execution time; checkout credentials are not persisted and the workflow token is read-only. Fork pull requests do not run on the persistent runner under this workflow.
- Keep deployment on GitHub-hosted Linux, separate from the PR runner. Document persistent-runner trust and availability requirements without claiming account isolation is a sandbox.
- Restore the green-CI-at-current-head merge convention and keep local verification available as preflight.
- Validate the workflow, complete Standards/Spec and RR8/stack review, re-enable CI, and open a PR. Confirm the PR's CI runs on the Mac mini and report its actual result; a queued, skipped, or failed job is not a pass.

## Scope

No runner installation, host configuration, deployment, application-code, schema, or dependency changes. The already-disabled worker-count pilot remains disabled.
