# 32: Donation support page

**What to build:** An optional, anonymous donation page linked from the site footer that shows static cryptocurrency addresses with locally generated QR codes, takes no Account or personal data, records nothing, and grants nothing.

**Blocked by:** 01 (Project foundation).

**Status:** ready-for-agent

- [ ] The page is linked from the site footer and requires no Account, no session, and no personal data.
- [ ] It shows static cryptocurrency addresses with QR codes generated locally at build time or from vendored code, and embeds no third-party script, widget, tracker, or analytics.
- [ ] It creates no record in D1 or any operational store, and no donation data is stored anywhere.
- [ ] It states what donations cover (domain and any future paid infrastructure) and that mdwn runs identically without them; capacity exhaustion still fails closed rather than triggering paid spend.
- [ ] Donations grant nothing: no badge, priority, feature, storage, or service guarantee.
- [ ] The page renders under the strict Content Security Policy with no external requests and no nonessential cookies.
