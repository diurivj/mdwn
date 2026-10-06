# Donation wallet and address setup — Monero, Lightning, and EVM

Research note for the operator of mdwn's `/support` page. Primary sources were followed
from the owning project, provider, or spec; the **check date is 2026-10-05** for every
fact cited below. Volatile items are flagged and collected in "Uncertainty / re-check
before publishing". No code or config was changed.

## Scope and constraints

Context: [`support-options.md`](../../../docs/support-options.md),
[ADR-0007](../../../docs/adr/0007-no-monetization-anonymous-support.md),
`app/support/donations.ts`, `app/routes/support.tsx`.

- One operator; no KYC if possible; self-custody preferred; minimal ongoing operations;
  free or near-free; occasional small donations.
- Addresses are Worker `vars` server-rendered verbatim; the QR payload must be the exact
  displayed string. `parseSupportAddress` rejects whitespace/control characters and
  anything over **1024 characters**, so no identifier may wrap or contain spaces.
- The catalog has three slots today (`monero`, `bitcoin` on-chain, `lightning`).
  Publishing ETH/EVM needs a code change (catalog entry + env var + tests) — separate issue.
- Receiving to a self-custodial wallet needs no KYC; some custodial services may request ID
  at onboarding, and converting to fiat requires a verified exchange account (e.g.
  [Kraken deposit help](https://support.kraken.com/articles/360000672643-how-to-deposit-cryptocurrencies-to-your-kraken-account)).
- Donor privacy: Monero hides sender, receiver, and amount; Lightning hides on-chain
  linkage but the recipient's service and the routing path see the payment; BTC and EVM
  are public and traceable.
- Tax: US treatment is property, not currency; income from digital assets is taxable and
  records must capture fair-market value at receipt
  ([IRS, Digital assets](https://www.irs.gov/filing/digital-assets)). Not legal advice;
  non-US rules differ.

## Summary

- XMR: Feather or Monero GUI + fresh subaddress (95 chars, self-custodial, no KYC).
- Lightning: self-hosted Alby Hub + `name@getalby.com` (self-custodial funds, hosted identifier; email account, no ID docs found).
- EVM: fresh hardware-wallet address, Base primary, EIP-55 `0x…` + chain label (self-custodial, no KYC).

## Monero (XMR)

**Recommendation — a dedicated Feather (desktop) or Monero GUI wallet that publishes one
subaddress; use a hardware wallet only if you already own a listed model.** Subaddresses
are the documented default for receiving; a fresh subaddress per page revision limits what
a payer learns, and accounts (e.g. a "donations" account) group subaddresses under one seed
([Monero docs: Subaddress](https://docs.getmonero.org/public-address/subaddress/),
[address types](https://docs.getmonero.org/public-address/)). The Monero project's own
downloads page lists both wallets and is the source to re-check for releases
([getmonero.org/downloads](https://web.getmonero.org/downloads/)).

| Setup | Custody | KYC | Platform | Cost | Difficulty | Identifier |
| --- | --- | --- | --- | --- | --- | --- |
| Feather + fresh subaddress (recommended) | self | none | desktop (Win/macOS/Linux/Tails) | free | low | 95-char subaddress |
| Monero GUI + fresh subaddress | self | none | desktop | free | medium (chain sync) | 95-char subaddress |
| Cake Wallet (mobile) | self | none | iOS/Android/desktop | free | lowest | 95-char subaddress |
| Monerujo (Android) | self | none | Android | free | low | 95-char subaddress |

- Address facts: a raw address is 95 characters starting with `4` or `8`; an integrated
  address is 106 characters ([Moneropedia](https://www.getmonero.org/resources/moneropedia/address.html)).
  A subaddress is 95 characters and fits the cap; publish it, not the main address (Janus
  caveat: [advisory](https://www.getmonero.org/2019/10/18/subaddress-janus.html)).
- Wallet facts: Feather is free, open source, and listed by the Monero project
  ([featherwallet.org](https://featherwallet.org/)); Cake Wallet is open source and
  non-custodial ([cakewallet.com](https://cakewallet.com/)); Monerujo is free and open
  source for Android ([monerujo.io](https://www.monerujo.io/)).
- Hardware wallets (checked 2026-10-05 on the Monero project's own page): Ledger Nano S,
  Nano S Plus, and Nano X work with Monero GUI/CLI, Cake Wallet, Feather, and Monerujo;
  Trezor Model T, Safe 3, and Safe 5 work with Monero GUI/CLI and Feather
  ([getmonero.org/downloads](https://web.getmonero.org/downloads/)). Ledger signs XMR only
  through third-party wallets, not Ledger Live
  ([Ledger Monero page](https://www.ledger.com/coin/wallet/monero),
  [Ledger support article](https://support.ledger.com/article/360006352934-zd)).
- Trezor adds a recovery caveat: XMR keys use SLIP-0010, so a Trezor backup may not
  restore in another brand's software wallet; recover on another Trezor
  ([Trezor knowledge base](https://trezor.io/learn/supported-assets/other-cryptocurrencies/monero-xmr-on-trezor)).
- Keystone advertises XMR support via QR with Monero GUI/CLI
  ([keyst.one](https://keyst.one/supported-crypto-assets/monero/)); it is **not** in the
  Monero project's hardware table, so treat it as vendor-supported-only.

**Runner-up — Cake Wallet on mobile** for the least setup; if the page is ever revised,
generate a new subaddress there and republish. Monerujo is the Android-only alternative
with the same model.

## Bitcoin Lightning

**Recommendation — a self-hosted Alby Hub with a linked Alby Account Lightning Address
(`name@getalby.com`), on an always-on machine (Umbrel, Start9, RaspiBlitz, or a small
VPS).** Funds settle to your own node, and the email-like identifier is the most widely
accepted static Lightning identifier (LUD-16)
([Alby: why link an account](https://guides.getalby.com/user-guide/alby-hub/faq/why-do-i-need-to-link-my-alby-account),
[LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)). Caveats: Alby Hub "ideally runs
24/7 … so it can be connected to a lightning address and receive online payments"
([alby/hub README](https://github.com/getalby/hub)); the Alby Account is hosted and its
predecessor shared custodial wallet shut down on 2025-01-04 while accounts and addresses
continued ([Alby](https://guides.getalby.com/user-guide/alby-account/faq/embrace-alby-hub-phasing-out-albys-shared-wallet)).
Alby Hub runs on Umbrel, Start9, RaspiBlitz, MyNode, CasaOS, and Unraid
([Alby flavors](https://guides.getalby.com/user-guide/alby-hub/alby-hub-flavors/umbrel-start9-etc)),
and an own-domain LNURL endpoint can front the same address later
([Alby: own domain](https://guides.getalby.com/user-guide/alby-account/faq/how-to-use-my-own-domain-as-lightning-address)).

| Setup | Custody | KYC | Platform | Cost | Difficulty | Identifier |
| --- | --- | --- | --- | --- | --- | --- |
| Alby Hub + Alby Account (recommended) | self-custodial funds; identifier hosted by Alby | account with email; no ID docs found | Umbrel/Start9/VPS/desktop | free software (+host) | medium (always-on) | `name@getalby.com` |
| Phoenix + permanent BOLT12 offer | self-custodial (12-word seed) | no account; KYC not documented (unverified) | iOS/Android | free app | lowest | `lno1…` offer (length varies) |
| WoS self-custody Lightning Address | self-custody model (Spark L2); WoS cannot recover keys | no ID docs for BTC; ID data only for stablecoin redemption via Brale | iOS/Android | free | lowest | `username@walletofsatoshi.com` |
| ZEUS Pay Zaplocker / NWC | self-custodial (NWC: your node) | not documented (unverified) | mobile + own node | free | medium | `handle@zeuspay.com` |

- Phoenix can generate "any number of Bolt12 offers (a.k.a. reusable invoices). They all
  stay valid permanently, just like a bitcoin address"
  ([Phoenix v2.6.0 release notes](https://github.com/ACINQ/phoenix/releases/tag/android-v2.6.0));
  Phoenix is self-custodial with a 12-word seed ([phoenix README](https://github.com/ACINQ/phoenix)).
  BOLT12 offers are the right model for a static page — "a merchant publishes an *offer*,
  such as on a web page or a QR code"
  ([BOLT 12 spec](https://github.com/lightning/bolts/blob/master/12-offer-encoding.md)) —
  but payer support is still narrow: Core Lightning needs experimental flags, Eclair and
  LDK support offers, and LND requires LNDK
  ([bolt12.org developers](https://bolt12.org/developers)).
- Wallet of Satoshi now documents two models: self-custody (available globally; you hold
  the keys; WoS cannot recover) and custodial (select regions; WoS holds funds and keys).
  The app picks per region ([Disclosure v1.23, 2026-08-25](https://www.walletofsatoshi.com/disclosure),
  [walletofsatoshi.com](https://www.walletofsatoshi.com/)). Receiving over Lightning is
  free; receiving on-chain deducts a network plus service fee
  ([WoS support](https://support.walletofsatoshi.com/en/support/solutions/articles/36000579025-how-to-send-and-receive-bitcoin-in-the-self-custody-wos-wallet)).
  A custom username needs "proof of work" (10 Lightning transactions, 100k sats on-chain)
  or a support-assisted migration
  ([WoS support](https://support.walletofsatoshi.com/en/support/solutions/articles/36000583190-lightning-addresses-how-they-work-and-how-to-create-a-custom-one)).
- ZEUS Pay has three address types over one handle: Cashu (mint custody), Zaplocker
  (self-custodial; payments must be claimed within 24 hours or are returned; needs a
  channel with the ZEUS LSP), and NWC (invoices from your own remote node)
  ([ZEUS intro](https://docs.zeusln.app/lightning-address/intro/),
  [Zaplocker](https://docs.zeusln.app/lightning-address/zaplocker/),
  [NWC](https://docs.zeusln.app/lightning-address/nwc/)).
- LNbits is explicit that "the LNbits instance operator has access to all funds. Users of
  a shared instance trust the operator" and that self-sovereign use means running it
  against your own node ([LNbits FAQ](https://docs.lnbits.com/guide/faq/general)); its
  LNURLp extension creates reusable static pay links
  ([LNbits LNURLp](https://docs.lnbits.com/extensions/lnurlp/)).
- Blink is custodial by default outside the US: "Custodial Mode … Blink … holds and
  manages the User's Bitcoin Balance … the User does not hold private keys directly", and
  "Blink may request a liveness photograph and identity documents at account creation"
  ([Blink Terms v2.6, 2026-09-04](https://www.blink.sv/en/terms-conditions)); US users may
  access only Non-Custodial Mode. A Blink address is `username@blink.sv`
  ([Blink FAQ](https://faq.blink.sv/blink-payment-methods/lightning-address/how-can-i-create-lightning-address-with-blink)).

### Static Lightning identifiers and the 1024-char cap

| Identifier | Durable? | Approx. payload | Fit for a published page |
| --- | --- | --- | --- |
| Lightning Address (LUD-16) | yes, while the provider domain resolves | very short (`name@domain`) | best donor UX |
| LNURL-pay link (LUD-06) | yes, endpoint-issued invoices | bech32, longer; measure | works, provider is the custodian |
| BOLT12 offer (`lno1…`) | yes, reusable by spec | variable, often long; can include `+` | measure exactly; must be ≤1024 and whitespace-free |
| BOLT11 invoice / pubkey+invoice | no (one-time) | — | never publish |

LUD-16 addresses resolve to `https://<domain>/.well-known/lnurlp/<username>`; LUD-06
defines the static link that issues a fresh invoice per payment
([LUD-16](https://github.com/lnurl/luds/blob/luds/16.md),
[LUD-06](https://github.com/lnurl/luds/blob/luds/06.md),
[lightningaddress.com](https://lightningaddress.com/)). BIP 21 is now marked superseded by
[BIP 321](https://github.com/bitcoin/bips/blob/master/bip-0321.mediawiki), which adds
`lightning` (BOLT11) and `lno` (BOLT12) parameters for unified `bitcoin:` URIs; mdwn's
separate Lightning slot does not need this, but it is the format to use if the page ever
merges on-chain and Lightning into one QR ([BIP 21](https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki)).

## Ethereum / EVM

**Recommendation — a fresh, receive-only EVM address generated on a hardware wallet
(Trezor Safe 5/3, Ledger, or Keystone); publish the EIP-55 checksummed `0x…` string and
state the chain, with Base as the primary network and Ethereum mainnet optional.**
A single address text covers ETH and every ERC-20 on a given chain, including USDC; the
token contract, not the address, distinguishes the asset
([EIP-681 ERC-20 transfer semantics](https://eips.ethereum.org/EIPS/eip-681)). Checksum
capitalization is defined by [EIP-55](https://eips.ethereum.org/EIPS/eip-55); a bare
`0x` + 40 hex characters is 42 characters, far under the cap.

| Setup | Custody | KYC | Platform | Cost | Difficulty | Identifier |
| --- | --- | --- | --- | --- | --- | --- |
| Hardware-wallet EOA (recommended) | self | none | desktop/mobile app | ~device price once; donor pays gas | medium | `0x…` (42 chars) + chain label |
| Rabby fresh hot address | self (keys on device) | none | browser extension | free | low | `0x…` + chain label |
| Safe smart account on Base | self (smart contract, M-of-N) | none | web app | gas to deploy per chain; multisig cannot be gasless | high | Safe address per chain |

- Chain facts: Base is an OP Stack L2 and Circle's native USDC on Base is the ERC-20
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  ([Circle: USDC on Base](https://www.circle.com/multi-chain-usdc/base)); USDC on Ethereum
  is `0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
  ([Circle: USDC on Ethereum](https://www.circle.com/multi-chain-usdc/ethereum)).
  Ethereum's own site reports average L2 transaction costs a fraction of mainnet
  ([ethereum.org Layer 2](https://ethereum.org/en/layer-2/)).
- One address works on Base, Optimism, Arbitrum One, and mainnet, but balances are
  per-chain; each chain needs its own ETH for gas, and a Safe must be deployed on the
  destination network before it can receive there
  ([Trezor Suite L2 support](https://trezor.io/learn/supported-assets/ethereum-layer-2-EVM/optimism-arbitrum-one-base-in-trezor-suite),
  [Ledger supported networks](https://help.enterprise.ledger.com/supported-networks),
  [Safe: receiving](https://help.safe.global/articles/4119085855-how-can-i-receive-assets),
  [Safe supported networks](https://docs.safe.global/advanced/smart-account-supported-networks)).
- Stablecoin caveat: Circle's USDC terms allow blocklisting addresses and freezing funds
  ([Circle USDC terms](https://www.circle.com/legal/usdc-terms)), so USDC is not
  censorship-resistant and adds issuer surface. Wrong-chain transfers are not recoverable.
- ENS is a convenience alias, not a good QR payload: `.eth` names expire after a 90-day
  grace period ([ENS lifecycle](https://support.ens.domains/en/articles/8046877-eth-name-lifecycle);
  ENSv2 proposes 28 days, [ENSv2 docs](https://docs.ens.domains/ensv2/eth-registrar/)), and
  EIP-681 ENS resolution is payer-side with hex taking precedence and phishing warnings
  ([EIP-681](https://eips.ethereum.org/EIPS/eip-681)). Publish the `0x` address; add the
  ENS name as text only if you will keep renewing it.
- Rabby is a self-custodial, open-source (MIT) browser extension whose terms state assets
  are stored locally on the user's device
  ([Rabby terms](https://rabby.io/docs/terms-of-use/index.html),
  [RabbyHub/Rabby](https://github.com/RabbyHub/Rabby)).
- Safe setup connects a signer wallet and costs deployment gas; single-signer Safes can be
  reserved with "Pay later", but multisignature Safes cannot currently be created gaslessly
  ([Safe: creating a Safe](https://help.safe.global/articles/7267202833-creating-a-safe-on-a-web-browser)).

**Runner-up 1 — Rabby** with a brand-new profile/address used only for donations, if no
hardware wallet is available. **Runner-up 2 — Safe** (a 1-of-1 reserved Safe, or 2-of-3
once balances justify it) on Base; it protects against key loss/compromise but adds
per-chain deployment, gas, and recovery complexity out of proportion to small donations.

## Why the convenient option may be the wrong one

- **Custodial Lightning wallets.** Wallet of Satoshi's own disclosure defines the custodial
  model as WoS holding your funds and keys, with refunds only to "the verified owner of the
  email address" ([disclosure](https://www.walletofsatoshi.com/disclosure)); Blink's terms
  define Custodial Mode the same way, allow identity-document requests, and exclude US
  users from that mode ([terms](https://www.blink.sv/en/terms-conditions)). You inherit
  account freezes, regional policy shifts, and an identity trail for money mdwn promises
  grants nothing for.
- **The service can change under you.** Alby's shared custodial wallet — including its
  `@getalby.com` addresses — was shut down on 2025-01-04; accounts and addresses survived
  only because users moved to self-hosted Hubs
  ([Alby](https://guides.getalby.com/user-guide/alby-account/faq/embrace-alby-hub-phasing-out-albys-shared-wallet)).
  A published identifier should depend on a service you can keep running or redirect.
- **Shared LNbits instances.** LNbits states the instance operator can access all funds
  ([LNbits FAQ](https://docs.lnbits.com/guide/faq/general)); only run it against your own node.
- **Exchange deposit addresses.** Deposits require a verified exchange account and land in
  exchange custody; addresses can expire, and valid transactions to expired addresses are
  credited only minus a fee ([Kraken deposit help](https://support.kraken.com/articles/360000672643-how-to-deposit-cryptocurrencies-to-your-kraken-account)).
  Publishing an exchange address links donations to your KYC identity and hands the
  exchange control of the funds.
- **Hosted donation pages.** NOWPayments is non-custodial by default and says KYC is rare
  for crypto-only merchants, but it holds suspicious transactions for ID/source-of-funds/
  selfie and always requires KYC/KYB for fiat
  ([KYC/AML](https://nowpayments.io/help/security/kyc-aml/kyc-aml-procedure),
  [about](https://nowpayments.io/help/about-nowpayments/about)); a gateway also observes donor
  metadata. BTCPay Server remains the self-hosted alternative at the cost of a server.

## Cross-cutting safety checklist

1. Use a dedicated seed (or a dedicated account index) for donations only; never mix it
   with other holdings. For Monero, dedicate a subaddress/account to donations
   ([Monero docs](https://docs.getmonero.org/public-address/subaddress/)).
2. Back up the seed offline before publishing anything; for Lightning addresses, back up
   the wallet/node state (Alby Hub, Phoenix, WoS self-custody each document their own
   backup model).
3. Verify the receive address on the device screen before publishing (every character;
   [Ledger Receiving Assets](https://support.ledger.com/article/4-2-Receiving-Assets)) and
   confirm the page renders the same string that the QR encodes.
4. Send a small test payment from a separate wallet and confirm receipt before trusting the
   published address.
5. Rotate deliberately: publish a fresh XMR subaddress and a fresh BTC on-chain address on
   any page revision; static Lightning/EVM identifiers cannot rotate without a page edit,
   so note their accumulation of public history (BIP 21 itself recommends a unique address
   per payment, [BIP 21](https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki)).
6. Never publish a seed phrase, private key, or Monero view key; a view key exposes
   incoming history.
7. State the chain in page copy for EVM ("Base", "Ethereum mainnet") — the same address
   string exists on many networks and transfers to the wrong one are usually unrecoverable.
8. Keep records at fair-market value on receipt and on disposal; US reporting treats digital
   assets as property and broker 1099-DA reporting began in 2025 for custodial brokers, not
   self-custody receipts ([IRS](https://www.irs.gov/filing/digital-assets)). Not legal
   advice.
9. Buying a hardware wallet, converting to fiat, or bridging L2 funds are the steps that
   introduce KYC and identity; keep those separate from the donation surface.

## Uncertainty / re-check before publishing

- **Alby Account continuity and terms.** The Lightning Address depends on a hosted Alby
  account; the 2025 shared-wallet shutdown is precedent. Re-check Alby's current terms,
  account status, and own-domain LNURL flow before publishing (checked 2026-10-05).
- **BOLT12 sender support and offer lengths.** Support is uneven (CLN experimental flags;
  LND via LNDK) and no exhaustive current wallet matrix exists. Measure the exact offer
  string for the ≤1024, no-whitespace constraint (checked 2026-10-05).
- **Phoenix KYC and offline receive.** Phoenix's FAQ page blocked direct fetching; both
  "no account/KYC" and offline receiving are **unverified** here. Confirm in-app and in the
  current FAQ before relying on it (checked 2026-10-05).
- **Wallet of Satoshi model changes.** Self-custody is global and custodial is
  region-gated, but models, fees, and availability changed repeatedly through 2025-2026;
  re-check the disclosure/version and whether a custom address is available without
  activity (checked 2026-10-05).
- **Blink terms.** Current terms are v2.6 dated 2026-09-04; the FAQ (phone number only)
  and terms §2.6 (may request ID) conflict. Re-check (checked 2026-10-05).
- **Monero hardware lists drift.** Trezor's knowledge base says Safe 7 works with Cake
  Wallet and Monero GUI/CLI, while the Monero project's table lists only Model T/Safe 3/
  Safe 5; Keystone is vendor-supported only. Re-check both before buying hardware
  (checked 2026-10-05).
- **ENSv2.** It proposes a 28-day grace period and a new registrar; do not depend on ENS
  for a donation address (checked 2026-10-05).
- **EVM L2 support in wallet software** (Trezor Suite added Base/Optimism/Arbitrum in the
  January 2025 update; Ledger Live lists Base/Arbitrum/Optimism) — re-check before
  publishing chain-specific instructions (checked 2026-10-05).
- **USDC issuer controls and regional availability.** Circle blocklisting and L2 stablecoin
  variants change; re-check the exact contract address per chain when publishing
  (checked 2026-10-05).
