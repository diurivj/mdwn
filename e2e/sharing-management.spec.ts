import type { Page } from "@playwright/test";
import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";
import { inviteToFile, seededAccount, sharedMarkdown } from "./support/provisioning-fixtures";

test.setTimeout(180_000);
test.use({ initialSource: sharedMarkdown });

/** These Shares are created through the API to isolate the Sharing page; `sharing-invite.spec.ts` drives the Share dialog. */
async function openSharing(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.locator("#account-menu").getByRole("link", { name: "Sharing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sharing", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your share identifier" })).toBeVisible();
}

async function confirm(scope: ReturnType<Page["getByRole"]>, action: string, confirmation: string) {
  await scope.getByRole("button", { name: action, exact: true }).click();
  await scope.getByRole("button", { name: confirmation, exact: true }).click();
}

async function acceptFromSharing(page: Page) {
  await openSharing(page);
  const invitations = page.getByRole("region", { name: "Invitations" });
  await confirm(invitations, "Accept", "Confirm accept");
  await expect(page.getByRole("status").filter({ hasText: "Invitation accepted" })).toBeVisible();
  await expect(invitations).toContainText("No pending invitations.");
}

test("a recipient sees the invitation in the library, accepts it, and opens the shared root from Shared with me", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  try {
    await inviteToFile(page, recipient.accountId, workspace, { permission: "read_write" });
    const r = recipient.page;
    await waitForSharedProvisioning(r);
    await r.reload();
    const tree = r.getByRole("complementary", { name: "Files tree", exact: true });
    await tree.getByRole("link", { name: "1 invitation", exact: true }).click();
    await expect(r).toHaveURL(`${origin}/account/sharing`);
    const address = await workspace.db
      .prepare("SELECT share_id FROM accounts WHERE id = ?")
      .bind(recipient.accountId)
      .first<{ share_id: string }>();
    await expect(r.getByRole("textbox", { name: "Share identifier", exact: true })).toHaveValue(address!.share_id);
    const invitations = r.getByRole("region", { name: "Invitations" });
    await expect(invitations.getByRole("listitem")).toHaveCount(1);
    await expect(invitations.getByRole("listitem")).toContainText("Shared File");
    await expect(invitations.getByRole("listitem")).toContainText("Read/write");
    await expect(r.getByRole("region", { name: "Shared with you" })).toContainText("Nothing is shared with you yet.");

    await confirm(invitations, "Accept", "Confirm accept");
    await expect(r.getByRole("status").filter({ hasText: "Invitation accepted" })).toBeVisible();
    await expect(invitations).toContainText("No pending invitations.");
    const received = r.getByRole("region", { name: "Shared with you" }).getByRole("listitem");
    await expect(received).toHaveCount(1);
    await expect(received).toContainText("Read/write");
    await expect(received).toContainText("No expiry");
    await expect(received.getByRole("link", { name: "Open File", exact: true })).toHaveAttribute(
      "href",
      `/f/${workspace.fileId}`,
    );

    // Only the sidebar lists pending Shares inside the library. The Sharing
    // page's fresh read primes its tab memory, so remounting Files routes
    // sends no further relationship list.
    const listings: string[] = [];
    r.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/private/shares") listings.push(request.url());
    });
    await r.getByRole("link", { name: "Open library", exact: true }).click();
    await expect(r.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    const shared = tree.getByRole("region", { name: "Shared with me", exact: true });
    await expect(shared.getByRole("link", { name: /invitation/ })).toHaveCount(0);
    await shared.getByRole("link", { name: "Shared File Read/write", exact: true }).click();
    await expect(r).toHaveURL(`${origin}/f/${workspace.fileId}`);
    await expect(r.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(sharedMarkdown);
    await expect(shared.getByRole("link", { name: "Shared File Read/write", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(listings).toEqual([]);
    await expect(r.getByText("Shared content is being securely provisioned", { exact: true })).toHaveCount(0);
  } finally {
    await recipient.context.close();
  }
});

test("accepting before secure access is prepared explains the wait, and the recipient can decline", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  try {
    await inviteToFile(page, recipient.accountId, workspace, { prepare: false });
    const r = recipient.page;
    await openSharing(r);
    const invitations = r.getByRole("region", { name: "Invitations" });
    await confirm(invitations, "Accept", "Confirm accept");
    await expect(r.getByRole("alert").filter({ hasText: "still preparing secure access" })).toBeVisible();
    await expect(invitations.getByRole("listitem")).toHaveCount(1);
    await confirm(invitations, "Decline", "Confirm decline");
    await expect(r.getByRole("status").filter({ hasText: "Invitation declined." })).toBeVisible();
    await expect(invitations).toContainText("No pending invitations.");
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM shares").first()).toEqual({ total: 0 });
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM grants").first()).toEqual({ total: 0 });
  } finally {
    await recipient.context.close();
  }
});

test("the Owner sees a pending invitation with the recipient's share identifier and cancels it", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  try {
    const share = await inviteToFile(page, recipient.accountId, workspace, { prepare: false });
    await page
      .getByRole("complementary", { name: "Files tree", exact: true })
      .getByRole("link", { name: "Sharing", exact: true })
      .click();
    await expect(page).toHaveURL(`${origin}/account/sharing`);
    const sharedByYou = page.getByRole("region", { name: "Shared by you" });
    const pending = sharedByYou.getByRole("listitem");
    await expect(pending).toHaveCount(1);
    await expect(pending).toContainText(share.recipientShareId);
    await expect(pending).toContainText("Read-only");
    await expect(pending).toContainText("Waiting for acceptance");
    await expect(pending.getByRole("link", { name: "File", exact: true })).toHaveAttribute(
      "href",
      `/f/${workspace.fileId}`,
    );
    await expect(page.getByRole("region", { name: "Invitations" })).toContainText("No pending invitations.");
    await confirm(sharedByYou, "Cancel invitation", "Confirm cancel");
    await expect(page.getByRole("status").filter({ hasText: "Invitation cancelled." })).toBeVisible();
    await expect(sharedByYou).toContainText("No pending invitations from you.");
    await expect(sharedByYou).toContainText("No one has access to your Files or folders.");

    await openSharing(recipient.page);
    await expect(recipient.page.getByRole("region", { name: "Invitations" })).toContainText("No pending invitations.");
  } finally {
    await recipient.context.close();
  }
});

test("the Owner changes a Grant's permission, sets and clears its expiry, and revokes it", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  try {
    const share = await inviteToFile(page, recipient.accountId, workspace);
    await acceptFromSharing(recipient.page);

    await page
      .getByRole("complementary", { name: "Files tree", exact: true })
      .getByRole("link", { name: "Sharing", exact: true })
      .click();
    const sharedByYou = page.getByRole("region", { name: "Shared by you" });
    const grant = sharedByYou.getByRole("listitem");
    await expect(grant).toHaveCount(1);
    await expect(grant).toContainText(share.recipientShareId);
    await expect(grant).toContainText("Read-only");
    await expect(grant).toContainText("No expiry");
    await expect(sharedByYou).toContainText("No pending invitations from you.");

    await grant.getByRole("button", { name: "Allow editing", exact: true }).click();
    await expect(grant).toContainText("Their current access ends now");
    await expect(grant.getByRole("link", { name: "secure access update" })).toHaveAttribute(
      "href",
      "/account/key-rotations",
    );
    await grant.getByRole("button", { name: "Confirm permission change", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Permission changed." })).toBeVisible();
    await expect(grant).toContainText("Read/write");
    expect(
      await workspace.db.prepare("SELECT permission, revision FROM grants WHERE id = ?").bind(share.shareId).first(),
    ).toEqual({ permission: "read_write", revision: 2 });

    const future = new Date();
    future.setDate(future.getDate() + 30);
    const day = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
    await grant.getByLabel("Expiry date").fill(day);
    await grant.getByRole("button", { name: "Set expiry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expiry set." })).toBeVisible();
    await expect(grant).toContainText("Expires");
    const stored = await workspace.db
      .prepare("SELECT expires_at FROM grants WHERE id = ?")
      .bind(share.shareId)
      .first<{ expires_at: number }>();
    expect(stored!.expires_at).toBe(
      new Date(future.getFullYear(), future.getMonth(), future.getDate(), 23, 59, 59, 999).getTime(),
    );

    await grant.getByRole("button", { name: "Clear expiry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Expiry cleared." })).toBeVisible();
    await expect(grant).toContainText("No expiry");

    await grant.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(grant).toContainText("Their access ends now");
    await grant.getByRole("button", { name: "Confirm revoke", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Access revoked." })).toBeVisible();
    await expect(sharedByYou).toContainText("No one has access to your Files or folders.");
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM grants").first()).toEqual({ total: 0 });

    const r = recipient.page;
    await r.reload();
    await expect(r.getByRole("region", { name: "Shared with you" })).toContainText("Nothing is shared with you yet.");
    await r.getByRole("link", { name: "Open library", exact: true }).click();
    await expect(r.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(r.getByRole("region", { name: "Shared with me", exact: true })).toHaveCount(0);
    await waitForSharedProvisioning(r);
    await r.goto(`${origin}/f/${workspace.fileId}`);
    await expect(r.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
    await expect(r.getByText("Only the target File.", { exact: false })).toHaveCount(0);
  } finally {
    await recipient.context.close();
  }
});

test("a recipient leaves a Grant and loses access", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  try {
    await inviteToFile(page, recipient.accountId, workspace);
    const r = recipient.page;
    await acceptFromSharing(r);
    const received = r.getByRole("region", { name: "Shared with you" });
    await expect(received.getByRole("listitem")).toContainText("Read-only");
    await received.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(received).toContainText("You lose access now.");
    await received.getByRole("button", { name: "Confirm leave", exact: true }).click();
    await expect(r.getByRole("status").filter({ hasText: "You left the shared item." })).toBeVisible();
    await expect(received).toContainText("Nothing is shared with you yet.");
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM grants").first()).toEqual({ total: 0 });

    await r.getByRole("link", { name: "Open library", exact: true }).click();
    await expect(r.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(r.getByRole("region", { name: "Shared with me", exact: true })).toHaveCount(0);
    await waitForSharedProvisioning(r);
    await r.goto(`${origin}/f/${workspace.fileId}`);
    await expect(r.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  } finally {
    await recipient.context.close();
  }
});
