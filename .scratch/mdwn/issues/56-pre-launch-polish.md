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
- Private authorization reads its Session, Encryption device and registry epoch in one D1 query.
- Changes that alter the private-request protocol, Worker placement or data freshness are documented for maintainer decision, not implemented.

## Acceptance criteria

- [ ] Landing explains why mdwn exists; closing buttons are equal width and aligned on desktop and mobile.
- [ ] Header shape is identical signed out and signed in on site, Account and workspace pages; signed-in navigation shows Support only, and the Account menu carries every Account destination.
- [ ] A device-bound Session visiting `/sign-in` or `/sign-up` lands in the library; sign-in success navigates there.
- [ ] Workspace root reads "Library"; no redundant single breadcrumb; sidebar footer spacing is uniform; editor status is on the right.
- [ ] "Optional support only" and the other filled panels have complete borders.
- [ ] No navigation progress bar; destination placeholders appear on navigation; reduced motion is respected.
- [ ] Creating a File or folder never shows "Navigation interrupted" (browser regression).
- [ ] People choose a Public pseudonym at signup and on the Public pseudonym page, with validation and a suggestion.
- [ ] Recovery phrase and codes can be downloaded as `.txt` wherever they are shown.
- [ ] `/assets/*` responses are immutable; `/files` performs one bootstrap; expanded folders do not add sequential round trips; private authorization uses one Session/device query.
- [ ] Standards/Spec review and the separate RR8/stack gate cover the final diff; clean-head `npm run verify` evidence is recorded with the PR.

## Comments
