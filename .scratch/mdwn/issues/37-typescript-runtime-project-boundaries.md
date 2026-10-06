# 37: Replace per-file TypeScript project exceptions with runtime boundaries

**What to build:** A maintainable Node/Workers TypeScript project split in which portable SQL and shared modules are discovered by a stable directory/glob convention or shared referenced project, rather than manually registering each new file. Keep runtime-specific code and React Router's server-only privacy boundary distinct.

**Type:** maintenance

**Status:** ready-for-agent

**Blocked by:** 31 (Retention and operations; introduces the shared production-query imports that expose this problem).

**Related:** [33: MVP acceptance suite](33-mvp-acceptance-suite.md); [34: Resource-route organization](34-resource-route-organization.md). This is a separate runtime/project-boundary refactor, not an expansion of ticket 34's route moves.

## Problem

`tsconfig.node.json` is a composite project with a growing hand-picked list of application files. Node tooling now compiles the actual production subtree SQL rather than maintaining a copied query:

- `scripts/lib/d1-query-plans.mjs` imports `app/tree/subtree.server.ts`, requiring a new individual `include` entry.
- That helper imports `app/import/visibility.server.ts`. The Node project's blanket `app/import/*.server.ts` exclusion catches this portable SQL leaf, so ticket 31 adds an explicit `files` exception.
- Composite projects require their imported implementation files to belong to the project. The symptom is therefore a consequence of the current source/project classification, not a requirement to maintain a manual file registry.

The `.server` suffix prevents client-bundle inclusion; it does not mean a module requires Cloudflare's `Env` or cannot run in Node. Conversely, including all application files in the Node project would pull in Worker-only bindings and route/JSX dependencies rather than resolve the boundary.

## Acceptance criteria

- [ ] Classify portable/shared source versus Node-specific and Workers-specific entrypoints/dependencies. Use a stable source-layout/glob convention or shared TypeScript project; explain the chosen approach in `docs/testing.md`. Preserve feature ownership of business/query logic.
- [ ] Remove ticket 31's individual `app/tree/subtree.server.ts` inclusion and `app/import/visibility.server.ts` root-file exception. Migrate other equivalent hand-picked shared application entries where the same classification applies, without sweeping unrelated runtime code into Node.
- [ ] A new portable SQL module placed in the chosen area is typechecked through both Node tooling/tests and the Workers application/tests without another per-file tsconfig edit. Add a compiler-focused regression or reproducible verification of this property.
- [ ] Keep Worker-only `Env`/generated binding consumers in the Workers target and Node-only tooling out of the deployed Worker graph. Do not solve the problem with fake ambient `Env` declarations, weakened typechecking, ignored errors, or duplicate query implementations.
- [ ] Preserve `.server` client-bundle protection for server SQL. Operational query-plan checks and supplemental SQLite measurements still compile the exact production subtree query; access/traversal use the same committed-Import visibility predicate.
- [ ] Preserve public URLs, authorization, query behavior, deletion/expiry limits, and schema. No database migration, cryptographic protocol change, or new runtime abstraction is required.
- [ ] Run `npm run typecheck`, the Node query-work-bound test, focused Workers query-plan/retention/tree tests, and a production build/secret-leak check. Complete Standards/Spec review and the separate RR8/stack gate, then the clean-head `npm run verify` merge gate.

## Implementation pointers

- `tsconfig.json`, `tsconfig.node.json`, `tsconfig.cloudflare.json`: composite project ownership and current exclusions.
- `app/tree/subtree.server.ts`, `app/import/visibility.server.ts`: portable server-only SQL leaves.
- `scripts/lib/d1-query-plans.mjs`, `tests/subtree-work-bound.test.ts`, `tests/worker/query-plans.test.ts`: shared production-query consumers across runtimes.
- `docs/testing.md`: explain source ownership and how to add a module without growing the manual registry.

## Comments

- Raised by the maintainer after ticket 31's PR #41. The existing exceptions pass verification, but are a tracked workaround rather than the desired project structure. No refactor is implemented by this ticket's creation.
- 2026-10-06: Implemented on `issue/37-typescript-runtime-project-boundaries`. Portable application modules now live under `app/shared/<feature>/`; the 62 files the Node project previously hand-picked moved there with import-only rewrites. `tsconfig.node.json` is now `app/shared/**/*.ts` plus the Node tooling roots, with ticket 31's `files` exception and individual `app/tree/subtree.server.ts` entry gone. `docs/testing.md` records the classification (shared vs Worker/browser vs Node-only tooling) and how to add a module. `tests/typescript-boundaries.test.ts` writes a probe SQL module into the shared area and uses the TypeScript compiler's own config parser and program construction to prove both projects discover and typecheck it, and asserts the Node project's application files all come from the shared layer. Verification: `npm run typecheck`, Node suite 31 files/229 tests, Workers suite 50 files/374 tests, `npm run build`, `npm run check:secrets` (no candidate secrets in 123 client files), `npm run check:namespace`. Standards and Spec review plus the separate RR8 gate completed; RR8 reported not applicable (no route/loader/action/fetcher or Worker-binding behavior changed; the D1 boundary module is a pure rename and keeps `.server.ts`). Merge still requires the clean-head `npm run verify` gate and green CI.
