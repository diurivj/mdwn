import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * Ticket 34 moved the robots.txt resource module under app/routes/resources/;
 * ticket 68 opened only the landing page and its preview banner to crawling,
 * so link previews can read them. Indexing stays off on every page.
 */
it("serves robots.txt as plain text that allows crawling only the landing page and its banner", async () => {
  const response = await SELF.fetch("https://mdwn.test/robots.txt");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/plain");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("User-agent: *\nAllow: /$\nAllow: /og-image.jpg\nDisallow: /\n");
});

it("keeps the crawlable landing page non-indexed", async () => {
  const response = await SELF.fetch("https://mdwn.test/");
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
});
