# 59: Upgrade Playwright to 1.64 once WebKit's Keychain access is approved

**What to build:** Move the browser suite from Playwright 1.63.0 to 1.64.0, whose Firefox fixes the lost first COOP navigation, and drop the Firefox-only COOP preference that [56](56-pre-launch-polish.md) uses meanwhile.

**Type:** test infrastructure

**Status:** needs-triage

**Blocked by:** a person approving the new WebKit's Keychain prompt on every Mac that runs the suite.

**Related:** [56: pre-launch polish](56-pre-launch-polish.md); [`docs/testing.md`](../../../docs/testing.md); [microsoft/playwright#42731](https://github.com/microsoft/playwright/issues/42731) and its fix [#42788](https://github.com/microsoft/playwright/pull/42788); [Keychain prompt report #20850](https://github.com/microsoft/playwright/issues/20850).

## Why it waits

During 56, a parallel session upgraded to 1.64 and measured the Firefox fix: a plain-HTML COOP repro stalled 71 of 200 times on 1.63.0 and 0 of 200 on 1.64.0, and a 200-repetition publication loop passed. But 1.64's WebKit (`webkit-2370`) asks for access to the **Playwright WebCrypto Master Key** Keychain item the first time it stores a non-extractable `CryptoKey` in IndexedDB. On the maintainer's MacBook, macOS's SecurityAgent has waited for an answer since 2026-10-12 01:31, right after that WebKit was installed, and every WebKit test that stores a device key hangs until someone answers. The CI Mac mini's runner account holds the same Keychain item for the older WebKit, so its WebKit job will most likely wait in the same way (up to its 60-minute timeout).

## Steps

1. On each Mac that runs the suite (the development MacBook and the CI runner account on the Mac mini), run a WebKit test with 1.64's WebKit and choose **Always Allow** at the prompt. Do not automate Keychain access, delete the item, or export keys.
2. Bump `@playwright/test` to `^1.64.0` (lockfile: `playwright` and `playwright-core` 1.64.0), run `npm ci`, and install the browsers with the download preload from `docs/testing.md`.
3. In `e2e/support/passkey.ts`, prime a synced Passkey only when the copied credential's `signCount` is zero: 1.64 keeps the counter, and an extra assertion exhausts the enrollment fixture's catch-up attempts.
4. Remove the `firefoxUserPrefs` COOP preference from `playwright.config.ts` and update `docs/testing.md`.
5. Run the full three-engine suite and `npm run verify`, then let CI pass at the PR head.

## Acceptance criteria

- [ ] All three browser projects pass on 1.64 locally and in CI, with COOP enforced by Firefox again.
- [ ] No Keychain prompt is pending on either Mac after the run.

## Comments

- 2026-10-12: The maintainer kept this ticket out of the combined 53/57/58 pull request until **Always Allow** has been chosen for 1.64's WebKit Keychain prompt on both Macs. No Keychain prompt was pending on the development MacBook at that time (no `SecurityAgent` process), and `webkit-2370` is installed there. Nobody has confirmed the CI Mac mini runner account.
