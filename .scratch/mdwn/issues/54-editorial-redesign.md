# 54: Adopt the Laboratorio design system, add a landing page and site navigation, and make the workspace fast

**What to build:** mdwn is functionally ready but reads as a prototype: unstyled pages, no landing page, no way to move between Files, Account and devices, and a Files workspace that feels slow. Adopt the Laboratorio design system archived in `../demon-mvp` (variant D: warm-gray paper, thin ink rules, light Inter Tight headings and Courier Prime labels) across every page, add a public landing page and persistent navigation, and remove the avoidable network waterfall behind workspace navigation.

**Type:** feature

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [15: editor and preview workspace](15-editor-and-preview-workspace.md); [45: Publish panel](45-publish-panel-mutations-unified.md); `docs/serving-and-security.md` (SSR shell boundary); `../demon-mvp` Laboratorio prototype (design source, not a dependency).

## Design system

Design source: `../demon-mvp/.prototypes/style-variants-2026-10-10.tgz`, confirmed by that project's README. Archive members `src/app/_style-prototype/variant-d-laboratorio.tsx`, `prototype.css`, and `style-prototype.tsx` define variant D (Laboratorio). The user explicitly corrected the original Editorial selection to Laboratorio after reviewing all four variants. Preserve the existing navigation, performance and safety fixes; change presentation only. Keep this ticket/branch path for PR continuity, with the earlier Editorial review history below intact.

- Use warm gray `#eeece6`, ink `#151515`, secondary paper `#f7f6f2`, inset panels `#e6e3db`, thin rules, square controls, flat panels, numbered sections/index rows and specimen-style diagrams. No wine/pink palette, serif display type, pastel feature cards, floating shadows or rotating badge. Semantic status colors remain.
- Light Inter Tight headings with tight tracking; Courier Prime uppercase labels. Inter Tight and Courier Prime are pinned `@fontsource` packages served first-party; CSP `font-src 'self'` stays unchanged, with no font/style CDN. Editor source and code retain monospace; Markdown emphasis and readable Public-page typography remain.
- Tokens and recipes live in `app/app.css` (`@theme`, `eyebrow`, `container-page`, `.prose-markdown`, drawer/popover/modal/skeleton) and `app/ui/`. Actual status dots may stay round; controls and panels are square.
- Landing content adapts the guide/index/formula/specimen visual language to Markdown, not perfume-shopping behavior: a three-step getting-started guide, numbered feature index, encryption formula and Public-link specimen. No fake working editor, scent quiz, store or new product capabilities.
- Pages compose `PageIntro`, `FocusLayout` and `AccountLayout`. Preserve responsive layouts, browser-only private data, native navigation/dialog semantics, accessible names and reduced-motion support.

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

- [x] Every page uses Laboratorio tokens, type and components, including Account pages, workspace, dialogs, editor/preview and standalone Public reader; no Editorial serif/pastel/rounded-card remnants.
- [x] Landing page at `/`; persistent header/footer navigation; Account section navigation; mobile drawer; `/files` entry point.
- [x] Private plaintext and Account data stay out of SSR; the header reads only the Session boolean after hydration.
- [x] Files navigation sends independent private requests concurrently without weakening per-operation proofs, cancellation boundaries, or the fresh registry read for sequential operations.
- [x] Hydrated private routes contain one page, not the server fallback plus the page.
- [x] Existing accessible names, roles and texts used by the browser suite are preserved.
- [x] Standards/Spec review and a separate RR8/stack gate cover the final Laboratorio diff.
- [ ] Merge gate: clean-head `npm run verify` evidence is recorded with the PR, and every current-head `CI` job must pass before merge. Recording that evidence in the PR avoids changing the already-verified commit.

## Scope and pointers

- `app/app.css`, `app/root.tsx`, `app/ui/*`, `app/landing/*`, `app/routes/*.tsx` (pages), `app/routes.ts`.
- `app/tree/*` (workspace, editor, fallback, navigation walk), `app/comments/*`, `app/publications/publish-panel.tsx`, `app/export/export-control.tsx`, `app/import/import-control.tsx`, `app/sharing/shared-provisioning.tsx`.
- `app/shared/device/private-client.ts` (shared registry read, `privateExchange`), `app/shared/tree/client.ts` (fetch/open halves), `app/device/access-client.ts`.
- `react-router.config.ts`, `docs/serving-and-security.md`, `e2e/private-tree-shell.spec.ts`, `tests/support/cross-engine-vector.ts`.

Out of scope: share-management UI (no UI creates or manages Shares today, so the landing page does not advertise sharing), indexing (every response stays `noindex` by spec), immutable caching headers for hashed static assets.

## Comments

- 2026-10-11: Final Laboratorio review: base `c0d072891c33bbf6599282006461781e11f4a10c`, implementation tree `d7048787eef6ebeec5e5a7e9c1766fb50b6a15b4`. **Standards: Pass; Spec: Pass**, no remaining findings. Spec initially caught invisible sidebar skeletons (sand on sand); a held-listing browser regression failed before switching placeholders to the darker neutral line token, then passed all three engines. Both reviewers checked that final delta. **Separate RR8/stack gate: Not applicable — no changed RR8 data-flow or Worker/D1 boundaries in this presentation-only follow-up.** Reviewed all 13 changed page-route contracts (AST comparison confirms loader/action/clientLoader/clientAction/handle/hydrate declarations unchanged), root/font links, header/Account consumers, editor/preview/comments and Import/Export/Publish UI. No resource routes, route map, Session subscription, private-client/navigation flows, Worker bindings or database code changed. Checked RR 8.4.0, config, spec §3, serving §1, testing docs and ADR-0002; there is no new API-contract claim. Browser-only data and native Forms remain intact. Node 406 + Workers 382 passed, along with the focused 51 browser checks and 39 publication/Session checks; final clean-head preflight will be recorded in PR #61 after committing this review record.

- 2026-10-11: Laboratorio conversion implemented across the shell, landing guide/index/formula, Account and authentication pages, workspace, comments, dialogs and Public reader. Fonts are pinned first-party Inter Tight and Courier Prime. Visual regressions now live in `e2e/laboratorio-*.spec.ts`; existing Session and unsaved-draft checks remain. The new mobile Account check reproduced a 970px intrinsic navigation width at a 375px viewport; `min-w-0` on the navigation grid child confines scrolling to its tab strip. After that correction, 51 focused Chromium/Firefox/WebKit checks passed. Standards/Spec/RR8 review and clean-head preflight follow; the PR will record final verification.

- 2026-10-11: User corrected the requested variant to **D — Laboratorio**. Continuing on PR #61 from `c0d072891c33bbf6599282006461781e11f4a10c`, retaining the existing navigation and performance behavior. The entries below document the earlier Editorial iteration, not verification of the new presentation.

- 2026-10-11: Resumed the uncommitted implementation in `../mdwn-editorial` on `issue/54-editorial-redesign`, preserving unrelated ticket-53 files in the main checkout. Verified the archived design palette and inspected desktop/mobile landing and workspace screenshots. Installed the locked font dependencies with `npm ci`.
- 2026-10-11: Added browser coverage for first-party fonts, landing sections, keyboard-operated mobile navigation, `/files`, Account navigation, responsive workspace layout, and parallel File/listing reads before verified rendering. Reproduced and fixed header sign-out bypassing the unsaved-File blocker (navigation `Form` rather than a fetcher), stale Session responses overriding completed sign-out, and the existing provisioning test waiting for the obsolete split-module filename. Those focused checks passed in Chromium, Firefox, and WebKit.
- 2026-10-11: Initial pinned review used base `610e8b6d715750cb1d7a44c2cd675c28afdbf58d` and tree `03cd0bccf732cf9a5f950349f79f511071d89c22`. Standards: no blockers; one advisory about duplicated Account destination descriptors, retained because the menus have intentionally different composition. Spec: fixed three findings (cross-tab Session navigation reconciliation, wrapping long mobile confirmation labels, and honest-client privacy wording). Separate RR8/stack gate: fixed cancelled-loader registry-read reuse by scoping coalescing to the abort-signal lifetime. Added red/green cross-tab and narrow Unpublish tests.
- 2026-10-11: Initial full regression before the review corrections: 403 Node + 382 Workers tests passed; browser suite 452 passed, one existing WebKit synthetic FileSystemEntry drag-and-drop case skipped. These initial results are not a final-head gate.
- 2026-10-11: Follow-up review of tree `98397633ecd63b5acb533f3e333d2b3703577aad` passed Standards and confirmed the prior corrections, but identified a held cross-tab Session read surviving a new location. Centralized invalidation now supersedes reads on authentication changes, new locations, focus, and final subscriber cleanup while retaining same-location deduplication. A real two-tab, held-response regression failed before the correction and passed afterward in every browser. Also verified failed header sign-out cannot be hidden by an earlier Account-action success; React Router's `fetcher.reset()` clears that older result.
- 2026-10-11: Final two-axis review of `9839763..40b99f95f7249fff7960be2284682c432aa2d824`: Standards **Pass**, Spec **Pass**, no new findings. Separate RR8/stack follow-up **Pass**: private request reads are abort-lifetime scoped, Session navigation remains a browser-only boolean subscription, stale completions cannot clear/publish over newer reads, navigation Forms preserve draft blockers, and Worker/D1/resource authority is unchanged. Installed RR 8.4.0 contracts and current client-data/fetcher/race documentation were checked. Verification so far: lint/typecheck/build, 17 real-WebCrypto lifetime tests, 39 focused cross-engine checks before the last Session refinement, and 24 cross-engine Session/workspace/review regressions afterward. Final clean-head preflight follows the commit; the PR carries its result. No merge or deployment is part of this continuation.
