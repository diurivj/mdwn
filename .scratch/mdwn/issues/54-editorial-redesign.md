# 54: Adopt the Editorial design system, add a landing page and site navigation, and make the workspace fast

**What to build:** mdwn is functionally ready but reads as a prototype: unstyled pages, no landing page, no way to move between Files, Account and devices, and a Files workspace that feels slow. Adopt the Editorial design system archived in `../demon-mvp` (variant A: cream paper, wine accent, Instrument Serif display type over Geist text) across every page, add a public landing page and persistent navigation, and remove the avoidable network waterfall behind workspace navigation.

**Type:** feature

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [15: editor and preview workspace](15-editor-and-preview-workspace.md); [45: Publish panel](45-publish-panel-mutations-unified.md); `docs/serving-and-security.md` (SSR shell boundary); `../demon-mvp` Editorial style guide (design source, not a dependency).

## Design system

Design source: `../demon-mvp/.prototypes/style-variants-2026-10-10.tgz`, confirmed by that project's README. Archive members `src/app/globals.css`, `src/components/home/hero.tsx`, `src/components/section-heading.tsx`, and `src/app/_style-prototype/style-prototype.tsx` define variant A (Editorial). The adaptation retains all 16 used palette values, the serif/sans pairing, responsive page measure, eyebrows, rounded controls, drawers, and reduced-motion treatment; retail imagery/copy is replaced with Markdown-specific illustrations and content.

- Tokens, typography and component recipes live in `app/app.css` (`@theme` colors, `eyebrow`, `container-page`, `.prose-editorial`, drawer/popover/modal/skeleton recipes) and `app/ui/` (`styles.ts` button/field/notice classes, line icons, layouts, header, footer, logo).
- Instrument Serif and Geist are pinned `@fontsource` packages served as first-party assets; CSP `font-src 'self'` is unchanged and nothing loads from a CDN.
- Pages compose `PageIntro`, `FocusLayout` (sign-in, sign-up, recovery, enrollment) and `AccountLayout` (Account pages with an Account section nav). Reduced-motion users get no decorative motion.

## Navigation and pages

- Sticky site header: public navigation for visitors, Files/Account/Devices/Support plus an Account menu (popover) and Sign out for signed-in browsers; a dialog drawer on narrow screens. Session presence is the boolean `/api/auth/session` answer read after hydration, so the server-rendered shell is identical for everyone.
- Routes declare `handle.chrome` (`site`, `account`, `workspace`, `reader`); Public pages (`/p/:linkId`) keep a bare reader shell with no site navigation.
- New landing page at `/` (how it works, what mdwn can't see, publishing, questions). It makes no claim about features the UI does not offer.
- New `/files` route: a stable "my Files" address that opens the root Directory, or hands over to device access when this browser cannot open Files yet.
- Files workspace: sidebar tree (drawer on narrow screens), breadcrumbs, title row actions, structure toolbar, folder contents view, Edit/Preview/Comments panes, restyled dialogs, Export and Import cards, and skeleton fallbacks that match the loaded layout.
- Sign-in and sign-up lead to "Open your Files"; sign-up explains the phrase/codes/passkey steps before starting.

## Performance

- Files navigation walked the tree with sequential private requests, each preceded by its own registry-state read: a File two folders deep took eleven round trips before anything rendered. The walk now sends independent requests together (root bootstrap with the path; every listing on the path with the File) and still opens keys strictly down the verified path, surfacing failures in walk order. Measured at 80 ms emulated latency: four round trips for the same File.
- Concurrent private operations within the same abort-signal lifetime share one in-flight registry-state read; every operation that starts after it settles reads again. Different navigation signals never share a pending read, so a cancelled loader cannot supply an old Session binding to a new navigation. Sequential refresh/denial semantics are unchanged.
- The editor preview renders from `useDeferredValue` behind `memo`, so typing never waits on Markdown rendering. A navigation progress bar acknowledges every route transition.
- Hydration fix: React Router's split route modules moved every route's `HydrateFallback` into a chunk the client manifest never referenced, so hydration rendered the root's default fallback, failed to match, and left the server-rendered fallback page in the document beside the real one (two `main` landmarks on every private route, already present on `main`). `splitRouteModules: false` keeps route modules whole; an E2E check asserts one `main` after hydration.

## Acceptance criteria

- [x] Every page uses the Editorial tokens, type, and components; no page keeps the prototype stone/rose styling.
- [x] Landing page at `/`; persistent header/footer navigation; Account section navigation; mobile drawer; `/files` entry point.
- [x] Private plaintext and Account data stay out of SSR; the header reads only the Session boolean after hydration.
- [x] Files navigation sends independent private requests concurrently without weakening per-operation proofs, cancellation boundaries, or the fresh registry read for sequential operations.
- [x] Hydrated private routes contain one page, not the server fallback plus the page.
- [x] Existing accessible names, roles and texts used by the browser suite are preserved.
- [x] Standards/Spec review and a separate RR8/stack gate cover the final pinned implementation.
- [ ] Merge gate: clean-head `npm run verify` evidence is recorded with the PR, and every current-head `CI` job must pass before merge. Recording that evidence in the PR avoids changing the already-verified commit.

## Scope and pointers

- `app/app.css`, `app/root.tsx`, `app/ui/*`, `app/landing/*`, `app/routes/*.tsx` (pages), `app/routes.ts`.
- `app/tree/*` (workspace, editor, fallback, navigation walk), `app/comments/*`, `app/publications/publish-panel.tsx`, `app/export/export-control.tsx`, `app/import/import-control.tsx`, `app/sharing/shared-provisioning.tsx`.
- `app/shared/device/private-client.ts` (shared registry read, `privateExchange`), `app/shared/tree/client.ts` (fetch/open halves), `app/device/access-client.ts`.
- `react-router.config.ts`, `docs/serving-and-security.md`, `e2e/private-tree-shell.spec.ts`, `tests/support/cross-engine-vector.ts`.

Out of scope: share-management UI (no UI creates or manages Shares today, so the landing page does not advertise sharing), indexing (every response stays `noindex` by spec), immutable caching headers for hashed static assets.

## Comments

- 2026-10-11: Resumed the uncommitted implementation in `../mdwn-editorial` on `issue/54-editorial-redesign`, preserving unrelated ticket-53 files in the main checkout. Verified the archived design palette and inspected desktop/mobile landing and workspace screenshots. Installed the locked font dependencies with `npm ci`.
- 2026-10-11: Added browser coverage for first-party fonts, landing sections, keyboard-operated mobile navigation, `/files`, Account navigation, responsive workspace layout, and parallel File/listing reads before verified rendering. Reproduced and fixed header sign-out bypassing the unsaved-File blocker (navigation `Form` rather than a fetcher), stale Session responses overriding completed sign-out, and the existing provisioning test waiting for the obsolete split-module filename. Those focused checks passed in Chromium, Firefox, and WebKit.
- 2026-10-11: Initial pinned review used base `610e8b6d715750cb1d7a44c2cd675c28afdbf58d` and tree `03cd0bccf732cf9a5f950349f79f511071d89c22`. Standards: no blockers; one advisory about duplicated Account destination descriptors, retained because the menus have intentionally different composition. Spec: fixed three findings (cross-tab Session navigation reconciliation, wrapping long mobile confirmation labels, and honest-client privacy wording). Separate RR8/stack gate: fixed cancelled-loader registry-read reuse by scoping coalescing to the abort-signal lifetime. Added red/green cross-tab and narrow Unpublish tests.
- 2026-10-11: Initial full regression before the review corrections: 403 Node + 382 Workers tests passed; browser suite 452 passed, one existing WebKit synthetic FileSystemEntry drag-and-drop case skipped. These initial results are not a final-head gate.
- 2026-10-11: Follow-up review of tree `98397633ecd63b5acb533f3e333d2b3703577aad` passed Standards and confirmed the prior corrections, but identified a held cross-tab Session read surviving a new location. Centralized invalidation now supersedes reads on authentication changes, new locations, focus, and final subscriber cleanup while retaining same-location deduplication. A real two-tab, held-response regression failed before the correction and passed afterward in every browser. Also verified failed header sign-out cannot be hidden by an earlier Account-action success; React Router's `fetcher.reset()` clears that older result.
- 2026-10-11: Final two-axis review of `9839763..40b99f95f7249fff7960be2284682c432aa2d824`: Standards **Pass**, Spec **Pass**, no new findings. Separate RR8/stack follow-up **Pass**: private request reads are abort-lifetime scoped, Session navigation remains a browser-only boolean subscription, stale completions cannot clear/publish over newer reads, navigation Forms preserve draft blockers, and Worker/D1/resource authority is unchanged. Installed RR 8.4.0 contracts and current client-data/fetcher/race documentation were checked. Verification so far: lint/typecheck/build, 17 real-WebCrypto lifetime tests, 39 focused cross-engine checks before the last Session refinement, and 24 cross-engine Session/workspace/review regressions afterward. Final clean-head preflight follows the commit; the PR carries its result. No merge or deployment is part of this continuation.
