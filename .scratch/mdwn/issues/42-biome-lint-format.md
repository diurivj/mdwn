# 42: Adopt Biome for formatting and linting

**What to build:** Adopt Biome (formatter + linter, one Rust binary) as the repo's formatting and lint guardrail, and wire it into `CI` and `npm run verify`. The repo currently has no linter, no formatter, no pre-commit hook, and no `lint` script; correctness is gated by typecheck/tests/build/smoke/secrets/browser, but style and a class of lint findings are unchecked.

**Type:** maintenance

**Status:** done

**Blocked by:** [40](40-retro-environment-improvements.md) (PR #49) — it edits the same `package.json`, `.github/workflows/ci.yml`, and `scripts/verify-local.mjs` files. Coordinate with [41](41-coding-standards.md): mechanical rules go here, judgement calls go there.

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

- [x] `@biomejs/biome` is a pinned devDependency with a committed `biome.json` (formatter matching the repo style: 2-space indent, double quotes, semicolons, trailing commas, 120 columns; Tailwind CSS parsing; repo ignores).
- [x] A standalone formatting-baseline commit applies `biome format --write` across the repo; typecheck, unit/Workers tests, build, smoke, and browser suites pass after it.
- [x] Linter config starts from `preset: recommended` with `noNonNullAssertion` disabled; every remaining error is fixed, or carries a `biome-ignore` with a one-line reason; noisy stylistic rules are explicitly off.
- [x] `npm run lint` runs `biome check` (lint + format check) and `npm run format` runs `biome format --write`.
- [x] The `CI` workflow gains a `Lint and format check` step running `npm run lint` (and `npm run verify` gains the same step), so the repo no longer relies on `tsc` alone for static checking. The existing `Typecheck` step stays: Biome is not a type checker, and its inference-based type rules do not replace `tsc -b`.
- [x] `docs/testing.md` documents the commands, the config choices, how the lint step relates to `Typecheck`, and how to add an exception.
- [x] No `--unsafe` fixes land without individual review; the security and a11y findings are decided explicitly.

## Scope and pointers

- `biome.json`, `package.json`, `package-lock.json`.
- `.github/workflows/ci.yml`, `scripts/verify-local.mjs`.
- `docs/testing.md`; `AGENTS.md` (standards/review pointers).
- Biome docs: formatter, linter rules, CSS parser.

## Comments

- 2026-10-06: Raised from the MVP retro with the spike baseline above. Deliberately a separate PR from ticket 40 so the 301-file formatting baseline does not bury the steering changes.
- 2026-10-06: Decision note — **Biome over oxlint**. oxlint is the faster linter (roughly 3x Biome on lint-only; both finish this 350-file repo in milliseconds, and `biome check` already ran in ~135 ms), but the decisive factors here are: (1) the 301-file formatting baseline needs a stable formatter, and oxfmt is still beta (0.65.0, not 1.0) while Biome's formatter is stable 2.x; (2) oxlint's real advantage — type-aware rules delegated to the Go `tsc` via `oxlint-tsgolint` (59 of 61 typescript-eslint type-aware rules) — requires TypeScript 7.0+ and a separate install, and this repo is on TypeScript 5.9, whereas Biome's inference-based type rules need no compiler; (3) Biome is one dependency and one config, which fits a repo with no existing ESLint config, plugins, or custom rules to preserve. Revisit when CI lint latency matters (thousands of files), or once oxfmt reaches 1.0 and the repo moves to TypeScript 7 — both tools are config-file based and the formatting baseline is a one-time cost, so switching later is cheap.
- 2026-10-07: Status reconciled to **done**: PR #50 merged as `a827ab9`. All seven criteria are evidenced in the merged work: pinned `@biomejs/biome` 2.5.15 with `biome.json`, the standalone formatting-baseline commit (`795922e`), recommended preset with the noisy rules off and every remaining finding fixed or suppressed with a reason, `lint`/`format` scripts, the CI and `npm run verify` lint step beside `Typecheck`, and `docs/testing.md`. PR #50 records the two-axis review (the hook-dependency regression risk it caught was fixed before merge) and a separate RR8 pass; the scoped `--unsafe` `noUnusedImports` run was individually reviewed.
