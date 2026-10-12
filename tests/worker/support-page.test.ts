import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { SUPPORT_ADDRESS_FIXTURES } from "../support/donation-fixtures";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** Row count per application table, to prove the request stores nothing. */
async function tableCounts(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of results) {
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>();
    counts[name] = row?.n ?? 0;
  }
  return counts;
}

describe("anonymous support page", () => {
  it("server-renders configured addresses and locally generated QR codes", async () => {
    expect(env.SUPPORT_MONERO_ADDRESS).toBe(SUPPORT_ADDRESS_FIXTURES.monero);

    const response = await SELF.fetch("https://mdwn.test/support");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();

    for (const address of Object.values(SUPPORT_ADDRESS_FIXTURES)) {
      expect(html).toContain(address);
    }
    // One inline SVG QR code per configured asset, generated from the same
    // address string that is displayed (never a remote image service).
    expect(html.match(/shape-rendering="crispEdges"/g)).toHaveLength(Object.keys(SUPPORT_ADDRESS_FIXTURES).length);
  });

  it("requires no session, sets no cookie, and stores no record", async () => {
    const before = await tableCounts();
    const response = await SELF.fetch("https://mdwn.test/support", {
      headers: { "X-Forwarded-For": "203.0.113.9" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await tableCounts()).toEqual(before);
  });

  it("states what donations cover and that donations grant nothing", async () => {
    const html = await (await SELF.fetch("https://mdwn.test/support")).text();
    expect(html).toMatch(/domain and hosting costs/i);
    expect(html).toMatch(/change nothing about how mdwn runs/i);
    expect(html).not.toMatch(/paid spend|future paid infrastructure/i);
    expect(html).toMatch(/no badge/i);
    expect(html).toMatch(/no account/i);
  });

  it("carries the strict Content Security Policy and hardening headers", async () => {
    const response = await SELF.fetch("https://mdwn.test/support");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
    // The nonce-based production policy is asserted in tests/headers.test.ts
    // and against the built Worker in e2e/support.spec.ts; the Worker test
    // runtime runs with the local dev relaxation.
    expect(csp).toContain("script-src 'self'");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
