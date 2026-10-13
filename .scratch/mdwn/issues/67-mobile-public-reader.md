# 67: Readable, accessible published Markdown on phones

**What to build:** Make a Publication read well on a phone. The Public reader keeps its Laboratorio look, but tables, code, footnotes, task lists, headings and images must be legible and usable at 360–390 px, with the keyboard and with a screen reader. The editor Preview renders the same Markdown component, so it gets the same fixes.

**Type:** feature

**Status:** ready-for-agent

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
- `app/app.css` (`.prose-markdown`): a type scale relative to the container's body size, distinct h4–h6, hanging-indent task lists, edge cues on horizontal scroll areas, footnote styling, readable inline/block code and tables on narrow screens.
- `app/routes/publication.tsx`: remove the article-wide `overflow-wrap: anywhere`; tune the title for narrow screens.
- Docs: the "Public reader" section of `docs/publications.md`.

Out of scope: dark mode, user-selected themes or custom styling (buildable spec §1.1), image storage, heading anchors or a table of contents, any change to the capability, encryption or Public routes.

## Acceptance criteria

- [ ] At 360–390 px in Chromium, Firefox and WebKit the page has no horizontal overflow; a wide table scrolls inside its own region without splitting words.
- [ ] A scroll area that overflows is keyboard-focusable, has an accessible name and scrolls with the arrow keys; one that fits adds no tab stop.
- [ ] Footnote and back-reference links keep the Public-link fragment, open no new tab, and move focus to their target; the back-reference has its accessible name.
- [ ] A Markdown image renders as text with its description and requests nothing from the image's host.
- [ ] Wrapped task-list text aligns with its first line, not under the checkbox.
- [ ] Browser regression coverage for the above; existing publication, preview and accessibility checks still pass.

## Comments

- 2026-10-13: Published from the maintainer's `/goal` ("make published markdown look beautiful, accessible and easy to read on mobile viewports"). Problems above were reproduced on the built Worker with a published sample at 360 and 390 px in Chromium and WebKit before any change.
