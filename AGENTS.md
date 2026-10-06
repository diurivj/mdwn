## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/mdwn/` — the wayfinder map with its completed decision tickets in `wayfinder/`, and the MVP build tickets in `issues/`, numbered from `01`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, recorded as `Status:` lines. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

### React Router route placement

Put resource-only route modules (no default page component) under `app/routes/api/` for `/api/*` URLs and `app/routes/resources/` for other endpoints. Keep page modules at the top level of `app/routes/`, map public URLs explicitly in `app/routes.ts`, and keep business logic in feature modules.

### File naming

Use kebab-case for every file we author — route modules, feature modules, components, hooks, tests, and scripts: `import-control.tsx`, `use-file-draft.ts`, `public-comments.test.ts`. Exported identifiers keep their language convention: React components and types stay PascalCase, hooks and functions stay camelCase.

Framework-reserved entry files (`app/root.tsx`, `app/routes.ts`, `app/entry.server.tsx`), generated files (`drizzle/`), vendored data (`vendor/`), skill entry files (`SKILL.md`), and conventional root documents (`AGENTS.md`, `CONTEXT.md`, `README.md`, `NOTES_TO_DISCUSS.md`) keep their required names.

### Reference docs

- `docs/testing.md`: Node/Workers/browser test layout, lint/format commands and config, TypeScript project boundaries, CI output.
- `docs/operations.md`: retention, D1 query plans, Time Travel, export restoration.
- `docs/operations/d1-scripting.md`: verified Wrangler/D1 semantics before writing an operational script.
- `docs/serving-and-security.md`: serving and security model.
- `CONTEXT.md`: domain vocabulary.

### Post-review RR8 gate

After every code review, load `.agents/skills/rr8-post-review/SKILL.md` and run it against the same pinned diff before finishing. Report its RR8/stack result separately from Standards and Spec, even when there are no RR8 touchpoints.

### Merge discipline

The team is just the maintainer and agents, and `main` is a private Free repo with no enforceable branch protection — so the review gate is a convention, not a rule. At ticket completion, commit the reviewed and verified work on its issue branch, push the branch, and open or update a pull request to `main`. Report the commit and PR URL. The `deploy` workflow applies reviewed migrations and releases the Worker on merge.

Merge only after every job in the `CI` workflow passes at the PR's current head; re-check after any push. Queued, skipped, or cancelled jobs are not a pass. CI uses the repository's self-hosted Mac mini; keep it awake and its runner online (see README.md, "CI"). Deployment stays on GitHub-hosted Linux.

Use `npm run verify` for local preflight, not as a replacement for green CI. It refuses a dirty tree or a branch behind `origin/main`. Run `npm ci` first when `package-lock.json` changed.

After pushing the branch or opening/updating the PR, report the commit and PR URL and stop. Check CI when the user asks, or once immediately before merging; the self-hosted runner executes the jobs sequentially, so blocking on `gh pr checks --watch` costs tens of minutes for no new information.
