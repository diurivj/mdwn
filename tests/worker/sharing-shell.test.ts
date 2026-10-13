import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

import { grant, invite, sharingAccount, treeChild } from "./sharing-fixtures";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("server-renders only the Sharing shell, never a share identifier, relationship or Account id", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const pendingTarget = await treeChild(owner, owner.rootId, "directory");
  const grantedTarget = await treeChild(owner, owner.rootId, "file");
  const pending = await invite(owner, recipient, pendingTarget);
  const active = await grant(owner, recipient, grantedTarget);
  const secrets = [
    owner.accountId,
    owner.shareId,
    owner.session.id,
    recipient.accountId,
    recipient.shareId,
    recipient.session.id,
    pending.shareId,
    active.grantId,
    pendingTarget,
    grantedTarget,
  ];
  for (const account of [owner, recipient]) {
    const response = await SELF.fetch("https://mdwn.test/account/sharing", {
      headers: { cookie: account.session.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Loading sharing…");
    for (const secret of secrets) expect(html).not.toContain(secret);
  }
});
