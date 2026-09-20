# 02: Cross-engine test harness: Worker test target + Chromium, Firefox, WebKit

**What to build:** One command that proves mdwn's browser-side cryptography, IndexedDB device persistence, and UI behaviour in Chromium, Firefox, WebKit, and the Worker test target — so no later ticket can be accepted on "works in Chrome".

**Blocked by:** 01 (Project foundation).

**Status:** done

- [x] Unit and integration tests run against the Workers runtime in the Worker test target, reachable through the project's normal `npm test` (no separate toolchain for server-side tests).
- [x] Browser tests run against a real app instance in Chromium, Firefox, and WebKit, with a CI job that fails if any engine fails and reports which engine failed.
- [x] The harness supports WebCrypto-heavy tests in a secure context, IndexedDB persistence across a full browser restart, and multi-context scenarios (two independent devices/browsers signed into the same Account).
- [x] A sample test proves one app route and one WebCrypto operation behave identically in all three engines and in the Worker test target.
- [x] Test failures expose readable engine-attributed output in CI logs and artifacts.
- [x] The harness is documented well enough that a later ticket adds a test without touching harness configuration.

## Comments

- 2026-09-19: Added the Workers Vitest target, a Wrangler `createTestHarness()` Playwright fixture, Chromium/Firefox/WebKit projects, secure-context AES-GCM coverage, IndexedDB CryptoKey restart coverage, independent multi-device contexts, CI engine matrix diagnostics, and `docs/testing.md`. `npm run test:all` passes all Node, Worker, and 9 browser tests.
- Scope note: the foundation has no Account sign-in or production device-store module yet, so the multi-device and restart cases exercise the documented harness seams with harness-owned test state; later auth/device tickets replace that setup without changing the harness configuration.
