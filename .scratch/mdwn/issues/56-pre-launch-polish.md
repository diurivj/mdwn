# 56: Pre-launch polish: navigation, library workspace, recovery downloads and chosen pseudonyms

**What to build:** The maintainer's pre-announcement review list. Say why mdwn exists, keep signed-in people out of sign-in, make the header identical in shape for visitors and Accounts, tidy the workspace and its copy, replace the navigation progress bar with immediate destination placeholders, fix the "Navigation interrupted" flash after creating a File, let people choose their Public pseudonym (including at signup), offer recovery material as a text download, and remove the avoidable network round trips that make every private page slow.

**Type:** feature

**Status:** ready-for-agent

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
- Every place that shows a recovery phrase or recovery codes offers a plain `.txt` download of exactly that material, with storage guidance. Phrase and codes stay separate files, matching the existing advice to store them apart.

### Performance

- Hashed static assets are served `immutable` for a year.
- `/files` opens the library root without a redirect and a second bootstrap.
- A workspace navigation fetches the remembered expanded folders together with the selected path, instead of one level per extra round trip.
- Private authorization reads its Session and the bound Encryption device/registry concurrently, removing a sequential D1 round trip while preserving React Router's D1-backed Session-storage authority.
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
- [x] Recovery phrase and codes can be downloaded as `.txt` wherever they are shown.
- [x] `/assets/*` responses are immutable; `/files` performs one bootstrap; remembered expanded folders are prefetched alongside the selected path (up to 24); private authorization reads Session/device state concurrently.
- [ ] Standards/Spec review and the separate RR8/stack gate cover the final diff; clean-head `npm run verify` evidence is recorded with the PR.

## Comments

- Continuation: retained the parallel Session/device reads rather than replace React Router's authoritative Session-storage read with a separate joined-query implementation. This removes the sequential round trip, not the number of queries. Remembered folders beyond the bounded 24-folder prefetch still load level by level; neither optimization changes authorization or freshness rules.
- Review fixes: restored Files access in both Account menus and kept the workspace header's primary Open library control. Support remains directly visible at narrow widths. Stale-device sign-in now navigates to Files access with a sign-in-again prompt; only another fresh Passkey assertion binds a new Session. Browser tests use Account-menu links rather than cancelling live provisioning with document navigation, and wait for decrypted Account content rather than an optimistic placeholder heading.
- Two-axis review findings resolved in follow-up inspection and regressions: **Standards: Pass; Spec: Pass**. Final code scope is `git diff 414d912ef5f2338153639cdb3377a5d10d48bd64`, including working-tree changes, SHA256 `0f2b5b284f536fcc6e9d67dce64b431141e1194e38c8632f64310197acd4fce2`; this checklist/comment is the only subsequent change. **Separate RR8/stack gate: Pass.** Checked RR 8.4.0, current client-data/fetcher/race-condition docs, route/type contracts, public HydrateFallbacks, browser-only profile/recovery handling, native mutation/revalidation paths, abort-aware navigation, authoritative D1 Session storage and unchanged guarded read/write authority. The immutable asset response, stale-registry sign-in, signup/download ceremony and pending-page tests pass in all three engines (12 checks); public and authenticated mobile/header/width checks pass in all three engines (9 checks). Desktop/mobile screenshots inspected. Clean-head preflight evidence will be recorded in the PR; it remains pending here until that run completes.
- Product/infrastructure decisions remain in tickets 57 and 58, not silently implemented. In particular, the observed production Cloudflare analytics injection needs maintainer action before the existing no-analytics claim can be relied on; no production settings were changed.
