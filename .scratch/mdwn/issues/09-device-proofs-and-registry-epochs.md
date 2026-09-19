# 09: Device proofs, Device registry epochs, and device-key persistence

**What to build:** After signup, every private read and mutation only works from a browser that holds an active Encryption device and proves it per request, while a returning browser re-binds to its existing device silently instead of re-enrolling.

**Blocked by:** 08 (Signup: first-Encryption-device bootstrap).

**Status:** ready-for-agent

- [ ] Every private read or mutation requires the bound normal Session plus a `mdwn/device-proof/v1` signature from the active device's assertion key, whose canonical payload binds a Session-binding digest, device ID, current device-registry epoch, HTTP method, canonical path/query, body digest, issued/expiry time of at most five minutes, and a random proof ID.
- [ ] Before any private operation the service verifies the signature, the matching bound Session, active device state, and current registry epoch.
- [ ] Mutation and security-sensitive proofs are atomically consumed with the action's expected revision/idempotency condition; a read-only proof is request-bound and expires but is not persistently consumed, so replay cannot change state and no workspace read creates a D1 write.
- [ ] A Session whose browser holds no bound active device is unprovisioned: it may use only authentication, account-security, and enrollment routes, and cannot read or mutate private material, Key envelopes, Grants, Comments (including Public Comment posting), or Publications.
- [ ] Bind-on-sign-in: a normal Session created by a fresh Passkey assertion may present a proof from an already-active device whose keys are persisted in that browser, and the Session becomes bound to it. It applies only at Session creation and only to an existing active device at the current registry epoch; it never activates a device, changes the registry epoch, or replaces/approves anything. A failed proof, or a revoked or tombstoned device, leaves the Session unprovisioned.
- [ ] Every active-device membership change advances the Account's monotonic device-registry epoch; existing non-target Sessions remain usable only after their browsers refresh registry state and make a proof at the new epoch, and stale proofs return no private material.
- [ ] Every Encryption device generates its transport and assertion private keys with `extractable: false` and persists them as WebCrypto `CryptoKey` handles by structured clone into IndexedDB, alongside the opaque device ID and cached registry epoch; this survives tab close, sign-out, and full browser restart in Chromium, Firefox, and WebKit. Keys are never self-wrapped, and the app requests `navigator.storage.persist()`.
- [ ] Losing device keys is never silent: the browser detects a missing, replaced, or unreadable device before private operations and shows the recovery/enrollment path instead of failing a private request (covering WebKit eviction, private windows, quota eviction, and "clear site data").
- [ ] Tests prove every private endpoint rejects missing, mismatched, expired, stale, or invalid Device proofs; mutation-proof replay is rejected atomically; a replayed read proof changes no state; a replayed non-extractable key handle still proves possession after a full browser restart in all three engines; and an unprovisioned Session is refused on every private route.
