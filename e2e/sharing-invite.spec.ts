import type { Page } from "@playwright/test";
import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";
import { seededAccount, sharedMarkdown } from "./support/provisioning-fixtures";

test.setTimeout(180_000);
test.use({ initialSource: sharedMarkdown });

/** Every step is UI: the recipient reads its own identifier, the Owner invites and prepares from the Share dialog. */
async function openSharing(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.locator("#account-menu").getByRole("link", { name: "Sharing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sharing", level: 1 })).toBeVisible();
}

async function ownIdentifier(page: Page) {
  await openSharing(page);
  const field = page.getByRole("textbox", { name: "Share identifier", exact: true });
  await expect(field).not.toHaveValue("");
  return field.inputValue();
}

async function acceptInvitation(page: Page) {
  await openSharing(page);
  const invitations = page.getByRole("region", { name: "Invitations" });
  await invitations.getByRole("button", { name: "Accept", exact: true }).click();
  await invitations.getByRole("button", { name: "Confirm accept", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invitation accepted" })).toBeVisible();
}

async function share(page: Page, identifier: string, permission: "Read only" | "Read & write") {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Recipient’s share identifier" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Recipient’s share identifier" }).fill(identifier);
  await dialog.getByRole("radio", { name: permission, exact: true }).check();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  return dialog;
}

test("the Owner shares a legacy File read-only from the workspace, and revoking from the Share dialog ends access", async ({
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
    const r = recipient.page;
    const identifier = await ownIdentifier(r);
    expect(
      await workspace.db.prepare("SELECT capability_id FROM files WHERE node_id = ?").bind(workspace.fileId).first(),
    ).toEqual({ capability_id: null });

    // The first envelope upload commits, but its response is lost: the retry
    // resends the identical saved bytes (no re-sealing) with a fresh proof.
    const uploads: { body: string; proof: string }[] = [];
    await page.route("**/api/private/shares/*/keys", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      uploads.push({ body: route.request().postData()!, proof: route.request().headers()["x-mdwn-device-proof"]! });
      const response = await route.fetch();
      if (uploads.length === 1) {
        expect(response.status()).toBe(200);
        return route.abort();
      }
      return route.fulfill({ response });
    });
    const dialog = await share(page, identifier, "Read only");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Invitation sent and secure access prepared" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText("Sharing in their Account menu");
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.body).toBe(uploads[0]!.body);
    expect(uploads[1]!.proof).not.toBe(uploads[0]!.proof);
    await page.unroute("**/api/private/shares/*/keys");
    // The legacy File gained its own capability before the invitation.
    expect(
      await workspace.db
        .prepare("SELECT capability_id IS NOT NULL AS converted FROM files WHERE node_id = ?")
        .bind(workspace.fileId)
        .first(),
    ).toEqual({ converted: 1 });
    const people = dialog.getByRole("region", { name: "People with access" });
    await expect(people.getByRole("listitem")).toHaveCount(1);
    await expect(people.getByRole("listitem")).toContainText(identifier);
    await expect(people.getByRole("listitem")).toContainText("Waiting for acceptance");
    await expect(people.getByRole("listitem")).toContainText("Read-only");

    await r.reload();
    await acceptInvitation(r);
    await r.getByRole("link", { name: "Open library", exact: true }).click();
    const tree = r.getByRole("complementary", { name: "Files tree", exact: true });
    await tree
      .getByRole("region", { name: "Shared with me", exact: true })
      .getByRole("link", { name: "Shared File Read-only", exact: true })
      .click();
    await expect(r).toHaveURL(`${origin}/f/${workspace.fileId}`);
    await expect(r.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(sharedMarkdown);

    // Reopening the dialog re-reads this target's relationships.
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const collaborator = people.getByRole("listitem");
    await expect(collaborator).toHaveCount(1);
    await expect(collaborator).toContainText(identifier);
    await expect(collaborator).toContainText("No expiry");
    await collaborator.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(collaborator).toContainText("Their access ends now");
    await collaborator.getByRole("button", { name: "Confirm revoke", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: "Access revoked." })).toBeVisible();
    await expect(people).toContainText("Only you can open this File.");
    // The Files page was not reloaded underneath the dialog.
    await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(sharedMarkdown);
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM grants").first()).toEqual({ total: 0 });
    // No share identifier or relationship enters server-rendered HTML of either page.
    for (const path of [`/f/${workspace.fileId}`, "/account/sharing"])
      expect(await (await page.request.get(path)).text()).not.toContain(identifier);

    await waitForSharedProvisioning(r);
    await r.goto(`${origin}/f/${workspace.fileId}`);
    await expect(r.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
    await expect(r.getByText("Only the target File.", { exact: false })).toHaveCount(0);
  } finally {
    await recipient.context.close();
  }
});

test("a read/write folder share prepares real Comment keys, so the Collaborator edits a File and reads its Comment", async ({
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
    const r = recipient.page;
    const identifier = await ownIdentifier(r);

    await page.getByRole("button", { name: "New folder", exact: true }).click();
    let create = page.getByRole("dialog", { name: "Create a name" });
    await create.getByRole("textbox", { name: "Name", exact: true }).fill("Team");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    const folderId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "New File", exact: true }).click();
    create = page.getByRole("dialog", { name: "Create a name" });
    await create.getByRole("textbox", { name: "Name", exact: true }).fill("Notes.md");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Notes.md", exact: true })).toBeVisible();
    const notesId = new URL(page.url()).pathname.split("/").at(-1)!;
    const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
    await source.fill("# Team notes");
    await source.press("ControlOrMeta+s");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await page.getByLabel("Add a private comment").fill("Owner context for the team");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const comments = page.getByRole("region", { name: "Private comments", exact: true });
    await expect(comments.getByText("Owner context for the team")).toBeVisible();
    expect(
      await workspace.db
        .prepare("SELECT count(*) AS total FROM sharing_comment_capabilities WHERE file_id = ?")
        .bind(notesId)
        .first(),
    ).toEqual({ total: 1 });

    await page
      .getByRole("navigation", { name: "Breadcrumbs" })
      .getByRole("link", { name: "Team", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    const dialog = await share(page, identifier, "Read & write");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Invitation sent and secure access prepared" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole("region", { name: "People with access" })).toContainText("Read/write");

    await r.reload();
    await acceptInvitation(r);
    await r.getByRole("link", { name: "Open library", exact: true }).click();
    await r
      .getByRole("complementary", { name: "Files tree", exact: true })
      .getByRole("region", { name: "Shared with me", exact: true })
      .getByRole("link", { name: "Shared folder Read/write", exact: true })
      .click();
    await expect(r).toHaveURL(`${origin}/d/${folderId}`);
    await r.getByRole("list", { name: "Folder contents" }).getByRole("link", { name: "Notes.md, File" }).click();
    await expect(r).toHaveURL(`${origin}/f/${notesId}`);
    const shared = r.getByRole("textbox", { name: "Markdown source", exact: true });
    await expect(shared).toHaveValue("# Team notes");
    await shared.fill("# Team notes\n\nEdited by the Collaborator.");
    await shared.press("ControlOrMeta+s");
    await expect(r.getByText("Saved", { exact: true })).toBeVisible();
    await r.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(
      r.getByRole("region", { name: "Private comments", exact: true }).getByText("Owner context for the team"),
    ).toBeVisible();

    await page.reload();
    await page.getByRole("link", { name: "Notes.md, File" }).click();
    await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
      "# Team notes\n\nEdited by the Collaborator.",
    );
  } finally {
    await recipient.context.close();
  }
});

test("inviting an unknown or your own share identifier explains why nothing was sent", async ({ page, workspace }) => {
  const dialog = await share(page, "not-an-account-identifier", "Read only");
  await expect(dialog.getByRole("alert")).toHaveText(
    "No Account has that share identifier. Check it with the person you want to share with.",
  );
  const own = await workspace.db
    .prepare("SELECT share_id FROM accounts WHERE id = ?")
    .bind(workspace.accountId)
    .first<{ share_id: string }>();
  await dialog.getByRole("textbox", { name: "Recipient’s share identifier" }).fill(own!.share_id);
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That is your own share identifier. You can’t share with yourself.",
  );
  expect(await workspace.db.prepare("SELECT count(*) AS total FROM shares").first()).toEqual({ total: 0 });
  await expect(dialog.getByRole("region", { name: "People with access" })).toContainText(
    "Only you can open this File.",
  );
});
