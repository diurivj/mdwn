## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/mdwn/` — the wayfinder map with its completed decision tickets in `wayfinder/`, and the MVP build tickets in `issues/`, numbered from `01`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, recorded as `Status:` lines. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

### Merge discipline

The team is just the maintainer and agents, and `main` is a private Free repo with no enforceable branch protection — so the review gate is a convention, not a rule. Land work as a branch and pull request to `main`, and merge only once the `ci` workflow is green; the `deploy` workflow applies reviewed migrations and releases the Worker on merge.
