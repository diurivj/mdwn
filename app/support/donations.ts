/**
 * Operator-published donation addresses for the anonymous `/support` page.
 *
 * These are public page content, not secrets: they are configured as Worker
 * `vars` (`SUPPORT_*_ADDRESS` per environment, or `.dev.vars` locally) and are
 * only ever server-rendered into the support page. An unset or empty value
 * hides that asset — the page never shows a placeholder address.
 *
 * Invariants (spec §1.2, ADR-0007): no Account, session, or personal data; no
 * record in D1 or any operational store; donations grant nothing.
 */

export interface SupportAddressEnv {
  SUPPORT_MONERO_ADDRESS?: string | undefined;
  SUPPORT_BITCOIN_ADDRESS?: string | undefined;
  SUPPORT_LIGHTNING_ADDRESS?: string | undefined;
}

export interface DonationOption {
  id: "monero" | "bitcoin" | "lightning";
  /** Display name for the asset. */
  asset: string;
  /** The exact string shown and encoded into the QR code. */
  address: string;
  /** Short, non-promissory guidance shown under the address. */
  note: string;
}

interface SupportCatalogEntry {
  id: DonationOption["id"];
  asset: string;
  note: string;
  envKey: keyof SupportAddressEnv;
}

const CATALOG: readonly SupportCatalogEntry[] = [
  {
    id: "monero",
    asset: "Monero (XMR)",
    note: "Monero hides sender, receiver, and amount by default. Use a wallet you control.",
    envKey: "SUPPORT_MONERO_ADDRESS",
  },
  {
    id: "bitcoin",
    asset: "Bitcoin (BTC, on-chain)",
    note: "On-chain payments are public and traceable. Verify the address in your own wallet before sending.",
    envKey: "SUPPORT_BITCOIN_ADDRESS",
  },
  {
    id: "lightning",
    asset: "Bitcoin Lightning",
    note: "Low-fee option for small amounts. A Lightning address or BOLT12 offer can be pasted into a wallet.",
    envKey: "SUPPORT_LIGHTNING_ADDRESS",
  },
] as const;

/** Longest accepted value: Lightning BOLT12 offers are long; anything else is suspicious. */
const MAX_ADDRESS_LENGTH = 1024;

/**
 * Normalize one configured address. Returns the exact trimmed string that will
 * be displayed and encoded into a QR code, or null when unconfigured/invalid.
 */
export function parseSupportAddress(value: string | undefined): string | null {
  const address = value?.trim() ?? "";
  if (!address) return null;
  if (address.length > MAX_ADDRESS_LENGTH) return null;
  // Crypto addresses and Lightning identifiers never contain whitespace or
  // control characters; rejecting them keeps QR payloads and page markup clean.
  if (/[\s\u0000-\u001f\u007f]/.test(address)) return null;
  return address;
}

/**
 * Collect the configured donation options in catalog order. Nothing is
 * invented: an asset with no usable configured address is omitted.
 */
export function donationOptionsFromEnv(env: SupportAddressEnv): DonationOption[] {
  const options: DonationOption[] = [];
  for (const entry of CATALOG) {
    const address = parseSupportAddress(env[entry.envKey]);
    if (address) {
      options.push({ id: entry.id, asset: entry.asset, address, note: entry.note });
    }
  }
  return options;
}
