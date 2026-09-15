# Research: passkeys/WebAuthn implementation and recovery

Type: research
Status: open
Blocked by:

## Question

For a TypeScript **RR7 (React Router v7)** web app on Node, what is the current best-supported way to implement **passkeys (WebAuthn)** for login and registration?

- Which library (e.g. SimpleWebAuthn) integrates cleanly with an RR7/Node server, and what are the current maintenance/version facts?
- What does open signup with passkeys look like — can an attacker register unlimited accounts, and what stops them?
- Recovery is the hard part: passkeys are device-bound. What are the accepted recovery patterns (recovery codes, a second device, synced/backup vs device-bound authenticators, an email fallback), and what is the security cost of each?
- Can you support "passkeys first, optional fallback" without weakening the privacy story?

Findings go in `.scratch/mdwn/research/passkeys-webauthn.md`, every claim cited to a primary source (library docs/repo, WebAuthn spec, platform docs).

## Answer
