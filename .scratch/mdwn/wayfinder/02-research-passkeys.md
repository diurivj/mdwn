# Research: passkeys/WebAuthn implementation and recovery

Type: research
Status: resolved
Blocked by:

## Question

For a TypeScript **RR7 (React Router v7)** web app on Node, what is the current best-supported way to implement **passkeys (WebAuthn)** for login and registration?

- Which library (e.g. SimpleWebAuthn) integrates cleanly with an RR7/Node server, and what are the current maintenance/version facts?
- What does open signup with passkeys look like — can an attacker register unlimited accounts, and what stops them?
- Recovery is the hard part: passkeys are device-bound. What are the accepted recovery patterns (recovery codes, a second device, synced/backup vs device-bound authenticators, an email fallback), and what is the security cost of each?
- Can you support "passkeys first, optional fallback" without weakening the privacy story?

Findings go in `.scratch/mdwn/research/passkeys-webauthn.md`, every claim cited to a primary source (library docs/repo, WebAuthn spec, platform docs).

## Answer

Use `@simplewebauthn/server` + `@simplewebauthn/browser` (v14.x, Node 22+, framework-agnostic; challenge must be stored server-side and deleted on use) with RR7 `action`/`loader` + `createCookieSessionStorage`. Passkeys-first works; "no password ever" stays compatible with privacy because the server only stores a public key and the login identifier may be pseudonymous ([NIST](https://pages.nist.gov/800-63-4/sp800-63b.html), [Google](https://developers.google.com/identity/passkeys)). WebAuthn has **no** built-in signup abuse control ([spec §13](https://www.w3.org/TR/webauthn-3/)), so open signup needs rate limits plus either a proof-of-work bot challenge ([Turnstile](https://developers.cloudflare.com/turnstile/)) or an email-confirmed signup ([SimpleWebAuthn](https://simplewebauthn.dev/docs/advanced/passkeys)). Recovery, not login, is where privacy cost enters: the PII-free pair is a pre-enrolled **second passkey** + **single-use recovery codes** (≥64 bits, hashed, rate-limited — [NIST §4.2.1.1](https://pages.nist.gov/800-63-4/sp800-63b/events/)); synced passkeys recover automatically but cede trust to the platform and cap at AAL2 ([NIST App B](https://pages.nist.gov/800-63-4/sp800-63b/syncable/), [Apple](https://support.apple.com/en-us/102651)); email fallback is standards-permitted for recovery only but weakest and most PII-heavy ([NIST §3.1.3.1](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)). Keep attestation off by default (it excludes synced passkeys and creates device provenance). Full findings: `.scratch/mdwn/research/passkeys-webauthn.md`.
