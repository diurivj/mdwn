# 10: Authentication recovery: Recovery code to restricted Session to replacement Passkey

**What to build:** A person who has lost their passkeys uses one unused authentication recovery code to enroll a replacement passkey, gets a normal Session back, and sees every other Session revoked — while the service reveals nothing about whether the Account exists.

**Blocked by:** 06 (Accounts, passkeys, sessions), 07 (Abuse-control primitives), 08 (Signup: first-Encryption-device bootstrap).

**Status:** done

- [x] A non-secret recovery identifier plus one unused recovery code begins recovery; rate limits apply without disclosing whether an Account or recovery record exists.
- [x] A valid code is consumed and removed; the rest of the set remains until invalidated.
- [x] Recovery creates only a short-lived restricted Session that can enroll a replacement passkey; enrolling the replacement passkey allows a normal Session.
- [x] Successful recovery revokes every active Session, preserves existing passkeys, and writes a bounded Security event.
- [x] Generating a new recovery-code set invalidates the entire previous set.
- [x] There is no support or operator override; loss of all passkeys and all authentication recovery codes makes the Account unrecoverable, and the UI states this honestly.
- [x] Authentication recovery alone never grants encrypted-content access: the recovered browser remains unprovisioned and must complete Vault recovery (ticket 11) before it can read or mutate private material.
- [x] Tests cover code consumption, set replacement, restricted-Session route limits, global Session revocation, recovery limits and generic failures, and the no-override failure path.

## Comments

- Implemented a five-minute code-backed restricted Session, one-use code deletion, replacement Passkey enrollment with atomic global Session revocation and a bounded Security event, and fresh-assertion-gated code-set rotation. The Account ID is the non-secret recovery identifier, presented at signup and in Account security. Enrollment is followed by a new Passkey assertion; the resulting normal Session is unprovisioned. Ticket 11 must implement the separate Vault recovery ceremony before a newly recovered browser can read private Files.
- Validation: `npm run typecheck` and `npm run test:all` passed (79 Node tests, 70 Worker tests, 156 browser tests across Chromium, Firefox, and WebKit). Implementation completion does not imply merge or deployment; the PR and green CI remain the merge gate.
