# 02: Cross-engine test harness: Worker test target + Chromium, Firefox, WebKit

**What to build:** One command that proves mdwn's browser-side cryptography, IndexedDB device persistence, and UI behaviour in Chromium, Firefox, WebKit, and the Worker test target — so no later ticket can be accepted on "works in Chrome".

**Blocked by:** 01 (Project foundation).

**Status:** ready-for-agent

- [ ] Unit and integration tests run against the Workers runtime in the Worker test target, reachable through the project's normal `npm test` (no separate toolchain for server-side tests).
- [ ] Browser tests run against a real app instance in Chromium, Firefox, and WebKit, with a CI job that fails if any engine fails and reports which engine failed.
- [ ] The harness supports WebCrypto-heavy tests in a secure context, IndexedDB persistence across a full browser restart, and multi-context scenarios (two independent devices/browsers signed into the same Account).
- [ ] A sample test proves one app route and one WebCrypto operation behave identically in all three engines and in the Worker test target.
- [ ] Test failures expose readable engine-attributed output in CI logs and artifacts.
- [ ] The harness is documented well enough that a later ticket adds a test without touching harness configuration.
