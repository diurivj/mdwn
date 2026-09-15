# Passkeys / WebAuthn for an RR7 + Node app — research findings

Research for `issues/02-research-passkeys.md`. Method: primary sources only (library repos/docs,
the W3C WebAuthn spec, NIST SP 800-63B, platform vendor docs, OWASP). Web-search APIs were
unavailable during this session, so facts below were pulled by fetching the source pages directly
and, for SimpleWebAuthn, by cloning the repo at `main` (HEAD `7e3c4c4`, 2026-09-12). Every claim is
cited to the page that owns it.

Scope note (2026): the project decision records say **React Router v7**. React Router **v8** is now
released and is described by the project as a *non-breaking* upgrade from v7, with a modern baseline
of **Node 22+, Vite 7+, React 19+, ESM-only** ([reactrouter.com](https://reactrouter.com/)). This
matters only because SimpleWebAuthn's own baseline is also Node LTS 22+ (below), so either target
sits on Node 22+.

---

## 1. Library: SimpleWebAuthn is the best-supported option, and is framework-agnostic

**Current status (verified from the repo, not memory):**

- Two packages: `@simplewebauthn/server` and `@simplewebauthn/browser`
  ([repo README](https://github.com/MasterKale/SimpleWebAuthn#readme)).
- Versions in `main` at time of research: server **14.0.2**, browser **14.0.0**; the docs site
  shows **Version: 14.0.x** ([deno.json](https://github.com/MasterKale/SimpleWebAuthn/blob/main/packages/server/deno.json),
  [simplewebauthn.dev/docs](https://simplewebauthn.dev/docs/)).
- **Node LTS 22.x and higher**, Deno v2.4.x and higher; also "other compatible runtimes (Cloudflare
  Workers, Bun, etc.)" ([repo README](https://github.com/MasterKale/SimpleWebAuthn#readme),
  [server install docs](https://simplewebauthn.dev/docs/packages/server#installation)).
- Actively developed: HEAD commit dated 2026-09-12 (clone of `main`); changelog shows v14.0.0
  (PQC ML-DSA support, Node 22 minimum) and a v14.0.2 release fixing two security advisories
  ([CHANGELOG.md](https://github.com/MasterKale/SimpleWebAuthn/blob/main/CHANGELOG.md),
  [GHSA-2g3p-m8c9-hhwh](https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-2g3p-m8c9-hhwh)).
- **Bus-factor caveat:** the README states "The SimpleWebAuthn project is not currently open to
  external contributions" and directs fixes/features to issues
  ([README](https://github.com/MasterKale/SimpleWebAuthn#contributions)). One maintainer, no external
  PRs — a real supply-chain/continuity consideration for a long-lived project, mitigated by the
  library being small, fully typed, and MIT-licensed.
- Supports **all current WebAuthn attestation formats** (Packed, TPM, Android Key, Apple, FIDO U2F,
  None) and now PQC algorithms ([server README](https://github.com/MasterKale/SimpleWebAuthn/blob/main/packages/server/README.md#supported-attestation-formats),
  [CHANGELOG](https://github.com/MasterKale/SimpleWebAuthn/blob/main/CHANGELOG.md)).

**Why it fits RR7/Node:** the library is not framework-coupled. It exposes pure functions that
consume/produce JSON — `generateRegistrationOptions` / `verifyRegistrationResponse` and
`generateAuthenticationOptions` / `verifyAuthenticationResponse` — which map directly onto RR7
resource routes or `action`/`loader` handlers ([server docs](https://simplewebauthn.dev/docs/packages/server#registration)).
The browser package is called from a client component and "should be easily adaptable to the front
end framework of your choice (React/VueJS/Svelte/etc...)"
([browser docs](https://simplewebauthn.dev/docs/packages/browser#startregistration)).

**The one piece of server state you must add:** the challenge. Options generation returns a
`challenge` that must be stored server-side between the two requests and consumed exactly once.
SimpleWebAuthn explicitly documents the pattern — assign an HTTP-only session cookie on page view,
store the challenge (their example uses Redis `setex()`, 5 minutes) keyed by session ID, "Make sure
to delete the challenge so it can't be reused, even if verification fails, to prevent replay
attacks!" ([advanced/passkeys — Remembering challenges](https://simplewebauthn.dev/docs/advanced/passkeys#remembering-challenges)).
In RR7 this is a natural fit for `createCookieSessionStorage` / `createSessionStorage` plus a table
or KV store ([RR sessions-and-cookies](https://reactrouter.com/explanation/sessions-and-cookies)).

**Storage shape and privacy:** SimpleWebAuthn publishes a recommended schema — a `passkeys` table
keyed by credential `id`, with `publicKey` (bytes), `webauthnUserID`, `counter`,
`deviceType` (`singleDevice`/`multiDevice`), `backedUp`, and `transports`. It notes a
`UNIQUE(webAuthnUserID + user)` constraint "achieves maximum user privacy"
([server docs — Additional data structures](https://simplewebauthn.dev/docs/packages/server#additional-data-structures)).
Note the counter caveat: some authenticators (e.g. Touch ID on macOS) always return `0`, so a
repeated counter is not proof of cloning, especially for multi-device credentials
([server docs](https://simplewebauthn.dev/docs/packages/server#3-post-registration-responsibilities)).

---

## 2. Open signup with passkeys: the spec stops nothing; the RP must

**What passkeys do NOT solve:** registration is just a public-key ceremony. The WebAuthn spec
contains no anti-automation or account-creation control. Its §13 Security Considerations says
bluntly: "At this time, this specification does not feature detailed security considerations," and
the only rate-limiting concept it defines is an **authenticator-side** mechanism against brute-force
PIN attempts, not an RP-side signup limit ([W3C WebAuthn L3](https://www.w3.org/TR/webauthn-3/),
§4 "Rate Limiting", §13). An attacker can script browser/authenticator calls and create accounts
indefinitely if the RP lets them. Passkeys raise the *cost per account* only slightly (each needs a
fresh keypair and a user gesture/UV prompt); they do not act as a captcha.

**Usernameless login is a deliberate option, and it changes the signup UX:** with discoverable
credentials the RP can invoke `navigator.credentials.get()` with an empty `allowCredentials`, and the
authenticator must return a `userHandle`, letting the user pick an account without typing an
identifier ([spec §4, §5.2.2](https://www.w3.org/TR/webauthn-3/); SimpleWebAuthn's
`generateAuthenticationOptions({ allowCredentials: [] })` and conditional UI, plus `<input
autocomplete="username webauthn">` for browser autofill
([advanced/passkeys](https://simplewebauthn.dev/docs/advanced/passkeys); [browser docs](https://simplewebauthn.dev/docs/packages/browser#browser-autofill-conditional-ui);
[passkeys.dev bootstrapping](https://passkeys.dev/docs/use-cases/bootstrapping/))). This is the
"passkeys-first" login experience, but it means the account identity lives in `webauthnUserID` +
credential rows, not necessarily in a username.

**What actually limits abuse (primary-source options):**

| Control | Primary-source basis | Privacy cost |
|---|---|---|
| Per-IP / per-account rate limits on the ceremony endpoints | NIST SP 800-63B-4 §3.2.2: verifiers "**SHALL** implement a rate-limiting mechanism", with a 100-attempt upper bound and optional "bot detection and mitigation challenge" ([NIST](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)) | Low (ephemeral/aggregate) |
| Proof-of-work / bot challenge | Cloudflare Turnstile: "non-interactive JavaScript challenges… include proof-of-work (computational puzzles), proof-of-space…"; it "does not access, store, or transmit user communications, form entries, or other page inputs" ([Turnstile docs](https://developers.cloudflare.com/turnstile/)) | Medium: it is still a third-party script; self-hosting or a local PoW avoids third-party leakage |
| Email verification / magic link as the signup gate | SimpleWebAuthn recommends exactly this: "ideally after verifying that the new user is not a bot… a 'magic link' sent to an email address… confirms that the user is signing up with a valid email account… then initiates a registration ceremony" ([advanced/passkeys](https://simplewebauthn.dev/docs/advanced/passkeys#remembering-challenges)); NIST permits email **confirmation codes** even though it bans email for authentication (§3.1.3.1) ([NIST](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)) | High: collects PII and a recoverable identifier |
| Require attestation ("direct") to gate device provenance | Microsoft: attestation "provides cryptographically verifiable device identity through FIDO Metadata Service"; synced passkeys "do not support attestation", and enforcing it "only device-bound passkeys are allowed" ([Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2)) | High: creates a device-identity signal; excludes platform synced passkeys; passkeys.dev recommends **against** requesting attestation for most RPs ([passkeys.dev](https://passkeys.dev/docs/use-cases/bootstrapping/)) |

The tension for an open-signup, privacy-first app: the cheapest strong anti-bot gate (email) is also
the thing privacy-minded users least want to hand over; the most privacy-preserving gate (self-hosted
PoW + rate limits) is weaker. This is a genuine trade-off for ticket `04`, not a settled answer.

---

## 3. Recovery: the hard part, and what each pattern costs

**First, the spec's position.** WebAuthn defines no key backup or transfer. "This specification
defines no protocol for backing up credential private keys, or for sharing them between
authenticators… Losing an authenticator therefore, in general, means losing all credentials bound to
the lost authenticator." Its prescribed mitigations: register multiple credentials per account and
implement an account recovery process — "Relying Parties SHOULD allow and encourage users to
register multiple credentials to the same user account" and "SHOULD ensure that each user account
has additional authenticators registered and/or an account recovery process in place"
([W3C WebAuthn L3 §13.4.6, §6.1.3](https://www.w3.org/TR/webauthn-3/)).

**Synced vs device-bound is reported by the authenticator via the BE/BS flags** (authenticator data
bits 3 and 4). BE=1 means backup-eligible ("multi-device credential"), BS=1 means currently backed
up; BE "MUST NOT change after a registration ceremony", and the allowed combinations are
single-device, multi-device-not-backed-up, multi-device-backed-up ([spec §6.1, §6.1.3](https://www.w3.org/TR/webauthn-3/)).
SimpleWebAuthn surfaces these as `credentialDeviceType` and `credentialBackedUp`
([advanced/passkeys](https://simplewebauthn.dev/docs/advanced/passkeys)).

### (a) Second / multiple credentials (device-bound or another provider)
- **How:** prompt users to enrol a second authenticator (another phone, a security key), enforced by
  checking `excludeCredentials` / `user.id` to avoid duplicates ([spec §13.4.6](https://www.w3.org/TR/webauthn-3/)).
- **Cost:** the lost-device case is covered without any server-side secret-to-identity reset; but the
  user must actually enrol the second credential before loss, and each credential is a separate
  attack surface. This is the cleanest recovery story and the spec's first recommendation.

### (b) Synced / backup-eligible passkeys (iCloud Keychain, Google Password Manager, etc.)
- **How it works:** the platform syncs an encrypted copy of the private key across the user's devices
  in the same provider account. Apple: "Passwords and Keychain" (which includes passkeys) is in the
  15 categories that are **always end-to-end encrypted**; Apple "doesn't have the encryption keys for
  these categories" ([Apple iCloud data security](https://support.apple.com/en-us/102651)). Google:
  passkeys are "securely encrypted on-device before being synced", and "Passkeys on their own don't
  allow tracking users or devices between sites" ([Google passkeys](https://developers.google.com/identity/passkeys)).
  Microsoft describes the model as HSM-created, encrypted on device, synced via the provider's cloud,
  and notes synced passkeys **do not support attestation** ([Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2)).
- **Security trade-offs:**
  - Convenience is excellent and device-loss recovery is automatic — the RP gets `credentialBackedUp: true`
    and can treat it as lower recovery risk ([SimpleWebAuthn](https://simplewebauthn.dev/docs/advanced/passkeys)).
  - The RP **cannot verify the provider's security**; the sync fabric becomes the real root of trust.
    NIST's syncable-authenticator appendix requires the sync fabric to protect keys with AAL2-equivalent
    MFA, store keys only encrypted (≥112-bit strength, "SHOULD… employ a user-controlled secret"), and
    says syncing "violates the non-exportability requirements of AAL3", so syncable credentials are
    **only usable up to AAL2** ([NIST SP 800-63B-4 Appendix B](https://pages.nist.gov/800-63-4/sp800-63b/syncable/)).
  - FIDO's own framing: "Device-bound passkeys in modern hardware security keys offer the highest
    security assurance", and a security key can be used as a recovery factor if the user loses access
    to devices with synced passkeys ([FIDO Alliance](https://fidoalliance.org/passkeys/)).

### (c) Recovery codes ("saved recovery codes" / look-up secrets)
- **How:** issue one high-entropy code at enrolment; the user stores it offline; present it to start
  recovery.
- **Security cost:**
  - NIST requires saved recovery codes to include **at least 64 bits** from an approved RNG and
    forbids reuse; issuance of a replacement must trigger an account-recovery notification
    ([NIST SP 800-63B-4 §4.2.1.1](https://pages.nist.gov/800-63-4/sp800-63b/events/)).
  - Look-up secrets in general are "**not** phishing-resistant", must be stored hashed, at least six
    digits, used successfully only once, and the verifier "**SHALL** implement a rate-limiting
    mechanism" ([NIST §3.1.2, §3.1.2.2](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)).
  - OWASP: tokens must be "randomly generated… sufficiently long… stored securely… single use and
    expire", and responses must not enable account enumeration
    ([OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)).
- **Verdict:** the standard, privacy-friendly default — no third party, no PII — but it moves the
  root of trust back to a paper/offline secret and is phishable and lossable. Because recovery codes
  are "something you have", combining them with a still-held passkey is stronger than codes alone.

### (d) Email fallback
- **What the standards say:** NIST **bans email for out-of-band authentication** ("Email **SHALL
  NOT** be used for out-of-band authentication because it may be vulnerable to: Access using only a
  password; Interception…; Rerouting attacks, such as those caused by DNS spoofing") **but
  explicitly exempts** "confirmation codes that are sent to validate email addresses or are issued
  as recovery codes" ([NIST §3.1.3.1](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)).
  So an email-based **recovery** flow is standards-permissible; an email-based **login** factor is not.
  SimpleWebAuthn likewise recommends an email "point of contact" because "the point of contact can
  also help with account recovery in case of device loss" ([advanced/passkeys](https://simplewebauthn.dev/docs/advanced/passkeys)).
- **Security cost:** email is only as strong as the user's mail account (often itself password-only),
  is phishable, and introduces a support-visible account-recovery path. It also means storing an
  email address — the exact PII a privacy-first product may not want. Use short-lived single-use
  tokens, hash them at rest, rate-limit, and send a notification after any recovery
  ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html); NIST
  §4.2 requires recovery notifications).

### (e) Recovery contacts / repeated identity proofing
NIST recognises four recovery classes: saved recovery codes, issued recovery codes, recovery
contacts, and repeated identity proofing; a CSP "**SHALL** support one or more", and any
application-specific method "**SHALL** be based on a risk analysis and documented". Every recovery
event "always causes one or more notifications to be sent to the subscriber to help detect the
fraudulent use of account recovery" ([NIST §4.2](https://pages.nist.gov/800-63-4/sp800-63b/events/)).
For a no-monetization, no-support-team app, recovery contacts and identity proofing are likely too
heavy; codes + a second credential are the realistic set.

### Recovery comparison

| Pattern | Recovers lost device? | PII / third party | Security level | Primary source |
|---|---|---|---|---|
| Second credential | Only if pre-enrolled | None | Highest (device-bound) | WebAuthn §13.4.6 |
| Synced passkey | Yes, automatically | Platform provider | High, but provider is root; AAL2 cap | NIST App B; Apple; Google |
| Recovery codes | Yes | None | Medium; phishable, single-use | NIST §4.2.1.1 |
| Email fallback | Yes | Email address + mail provider | Weakest; email is password-protected | NIST §3.1.3.1; OWASP |
| Recovery contact / proofing | Yes | Depends | Varies; needs documented risk analysis | NIST §4.2 |

---

## 4. Can "passkeys-first with optional fallback" coexist with a strong privacy stance?

**Evidence that it can, if scoped carefully:**

- Passkeys are privacy-positive by construction: biometric material "never leaves the user's personal
  device", and "Passkeys on their own don't allow tracking users or devices between sites… Passkey
  protocols are carefully designed so that no information shared with sites can be used as a tracking
  vector" ([Google](https://developers.google.com/identity/passkeys)). The server stores only a
  public key and credential metadata ([SimpleWebAuthn schema](https://simplewebauthn.dev/docs/packages/server#additional-data-structures)).
- NIST explicitly allows the authenticated identifier to be **pseudonymous**: "The identifier **MAY**
  be pseudonymous" ([NIST AAL intro](https://pages.nist.gov/800-63-4/sp800-63b.html)). So an account
  needs a stable internal handle (`webauthnUserID`), not a legal identity.
- "Passkeys first, optional fallback" does not require email at all if the fallback is **recovery
  codes + a second credential**. That combination keeps the server free of PII and free of any
  third-party dependency, at the cost of a worse lost-everything story for non-technical users.
- If email is added as a fallback, keep it optional and minimal: verify it once, store it, use it
  only for recovery tokens (NIST-permitted), and prefer a generic response to avoid enumeration
  (OWASP).

**Where privacy is genuinely weakened:**
1. **Email as identifier** — it is PII, it correlates the account to a real mailbox, and it creates a
   phishable recovery channel. It also lets an operator (or a compromised mailbox) take over an
   account in a way passkeys prevent.
2. **Third-party bot defence** — Turnstile processes only what is necessary and stores no form data,
   but it is still an external script on a privacy-first page ([Cloudflare](https://developers.cloudflare.com/turnstile/)).
   A self-hosted proof-of-work challenge plus rate limits avoids that; the trade is weaker bot
   resistance.
3. **Attestation** — enforcing it creates device provenance and excludes synced passkeys entirely
   ([Microsoft](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2),
   [passkeys.dev](https://passkeys.dev/docs/use-cases/bootstrapping/)). For an open-signup privacy
   product this is the wrong default.

**Bottom line:** passkeys-first is privacy-*friendly*; the fallback, not the passkey, is where the
privacy cost enters. A defensible stance is: passkeys required as the primary credential; no password
ever; recovery via (1) a second passkey the user is prompted to enrol and (2) single-use recovery
codes; email verification optional and used only to gate signup/recovery when the user chooses to
provide it. Attestation off.

---

## 5. Decision inputs for `issues/04-design-auth.md`

Concrete facts a later decision depends on (not decisions themselves):

- Library: `@simplewebauthn/server` + `@simplewebauthn/browser`, v14.x, Node 22+, framework-agnostic;
  challenge must be persisted server-side per ceremony and deleted on use. MIT; one maintainer, not
  accepting external PRs.
- RR7: use `loader`/`action` + `createCookieSessionStorage`/`createSessionStorage`; target Node 22+
  (also required by RR v8, which is a non-breaking upgrade).
- Discoverable credentials + conditional UI give a username-less "Sign in with a passkey" button; the
  account identity can be an opaque `webauthnUserID`.
- Open signup has no built-in abuse control; the RP needs rate limits + either a bot challenge or an
  email-confirmed signup. Email is the stronger gate and the bigger privacy cost.
- Recovery has four standards-recognised classes; "second credential + recovery codes" is the
  PII-free pair, email is the permissive/weak one. Synced passkeys move trust to the platform
  provider and cap at AAL2; device-bound keys are highest assurance.
- Store `deviceType`/`backedUp`/`counter`/`transports` per credential; do not treat a non-incrementing
  counter as proof of compromise.

## Open questions / limits of this research

- No verified, current benchmarking of alternatives (e.g. `fido2-lib`); SimpleWebAuthn is clearly the
  best-documented and the only one checked here. If a second option matters, verify it separately.
- Real-browser testing of conditional UI / cross-device auth in the target stack was not done.
- Bot-defence effectiveness vs. fingerprinting for a self-hosted proof-of-work scheme was not tested.

## Sources (primary)

- W3C WebAuthn Level 3 — https://www.w3.org/TR/webauthn-3/
- NIST SP 800-63B-4 — https://pages.nist.gov/800-63-4/sp800-63b.html ; authenticators
  https://pages.nist.gov/800-63-4/sp800-63b/authenticators/ ; events/recovery
  https://pages.nist.gov/800-63-4/sp800-63b/events/ ; syncable Appendix B
  https://pages.nist.gov/800-63-4/sp800-63b/syncable/ ; session
  https://pages.nist.gov/800-63-4/sp800-63b/session/ ; privacy
  https://pages.nist.gov/800-63-4/sp800-63b/privacy/
- SimpleWebAuthn — repo https://github.com/MasterKale/SimpleWebAuthn ; docs
  https://simplewebauthn.dev/docs/ ; server https://simplewebauthn.dev/docs/packages/server ;
  browser https://simplewebauthn.dev/docs/packages/browser ; passkeys
  https://simplewebauthn.dev/docs/advanced/passkeys
- React Router — https://reactrouter.com/ ; sessions & cookies
  https://reactrouter.com/explanation/sessions-and-cookies
- FIDO Alliance passkeys — https://fidoalliance.org/passkeys/
- passkeys.dev (FIDO/W3C project) — https://passkeys.dev/docs/use-cases/bootstrapping/
- Apple iCloud data security — https://support.apple.com/en-us/102651
- Google Identity passkeys — https://developers.google.com/identity/passkeys
- Microsoft Entra passkeys (FIDO2) — https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2
- OWASP Forgot Password Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- Cloudflare Turnstile — https://developers.cloudflare.com/turnstile/
