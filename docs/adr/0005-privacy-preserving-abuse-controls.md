# Privacy-preserving abuse controls

mdwn will stay on the Workers/D1 Free tier for the MVP and use a coarse Free WAF breaker, D1-backed purpose-scoped counters, browser proof of work for signup, and form honeypots. It deliberately rejects Turnstile, Durable Objects, paid autoscaling, behavioural tracking, and persistent raw-IP logging: lower abuse resistance and availability are accepted to preserve the no-tracking and fixed-cost commitments.

Only short-lived, purpose-scoped network identifiers and bounded Security events may support enforcement. The service may temporarily suspend an Account’s public participation without reading encrypted content, but it must preserve that Account’s private Files, Shares, export, recovery, and ownership.
