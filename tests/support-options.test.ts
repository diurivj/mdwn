import { describe, expect, it } from "vitest";

import { donationOptionsFromEnv, parseSupportAddress } from "../app/support/donations";

describe("parseSupportAddress", () => {
  it("keeps a configured address and trims surrounding whitespace", () => {
    expect(parseSupportAddress("  bc1qexample  ")).toBe("bc1qexample");
  });

  it("treats missing, empty, and whitespace-only values as unconfigured", () => {
    expect(parseSupportAddress(undefined)).toBeNull();
    expect(parseSupportAddress("")).toBeNull();
    expect(parseSupportAddress("   \n\t ")).toBeNull();
  });

  it("rejects values containing whitespace or control characters", () => {
    expect(parseSupportAddress("bc1q example")).toBeNull();
    expect(parseSupportAddress("bc1q\u0000example")).toBeNull();
    expect(parseSupportAddress("bc1q\u007fexample")).toBeNull();
  });

  it("rejects implausibly long values", () => {
    expect(parseSupportAddress("a".repeat(1025))).toBeNull();
    expect(parseSupportAddress("a".repeat(1024))).toBe("a".repeat(1024));
  });
});

describe("donationOptionsFromEnv", () => {
  it("returns configured assets in catalog order with their display fields", () => {
    const options = donationOptionsFromEnv({
      SUPPORT_MONERO_ADDRESS: " monero-test-address ",
      SUPPORT_LIGHTNING_ADDRESS: "donate@example.invalid",
    });
    expect(options).toEqual([
      expect.objectContaining({ id: "monero", asset: "Monero (XMR)", address: "monero-test-address" }),
      expect.objectContaining({
        id: "lightning",
        asset: "Bitcoin Lightning",
        address: "donate@example.invalid",
      }),
    ]);
  });

  it("returns no options when nothing is configured", () => {
    expect(donationOptionsFromEnv({})).toEqual([]);
    expect(
      donationOptionsFromEnv({
        SUPPORT_MONERO_ADDRESS: "",
        SUPPORT_BITCOIN_ADDRESS: "   ",
        SUPPORT_LIGHTNING_ADDRESS: undefined,
      }),
    ).toEqual([]);
  });
});
