# 31: Retention, purge, and D1 operational verification

**What to build:** Expired security material actually disappears on schedule, and the schema's access and traversal queries are proven to use their indexes rather than scanning a growing tree.

**Blocked by:** 07 (Abuse-control primitives), 09 (Device proofs and registry epochs), 30 (Import staging and commit marker).

**Status:** ready-for-agent

- [ ] One-use challenges live at most 10 minutes; expired sessions, challenges, routine and recovery enrollments, Import sessions, counters, and Security events are purged; Security events are retained at most 30 days.
- [ ] The purge is covered by a scheduled integration test or documented operational verification, and it removes only expired rows — never live authority, current envelopes, or active records.
- [ ] D1 foreign-key checks are enabled and verified in the deployed environment.
- [ ] Child traversal indexes begin with `parent_node_id`; active-Grant lookup supports exact target and recipient plus ancestor-recursive access checks; the Publication path lookup is unique and reveals no retired link state.
- [ ] Covering indexes exist and are exercised for current representation, current epoch, pending Share and Publication request, active-or-deleting Publication, current Recovery capsule and Device registry, unexpired session/challenge/enrollment/Import, consumed mutation proof, outstanding provisioning need, and counter-window lookups.
- [ ] Representative tree and access queries are validated with reviewed `EXPLAIN QUERY PLAN` output; recursive traversal and deletion are explicitly bounded.
- [ ] Migration rollback posture is rehearsed on non-production data using D1 Time Travel plus a pre-change export.
- [ ] (Moved from 07.) Network buckets: rotating the HMAC key is exercised (a rotated key yields fresh buckets and the raw IP is never retained), and counter rows are physically deleted within 24 hours, not just logically expired. A test or documented operational verification proves this.
