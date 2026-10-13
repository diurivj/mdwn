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
