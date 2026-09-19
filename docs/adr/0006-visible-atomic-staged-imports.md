# Visible-atomic staged imports on the Free tier

mdwn will use a short-lived, initiating-Account-bound private Import session and one immutable committed-import visibility marker for browser-preflighted imports. The session may target an owned Directory or one covered by an active read/write Directory Grant; committed descendants always belong to the target Directory’s Owner. Workers Free and D1 Free must remain sufficient for the MVP, while a literal 100-node D1 transaction cannot be promised without a schema-specific proof; therefore encrypted staged records remain unreachable until the marker commits, preserving an all-or-nothing user-visible hierarchy without making a Paid plan a prerequisite.

## Considered options

- A literal one-batch transaction with a much lower import cap would simplify reads but makes ordinary initial imports unnecessarily restrictive.
- A Paid Worker/D1 prerequisite would make a larger batch budget available but violates the fixed-cost MVP commitment.
- Staging records in private storage with a final commit marker retains Free-tier operation and the 100-node product envelope, at the cost of a mandatory committed-marker predicate on every normal read path.
