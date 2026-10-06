import { describe, expect, it } from "vitest";

import { deriveNetworkBucket, normalizeEdgeIp } from "../app/shared/security/network-bucket";

const secret = "test-only-key-with-at-least-32-bytes";

describe("privacy-preserving Network buckets", () => {
  it("normalizes IPv4 and IPv6 edge addresses to stable forms", () => {
    expect(normalizeEdgeIp("192.000.2.001")).toBe("192.0.2.1");
    expect(normalizeEdgeIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeEdgeIp("::ffff:192.0.2.1")).toBe("::ffff:c000:201");
    expect(normalizeEdgeIp("::ffff:c000:201")).toBe("::ffff:c000:201");
  });

  it("rejects malformed addresses without including them in an error", () => {
    expect(() => normalizeEdgeIp("not-an-address"))
      .toThrow("invalid edge address");
  });

  it("HMACs the normalized address with independent purpose and epoch domains", async () => {
    const ipv4 = await deriveNetworkBucket("192.0.2.1", "registration.challenge", 20_000, secret);
    const ipv4Alternate = await deriveNetworkBucket("192.000.2.001", "registration.challenge", 20_000, secret);
    const otherPurpose = await deriveNetworkBucket("192.0.2.1", "public_comment.mutate", 20_000, secret);
    const otherEpoch = await deriveNetworkBucket("192.0.2.1", "registration.challenge", 20_001, secret);
    const otherSecret = await deriveNetworkBucket("192.0.2.1", "registration.challenge", 20_000, `${secret}!`);

    expect(ipv4).toMatch(/^network:[a-f0-9]{64}$/);
    expect(ipv4Alternate).toBe(ipv4);
    expect(otherPurpose).not.toBe(ipv4);
    expect(otherEpoch).not.toBe(ipv4);
    expect(otherSecret).not.toBe(ipv4);
    expect(ipv4).not.toContain("192.0.2.1");
  });
});
