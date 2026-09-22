# 06: Accounts, passkeys, sessions, and passkey management

**What to build:** A person signs in to mdwn with a passkey and out again; sessions behave as decided (idle and absolute expiry, revocable), and passkey changes require a fresh assertion — all with zero emails, zero passwords, and no plaintext handle or pseudonym at the service.

**Blocked by:** 01 (Project foundation), 02 (Cross-engine test harness).

**Status:** done

- [x] SQLite-compatible schema and reviewed migrations for `accounts` (opaque Account ID, unique opaque share identifier, optional unique normalized share-handle lookup token, lifecycle timestamps), `account_profiles` (encrypted current profile with revision/epoch), `passkeys`, `webauthn_challenges`, and `sessions` — no email, password, plaintext handle, or plaintext pseudonym anywhere.
- [x] `@simplewebauthn/server` and `@simplewebauthn/browser` v14 are used for the ceremony; one-use WebAuthn challenges live in D1 and are deleted after use.
- [x] React Router `createSessionStorage` uses D1-backed CRUD; cookie-contained session state is never the source of truth; the cookie holds only a signed opaque session identifier and is `Secure`, `HttpOnly`, and `SameSite=Lax`.
- [x] A normal Session has 30-day idle and 90-day absolute expiry and is server-tracked; sessions can be revoked individually and all at once.
- [x] Sign-in, sign-out, and session refresh work end-to-end in Chromium, Firefox, and WebKit against a seeded Account, including idle expiry and revoked-session rejection.
- [x] Adding or removing a passkey requires a fresh assertion; removing a passkey revokes Sessions authenticated with that credential; the last remaining recovery path cannot be removed.
- [x] The Account identity carries the generated Public pseudonym inside the encrypted Account profile (the signup ceremony in ticket 08 generates it; this ticket seeds one for tests) and keeps it separate from authentication and share addressing.
- [x] The session purpose field distinguishes a normal Session from the restricted `recovery` purpose used later in ticket 10.


## Comments

- 2026-09-22: Implemented seeded-Account passkey sign-in and Account security controls, D1-backed opaque signed Sessions, one-use purpose-bound WebAuthn challenges, explicit refresh and revocation, and fresh-assertion passkey management. Added encrypted Account-profile helpers and a valid ciphertext pseudonym seed; signup and device enrollment remain ticket 08.
- Validation: typecheck, Unicode drift check, local migration smoke, client secret scan, and deployment dry runs for preview/production passed. The full unfiltered suite passed with 56 Node tests, 38 Worker tests, and 87 browser tests across Chromium, Firefox, and WebKit. A targeted five-test WebKit authentication run also passed with Linux's non-constructor WebAuthn placeholder reproduced locally.
- PR: https://github.com/diurivj/mdwn/pull/7. Implementation completion does not imply merge or deployment; PR review and green CI remain the merge gate. Distinct preview/production Session signing secrets are configured in GitHub for upload alongside the reviewed Worker build on merge.
