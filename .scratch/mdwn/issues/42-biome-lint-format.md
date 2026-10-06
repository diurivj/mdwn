# 42: Adopt Biome for formatting and linting

**What to build:** Adopt Biome (formatter + linter, one Rust binary) as the repo's formatting and lint guardrail, and wire it into `CI` and `npm run verify`. The repo currently has no linter, no formatter, no pre-commit hook, and no `lint` script; correctness is gated by typecheck/tests/build/smoke/secrets/browser, but style and a class of lint findings are unchecked.

**Type:** maintenance

**Status:** ready-for-agent

**Blocked by:** none. Coordinate with [41](41-coding-standards.md): mechanical rules go here, judgement calls go there.

**Related:** [40: retro environment improvements](40-retro-environment-improvements.md); `docs/testing.md`.

## Spike findings (Biome 2.5.15, 2026-10-06)

Checked 350 files with `recommended` rules and a repo-tuned formatter:

- **Formatting: 301 files differ.** The repo is hand-formatted; a one-time `biome format --write` baseline is required. Keep it as its own commit so reviewers can skip it.
- **362 errors / 922 warnings** overall. The dominant warning is `style/noNonNullAssertion` (835) — the codebase uses `!` deliberately, so disable that rule. Other noisy rules: `complexity/useOptionalChain` (28), `style/useTemplate` (11), `complexity/noBannedTypes` (4).
- **Real findings worth fixing**, not just style:
  - `correctness/useExhaustiveDependencies` (6): `app/comments/comments-panel.tsx`, `app/import/import-control.tsx`, `app/publications/publish-panel.tsx`, `app/tree/files-page.tsx`, `app/tree/use-file-draft.ts`, `app/tree/use-file-lease.ts`.
  - `correctness/noUnusedImports` (22) + `correctness/noUnusedVariables` (7) + `correctness/noUnusedFunctionParameters` (12): dead code.
  - `suspicious/noImplicitAnyLet` (14): an evolving `let` that ends up `any` slips past strict `tsc`.
  - `suspicious/noArrayIndexKey` (3): `app/routes/account-security.tsx`, `app/routes/sign-up.tsx`.
  - `a11y/noAutofocus` (2), `a11y/useButtonType` (1), `a11y/useAriaPropsSupportedByRole` (1), `a11y/useSemanticElements` (1), `a11y/noStaticElementInteractions` (1).
  - `security/noDangerouslySetInnerHtml` (1, `app/routes/support.tsx`) and `suspicious/noControlCharactersInRegex` (5, likely intentional control-character stripping) need a decision or a documented `biome-ignore` with a reason.
  - `correctness/noEmptyPattern` (17): mostly `loader({})` / `action({})` in route modules that ignore their arguments.
- **One parse error:** `app/app.css` uses Tailwind directives; set `css.parser.tailwindDirectives: true`.
- **Config notes:** `linter.rules.recommended` is deprecated in 2.5 (use `preset`); folder ignores are written without `/**` (`!drizzle`, not `!drizzle/**`).

## Acceptance criteria

- [ ] `@biomejs/biome` is a pinned devDependency with a committed `biome.json` (formatter matching the repo style: 2-space indent, double quotes, semicolons, trailing commas, 120 columns; Tailwind CSS parsing; repo ignores).
- [ ] A standalone formatting-baseline commit applies `biome format --write` across the repo; typecheck, unit/Workers tests, build, smoke, and browser suites pass after it.
- [ ] Linter config starts from `preset: recommended` with `noNonNullAssertion` disabled; every remaining error is fixed, or carries a `biome-ignore` with a one-line reason; noisy stylistic rules are explicitly off.
- [ ] `npm run lint` runs `biome check` (lint + format check) and `npm run format` runs `biome format --write`.
- [ ] `CI` and `npm run verify` run `npm run lint`; `docs/testing.md` documents the commands, the config choices, and how to add an exception.
- [ ] No `--unsafe` fixes land without individual review; the security and a11y findings are decided explicitly.

## Scope and pointers

- `biome.json`, `package.json`, `package-lock.json`.
- `.github/workflows/ci.yml`, `scripts/verify-local.mjs`.
- `docs/testing.md`; `AGENTS.md` (standards/review pointers).
- Biome docs: formatter, linter rules, CSS parser.

## Comments

- 2026-10-06: Raised from the MVP retro with the spike baseline above. Deliberately a separate PR from ticket 40 so the 301-file formatting baseline does not bury the steering changes.
