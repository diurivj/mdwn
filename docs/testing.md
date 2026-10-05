# Testing across runtimes and browsers

mdwn has one test command for the application contract and separate commands for
fast layers:

```sh
npm test             # Node unit tests, then Workers-runtime tests
npm run test:all     # npm test, a production Worker build, and all browser engines
npm run verify      # local preflight: every CI check, then all browser engines
```

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

The `CI` workflow runs on the repository-scoped Mac mini. All CI jobs must
pass at the current PR head before merging (see AGENTS.md). The persistent
runner keeps npm's cache locally; CI disables `setup-node`'s GitHub cache
restore/upload, which would otherwise transfer the account's entire npm cache.

The `browser` CI job runs a non-fail-fast matrix with one job for each engine.
Each job uses one Playwright worker; the local worker default stays automatic.
A two-worker CI trial was rolled back after it pushed Firefox's heaviest tests
past their timeouts on the two-vCPU runners. See [the worker-count pilot and rollout record](playwright-workers-benchmark.md)
for the evidence.

The job name and Playwright list reporter identify the failing engine directly.
Each matrix job uploads `playwright-report/` plus `test-results/`, including
screenshots, videos, and traces retained for failures. These artifacts can
contain page and application details; keep them within the repository's CI
retention/access policy and never put real credentials in browser fixtures.

The auth fixture installs Playwright’s virtual WebAuthn authenticator. Linux WebKit can lack the native `PublicKeyCredential` constructor, with Playwright supplying an object placeholder; the fixture replaces a non-function value with a constructor so SimpleWebAuthn reaches the virtual authenticator. This shim is confined to the test BrowserContext; application feature detection and Worker verification remain unchanged.
