import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

import { seedAccount, seedNormalSession } from "./auth-fixtures";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("server-renders only the Public pseudonym shell, never a pseudonym", async () => {
  const account = await seedAccount();
  const session = await seedNormalSession(account);
  const response = await SELF.fetch("https://mdwn.test/account/pseudonym", {
    headers: { cookie: session.cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("Loading Public pseudonym…");
  expect(html).not.toContain(session.id);
  expect(html).not.toContain("Member ");
  for (const credentialId of account.credentialIds) expect(html).not.toContain(credentialId);
});
