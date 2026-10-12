# Testing across runtimes and browsers

mdwn has one test command for the application contract and separate commands for
fast layers:

```sh
npm test             # Node unit tests, then Workers-runtime tests
npm run test:all     # npm test, a production Worker build, and all browser engines
npm run verify      # local preflight: every CI check, then all browser engines
```

## Linting and formatting

Biome (`@biomejs/biome`, pinned) is the formatting and lint guardrail:

```sh
npm run lint    # Biome plus scoped operational safety checks, read-only
npm run format  # biome format --write: apply the formatter
```

The `CI` workflow runs `Lint and format check` before `Typecheck`, and
`npm run verify` runs the same step first, so static checking is no longer
`tsc -b` alone. The checks stay separate: Biome is not a type checker, and its
inference-based rules do not replace the TypeScript build.

`scripts/check-operational-safety.mjs` runs after Biome in the same lint command,
so both `CI` and clean-head `npm run verify` enforce it. The pinned Biome has no
`noProcessExit` rule; the repository check uses the installed TypeScript compiler
to reject Node process-exit calls (including imported/local aliases) only in
`scripts/lib/`. Command entrypoints own exit status. It also reads `git ls-files`
to reject tracked [reserved operational output paths](operations.md#local-artifacts-and-disposal),
even when ignored. It does not classify arbitrary SQL/JSON contents.

`tests/operational-safety-check.test.ts` exercises the check in disposable Git
repositories. `tests/operational-script-lifecycle.test.ts` runs actual command
entrypoints under a test-only controlled subprocess runner, with synthetic
SQLite data and filesystem permission/cleanup faults. The preload never runs a
real subprocess command or fetches a remote resource. `tests/sensitive-artifacts.test.ts`
exercises the actual sensitive writers, including overwrites, partial raw
command output, umask restoration and `0600` permissions. These are Node tests
in the normal `npm test`; the separate `db:restore:local` gate still exercises the
real installed Wrangler export/restore path with no remote resources.

`biome.json` is the only Biome config. The formatter matches the repo's existing
style (two-space indent, double quotes, semicolons, trailing commas,
120-column lines) and parses `app/app.css` with Tailwind directive support. It
ignores `.scratch`, `drizzle`, `vendor`, and the generated
`app/shared/namespace-v1/generated.ts` and `data-version.ts`; `.gitignore`
supplies the rest (build output, generated Worker types). The linter starts
from the recommended preset: `noNonNullAssertion` is off because the codebase
uses `!` deliberately, while `useOptionalChain`, `useTemplate`, and
`noBannedTypes` are off as noisy style rules. The organize-imports assist is
off, so `biome check` is formatter plus linter only.

When a rule fires, prefer changing the code. For an intentional pattern, add a
suppression directly above the flagged line with a one-line reason:

```ts
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips C0 control characters from export file names.
```

Use a `//` line immediately above the flagged line; inside a JSX attribute
list it can sit between attributes, and as a JSX child use `{/* ... */}`. For
a single-purpose file, `// biome-ignore-all lint/<group>/<rule>: reason` at
the top suppresses the whole category. `useExhaustiveDependencies` can ignore
one dependency by name:
`// biome-ignore lint/correctness/useExhaustiveDependencies(name): reason`.
Never run `biome check --write --unsafe` without reviewing each change.

## TypeScript project boundaries

`npm run typecheck` builds the root `tsconfig.json` solution, which references
two composite projects. For a script-only change, `npm run typecheck:node`
builds just the Node tooling project and skips the Wrangler/React Router type
regeneration:

- `tsconfig.node.json` owns the Node tooling target: scripts, Node tests,
  Playwright specs, and the portable application modules under
  `app/shared/**/*.ts`.
- `tsconfig.cloudflare.json` owns the Workers target: the full `app/` tree,
  `workers/`, generated Worker bindings, and the workerd tests under
  `tests/worker/`. It also includes `scripts/lib/d1-query-plans.mjs` because
  `tests/worker/query-plans.test.ts` imports the reviewed plan table; that is a
  typecheck edge, not deployed code.

Application source is classified by the target that compiles it, not by the
`.server` suffix alone:

- `app/shared/<feature>/**/*.ts` is the shared layer: `.ts` modules that both
  the Node tooling target and the Workers/browser application compile. A SQL
  fragment used by Node query tooling belongs here. Keeping the `.server.ts`
  suffix on server-only SQL still triggers React Router's client-bundle guard:
  the suffix means "never import from client code", not "requires Cloudflare
  `Env`". The shared layer is TypeScript-only; `.tsx` UI stays in the feature
  directory and is never part of the Node target.
- The rest of `app/` and all of `workers/` belong to the Workers/browser
  application only: `app/routes/**`, `app/routes.ts`, `app/context/**`, `.tsx`
  UI modules, Worker-only `.server.ts` modules that consume the generated `Env`
  binding or route context, and feature-local browser modules that Node tooling
  does not import.
- `scripts/**`, `tests/**` (except `tests/worker/`), and `e2e/**` are Node-only
  tooling and stay out of the deployed Worker graph. Two typecheck edges cross
  on purpose: the Workers project compiles `tests/support/**` for its own
  tests, and both projects compile `scripts/lib/d1-query-plans.mjs` because the
  Worker query-plan test imports the reviewed plan table.

To add portable application code — including a SQL fragment shared with Node
tooling — put it under `app/shared/`, normally in the owning feature's
`app/shared/<feature>/` directory; a module with no feature owner (such as
`opaque-id.ts`) sits at the shared root. Both projects discover it through
their existing globs; no per-file tsconfig entry is needed. Worker-only server modules stay next to their feature as `.server.ts`
and are intentionally absent from the Node project, so a shared module that
imports one fails the Node typecheck.

`tests/typescript-boundaries.test.ts` guards this contract. It drops a probe
module into the shared area, resolves both projects through the TypeScript
compiler's own config parser, and asserts the probe is in both file lists while
Worker-only entrypoints are not in the Node project.

## Workers runtime

`npm test` runs both Vitest configurations. The first uses the Node environment
for renderer-free unit tests, including simulated old/new deployment responses
and bounded readiness retries. The second uses
`@cloudflare/vitest-plugin` with `wrangler.jsonc`, so tests execute in the same
Workers runtime (`workerd`) and bindings shape as the application. It is not a
second server or a Node mock. The Worker suite also checks that `/healthz`
reports the runtime's version-metadata binding.

Worker tests are typechecked by `tsconfig.cloudflare.json`, alongside the
application and generated Worker bindings. The Node project excludes this
directory. Shared JSON fixtures use import attributes, so the Worker project
uses `ESNext` modules.

The Worker test configuration supplies the committed D1 migrations and a
test-only Session signing key through Miniflare bindings. Tests that need D1
apply those migrations with `applyD1Migrations` from `cloudflare:test`; they
do not recreate the schema or connect to a remote database.

Put server-side tests that need the Worker runtime in
`tests/worker/**/*.test.ts`. Route and request-boundary tests must import `SELF`
from `cloudflare:test` and exercise the Worker through `SELF.fetch(...)`.
Schema constraints and atomic storage invariants without a public route may
be tested directly through real D1 bindings and storage helpers in workerd.
These tests supplement route coverage; they do not replace it or justify
production test endpoints. Use the real Web Platform APIs in that target.
Tests outside `tests/worker/` remain Node tests. The normal
`npm test` command runs both targets, and a failing target stops the command.

`tests/worker/cross-engine.test.ts` is the small contract test: it fetches the
application route and runs the fixed AES-GCM WebCrypto vector. The same vector
is run in the browser suite, so a change that only works in Node or Chromium
cannot silently pass.

## Real-browser suite

The browser suite runs the built Worker through Wrangler's
`createTestHarness()`. It does not start a Node HTTP server or mock the route.
`npm run test:e2e` builds the Worker before launching Playwright. Install the
browser binaries once on a development machine:

```sh
npx playwright install chromium firefox webkit
npm run test:e2e
```

With Node 24 / Playwright 1.63, a cold install can fail after about five seconds
while reporting a 30-second timeout: Playwright's IPv6-first fallback delay
races Node's default global-agent timeout before the connection is established.
CI preloads `scripts/playwright-download-network.mjs` only for browser installation,
matching the agent's connection budget to Playwright's 30-second default. TLS
verification, address-family selection, and browser tests remain unchanged.
If affected locally, use the same download-only workaround from the repo root:

```sh
NODE_OPTIONS='--import=./scripts/playwright-download-network.mjs' npx playwright install chromium firefox webkit
```

Remove the workaround after an upstream fix is verified with an empty browser
cache on the runner's network, not just an install that reuses cached binaries.

The configured Playwright projects are named `chromium`, `firefox`, and
`webkit`. To focus on one engine:

```sh
npm run test:e2e -- --project=firefox
```

Every browser spec imports `test` and `expect` from `e2e/fixtures.ts`. The
fixture starts the built Worker, supplies its current `baseURL`, resets local
Worker storage after each test, and prints a Wrangler diagnostic timeline when
a test fails. Add a later browser test as another `e2e/*.spec.ts` file using
that fixture; no Playwright project or Worker-harness configuration change is
needed.

The contract suite also demonstrates the browser seams later cryptographic and
device work will use. Those tests deliberately use a harness-owned IndexedDB
schema and a shared test Account identifier, not a production Encryption-device
store. `e2e/auth-sign-in.spec.ts` separately seeds Accounts with passkeys and
signs in through the real routes and checks fetcher revalidation. The
Account-security SSR shell is checked through `SELF.fetch` in the Workers suite. `e2e/signup.spec.ts`, `e2e/signup-integrity.spec.ts`,
and `e2e/device-store.spec.ts` exercise real signup, device enrollment, local
recovery confirmation before any signup request, and persisted key handles
through the same Worker/browser/engine harness.

Use real signup only when signup itself is under test, or for the single
signup-to-Files golden path in `private-tree-flow.spec.ts`. Tests that need an
existing fully provisioned Account use `seedAccount` from
`e2e/support/seeded-account.ts`, then `signInAccount` when they need a Session.
The seed creates device keys through the production browser device store,
uses production vault/profile/recovery crypto, and inserts signup-equivalent
D1 rows with a real virtual-authenticator Passkey. It runs no signup ceremony
or proof of work. Its recovery phrase and codes support real recovery routes;
its Passkey can be synced into another context for real device enrollment.
The atomic-signup test and seeded sign-out/sign-in test share
`e2e/support/signup-shape.ts` to detect storage-shape drift.

Assertions entirely about server responses/storage belong in the Workers suite,
not in Playwright merely to generate a valid request. The signup verification
Worker fixture generates genuine crypto material, solves the unchanged app
proof of work, and supplies software WebAuthn `none` attestation. A successful
unaltered commit guards the validity of the helper used by rejection tests.
These changes do not reduce Chromium, Firefox, or WebKit coverage of remaining
browser flows. See [ticket 36 measurements](browser-suite-signup-benchmark.md).

`e2e/editor-workspace.spec.ts` exercises the real Files routes and encrypted
save resource across all three engines, including UTF-8 source limits, whole
edit rejection, composition and paste, debounce/shortcut flushing, navigation
warnings, stale-revision overwrite confirmation, legacy reduction, and
same-browser editing leases. `e2e/workspace-fixture.ts` seeds local D1 and a
Session at the external storage/authentication boundary; its harness-only
script creates real browser key handles and signs the real Directory listing
protocol. No production test route or persisted draft store is introduced.
The File save API invariants run through `SELF.fetch` in
`tests/worker/private-tree.test.ts`, with supplemental real-D1 rollback checks.
`e2e/publications.spec.ts` publishes through the Publish panel and opens the
Public link in a fresh anonymous context; it checks wire-level requests (URL
without the never-transmitted fragment, headers and body), cookies, console
messages and every D1 table for the fragment capability.

Use existing UI links for in-app navigation. When a test intentionally replaces
an already-ready Files/device-access document (for example, opening a shared
File link with a fragment), first use `waitForSharedProvisioning` from
`e2e/support/navigation.ts`. A ready heading can precede the background fetcher's
lazy route import; cancelling that import in WebKit can make React Router reload
the old URL. The region stays busy from its initial render through its first
result, so initial idle cannot be mistaken for completion. The workspace fixture
includes this readiness check before yielding.
Keep explicit reload, deep-link, and fragment-privacy assertions; do not hide
navigation errors with retries, fixed sleeps, or a global `networkidle` wait.

- `window.isSecureContext` and AES-GCM WebCrypto;
- a non-extractable `CryptoKey` structured-cloned into IndexedDB and recovered
  after closing and relaunching a persistent browser profile; and
- two separate browser processes with independent storage for two devices of
  the same test Account.

Use persistent contexts for restart tests and separate contexts/processes for
multi-device tests. Do not use the shared default Playwright context when the
purpose of a test is storage isolation.

## CI output

The `CI` workflow runs on the bounded `mini-m4pro-ci` ARM64 Mac mini pool. All CI jobs must
pass at the current PR head before merging (see AGENTS.md). The persistent
runner keeps npm's cache locally; CI disables `setup-node`'s GitHub cache
restore/upload, which would otherwise transfer the account's entire npm cache.

The `browser` CI job runs a non-fail-fast matrix with one job for each engine.
Each job uses one Playwright worker; the local worker default stays automatic.
Node Vitest uses at most two workers in CI, and Workers Vitest retains its
two-worker limit. Verification and all browsers remain independent; the active
runner listeners cap aggregate jobs across refs and repositories.
A two-worker CI trial was rolled back after it pushed Firefox's heaviest tests
past their timeouts on the two-vCPU runners. See [the worker-count pilot and rollout record](playwright-workers-benchmark.md)
for the evidence.

The job name and Playwright list reporter identify the failing engine directly.
Each matrix job uploads `playwright-report/` plus `test-results/`, including
screenshots, videos, and traces retained for failures. These artifacts can
contain page and application details; keep them within the repository's CI
retention/access policy and never put real credentials in browser fixtures.
CI also writes `playwright-results.json` and a compact `playwright-summary.json`
with retry, flaky, failed, skipped, and timeout counts. Artifact names include
the browser, run ID, and attempt; inspect retry counts even on a green run.
The early runner diagnostic step verifies absolute writable cache/temp paths,
native architecture, and tool-cache containment. Service environments and
capacity qualification are documented in [ci-runner-pool.md](ci-runner-pool.md).

The auth fixture installs Playwright’s virtual WebAuthn authenticator. Linux WebKit can lack the native `PublicKeyCredential` constructor, with Playwright supplying an object placeholder; the fixture replaces a non-function value with a constructor so SimpleWebAuthn reaches the virtual authenticator. This shim is confined to the test BrowserContext; application feature detection and Worker verification remain unchanged.

## Acceptance suite (ticket 33)

[`docs/acceptance.md`](acceptance.md) maps every buildable-spec §12 criterion
to its evidence and defines the release-candidate gate. Three suites were added
for criteria the per-feature tests left implicit:

- `tests/worker/acceptance-privacy.test.ts` seals a unique sentinel into a
  private name, Markdown/front matter, Comment body, and displayed pseudonym,
  opens the stored ciphertext with browser-held capabilities, then sweeps every
  D1 table and every private/anonymous response for the sentinels. It also
  pins the passkey/content-envelope separation.
- `tests/worker/import-shared-target.test.ts` drives the full Import protocol
  from a read/write Directory Collaborator's own device-bound Session, proving
  target-Owner assignment, unchanged Grant authority, and pre-commit
  invisibility to tree, direct-read, and owned-export query classes.
- `e2e/accessibility.spec.ts` is keyboard-only in Chromium, Firefox, and
  WebKit: it creates a File through a labelled modal, operates the narrow tree
  drawer, and pins the accessible names/roles of the editor, preview, save
  status, thread tabs, and Comment composer.

The disposable remote Workers Free + D1 release gate is
`node scripts/import-proof.mjs`; it covers the Import protocol plus a
maximum-source create/save, staged Replace invisibility, one-byte-over
rejection, active-Publication paired updates, stale-conflict preservation, and
missing-sequence rejection. See [`docs/acceptance.md`](acceptance.md) for the
full evidence map and known boundaries.
