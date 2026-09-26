# 09: Device-proof enforcement, Device registry epochs, and device lifecycle

**What to build:** Extend ticket 08's device-proof primitives and persisted-device sign-in path into comprehensive private-route enforcement and Device registry lifecycle handling, so stale, unprovisioned, or lost device authority always fails closed.

**Blocked by:** 08 (Signup: first-Encryption-device bootstrap).

**Status:** ready-for-agent

**Scope boundary:** Ticket 08 delivers device-proof generation/verification and replay primitives, non-extractable device-key persistence, and bind-on-sign-in. Reuse those public interfaces here; this ticket owns comprehensive route integration, epoch transitions, and device-loss handling rather than prerequisites for signup acceptance.

- [ ] Every private read or mutation uses ticket 08's shared `mdwn/device-proof/v1` guard with a bound normal Session. Route integration preserves all canonical request bindings and checks the signature, matching Session, active device state, and current registry epoch before returning private material or changing state. Later private routes use this same guard.
- [ ] Every mutation and security-sensitive route integrates proof consumption atomically with its action's expected revision/idempotency condition. All read-only private routes preserve the request-bound, expiring, non-persistently-consumed proof contract: replay changes no state and no workspace read creates a D1 write.
- [ ] A Session whose browser holds no bound active device is unprovisioned: it may use only authentication, account-security, and enrollment routes, and cannot read or mutate private material, Key envelopes, Grants, Comments (including Public Comment posting), or Publications.
- [ ] Integration tests preserve ticket 08's bind-on-sign-in behavior across current, stale, revoked, and tombstoned device state: binding applies only at Session creation after fresh Passkey authentication, never activates a device or changes the registry epoch, and failed binding leaves the Session unprovisioned.
- [ ] Every active-device membership change advances the Account's monotonic device-registry epoch; existing non-target Sessions remain usable only after their browsers refresh registry state and make a proof at the new epoch, and stale proofs return no private material.
- [ ] Registry refresh and private-route integration reuse ticket 08's IndexedDB device store without replacing or exporting its non-extractable keys. A browser restart retains possession while a registry-epoch change refreshes only the cached authority state before the next proof.
- [ ] Losing device keys is never silent: the browser detects a missing, replaced, or unreadable device before private operations and shows the recovery/enrollment path instead of failing a private request (covering WebKit eviction, private windows, quota eviction, and "clear site data").
- [ ] Tests prove every private endpoint rejects missing, mismatched, expired, stale, or invalid Device proofs; mutation-proof replay is rejected atomically; a replayed read proof changes no state; a replayed non-extractable key handle still proves possession after a full browser restart in all three engines; and an unprovisioned Session is refused on every private route.

## Comments

- Maintainer-approved sequence correction: ticket 08 now owns the device-proof, device-key-persistence, and bind-on-sign-in prerequisites needed for independently acceptable signup. This ticket is blocked by 08 until that prerequisite lands and covers their comprehensive enforcement and lifecycle integration; no dependency points back from 08 to this ticket.
- 2026-09-23: Dependency satisfied by PR #11 (`02a5332`); this ticket is ready to implement its remaining private-route enforcement, registry-epoch, and device-loss work. Do not repeat ticket 08's completed primitives.
