## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/mdwn/` — the wayfinder map with its completed decision tickets in `wayfinder/`, and the MVP build tickets in `issues/`, numbered from `01`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, recorded as `Status:` lines. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

### React Router route placement

Put resource-only route modules (no default page component) under `app/routes/api/` for `/api/*` URLs and `app/routes/resources/` for other endpoints. Keep page modules at the top level of `app/routes/`, map public URLs explicitly in `app/routes.ts`, and keep business logic in feature modules.

### Post-review RR8 gate

After every code review, load `.agents/skills/rr8-post-review/SKILL.md` and run it against the same pinned diff before finishing. Report its RR8/stack result separately from Standards and Spec, even when there are no RR8 touchpoints.

### Merge discipline

The team is just the maintainer and agents, and `main` is a private Free repo with no enforceable branch protection — so the review gate is a convention, not a rule. At ticket completion, commit the reviewed and verified work on its issue branch, push the branch, and open or update a pull request to `main`. Report the commit and PR URL. The `deploy` workflow applies reviewed migrations and releases the Worker on merge.

Merge only after every job in the `CI` workflow passes at the PR's current head; re-check after any push. Queued, skipped, or cancelled jobs are not a pass. CI uses the repository's self-hosted Mac mini; keep it awake and its runner online (see README.md, "CI"). Deployment stays on GitHub-hosted Linux.

Use `npm run verify` for local preflight, not as a replacement for green CI. It refuses a dirty tree or a branch behind `origin/main`. Run `npm ci` first when `package-lock.json` changed.
