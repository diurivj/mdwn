# Design authentication: passkeys, recovery, open signup

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 01, 02

## Question

Given the privacy model (`01`) and the passkey research (`02`), lock the authentication design:

- Passkeys-only, or passkeys with a fallback? If fallback, what and how is it secured?
- The recovery flow in detail: what happens when a user loses every device? Who can recover, and what can they prove?
- Open signup: is email required as an identifier, and is it verified? What abuse controls (rate limits, proof of work, captcha) are acceptable given the no-tracking stance?
- Sessions: cookie strategy, lifetime, revocation.
- What identity does a user have if passkeys are device-bound? What anonymity do public readers get?

## Answer

Authentication is passkeys-only, email-free, and pseudonymous:

- An Account has a random opaque identity and may have an optional handle/display name. mdwn does not collect or store email addresses anywhere in the project.
- Passkeys are the only routine authentication method. An Account may register multiple synced or device-bound passkeys; attestation is off. Adding or removing a passkey requires recent verification, and the final remaining recovery path cannot be removed.
- Signup is open and protected by rate limits plus a privacy-preserving browser proof-of-work challenge. No third-party CAPTCHA, tracking, analytics, or behavioural fingerprinting is required. Short-lived operational abuse logs may exist, but exclude content, decryption keys, and public-link fragments.
- Account recovery uses a non-secret recovery identifier and ten high-entropy, single-use recovery codes shown once to the account holder. Code values are stored only as hashes; consuming a code invalidates it, and generating a replacement set invalidates the previous set. A second passkey is strongly encouraged.
- Recovery-code use creates a short-lived recovery session limited to registering a replacement passkey. After enrollment, the replacement passkey establishes a normal session; recovery codes are not a password-like routine login factor. Recovery revokes all active sessions, preserves existing passkeys, and records an in-app security event.
- Sessions are opaque, server-tracked, revocable grants with `Secure`, `HttpOnly`, `SameSite=Lax` cookies, 30-day idle expiry, and 90-day absolute expiry. Removing a passkey revokes sessions authenticated with it; users can revoke all sessions.
- Public readers do not have Accounts or sessions and receive no tracking identity. Network-level request metadata may still be visible to infrastructure and is subject only to bounded abuse/security retention.
- Losing every passkey and every recovery code makes the Account unrecoverable; there is no email, password, support, or operator override. Whether a newly authenticated browser can regain encrypted vault keys is governed by the encrypted-content capability model.
