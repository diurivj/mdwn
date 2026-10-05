/**
 * Test-only donation addresses for the `/support` page. They are deliberately
 * not valid payment destinations: the support page tests must never publish
 * (or suggest) a real receive address. Preview/production configure their own
 * public `SUPPORT_*_ADDRESS` vars.
 */
export const SUPPORT_ADDRESS_FIXTURES = {
  monero: "mdwn-test-monero-address-not-for-payment",
  bitcoin: "mdwn-test-bitcoin-address-not-for-payment",
  lightning: "test-donations@mdwn.invalid",
} as const;

/** The Worker `vars` both test harnesses bind for the support-page tests. */
export function supportAddressBindings(): Record<string, string> {
  return {
    SUPPORT_MONERO_ADDRESS: SUPPORT_ADDRESS_FIXTURES.monero,
    SUPPORT_BITCOIN_ADDRESS: SUPPORT_ADDRESS_FIXTURES.bitcoin,
    SUPPORT_LIGHTNING_ADDRESS: SUPPORT_ADDRESS_FIXTURES.lightning,
  };
}
