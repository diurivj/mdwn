# 10: Authentication recovery: Recovery code to restricted Session to replacement Passkey

**What to build:** A person who has lost their passkeys uses one unused authentication recovery code to enroll a replacement passkey, gets a normal Session back, and sees every other Session revoked — while the service reveals nothing about whether the Account exists.

**Blocked by:** 06 (Accounts, passkeys, sessions), 07 (Abuse-control primitives), 08 (Signup: first-Encryption-device bootstrap).

**Status:** ready-for-agent

- [ ] A non-secret recovery identifier plus one unused recovery code begins recovery; rate limits apply without disclosing whether an Account or recovery record exists.
- [ ] A valid code is consumed and removed; the rest of the set remains until invalidated.
- [ ] Recovery creates only a short-lived restricted Session that can enroll a replacement passkey; enrolling the replacement passkey allows a normal Session.
- [ ] Successful recovery revokes every active Session, preserves existing passkeys, and writes a bounded Security event.
- [ ] Generating a new recovery-code set invalidates the entire previous set.
- [ ] There is no support or operator override; loss of all passkeys and all authentication recovery codes makes the Account unrecoverable, and the UI states this honestly.
- [ ] Authentication recovery alone never grants encrypted-content access: the recovered browser remains unprovisioned and must complete Vault recovery (ticket 11) before it can read or mutate private material.
- [ ] Tests cover code consumption, set replacement, restricted-Session route limits, global Session revocation, recovery limits and generic failures, and the no-override failure path.
