# 68: See whether and how a File is published, keep its link, and change settings with a new link

**What to build:** Make a File's publication state obvious and its management clear. The Owner can see at a glance which Files are published and how each one is published, always sees the complete Public link again on any of their devices, and changes a Publication's settings either on the current link or together with a new link. The site also gets its favicon and a link-preview (Open Graph) banner.

**Type:** feature

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [22: publish a File](22-publish-a-file.md); [23: Public Comment threads](23-public-comment-threads.md); [25: link rotation and Unpublishing](25-link-rotation-and-unpublish.md); [ADR-0003](../../../docs/adr/0003-client-held-content-keys-and-capabilities.md), amended by [ADR-0009](../../../docs/adr/0009-owner-sealed-public-link-copy.md); `docs/publications.md`; `docs/serving-and-security.md`.

## Problems found (before this ticket)

- **Nothing says a File is published.** The header toggle reads **Publish** either way, and the tree and folder views show no difference, so the Owner has to open the panel to find out.
- **The Public link disappears.** The complete link lived only in the memory of the page that created it. After a reload, on another device, or after leaving the page, the panel could not show it ("mdwn never stores the key after #"), so the Owner could not copy or open their own link again.
- **"Paste a link" to change Comments.** Making Comments public needs the link's capability to seal the new epoch, so once the link was gone the panel showed a **Complete public link** field and asked the Owner to paste the link they no longer had.
- **The Comments and Authors controls are confusing.** "Make comments collaborators only", "Set up public comments", "Show my Public pseudonym", the author list and **Rotate link** sat side by side with no summary of the current settings and no explanation of what each audience means.
- **No way to start over with new settings.** Changing settings and retiring the old link were separate, unrelated actions.
- **No favicon or link preview.** The site had no icons and shared links showed no image.

## Scope

- **Owner link copy** ([ADR-0009](../../../docs/adr/0009-owner-sealed-public-link-copy.md)): the creating or rotating browser seals the link's scalar as a `vault-recovery` envelope under the Owner's Vault root key; the Worker validates and stores it in `publication_links.owner_link_envelope` (migration `0030`), returns it only in the Owner's panel read, and drops it with its link. The Owner's browser opens it to show the link and to seal public Comment epochs.
- **Published indicator:** the File header toggle reads **Published** with a status dot; the Files tree and folder contents mark each published File, from an unsigned `published` mark on Directory listing entries.
- **Publish panel:** shared settings fields (Comments **Public** / **Collaborators only** with their meaning; **Show my Public pseudonym as an author**); a **How it's published** summary; **Change settings** with **Save changes** (current link) or **Save and create new link** / **Create new link**; a separate **Credited collaborators** section; a clear notice and **Create new link** for a link without an Owner link copy. The paste field and the separate **Rotate link** control are removed.
- **Icons and link preview:** the supplied favicon set and web manifest in `public/`, the supplied banner as a 1200×630 `og-image.jpg`, icon links and Open Graph/Twitter tags in the root `Layout`, and `robots.txt` allowing crawling of only `/` and the banner, with `noindex` unchanged.
- Docs: `docs/publications.md`, ADR-0009 (and a partial-supersession note in ADR-0003), `CONTEXT.md` (**Owner link copy**), `docs/buildable-spec.md` §4.4/§8 and storage, `docs/serving-and-security.md`, and copy on the landing and Public pages that said mdwn never receives the key.

Out of scope: giving an existing link a copy without replacing it (a link row never changes in place), indexing any page, previews that show a File's own title or content, and link previews for Public pages on crawlers that honor `robots.txt`.

## Acceptance criteria

- [x] The header and the tree/folder views show which Files are published, for the Owner and for anyone who can read the File, and the header updates as soon as the File is published or unpublished.
- [x] The Owner sees the complete link after a reload, on another Owner device, and after leaving and returning; no other Account, File response or anonymous route receives the copy, and D1 never holds the scalar in readable form.
- [x] A mis-bound, malformed or oversized copy is refused with `400` and changes nothing; a request without one still works and leaves the link without a copy.
- [x] The panel summarises the Comment audience (with its meaning), the authors and the publication date; there is no paste field.
- [x] The Owner can change settings on the current link, or create a new link that carries the changed settings; a failure after the new link committed says so.
- [x] A link without an Owner link copy says it can't be shown and offers **Create new link**, whose new link then shows on later visits.
- [x] Every page links the favicon set and manifest and carries the banner's link-preview tags with absolute URLs; `robots.txt` allows only `/` and the banner, and every response stays `noindex, nofollow, noarchive`.
- [x] Worker, unit and Chromium/Firefox/WebKit coverage for the above; existing publication, comment and workspace checks still pass.
- [ ] Merge gate: clean-head `npm run verify` evidence is recorded with the PR, and every current-head `CI` job passes before merge.

## Comments

- 2026-10-13: Published from the maintainer's `/goal`: see whether a File is already published and how; fix the Public link that sometimes doesn't appear and the "paste a link" field; make the Comments/Authors section less confusing; change the settings of a published link and create a new one with them; add the favicon from `~/Downloads/mdwn-favicon/` and the banner `~/Downloads/mdwn-banner.png`.
- 2026-10-13: Implemented in `5ca33b7`.
  - **Root cause of the missing link:** by design the complete link lived only in the creating page's memory, so any reload, other device or return visit lost it, and the public-Comments path then needed it pasted back. The fix is the **Owner link copy** (ADR-0009, amending ADR-0003's "never sent in HTTP requests"): the scalar sealed under the Owner's Vault root key as a `vault-recovery` envelope bound to path ID, Publication ID and Owner. The Worker checks the header binding and the 1 KiB bound, stores it in `publication_links.owner_link_envelope` (`0030`, a column `CHECK` added by `ALTER TABLE` so the link triggers survive), and returns it only in the Owner's panel read. Rotation replaces it in the same in-place update; Unpublishing and hard deletion remove it with the link row. A link row still never changes in place, so a link from before this ticket cannot gain a copy: the panel says it can't be shown and offers **Create new link**.
  - **Indicator:** the lifecycle keeps the latest authoritative state across panel closes (`latest`), so the header toggle reads **Published** as soon as this page publishes or unpublishes; otherwise it follows the File response, then the parent listing. Directory listings carry an unsigned `published: true` on File entries (point lookup through `publications_current_idx`), outside the signed members like `canCreate`; revalidation of an unchanged head takes the current marks.
  - **Panel:** `changeSettings(next, { newLink })` replaces the separate audience, self-author and rotate decisions. It changes only what differs; with a new link it rotates first, then applies the audience with the new candidate and re-declares the Owner's own author row to the new link. A failure after the rotation committed is reported as such (`newLinkCreated`).
  - **Assets:** the supplied favicon set as-is, except a `<title>mdwn</title>` in the SVG (Biome's accessibility rule); the banner, cropped by under 2 px to 1200×630 and saved as a 106 KB JPEG (the PNG was 813 KB, over WhatsApp's ~300 KB preview limit). `robots.txt` now allows `/` and `/og-image.jpg` so X/LinkedIn-style crawlers can read the preview; `noindex, nofollow, noarchive` stays on every response.
  - **Copy:** the landing FAQ, the landing "Share the complete link" step and the Public page footer said mdwn never has or receives the key; they now say it never can read it.
- 2026-10-13: Review of `56da8eb...5ca33b7` (two axes, inline; Standards per `CODING_STANDARDS.md`).
  - **Standards: Pass.** No documented-rule violation: authored files are kebab-case, no route module moved or was added, and `robots.txt` stays in `app/routes/resources/`. Advisories applied: `marked` renamed `withPublishedMark` (Mysterious Name); the listing-mark plan test now compiles the production `filePublished` builder instead of a copy of its SQL. Not applied: the Worker fixtures re-implement the browser's Owner-link sealing, as every fixture there mimics the browser half.
  - **Spec: 2 findings, both fixed.**
    1. **Create new link** on a Publication without a Public thread (one from before ticket 23) would also have set up public Comments, because the settings defaulted a missing audience to Public. Settings changes now carry `audience: null` for such a Publication: a new link changes nothing else, and the form selects no audience until one is chosen. New lifecycle test.
    2. The partial-failure message said the other settings "weren't saved" when some may have been; it now says not every setting was saved and that **Save changes** applies the rest.
    - Scope note: **Save changes** on the current link is kept beside **Save and create new link**, preserving the earlier in-place audience change.
    - Coverage note: "on another Owner device" holds by construction (every Encryption device holds the Vault root key); the browser test proves a reload with fresh page memory, not a second enrolled device.
  - **Separate RR8/stack gate: Pass.** Touchpoints: `root.tsx` `links` and static `Layout` preview tags, `home.tsx` `meta` (static, no loader), `publication.tsx` footer copy only (its `loader`/`clientLoader`/`HydrateFallback`/`meta` unchanged), and the `robots.txt` resource loader body (route map unchanged); none carries private data, and `site-head`/`robots` tests fetch them through `SELF.fetch`. Files data still comes from `clientLoader` (`loadFilesPage`) and the documented ticket-57 background revalidation; the header reads the browser-only lifecycle store with `useSyncExternalStore`, not route data. Publication mutations stay proof-guarded resource requests driven by the lifecycle (pending, error, refresh and abort shared in `run`), and the Worker re-verifies owner authority, bindings and bounds; D1 changes go through Drizzle and a reviewed additive migration. Installed: React Router 8.4.0, React 19.2, Wrangler 4.
