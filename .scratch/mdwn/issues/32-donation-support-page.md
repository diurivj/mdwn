# 32: Donation support page

**What to build:** An optional, anonymous donation page linked from the site footer that shows static cryptocurrency addresses with locally generated QR codes, takes no Account or personal data, records nothing, and grants nothing.

**Blocked by:** 01 (Project foundation).

**Status:** done

- [x] The page is linked from the site footer and requires no Account, no session, and no personal data.
- [x] It shows static cryptocurrency addresses with QR codes generated locally at build time or from vendored code, and embeds no third-party script, widget, tracker, or analytics.
- [x] It creates no record in D1 or any operational store, and no donation data is stored anywhere.
- [x] It states what donations cover (domain and any future paid infrastructure) and that mdwn runs identically without them; capacity exhaustion still fails closed rather than triggering paid spend.
- [x] Donations grant nothing: no badge, priority, feature, storage, or service guarantee.
- [x] The page renders under the strict Content Security Policy with no external requests and no nonessential cookies.

## Comments

- 2026-10-05: Implemented on `issue/32-donation-support-page` (`c047a1e`, `3f8c910`, `cb87b58`). `GET /support` is a top-level page route linked from the home footer. It server-renders operator-published static addresses with inline SVG QR codes generated locally by the vendored `qrcode` package (`app/support/qr.server.ts`; the `.server` boundary keeps the encoder out of the client bundle). Addresses come from public Worker vars `SUPPORT_MONERO_ADDRESS` / `SUPPORT_BITCOIN_ADDRESS` / `SUPPORT_LIGHTNING_ADDRESS`, set per environment in `wrangler.jsonc` (or `.dev.vars` locally); an unset or empty value hides that asset and the page never invents an address, so preview and production currently show "No support addresses are published right now" until the operator fills them. The loader reads no session or cookie and writes no D1 row. The page states that donations fund the domain and any future paid infrastructure, that mdwn runs identically without them and fails closed rather than triggering paid spend, and that donations grant nothing (no badge, priority, feature, storage, or service guarantee). Tests: `tests/support-options.test.ts` (parse/filter), `tests/worker/support-page.test.ts` (`SELF.fetch` boundary: no `Set-Cookie`, unchanged table row counts, hardening headers), and `e2e/support.spec.ts` (footer link plus router client navigation, rendered addresses and inline QRs, strict nonce CSP, zero external requests, no cookies; Chromium/Firefox/WebKit). Two-axis review found no hard Standards violations (one minor test-harness duplication fixed in `3f8c910`) and no spec-invariant breaks; Spec's only open item is the operator-supplied address values. RR8 gate: Pass (server-only `loader`, no mutations or browser-only work, `.server` boundary verified against the built client chunk, coverage via `SELF.fetch` plus cross-engine tests). `npm run verify` passed at `cb87b58`.
- 2026-10-05 (follow-up): Added a fourth catalog slot for Ethereum/EVM (`SUPPORT_ETHEREUM_ADDRESS`). The operator's EIP-55 checksummed address `0x5399…D1CA` is set in local, preview, and production, so the deployed page publishes one asset (ETH/ERC-20) with its locally generated QR code; the other three slots remain empty and hidden until addresses exist. Parser, tests, page copy, `.dev.vars.example`, and `wrangler.jsonc` cover the new slot.

- 2026-10-06: Status reconciled to **done**: the work merged on main via PR #44 (merge `37a38aa`), and the completion evidence is recorded in the comments above. This reconciliation changed only the stale `Status:` line.
