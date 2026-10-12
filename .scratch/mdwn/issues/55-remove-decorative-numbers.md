# 55: Remove decorative UI numbering

**What to build:** Remove the arbitrary numbers added by ticket 54's UI redesign. Keep numbers only where they communicate a real quantity, limit, identifier, recovery-word position, or ordered procedure.

**Type:** cleanup

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [54: Laboratorio redesign](54-editorial-redesign.md). This request supersedes that ticket's decorative numbered-section/index-row styling, not its layout or behavior.

## Acceptance criteria

- Page/section labels, footer groups, illustrations, feature lists, privacy facts and FAQs no longer display arbitrary indices.
- Unordered content has no empty number column or number-specific indentation after cleanup.
- Genuine getting-started/publishing/signup steps, recovery-word positions, counts, limits, dates and identifiers remain intact.
- Browser regressions cover the public landing/footer, authentication/Account pages and Files workspace, including narrow layouts.
- Preserve the existing Laboratorio typography, palette, navigation, accessibility and private-data boundaries; no application behavior changes.

## Comments

- Implemented on `issue/55-remove-decorative-numbers`; awaiting PR/merge. Removed arbitrary indices from desktop/mobile navigation, landing labels, feature/privacy/FAQ entries, illustration labels, footer groups and folder rows. Removed the obsolete number columns/indentation, and made the unordered feature list a `ul`. Real procedures, recovery material, quantities and limits are unchanged.
- Regression evidence: the new landing check failed on the original UI with 17 decorative labels; after the cleanup, all 27 focused navigation/workspace checks passed across Chromium, Firefox and WebKit. Lint/build passed, and desktop/mobile landing screenshots were inspected. Clean-head `npm run verify` evidence will be recorded in the PR.
- Self-review pinned to `git diff 6dad4247bdd49ced3e74dcb6377808a053064068 9ff7fff02b085ab74036c5b1f7b8f88435757467`: **Standards: Pass; Spec: Pass**, no findings. This comment is the only subsequent change. **Separate RR8/stack gate: Not applicable — no RR8/stack data-flow touchpoints.** The five changed UI modules only alter labels/list markup and layout; routes, route contracts, Session presence, navigation destinations, native Forms, private loading/mutations, Worker/D1 boundaries and dependencies are unchanged. Checked installed RR 8.4.0, route/config contracts, spec §3, serving §1, testing guidance and ADR-0002; no new framework API claim. Browser checks retain hydration, menu, Session and draft-safety coverage.
