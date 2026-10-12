# Privacy-preserving abuse controls

mdwn will stay on the Workers/D1 Free tier for the MVP and use a coarse Free WAF breaker, D1-backed purpose-scoped counters, browser proof of work for signup, and form honeypots. It deliberately rejects Turnstile, Durable Objects, paid autoscaling, behavioural tracking, and persistent raw-IP logging: lower abuse resistance and availability are accepted to preserve the no-tracking and fixed-cost commitments.

Only short-lived, purpose-scoped network identifiers and bounded Security events may support enforcement. The service may temporarily suspend an Account’s public participation without reading encrypted content, but it must preserve that Account’s private Files, Shares, export, recovery, and ownership.


## Superseded in part (2026-10-12)

The premises that mdwn "will stay on the Workers/D1 Free tier for the MVP" and that a **fixed-cost** (zero-overage) commitment is one reason to reject paid autoscaling are superseded. Workers Paid is now the intended, metered operating baseline; whether the account is already subscribed is unconfirmed. Once Workers Paid is active, abuse that exceeds the included allowances becomes usage overage rather than a Free-tier outage, and no alert or application limit caps the invoice; until then, the Free-tier limits still apply. See the [Workers Paid operating policy](../operations.md#workers-paid-operating-policy) and [Budgeted Workers Paid adoption](../workers-paid-plan.md) §2.

Unchanged: the coarse WAF breaker, D1-backed purpose-scoped counters and their limits, browser proof of work, honeypots, short-lived Network buckets, bounded Security events and Public-participation suspension. Turnstile, Durable Objects, behavioural tracking and persistent raw-IP logging remain rejected on privacy and scope grounds; Paid capacity is not a reason to weaken or replace these controls.
