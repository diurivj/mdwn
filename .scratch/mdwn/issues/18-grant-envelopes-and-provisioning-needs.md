# 18: Grant capability envelopes and shared-content provisioning

**What to build:** When a Share is accepted, the recipient's current devices receive real cryptographic access to the shared subtree or File — and a device that holds server authority but not yet its envelopes sees **Shared content is being securely provisioned** instead of names, plaintext, or a fragment fallback.

**Blocked by:** 04 (Vault key hierarchy, recovery secret, and capsule), 17 (Shares and Grants).

**Status:** ready-for-agent

- [ ] Acceptance creates one active Grant and provisions the required recipient-device Key envelopes: active direct File or Directory Grant → recipient device, plus the Private Comment thread capability and any Public Comment audience epoch envelopes the Grant entitles.
- [ ] A Key envelope is the only persisted mechanism granting one capability access to another, and it never exposes the key to the service.
- [ ] Grant-derived capabilities are never placed in a Vault-root or `device-enrollment` envelope; a capability received only through a Grant is explicitly excluded from Vault recovery (ticket 11) and routine enrollment (ticket 12).
- [ ] A new Directory descendant inherits access through the Directory capability, with no per-node Grant and no extra envelope for a device that already holds the Directory capability.
- [ ] `provisioning_needs` records only an opaque active-Grant/new-device provisioning need and contains no object name, plaintext, or capability.
- [ ] A recipient device holding server authorization but missing envelopes shows **Shared content is being securely provisioned** with no names, plaintext, or URL-fragment fallback; a newly eligible device may instead show **secure access is being prepared** while an already authorized browser provisions retained Comment or Public-history envelopes.
- [ ] The cryptographic material alone is insufficient: server authorization removed by revoke, leave, or permission change takes effect independently of what a device still holds.
- [ ] Tests prove acceptance provisions only for current devices, a revoked Grant leaves no usable envelope behind, Grant paths reject cross-purpose, cross-object, and stale-epoch envelopes, and inheritance covers descendants added after acceptance.

## Comments

- 2026-09-21: Dependency note from ticket 03: Grant and Comment envelopes use `app/crypto/enc-v1` (`docs/enc-v1.md`) with purposes `grant`, `private-comment-thread`, and `public-comment-audience-epoch`. Opening is not authorization: HPKE base mode names no sender, so acceptance must require the current Device registry epoch and server authorization, never a successful open alone. Envelope epochs are exact — older fails `stale-epoch`, newer-than-current fails `unexpected-epoch` and must not trigger a re-key.
- 2026-10-01: Ticket 17 found a parent-free fresh-key write dependency: `directory_entries.key_envelope` currently wraps the current File key and is part of the signed encrypted parent listing. A direct File editor cannot update either without forbidden parent capability access. Before enabling direct-File saves, decide and implement a coordinated current-key persistence/read contract covering the Owner, inherited readers, and direct recipients; do not leave the parent edge stale, reuse an old content key, or provision the successor only to the saving device. See `docs/sharing.md`. The server-authority implementation currently returns `shared_content_provisioning_required` without committing a direct save. Browser sharing integration must also keep the actor's Account/device separate from the content Owner's vault encryption context when signing listings.
