# Testing across runtimes and browsers

mdwn has one test command for the application contract and separate commands for
fast layers:

```sh
npm test             # Node unit tests, then Workers-runtime tests
npm run test:all     # npm test, a production Worker build, and all browser engines
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
signs in through the real routes; it also checks the Account-security SSR shell
and fetcher revalidation. Ticket 08 will replace seeding with signup and device
enrollment without changing the Worker/browser/engine harness.

- `window.isSecureContext` and AES-GCM WebCrypto;
- a non-extractable `CryptoKey` structured-cloned into IndexedDB and recovered
  after closing and relaunching a persistent browser profile; and
- two separate browser processes with independent storage for two devices of
  the same test Account.

Use persistent contexts for restart tests and separate contexts/processes for
multi-device tests. Do not use the shared default Playwright context when the
purpose of a test is storage isolation.

## CI output

The `browser` CI job runs a non-fail-fast matrix with one job for each engine.
The job name and Playwright list reporter identify the failing engine directly.
Each matrix job uploads `playwright-report/` plus `test-results/`, including
screenshots, videos, and traces retained for failures. These artifacts can
contain page and application details; keep them within the repository's CI
retention/access policy and never put real credentials in browser fixtures.

The auth fixture installs Playwright’s virtual WebAuthn authenticator. Linux WebKit can lack the native `PublicKeyCredential` constructor, with Playwright supplying an object placeholder; the fixture replaces a non-function value with a constructor so SimpleWebAuthn reaches the virtual authenticator. This shim is confined to the test BrowserContext; application feature detection and Worker verification remain unchanged.
