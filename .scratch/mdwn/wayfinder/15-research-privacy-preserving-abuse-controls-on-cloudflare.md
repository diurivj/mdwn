# Research: privacy-preserving abuse controls on Cloudflare

Type: research
Status: resolved
Assignee: diurivj
Blocked by: 04, 06, 07, 08

## Question

Given [Design authentication: passkeys, recovery, open signup](04-design-auth.md), [Public publish model](06-public-publish-model.md), [Comments model](07-comments-model.md), and [Lock the stack and hosting](08-lock-stack-and-hosting.md), research the current Cloudflare-native, free/cheap options for privacy-preserving abuse controls:

- Which Workers, D1, WAF, Turnstile, Rate Limiting, Durable Object, or related primitives are available at the selected budget, and what are their current quotas, billing triggers, and implementation constraints?
- How can mdwn rate-limit passkey registration, recovery-code attempts, sessions, and signed-in public Comment posting by account, Publication, and network without retaining more network data than necessary?
- Can the existing browser proof-of-work approach be combined with these controls without adding third-party CAPTCHA, behavioral tracking, or a Public-link fragment to requests or logs?
- What bounded operational or abuse logs are necessary, how can IP-derived data be minimized or hashed, and which facts must remain server-visible to enforce limits?
- What controls are practical for public Comment spam and repeated abusive Accounts when content remains unreadable to the service and File Owners already have hard-delete authority?

Write findings to `.scratch/mdwn/research/cloudflare-abuse-controls.md`. Cite every current product, quota, pricing, and privacy claim to Cloudflare’s primary documentation; distinguish documented facts from recommendations for the later decision.

## Answer

**Resolution — Cloudflare provides a privacy-compatible baseline, but policy must be application-owned.** Full cited findings: [Research: privacy-preserving abuse controls on Cloudflare](../research/cloudflare-abuse-controls.md).

- On the Free tier, Workers/D1 and (if justified) SQLite-backed Durable Objects can keep bounded counters, but their quotas are shared application capacity. Free WAF rate limiting is only one coarse path/verified-bot rule, so it cannot replace account- or Publication-aware application controls.
- A layered counter design can use short-lived global, Account, Publication, Account+Publication, and purpose-scoped network buckets. The research recommends persisting only a short-lived, rotatable-HMAC network bucket key—not a raw IP—and stresses that this is pseudonymisation, not anonymisation.
- Browser proof-of-work can stay endpoint-bound and fragment-safe: challenge data must never derive from a full public URL, and comment posting uses a server-known Publication ID plus Account authorization rather than the read capability. Turnstile is free but remains an optional, disclosed Cloudflare-managed fallback because it conflicts with the current application-controlled PoW/no-third-party-CAPTCHA preference.
- Since the service cannot read Comment text, practical public-comment controls are admission friction, opaque-ID/size/time limits, Owner hard deletion, bounded Account suspension/session revocation, and category-only reports—not server-side content moderation.
- The research explicitly leaves product policy open: Free-only versus Paid upgrade posture, WAF/DO use, exact counter thresholds, PoW/accessibility fallback, logging/retention, enforcement/appeal, and any Turnstile exception belong in [Lock abuse and rate-limit policy](16-lock-abuse-and-rate-limit-policy.md).
