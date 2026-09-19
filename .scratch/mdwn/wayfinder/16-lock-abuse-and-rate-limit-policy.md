# Lock abuse and rate-limit policy

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 15

## Question

Using [Research: privacy-preserving abuse controls on Cloudflare](15-research-privacy-preserving-abuse-controls-on-cloudflare.md), lock the privacy-preserving abuse policy for mdwn’s open signup and signed-in public Comments:

- Choose the Free-only versus Paid-upgrade posture, whether to use the lone Free WAF rule, and D1-only versus a narrowly justified Durable Object counter store.
- Choose the exact layered controls for account registration, WebAuthn challenge/recovery endpoints, sessions, and Comment creation; distinguish account-, Publication-, and network-scoped limits.
- Decide when the browser proof-of-work challenge appears, how failure and retry behave, and whether any Cloudflare-managed challenge is acceptable under the no-tracking preference.
- Set the minimum operational data, retention bounds, access controls, and deletion behavior for abuse evidence without logging Markdown, Comment plaintext, decryption capabilities, or URL fragments.
- Define the MVP response to public Comment spam and abusive Accounts beyond a File Owner’s hard-delete authority, without pretending the service can perform plaintext content moderation.
- Record any hard-to-reverse, surprising trade-off as an ADR.

## Answer

**Resolution — Free-tier, privacy-preserving abuse controls.** mdwn’s MVP remains entirely on Workers Free plus D1: it has no automatic paid upgrade, Durable Object counter service, Turnstile, behavioural tracking, or visitor-identifying cookie. The one Free WAF rate-limit rule is a coarse 30-request-per-10-second circuit breaker with 10-second mitigation for registration routes. It is not the authorization or rate-limit source of truth; D1 checks application policy atomically before protected operations.

### Counter policy

All limits use rolling windows. The global bucket is checked first so an exhausted global cap rejects a request before creating a network-bucket row. A network bucket persists only a purpose- and time-epoch-scoped HMAC of the normalized edge IP, with a rotatable key; the raw IP is discarded. Counter records expire no later than 24 hours.

| Surface | Limits |
| --- | --- |
| Registration challenge | Network: 3 / 15 min, 10 / 24 h; global: 30 / 10 min |
| Successful registration | Network: 2 / 24 h; global: 100 / 24 h |
| WebAuthn sign-in ceremony | Network: 10 / 15 min, 50 / 24 h; Account once known: the same; global: 120 / 10 min |
| Recovery ceremony or code attempt | Network and recovery identifier: 3 / h, 10 / 24 h; global: 30 / 10 min |
| Session refresh | 12 / h per Session; revocation remains idempotent and available |
| Public Comment create or edit | Account: 5 / 10 min, 30 / 24 h; Publication: 10 / 10 min, 100 / 24 h; Account + Publication: 3 / 10 min, 20 / 24 h; network: 10 / 10 min, 50 / 24 h; global: 30 / min, 300 / 24 h |
| Public Comment report | 3 / 24 h per Account |
| Publication create or rotate | 5 / 24 h per Account |

A registration challenge is one-use: a proof submission, valid or invalid, consumes it, while a new challenge remains subject to the issuance cap. Successful-registration limits apply only after an Account is created. Public-participation limits never block hard deletion, unpublishing, session revocation, or browser export.

### Signup friction

Every registration completion requires a browser-worker proof of work: find an 8-byte nonce for which `SHA-256(challenge-bytes || nonce)` has 18 leading zero bits. The server binds the random challenge to registration only, expires it after five minutes, validates it cheaply, and marks it spent atomically. There is no difficulty escalation, Turnstile fallback, CAPTCHA, tracking, or operator override; a person may retry after the applicable cooldown using the fixed modest challenge.

Registration and public-Comment forms also contain one static, genuinely hidden, non-autofillable honeypot field. It is an auxiliary bot signal only, never a substitute for the proof of work or counters. A non-empty value creates no Account or Comment, is never logged or persisted, and produces only a generic failure; if an operational record is necessary, it contains the reason code `honeypot-filled`, never the field value. Do not use CSS-only or focusable traps, dynamic tracking fields, or honeypots on login or recovery flows.

### Minimal operational data and enforcement

One-use challenge records live for at most 10 minutes. A structured Security event may retain only timestamp, action class, allow/deny reason, the necessary opaque Account or Publication ID, fixed size class, proof/counter state, retry time, and the short-lived purpose-scoped network bucket. It is retained for at most 30 days, accessible only to the operator, and automatically purged on a tested schedule. Disable blanket Workers request logging. Never retain Markdown or Comment plaintext/ciphertext, capabilities, public-link fragments, raw IPs, full URLs, request headers, bodies, cookies, session tokens, recovery/passkey payloads, user agents, or behavioural/fingerprint data.

A File Owner’s hard deletion is the first response to unwanted public Comments. A signed-in Account may submit a rate-limited category-only report naming an opaque Public Comment ID; a report never exposes or authorizes review of Comment plaintext. For repeated technical abuse or a metadata-supported report pattern, mdwn may apply a **Public-participation suspension**: the first lasts seven days and a repeat lasts 30 days. It blocks public Comment posting and Publication creation or rotation, while preserving private Files, Shares, export, recovery, and ownership. There is no permanent account deletion, private-vault lockout, content moderation, or formal appeal flow in the MVP; suspensions expire automatically and the operator may correct an evident mistake from bounded metadata.

Rate- or quota-limited operations fail closed with a generic `429` and `Retry-After`, without revealing Account or recovery-record existence; the browser retains an unsent Comment draft. If platform capacity is exhausted, new registration, recovery attempts, and public Comment mutations fail closed, with no automatic paid spend. Essential security actions are excluded from public-participation limits, although a platform-wide outage cannot be bypassed.

This privacy/capacity trade-off is recorded in [ADR 0005: Privacy-preserving abuse controls](../../../docs/adr/0005-privacy-preserving-abuse-controls.md). The canonical terms are captured in [`CONTEXT.md`](../../../CONTEXT.md).