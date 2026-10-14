# 70: Stop phones from zooming into text fields

**What to build:** On a phone, focusing a text field zooms the page in, and the page stays zoomed after the field loses focus. iOS Safari does this for any text control whose font size is under 16px, and every mdwn text control is smaller. Render every text control at 16px or more on touch screens, keep the compact sizes for mouse and trackpad screens, and leave pinch zoom available.

**Type:** bug

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [54: Laboratorio design system](54-editorial-redesign.md) (`fieldClass`, `app/app.css`); [67: Readable, accessible published Markdown on phones](67-mobile-public-reader.md).

## Problems found (before this ticket)

- `fieldClass()` renders 15px text and `fieldClass("sm")` 14px. These include signup's pseudonym and recovery-phrase words, the comment fields, the import `select`, the share expiry `date` input, and the File and Directory Name field. The create and rename dialogs focus that field as they open.
- The Public link and both pairing-link fields add `font-mono text-xs` (12px); the Share identifier field and the recovery-phrase textarea on the Recover Files page add `font-mono text-sm` (14px).
- The Markdown editor's textarea is `font-mono text-[13.5px]`.

## Scope

- `app/app.css`: one rule for `(pointer: coarse)` gives `input` (except checkboxes and radios), `textarea` and `select` a font size of `max(1rem, 16px)`. It sits outside Tailwind's layers, like the reduced-motion rule, so it outranks every utility size, and future fields need no call-site change. Mouse and trackpad screens are unchanged.
- Not `maximum-scale=1` or `user-scalable=no` in the viewport meta: on Android that also blocks pinch zoom, which fails WCAG 1.4.4 (Resize text).
- `e2e/mobile-text-controls.spec.ts`, every engine. A touch-screen context (`hasTouch`) reports `pointer: coarse` in Chromium, Firefox and WebKit.

Out of scope: other text sizes on phones (labels, notices, the Preview). They do not trigger zoom.

## Acceptance criteria

- [x] On a touch screen at 390 × 844, every visible text control on the signup page and on an open, published File computes to at least 16px. That includes the editor (13.5px with a mouse), the Public link field (12px with a mouse), and a `select` and `date` input at `text-xs`.
- [x] With a mouse, the editor stays 13.5px and the Public link field 12px.
- [x] The viewport meta is unchanged, so pinch zoom stays available.
- [ ] Merge gate: clean-head `npm run verify` evidence is recorded with the PR, and every current-head `CI` job passes before merge.

## Comments

- 2026-10-13: Published from the maintainer's request: "on mobile sometimes the browser zooms in due to the small font size, let's fix that."
- 2026-10-13: Implemented on `issue/70-mobile-input-zoom`. Before the rule, the touch tests fail in every engine: the signup pseudonym field computes to 15px and the Public link field to 12px. With it they pass, and the mouse test confirms the compact sizes stay.
- 2026-10-13: Review of `e3c3f97` and the branch's changes (two axes, inline; Standards per `CODING_STANDARDS.md`).
  - **Standards: Pass.** A shared invariant (every text control on a touch screen) has one rule, in `app/app.css` beside the reduced-motion override it mirrors. The spec name is kebab-case. The selector chains `:not()` instead of using a selector list, so an engine without Selectors Level 4 lists cannot drop the whole rule.
  - **Spec: Pass.** `e2e/mobile-text-controls.spec.ts` covers the first two criteria in Chromium, Firefox and WebKit. `app/root.tsx`'s viewport meta is unchanged.
  - **Separate RR8/stack gate: Not applicable — no RR8/stack touchpoints.** The diff changes `app/app.css`, adds one browser spec and this ticket. It has no route, loader, action, fetcher, resource endpoint, Worker, D1 or SSR data change.
