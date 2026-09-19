# mdwn — markdown vault web app

> Wayfinder map. Canonical artifact for this effort. Child tickets live in `issues/`.

## Destination

A **buildable spec + locked technical decisions** for *mdwn*: a standalone web app that is a private markdown vault you write in and browse like a normal folder tree, with account-to-account directory sharing (e.g. diet plans with your wife), per-file public publish links, comments, and browser-side import/export. Personal-first, multi-user-capable, **open signup**, **never monetized**. Reaching the end = every decision ticket resolved and the spec assembled (`issues/12-assemble-buildable-spec.md`).

## Notes

- **This repo**: `/Users/diurivj/coding/mdwn` is the project directory for the web app. It is *only* the project — no ingestion from other repos, agent output, or local folders is in scope.
- **Oasis is out of scope**: do not consult `~/oasis` or its vault code.
- **Tracker**: local markdown. Map = this file; tickets = `issues/NN-<slug>.md`; blocking via the ticket's `Blocked by:` line.
- **Standing preferences**: RR8 (React Router v8) over Next.js. TypeScript. D1/SQLite is sufficient for the MVP; keep its schema and queries SQLite-compatible. Start on free/cheap infrastructure — budget is a hard constraint. Privacy is the stated core value: private content is decrypted only in the browser.
- **Never monetize**: no billing, ever.
- **Skills to consult**: `grilling` + `domain-modeling` for decision tickets; `research` for research tickets; `prototype` for UX tickets.

## Decisions so far

- [Define the privacy model](issues/01-define-privacy-model.md): Private Markdown is end-to-end encrypted; privacy also means no tracking, browser-side export, hard deletion, and anonymous non-indexed public viewing by default.
- [Research: passkeys/WebAuthn implementation and recovery](issues/02-research-passkeys.md): `@simplewebauthn` v14 + route `action`/`loader`; passkeys-first is privacy-compatible; open signup needs rate limiting plus PoW-or-email; recovery = pre-enrolled second passkey + single-use recovery codes; keep attestation off.
- [Research: free/cheap Postgres and RR7 hosting landscape](issues/03-research-infra.md): $0 is real — Cloudflare Workers+D1 (SQLite) or Workers+Neon free Postgres (permanent, no card); Fly/Render/Railway are not free; first cost ~$5/mo; no free tier offers customer-managed keys, so E2E must be app-level.
- [Lock the stack and hosting](issues/08-lock-stack-and-hosting.md): RR8 Framework Mode on Cloudflare Workers with D1/SQLite, Drizzle migrations, browser-only sanitized GFM, D1-backed passkey sessions, and Wrangler/GitHub Actions deployment.
- [Design authentication: passkeys, recovery, open signup](issues/04-design-auth.md): Email-free, pseudonymous passkeys-only accounts with multiple credentials, offline recovery codes, proof-of-work signup protection, revocable sessions, and unauthenticated public readers.
- [Navigation & editor UX prototype](issues/10-navigation-and-editor-ux.md): Human review selected the Persistent split workspace as the baseline; exact interaction behavior continues in [Lock editor and file interaction behavior](issues/14-lock-editor-and-file-interaction.md).
- [Define encrypted-content and capability model](issues/13-define-encrypted-content-capability-model.md): Client-held vault, directory, file, device, recovery, and public-link capabilities use a versioned HPKE/AES-GCM model with explicit revocation limits.
- [Sharing & permission model](issues/05-sharing-permission-model.md): Owner-controlled directory and file grants provide recursive future access, explicit permissions, independent overlap, and practical revocation.
- [Public publish model](issues/06-public-publish-model.md): Owner-controlled per-file live publications use opaque path identifiers plus URL-fragment capabilities, optional pseudonymous attribution, and public comments with a Collaborators-only mode.
- [Comments model](issues/07-comments-model.md): File-level private and public flat Comment threads are browser-encrypted, use signed-in pseudonymous authors, and omit rich formatting and notifications.
- [Lock editor and file interaction behavior](issues/14-lock-editor-and-file-interaction.md): Opaque private routes, Files-only UI, responsive split editing, coordinated autosave/conflicts, contextual actions/comments, and review-first browser import are locked.
- [Data model & schema](issues/09-data-model-and-schema.md): D1 uses encrypted adjacency-list nodes, Key envelopes, separate Share/Grant and Publication lifecycles, conditional representations, explicit bounded deletion, and resumable Key rotation.
- [Import/export format & flow](issues/11-import-export.md): Browser-only Markdown ZIP exports only Account-owned Files, preserves historical Private Comment data, and admits only preflighted all-or-nothing imports.
- [Research: D1-backed encrypted import envelope](issues/17-research-d1-import-envelope.md): D1 batches can atomically create only a tested, bounded import; Free/Paid query budgets require a later cap decision, with private staging as the larger-import fallback.
- [Research: privacy-preserving abuse controls on Cloudflare](issues/15-research-privacy-preserving-abuse-controls-on-cloudflare.md): Free WAF is only coarse protection; D1-backed purpose-scoped counters and browser PoW can preserve privacy, while Turnstile, Durable Objects, and paid upgrades remain explicit policy choices.
- [Lock abuse and rate-limit policy](issues/16-lock-abuse-and-rate-limit-policy.md): Free-tier D1 counters, local proof of work and honeypots, bounded pseudonymous metadata, and temporary public-participation suspensions balance abuse resistance with privacy.
- [Lock import operational bounds](issues/18-lock-import-operational-bounds.md): Free-tier visible-atomic imports cap normalized input at 100 nodes, depth 32, 256 KiB per Markdown file, 8 MiB ZIP/16 MiB expanded input, with 24-hour private staging and one commit marker.
- [Resolve Private Comment permissions for read-only Grants](issues/19-resolve-private-comment-permissions-for-read-only-grants.md): Private Comment participation follows any active File-read Grant, independently of Markdown write permission; authors control their own Comments and Owners may hard-delete any.
- [Resolve import ownership in shared Directories](issues/20-resolve-import-ownership-in-shared-directories.md): Read/write Directory Grants allow immediate imports whose new descendants belong to the target Directory Owner; direct File and read-only Grants cannot target imports.
- [Define Collaborators-only Public Comment capabilities](issues/21-define-collaborators-only-public-comment-capabilities.md): Audience-scoped Public Comment epochs give current File-read Accounts device-enveloped access without exposing Public-link capabilities; unpublishing seals and then destroys all Public material.
- [Define Vault recovery and replacement-device enrollment](issues/22-define-vault-recovery-device-enrollment.md): A fresh-passkey-authenticated, rotating offline recovery phrase atomically enrolls one replacement device, revokes prior device/session authority, restores owned keys, and waits for Grant-side reprovisioning.
- [Lock normal File size and representation storage](issues/23-lock-normal-file-size-and-storage.md): Single binary private/Public representations cap Markdown at 256 KiB and encrypted payloads at 512 KiB; overflow is lossless and paired saves are proven on Workers Free + D1.
- [Define routine Encryption-device enrollment and revocation](issues/24-define-routine-encryption-device-enrollment-and-revocation.md): QR-approved, fresh-passkey device enrollment supports multiple active devices; per-request device proofs and targeted removal protect future authority, while recovery remains the all-device cutover.
- [Lock canonical namespace normalization and import collision naming](issues/25-lock-canonical-namespace-normalization-and-import-collision-naming.md): Unicode 17 browser-private canonical names, safe segments, deterministic ` (2)` collision names, and clear no-overwrite conflict review are locked.
- [Lock encrypted import payload and chunk bounds](issues/26-lock-encrypted-import-payload-and-chunk-bounds.md): Binary-only 512 KiB/40-chunk staging, typed encrypted-payload ceilings, recordized Historical Comments, fail-closed retries, and a Workers Free proof gate are locked.
- [Define first Encryption-device bootstrap at signup](issues/27-define-first-encryption-device-bootstrap.md): Signup's single atomic commit creates the Account, first passkey, registry epoch 1, first active Encryption device, both initial Key envelopes, generation-1 Recovery capsule, and a device-bound Session; client-minted IDs, a WebAuthn challenge bound to the device transcript, a post-commit phrase gate before first content, bind-on-sign-in for later sessions, and non-extractable device keys persisted in IndexedDB.
- [Assemble the buildable spec](issues/12-assemble-buildable-spec.md): The destination is reached — [`docs/buildable-spec.md`](../../docs/buildable-spec.md) is buildable, with decision 27's signup-bootstrap contract folded in and no product decision left open.

## Not yet specified

<!-- No unticketed in-scope fog remains. Newly surfaced build blockers live as open child tickets; deferred work is explicitly outside this buildable MVP specification. -->

## Out of scope

<!-- Beyond the destination; never graduates. Closed, not part of Decisions so far. -->

- Monetization, billing, subscriptions — *never*, by explicit decision. The only support surface is an optional anonymous cryptocurrency donation page ([ADR-0007](../../docs/adr/0007-no-monetization-anonymous-support.md)).
- Integrating with or reusing Oasis Vault — explicitly excluded.
- CLI-driven or automatic ingestion/sync from local folders, git repos, research pipelines, or agent output — excluded from this MVP; import/export happens in the browser instead. A later CLI is a fresh effort after this destination is reached.
- Real-time collaborative editing.
- Version history / revisions.
- Custom public domains.
- Native mobile apps.
- Comment notifications — deferred beyond the MVP.
- Resumable hard deletion of Directory trees above the 500-node MVP cap — deferred beyond the MVP; oversized deletion now leaves all data unchanged.
- Attachment/image storage (object storage) — deferred beyond the MVP.
- Full-text search — no private-content search in the MVP; revisit only with a privacy-compatible, low-cost design.
- Public-page theming or custom styling — later polish, outside the MVP.
- Long-term off-site backups and disaster recovery — beyond the selected D1 Time Travel and pre-change-export MVP recovery posture.
- Account deletion and account-wide data export — beyond browser-owned-Files export and File/Directory Hard deletion in this MVP.
- Team/org capabilities beyond direct Account-to-Account directory sharing — beyond the personal-first MVP.
- Offline/PWA behavior and persisted drafts — deferred beyond the MVP.
- Historical audit logging — beyond bounded Security events and the explicitly absent sharing audit log.
- Jurisdiction-specific privacy notices and pre-launch legal review — separate pre-launch work, outside this buildable specification.
- Durable queue-backed autonomous Public-material teardown — future scalability work; the MVP uses owner-browser-driven bounded deletion after immediate sealing.
