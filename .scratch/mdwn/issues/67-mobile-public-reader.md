# 67: Readable, accessible published Markdown on phones

**What to build:** Make a Publication read well on a phone. The Public reader keeps its Laboratorio look, but tables, code, footnotes, task lists, headings and images must be legible and usable at 360–390 px, with the keyboard and with a screen reader. The editor Preview renders the same Markdown component, so it gets the same fixes.

**Type:** feature

**Status:** done

**Blocked by:** none.

**Related:** [54: Laboratorio design system](54-editorial-redesign.md) (tokens and `.prose-markdown`); [22: publish a File](22-publish-a-file.md); `docs/publications.md` ("Public reader"); maintainer note in `NOTES_TO_DISCUSS.md` (11 October 2026).

## Problems found at 390 px (Chromium and WebKit, before this ticket)

- **Tables are crushed instead of scrolling.** The reader adds `overflow-wrap: anywhere` to the whole article. Unlike `break-word`, `anywhere` counts every character as a break when columns are sized, so a table never overflows its `overflow-x: auto` box: columns shrink and words split mid-letter ("Provi/der", "Clou/dflare").
- **In-page links destroy the read capability.** Every Markdown link gets `target="_blank"`, including footnote links (`#user-content-fn-1`). On a Public page that opens a new tab whose fragment replaces the key, so the reader sees "This public link is incomplete". Following the link in place would do the same, because the fragment is the capability.
- **Footnote accessibility is stripped.** The link override keeps only `href`, discarding the sanitized `id`, `aria-describedby`, `aria-label` and `data-footnote-*` attributes, so "↩" has no accessible name and the back-reference target does not exist.
- **Images show a broken box.** CSP allows only first-party images and mdwn stores none, so every Markdown image fails to load.
- **Wrapped task-list text runs under its checkbox,** and headings below h3 are almost the body size, which flattens the hierarchy in the larger reader type.
- **Scrolling code blocks and tables cannot be reached by keyboard in every engine** and give no sign that more content is off-screen.

## Scope

- `app/tree/markdown-preview.tsx`: keep sanitized link attributes; open external links in a new tab; handle in-page links without changing the URL fragment, scrolling to and focusing their target; render images as an accessible "Image not shown" note with the description and an optional link; wrap tables and code blocks in scroll areas that become a named, focusable region only while they overflow.
- `app/app.css` (`.prose-markdown`): a type scale relative to the container's body size, distinct h4–h6, hanging-indent task lists, edge cues on horizontal scroll areas, footnote styling, readable inline/block code and tables on narrow screens. Smaller reading refinements belong here too: quieter link underlines and list markers, `text-wrap: pretty`, tabular figures in table cells, and blockquote type sized with the body.
- `app/routes/publication.tsx`: remove the article-wide `overflow-wrap: anywhere`; fit the title and the article's top spacing to narrow screens.
- Docs: the "Public reader" section of `docs/publications.md`.

Out of scope: dark mode, user-selected themes or custom styling (buildable spec §1.1), image storage, heading anchors or a table of contents, any change to the capability, encryption or Public routes.

## Acceptance criteria

- [x] At 320–390 px in Chromium, Firefox and WebKit the page has no horizontal overflow; a wide table scrolls inside its own region without splitting words.
- [x] A scroll area that overflows is keyboard-focusable, has an accessible name and scrolls with the arrow keys; one that fits adds no tab stop.
- [x] Footnote and back-reference links keep the Public-link fragment, open no new tab, and move focus to their target; the back-reference has its accessible name.
- [x] A Markdown image renders as text with its description and requests nothing from the image's host.
- [x] Wrapped task-list text aligns with its first line, not under the checkbox.
- [x] Browser regression coverage for the above; existing publication, preview and accessibility checks still pass.
- [x] Merge gate: clean-head `npm run verify` evidence is recorded with the PR, and every current-head `CI` job passes before merge.

## Comments

- 2026-10-13: Published from the maintainer's `/goal` ("make published markdown look beautiful, accessible and easy to read on mobile viewports"). Problems above were reproduced on the built Worker with a published sample at 360 and 390 px in Chromium and WebKit before any change.
- 2026-10-13: Implemented in `354ada5`.
  - **Renderer** (`app/tree/markdown-preview.tsx`): links keep their sanitized attributes, so footnote ids, `aria-describedby` and the back-reference's "Back to reference 1" name survive. `#…` links scroll to and focus their target without touching the fragment. Images render as an "Image not shown" note. Tables and code blocks measure their overflow and, only while overflowing, become focusable regions ("Scrollable table" / "Scrollable code") with `data-overflow` naming the hidden sides for an inset edge shade.
  - **Typography** (`app/app.css`): sizes are relative to the body, so the reader's 18 px body keeps the Preview's hierarchy. h5/h6 use the Courier Prime label voice, and narrow screens get smaller h1/h2.
  - **Reader** (`app/routes/publication.tsx`): `overflow-wrap: anywhere` is gone from the body; the title is clamped to 36–44 px below `sm`.
  - **Edge-cue approach:** a CSS-only scroll shadow (`background-attachment: local`) was tried first. It left hairline artifacts at the box edges in WebKit, the iPhone engine, so the cue moved to the measured `data-overflow` attribute.
  - **Test:** `e2e/public-reader-mobile.spec.ts` failed on `main` (no scroll region; the footnote click opened a new tab showing "incomplete link") and passes after the change.
  - **Playwright quirk:** Playwright's WebKit ignores the first arrow-key press on any focused scroller, even on a plain HTML page, so the keyboard check presses until the box scrolls.
- 2026-10-13: Review of `8eac4e6...354ada5`.
  - **Standards: Pass.** Advisories applied: the side state is renamed `HiddenSides`/`maxScrollLeft`; outside-link attributes are shared by the link and the image's "Open image" link; the h1/h2 sizes moved to the file's mobile-first `@media (width >= …)` form; the second test was renamed. Not applied: extracting a shared `publish()` helper from the other publication specs, which is outside this diff.
  - **Spec: Fail (2), both fixed and covered.**
    1. A footnote with a non-ASCII label (`[^señal]`) was dead, because GFM writes the id percent-encoded and the handler only tried the decoded fragment. It now tries the fragment as written first, then decoded, as HTML does. The spec's footnote is now `[^señal]`.
    2. A linked image (`[![alt](src)](href)`) nested its "Open image" link inside the outer link. A context now omits the inner link inside a Markdown link, and the spec asserts no `a a`.
    Both new assertions failed on `354ada5`'s renderer and pass now.
  - **Coverage gaps closed:** the image test listens for any request to the image host; the table region is reached with Tab; a short code block and a short table add no tab stop; a Preview edit grows a table past the pane and back.
  - **Scope:** the extra refinements the Spec reviewer flagged (link underline, list markers, `text-wrap`, tabular figures, blockquote size, article spacing) are kept as part of the readability goal and now listed in Scope.
  - **Separate RR8/stack gate: Not applicable — no RR8/stack touchpoints.** `publication.tsx` changes only two `className` strings: the `loader`, `clientLoader` and `hydrate` declarations, `HydrateFallback`, `meta` and `handle` are unchanged. The renderer's effects measure the DOM with ResizeObserver and scroll events, which are browser APIs, not route data. No resource routes, `app/routes.ts`, Worker bindings, D1, `app/shared` modules or SSR payloads changed. The reader shell is still SSR-only with no plaintext (the existing `publications.spec.ts` HTML assertion passes).
- 2026-10-13: Completed and merged into `main` via [PR #72](https://github.com/diurivj/mdwn/pull/72), merge commit `a304795975a35b2256a9148003dbe504fdd88300`, after clean-head `npm run verify` at `4d442c0` and all four `CI` jobs passed at that head. Deploy run 38434332980 migrated and released preview, then production, with both smoke tests passing; production `/assets/root-*.css` serves the new `.prose-markdown` rules.
