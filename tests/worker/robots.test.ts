import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * Ticket 34 moved the robots.txt resource module under app/routes/resources/;
 * this pins its unchanged public contract.
 */
it("serves robots.txt as plain text that blocks indexing", async () => {
  const response = await SELF.fetch("https://mdwn.test/robots.txt");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/plain");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
});
