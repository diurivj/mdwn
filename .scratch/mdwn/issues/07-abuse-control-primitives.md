# 07: Abuse-control primitives: rolling-window counters, Network buckets, honeypots, Security events

**What to build:** The privacy-preserving enforcement machinery that protected surfaces (registration, Public Comment participation, recovery) can call to apply the decided rate limits, produce generic denials, and record bounded Security events — without ever retaining raw IP addresses or identifying anyone.

**Blocked by:** 01 (Project foundation), 02 (Cross-engine test harness).

**Status:** done

- [x] D1 persists rolling-window counters keyed by purpose, scope (`global`, Account, Publication, Account+Publication, Session, recovery identifier, Network bucket), time epoch, count, and expiry.
- [ ] A Network bucket is a purpose/time-epoch-scoped HMAC of the normalized edge IP using a rotatable key; the raw IP is discarded immediately and counter rows expire within 24 hours.
- [x] The global bucket is checked first, so a rejected request never creates a Network-bucket row.
- [ ] Rate/quota denial returns a generic `429` with `Retry-After` and never confirms whether an Account or recovery record exists; a Comment draft held by the browser survives a denial.
- [ ] A honeypot helper supports one static, genuinely hidden, non-autofillable field on the registration and Public Comment forms; a non-empty value creates no Account or Comment, produces only a generic failure, is never logged or persisted, and records only `honeypot-filled` if an operational event is necessary. Honeypots are not used on sign-in or recovery.
- [x] `security_events` stores only timestamp, action class, allow/deny reason, necessary opaque Account/Publication ID, fixed size class, proof/counter state, retry time, and a short-lived Network bucket; it is operator-only, automatically purged, and retained at most 30 days.
- [x] No abuse-control record contains content, a fragment/capability, raw IP, full URL, headers/body, cookie/session token, credential payload, user agent, or behavioural fingerprint.
- [x] Tests assert the exact window boundaries and scopes from the policy table, the generic response shape, global-first ordering, and that the purge removes only expired rows.

## Comments

- 2026-09-23: The primitives merged into `main` at `15bfc20` (PR #10): atomic rolling counters, purpose/epoch HMAC Network buckets, global-first policy, generic 429 helper, static honeypot helper, bounded Security events, scheduled purge, and policy/Worker tests. **Done refers to these primitives**, not end-to-end integrations. The unchecked form/denial bullets still need the registration UI in 08 and Public Comment UI in 23; the Comment draft cannot yet be tested. A 24-hour counter stops counting exactly at expiry, but physical deletion follows the 15-minute purge schedule rather than being guaranteed within 24 hours. Operator access policy and live Cron execution remain deployment checks.
- 2026-09-23: Ticket 08 landed on `main` via PR #11, integrating the registration honeypot and registration challenge/success quotas. The unchecked bullets still cover Public Comment and recovery integrations, Comment draft retention, and strict physical deletion timing; do not treat those as completed by signup.
- 2026-09-29: The user decided where the three unchecked criteria go. Network-bucket key rotation and physical deletion within 24 h move to ticket 31. The Public Comment generic `429` with draft survival, and the Public Comment honeypot, move to ticket 23. Signup and both recovery surfaces already return `rateLimitResponse`, and the registration honeypot shipped in 08. Each criterion stays unchecked here until its new home ticks it.
