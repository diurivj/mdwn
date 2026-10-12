import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

/**
 * Ticket 57: `no-transform` on HTML stops Cloudflare injecting its Web
 * Analytics beacon into documents; other dynamic responses stay `no-store`.
 */
it.each(["/", "/sign-in", "/no-such-page"])("serves the %s document with no-store, no-transform", async (path) => {
  const response = await SELF.fetch(`https://mdwn.test${path}`);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  if (path === "/no-such-page") expect(response.status).toBe(404);
  await response.body?.cancel();
});

it("keeps exactly no-store on JSON API responses", async () => {
  const response = await SELF.fetch("https://mdwn.test/api/auth/session");
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await response.body?.cancel();
});
