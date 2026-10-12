# 56: Pre-launch polish: navigation, library workspace, recovery downloads and chosen pseudonyms

**What to build:** The maintainer's pre-announcement review list. Say why mdwn exists, keep signed-in people out of sign-in, make the header identical in shape for visitors and Accounts, tidy the workspace and its copy, replace the navigation progress bar with immediate destination placeholders, fix the "Navigation interrupted" flash after creating a File, let people choose their Public pseudonym (including at signup), offer recovery material as a text download, and remove the avoidable network round trips that make every private page slow.

**Type:** feature

**Status:** done

**Blocked by:** none.

**Related:** [54: Laboratorio redesign](54-editorial-redesign.md); [55: decorative numbering](55-remove-decorative-numbers.md); [24/pseudonym update](../../../docs/pseudonym-update.md); `docs/serving-and-security.md`.

## Scope

### Landing and navigation

- A "Why we built mdwn" section states the founding belief: in this agentic era, the only human thing we can still defend is our privacy. It makes no new product claims.
- The closing call to action uses equal-width, aligned buttons.
- The header keeps the same container, height and control shapes for visitors and Accounts. Signed-in navigation keeps only Support; Account destinations live in the Account menu, and the primary action opens the library.
- `/sign-in` and `/sign-up` redirect a device-bound Session to the library. An unbound Session may still sign in, because a fresh Passkey assertion is what binds it. A completed sign-in goes to the library (or, without an active Encryption device on this browser, to device access) instead of a notice.

### Library workspace

- The root of a person's Files is called **Library** in the sidebar, breadcrumbs and title; `/files` renders it directly. Repetitive "Files" labels that add nothing are removed.
- The sidebar's footer links share one list and one rhythm.
- The editor shows save instructions on the left and the save status on the right.
- Filled panels that only had top and bottom rules get complete borders.
- Creating or deleting through a dialog no longer reports its own completion navigation as "Navigation interrupted".

### Loading and motion

- Remove the top navigation progress bar.
- Navigation shows the destination's shape immediately: inside the workspace the clicked entry is selected, its name becomes the title and its content area shows a placeholder; entering the workspace or an Account page shows that layout's placeholder. Real content arrives with a short, reduced-motion-aware entrance.

### Accounts and recovery

- The Public pseudonym is chosen by the person, with a generated suggestion. Signup asks for it before any key material is created; the Public pseudonym page lets a person type a new one (still at most once every 30 days). The service still never sees a plaintext pseudonym.
- Every place that shows a recovery phrase or recovery codes offers it as a gzip-compressed text file (`.txt.gz`, as the maintainer asked), with the same text as a plain `.txt` beside it for places that cannot open `.gz`, and storage guidance. Both are made in the browser. Phrase and codes stay separate files, matching the existing advice to store them apart.

### Performance

- Hashed static assets are served `immutable` for a year.
- `/files` opens the library root without a redirect and a second bootstrap.
- A workspace navigation fetches the remembered expanded folders together with the selected path, instead of one level per extra round trip.
- Private authorization reads its Session and the bound Encryption device/registry concurrently, removing a sequential D1 round trip while preserving React Router's D1-backed Session-storage authority.
- Opening a Directory listing canonicalizes each entry name once to find duplicate siblings, instead of comparing every pair (which canonicalized both names again each time, quadratic in the listing).
- Changes that alter the private-request protocol, Worker placement or data freshness are documented for maintainer decision, not implemented.

## Acceptance criteria

- [x] Landing explains why mdwn exists; closing buttons are equal width and aligned on desktop and mobile.
- [x] Header shape is identical signed out and signed in on site, Account and workspace pages; signed-in navigation shows Support only, and the Account menu carries every Account destination.
- [x] A device-bound Session visiting `/sign-in` or `/sign-up` lands in the library; sign-in success navigates there.
- [x] Workspace root reads "Library"; no redundant single breadcrumb; sidebar footer spacing is uniform; editor status is on the right.
- [x] "Optional support only" and the other filled panels have complete borders.
- [x] No navigation progress bar; destination placeholders appear on navigation; reduced motion is respected.
- [x] Creating a File or folder never shows "Navigation interrupted" (browser regression).
- [x] People choose a Public pseudonym at signup and on the Public pseudonym page, with validation and a suggestion.
- [x] Recovery phrase and codes can be downloaded as `.txt.gz`, with a plain `.txt` alternative, wherever they are shown.
- [x] `/assets/*` responses are immutable; `/files` performs one bootstrap; remembered expanded folders are prefetched alongside the selected path (up to 24); private authorization reads Session/device state concurrently; a listing's duplicate-name check is linear.
- [x] Standards/Spec review and the separate RR8/stack gate cover the final diff; clean-head `npm run verify` evidence is recorded with the PR.

## Comments

- Continuation: retained the parallel Session/device reads rather than replace React Router's authoritative Session-storage read with a separate joined-query implementation. This removes the sequential round trip, not the number of queries. Remembered folders beyond the bounded 24-folder prefetch still load level by level; neither optimization changes authorization or freshness rules.
- Review fixes: restored Files access in both Account menus and kept the workspace header's primary Open library control. Support remains directly visible at narrow widths. Stale-device sign-in now navigates to Files access with a sign-in-again prompt; only another fresh Passkey assertion binds a new Session. Browser tests use Account-menu links rather than cancelling live provisioning with document navigation, and wait for decrypted Account content rather than an optimistic placeholder heading.
- Two-axis review findings resolved in follow-up inspection and regressions: **Standards: Pass; Spec: Pass**. Launch code scope was `git diff 414d912ef5f2338153639cdb3377a5d10d48bd64`, including working-tree changes, SHA256 `0f2b5b284f536fcc6e9d67dce64b431141e1194e38c8632f64310197acd4fce2`; the checklist/comment was the only addition in `a2ade2c`. **Separate RR8/stack gate: Pass.** Checked RR 8.4.0, current client-data/fetcher/race-condition docs, route/type contracts, public HydrateFallbacks, browser-only profile/recovery handling, native mutation/revalidation paths, abort-aware navigation, authoritative D1 Session storage and unchanged guarded read/write authority. The immutable asset response, stale-registry sign-in, signup/download ceremony and pending-page tests pass in all three engines (12 checks); public and authenticated mobile/header/width checks pass in all three engines (9 checks). Desktop/mobile screenshots inspected. Clean-head preflight evidence will be recorded in the PR; it remains pending here until that run completes.
- Product/infrastructure decisions remain in tickets 57 and 58, not silently implemented. In particular, the observed production Cloudflare analytics injection needs maintainer action before the existing no-analytics claim can be relied on; no production settings were changed.
- Browser-gate follow-up: the first clean-head run at `a2ade2c` passed all non-browser checks (413 Node, 386 Workers) and 474 browser checks, with two failures and one existing skip. The lost-signup-response test reproduced its WebKit interruption in three of five runs; a new cookie-absence assertion then exposed the fixture's retained Session. Dropping the intercepted response's synthetic Set-Cookie before abort/reload models the loss correctly; five WebKit repeats and Chromium/Firefox pass, while device persistence, one Account, two bound Sessions and proof guards remain asserted. The Firefox trace showed a hydrated sign-in page with completed requests while waiting for `load`; eight instrumented repeats did not reproduce that browser lifecycle stall. The cross-tab test now loads the new tab once and uses its hydration-gated button as readiness, then exercises real sign-in/out; three repeats per engine pass. No retries, timeout increases or debug instrumentation remain.
- Follow-up review scope: `git diff a2ade2cefbaa35066238eae649285017ea50e5b5`, working-tree test changes only, SHA256 `ff57af549dcf304fbc997bca42e7d8b44524c2cdc3df0661342f7c71adae1e5a`. Independent **Standards: Pass; Spec: Pass**, no findings. **Separate RR8/stack: Pass**: the two test changes exercise native navigation/fetcher sign-in, browser cookie loss before the public signup loader, IndexedDB device persistence and real proof-guarded resource calls. Route, loader/action, Worker, D1 and SSR contracts are unchanged. Checked installed/locked RR 8.4.0 and generated route types, framework config/route map, spec §3, serving §1, testing guidance and ADR-0002; lint, Node typecheck and all focused checks pass. This comment is the only subsequent change. Final clean-head preflight evidence belongs in the PR.
- Second clean-head gate at `d46a554` again passed all non-browser checks (413 Node, 386 Workers), with 474 browser passes, two failures and one existing skip. The WebKit signup-to-tree test now settles `/files` provisioning before its intentional root deep link. Equivalent private-document departures use the same readiness invariant and incidental navigation uses existing links; explicit SSR, deep-link, reload/persistence, access-expiry and capability checks remain.
- Firefox diagnosis: a plain local HTML/COOP repro stalled 71/200 times on Playwright 1.63.0 even though every stalled page had completed loading. `waitUntil: "commit"` also stalled. [Upstream #42731](https://github.com/microsoft/playwright/issues/42731) and [#42788](https://github.com/microsoft/playwright/pull/42788) identify the bundled Firefox/Juggler channel-ID correction in 1.64.0. The dependency/lockfile upgrade and fresh browser installation leave COOP and production code unchanged. The same minimal repro now stalls 0/200 times, and the publication-reconciliation Firefox application loop passes 200/200 with normal workers. Speculative new commit-wait options were removed, not retained as the fix. Virtual Passkey priming now respects 1.64's preserved copied `signCount`; the real enrollment/provisioning case passes Chromium and Firefox after the adaptation.
- Final evidence remains **pending**: upgraded WebKit stalls while storing a generated non-extractable `CryptoKey` in IndexedDB, reproduced independently of mdwn. A newly installed binary's macOS **Playwright WebCrypto Master Key** prompt is suspected ([upstream report](https://github.com/microsoft/playwright/issues/20850)), not yet confirmed locally. Human desktop confirmation is needed; no Keychain data was read or altered, no private-key export, skips, retries or longer suite timeouts were added. Current readiness/tooling changes need fresh Standards/Spec review, a separate RR8/stack gate, and a clean-head all-engine `npm run verify` before the branch/PR can be published.
- 2026-10-12, final pass after the parallel Codex session's readiness work (committed as `151303b`):
  - **Gzip downloads.** The maintainer asked for a gzip download of the recovery words. Every view that shows the phrase or the codes now saves `<name>.txt.gz` (CompressionStream, prepared before the click) with the same text as plain `.txt` beside it; without CompressionStream only the plain file is offered. The signup browser test saves both forms of each file and compares them; `tests/gzip.test.ts` round-trips through Node's zlib.
  - **Playwright stays on 1.63.0.** 1.64's WebKit waited for the *Playwright WebCrypto Master Key* Keychain prompt (macOS SecurityAgent pending since 01:31, right after `webkit-2370` was installed), so no WebKit run could finish without a person at this Mac or at the CI runner. The Firefox stall from microsoft/playwright#42731 is avoided by turning off COOP enforcement in the Firefox test browser only; the Worker still sends COOP and Chromium and WebKit still enforce it. Ticket 59 holds the 1.64 upgrade with the session's evidence (71/200 → 0/200 stalls) and the copied-Passkey counter change it needs.
  - **Large folders.** `openDirectory` found duplicate sibling names by comparing every pair, canonicalizing both names each time (about 280 ms for 500 entries in Node). It now canonicalizes each name once and uses a set of comparison keys; `tests/directory-listing-names.test.ts` signs real listings for both outcomes. The 500-entry over-cap test passed 14/14 repetitions in Chromium and Firefox and every full run since.
  - **Evidence.** Clean-head `npm run verify` passed at `a27e2e4`: lint, typecheck, namespace drift, 417 Node and 386 Workers tests, build, fresh-D1 smoke, export/restore, bundle-secret check, and 476 browser tests with the 1 existing WebKit skip, no failures and no retries. An earlier full run on the same tree also passed 476/1/0.
  - **Review** of `git diff 414d912..a27e2e4` (SHA256 `df2395195700db7ed7a20152c125894fb39a7b236b2ea91e0e7f7b539afd6526`), CODING_STANDARDS.md read first: **Standards: Pass; Spec: Pass**, no blocking findings. **Separate RR8/stack gate: Pass.** Sign-in and sign-up server loaders return only a redirect or null, with `.server` imports confined to them and `no-store` documents. `/files` and every private read stay in browser `clientLoader`s behind public `HydrateFallback`s. The pseudonym fetcher and sign-in `clientAction` keep their pending, invalid and redirect states. Private-request authority still comes from D1 Session storage and the unchanged read/write guards. Gzip and the listing check are browser-only and keep their semantics. Checked against installed RR 8.4.0, `app/routes.ts`, spec §3, serving §1, `docs/testing.md` and ADR-0002.
- 2026-10-12: Completed and merged into `main` via [PR #63](https://github.com/diurivj/mdwn/pull/63), merge commit `ad04d182f227a053d1702d6693811522191437fc`. Earlier pending verification notes are historical; tickets 57–59 remain separate follow-ups.
