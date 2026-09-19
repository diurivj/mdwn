# Support options with donor privacy

This document records the evaluated options for accepting optional donations under [ADR-0007](adr/0007-no-monetization-anonymous-support.md) and section 1.2 of the [buildable specification](buildable-spec.md). mdwn is never monetized; donations grant nothing and fund only the domain and future infrastructure costs.

The goals, in order:

1. No account, identity, or session linkage between a donor and their mdwn Account.
2. Minimal operational and legal surface for the operator.
3. Low friction for donors who want to contribute a few dollars.

Fee and KYC facts below were checked against provider documentation and third-party reviews at the time of writing; re-verify before implementing.

## Static addresses (no processor)

The simplest option: the support page displays fixed addresses and locally generated QR codes. No third party, no fees beyond the network, no account, and no data collected by the product.

| Asset | Donor privacy | Fees | Notes |
| --- | --- | --- | --- |
| Monero (XMR) | Strongest: hides sender, receiver, and amount by default | Low | Primary recommendation for anonymity. Use a dedicated wallet; subaddresses can limit the public trail. |
| Bitcoin on-chain (BTC) | Pseudonymous: the public ledger and chain analysis can link payments | Variable, can be significant for small amounts | Simple and widely understood. A static address accumulates public history; refresh it if the page is ever revised. |
| Lightning (BTC) | Good for small amounts: off-chain, fast, low fee; amounts are visible to routing nodes | Very low | A Lightning address such as `name@domain` is a one-line static option. Custody depends on the provider: self-custodial (for example Alby Hub or an own LNbits) versus custodial. |
| Stablecoins (USDC/USDT) | Pseudonymous and traceable; the issuer can freeze addresses | Chain-dependent | Lets the operator avoid volatility at the cost of extra chain and compliance surface. |

## Self-hosted processor: BTCPay Server

- Free and open source; non-custodial, so donations land in the operator's own wallet; no KYC because the operator runs it.
- Supports Bitcoin and Lightning natively and other assets through plugins; Monero is supported by a community-maintained plugin (it shares one Monero wallet across stores in the instance, which is fine for a single donation store).
- Includes donation and crowdfund page types, so it can host the support page itself.
- Cost: a small server (roughly the price of a cheap VPS) and ongoing maintenance. No per-transaction fee beyond network fees.

## Hosted non-custodial gateway: NOWPayments

- Hosted checkout and donation links with hundreds of supported assets.
- Non-custodial by default (with optional custody), and standard merchant use is advertised as KYC-free; some features, jurisdictions, or volumes trigger verification.
- Fees are around 0.5%–1% per transaction, and the gateway observes donor payment metadata, so it is less private than a static address.

## Custodial and KYC processors to avoid for this purpose

| Service | Why it does not fit |
| --- | --- |
| CoinGate | Full KYC required; ~1% fee; fiat settlement implies a business relationship. |
| BitPay | Business-oriented, KYC, fiat settlement. |
| OpenNode | Bitcoin/Lightning processor with custodial merchant accounts and KYC. |
| Coinbase Commerce | Requires a Coinbase account (KYC) and is custodial. |
| Bridge (a Stripe company) | Stablecoin orchestration infrastructure (onramp/offramp, issuance) for businesses with KYC onboarding; not a donation widget. |

Custodial processors also add failure modes the project deliberately avoids: account freezes, payout holds, and a business relationship that contradicts "personal-first, never monetized."

## Product constraints

Whatever option is chosen, the implementation must respect section 1.2 and the specification's invariants:

- The support page is reachable from the footer; it requires no Account, session, or personal data.
- Addresses and QR codes are static or generated locally; no third-party script, widget, tracker, or analytics is embedded.
- If a hosted page (BTCPay or NOWPayments) is used, the support page links out to it rather than embedding it.
- Donations create no D1 record, no entitlement, and no product behavior change.
- The page states plainly what donations fund and that mdwn runs identically without them.

## Operational notes

- Use a dedicated receive wallet, not a wallet holding other funds; losing that wallet loses the donations.
- Publish exact addresses and generate QR codes from the same source string to avoid transcription or substitution errors.
- Monero subaddresses or fresh Bitcoin/Lightning addresses can limit the public trail of a static page; re-check the page whenever addresses rotate.
- Received cryptocurrency is generally taxable income at receipt in many jurisdictions, and later disposal is a capital-gains event; keep records. Not legal advice.
- Converting donations to fiat normally requires KYC at an exchange; that is the operator's decision, not a donor-facing requirement.
- If a mobile client is ever shipped, store policies (notably Apple's) may prohibit in-app cryptocurrency donation links; keep the support surface on the web.

## Recommendation

Launch with a static support page: a Monero address, a Bitcoin address, and a Lightning address, with locally generated QR codes. This meets all three goals at zero cost and with no third-party dependency. Add BTCPay Server later only if a hosted, self-custodial, zero-fee multi-asset page is wanted, or NOWPayments if minimal operations matter more than privacy.
