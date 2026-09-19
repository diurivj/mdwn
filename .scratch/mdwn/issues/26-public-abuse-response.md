# 26: Public abuse response: category-only reports and Public-participation suspension

**What to build:** A signed-in Account can report a Public Comment without reading or restating its content, and repeated technical abuse can temporarily suspend only that Account's public participation — never its private Files, Shares, export, recovery, ownership, or ability to delete and unpublish.

**Blocked by:** 07 (Abuse-control primitives), 23 (Public Comment threads and audience epochs).

**Status:** ready-for-agent

- [ ] A signed-in Account may submit a rate-limited category-only report for an opaque Public Comment ID (3 per 24 h); the report conveys no plaintext and grants no content access.
- [ ] Reports and suspensions are keyed only to reporter Account, opaque Public Comment ID, suspension start/end, and fixed reason metadata — no content, fragment or capability, raw IP, full URL, headers or body, cookie or session token, credential payload, user agent, or behavioural fingerprint.
- [ ] Repeated technical abuse or metadata-supported report patterns may trigger a Public-participation suspension: seven days initially, 30 days for a repeat.
- [ ] A suspension blocks Public Comment posting and Publication create/rotate only. It preserves private Files, Shares, export, recovery, ownership, hard deletion, and unpublishing.
- [ ] Suspensions expire automatically, and the operator may correct an evident metadata-supported mistake.
- [ ] There is no permanent Account deletion, private-vault lockout, plaintext moderation, or formal appeal process in the MVP, and the UI does not imply otherwise.
- [ ] File Owner hard deletion remains the primary unwanted-Comment control and is surfaced as such.
- [ ] Tests prove the enforcement boundary, automatic expiry, and that export, hard deletion, unpublish, and session revocation are never blocked by these limits.
