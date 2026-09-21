# 22: Publish a File: Publication, Public representation, and Public reader

**What to build:** An Owner publishes one File to a public link that anonymous readers can decrypt and read, keeps it live as they edit, and can hand out that link knowing the read capability never reaches the service; a Collaborator can instead ask the Owner to publish.

**Blocked by:** 15 (Editor and preview workspace), 17 (Shares and Grants).

**Status:** ready-for-agent

- [ ] A Publication exposes exactly one File, is independent of Shares, follows File identity through rename and move, and presents the latest successfully saved representation; a partial unique constraint allows at most one active-or-deleting Publication per File.
- [ ] Only the File Owner may create, configure, or later rotate or unpublish a Publication. An active Collaborator with File access may create one pending Publication request that the Owner approves or denies and the requester may cancel; denial or cancellation removes the pending request, and a request never creates public access on its own.
- [ ] Creation generates a never-reused, independently generated 256-bit random base64url Publication path identifier that is sent to the service, and a versioned read-only decryption capability that stays in the URL fragment and is never sent to the service.
- [ ] The service stores a public encryption key so an authorized File editor can update the encrypted Public representation without learning the fragment capability or gaining Publication-management authority.
- [ ] The Public route contains only the opaque Publication identifier; the read capability is entirely after `#`; possession of a complete active URL is sufficient to read the current Public representation, and downloaded material cannot be recalled.
- [ ] The Public page renders sanitized GFM and, if present, the File title; it shows no raw front matter, path, breadcrumbs, user-authored timestamps, or Owner identity; it sends `noindex`, `nofollow`, and `noarchive`; it is non-indexed by default and uses no analytics, third-party scripts, or nonessential cookies.
- [ ] The Owner may opt into selected pseudonymous author attribution; attribution is off by default and never inferred from edit activity.
- [ ] The Public representation is one decoded encrypted presentation payload of at most 524,288 bytes, separate from the private representation and stored with the same enforced bound.
- [ ] After publication, any authorized File editor's save creates both the private and Public representations under one File-revision condition using the stored public key rather than the fragment; the Public pointer updates in the same operation as the private one.
- [ ] An unknown path identifier returns a ciphertext-free `404` indistinguishable from the response for a rotated or sealed link.
- [ ] Tests prove the paired save is atomic, the fragment never appears in requests, logs, errors, analytics, referrers, or server state, anonymous routes never return private or Collaborators-only ciphertext or envelopes, and a pending request creates no public access.

## Comments

- 2026-09-21: Dependency note from ticket 03: the `public-representation` envelope is HPKE to the Publications public encryption key, so the matching private decryption capability stays in the fragment while an editor updates without it. Bind the Publication as `publicationId` and its public key as `recipientId`. The Publication-capability wrappers used by Public Comment epochs are separate symmetric envelopes. See `docs/enc-v1.md`.
