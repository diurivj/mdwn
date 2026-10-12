import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { recoveryCookie, seedAccount, seedNormalSession, signedCookie } from "./auth-fixtures";
import { sharingAccount } from "./sharing-fixtures";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const page = (path: string, cookie?: string) =>
  SELF.fetch(`https://mdwn.test${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

describe("sign-in and sign-up pages for a signed-in browser", () => {
  it("send a device-bound Session to its library, document and data requests alike", async () => {
    const owner = await sharingAccount();
    for (const path of ["/sign-in", "/sign-up"]) {
      const document = await page(path, owner.session.cookie);
      expect(document.status).toBe(302);
      expect(document.headers.get("Location")).toBe("/files");
      // A client-side navigation asks for the route data; it must redirect the same way.
      const data = await page(`${path}.data`, owner.session.cookie);
      expect(data.status).toBe(202);
      const payload = await data.text();
      expect(payload).toContain('"SingleFetchRedirect"');
      expect(payload).toContain('"redirect","/files"');
    }
  });

  it("still show the page with no Session, an unbound, recovery, forged or revoked one", async () => {
    const owner = await sharingAccount();
    const account = await seedAccount(1);
    const cookies: (string | undefined)[] = [
      undefined,
      (await seedNormalSession(account)).cookie,
      await recoveryCookie(account.accountId),
      await signedCookie(crypto.randomUUID()),
    ];
    for (const cookie of cookies) {
      for (const [path, heading] of [
        ["/sign-in", "Sign in"],
        ["/sign-up", "Create your account"],
      ] as const) {
        const response = await page(path, cookie);
        expect(response.status, `${path} with ${cookie ?? "no cookie"}`).toBe(200);
        expect(await response.text()).toContain(heading);
      }
    }
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), owner.session.id).run();
    expect((await page("/sign-in", owner.session.cookie)).status).toBe(200);
  });

  it("still show the page to a live Session whose device is no longer active", async () => {
    const owner = await sharingAccount();
    expect((await page("/sign-in", owner.session.cookie)).status).toBe(302);
    await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(owner.deviceId).run();
    for (const path of ["/sign-in", "/sign-up"]) expect((await page(path, owner.session.cookie)).status).toBe(200);
  });
});
