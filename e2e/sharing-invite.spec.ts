import type { Page } from "@playwright/test";
import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";
import { enroll, provisioningNext, seededAccount, sharedMarkdown } from "./support/provisioning-fixtures";
import {
  ARCHIVE_COMMENTS_PATH,
  ARCHIVE_MANIFEST_PATH,
  createArchiveManifest,
  createPrivateCommentsSidecar,
  serializeArchiveManifest,
  serializePrivateCommentsSidecar,
} from "../app/shared/archive/format";
import { createZip } from "../app/shared/archive/zip";

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

async function share(page: Page, identifier: string, permission: "Read-only" | "Read/write") {
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
    const dialog = await share(page, identifier, "Read-only");
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
    // The same Account cannot be invited twice to the same item.
    await dialog.getByRole("textbox", { name: "Recipient’s share identifier" }).fill(identifier);
    await dialog.getByRole("button", { name: "Share", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "That Account already has an invitation or access for this item.",
    );
    await dialog.getByRole("textbox", { name: "Recipient’s share identifier" }).fill("");
    // Preparing again is safe: pending envelopes upsert.
    await people.getByRole("button", { name: "Prepare secure access", exact: true }).click();
    await expect(people.getByRole("status").filter({ hasText: "Secure access prepared." })).toBeVisible();

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
    // Collaborators cannot reshare: content shared with you has no Share action.
    await expect(r.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);

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
    const dialog = await share(page, identifier, "Read/write");
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
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New folder", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Draft.md", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  const dialog = await share(page, "not-an-account-identifier", "Read-only");
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

test("the Owner cancels a pending invitation from the Share dialog", async ({
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
    const address = await workspace.db
      .prepare("SELECT share_id FROM accounts WHERE id = ?")
      .bind(recipient.accountId)
      .first<{ share_id: string }>();
    const dialog = await share(page, address!.share_id, "Read/write");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Invitation sent and secure access prepared" }),
    ).toBeVisible({ timeout: 60_000 });
    const people = dialog.getByRole("region", { name: "People with access" });
    await people.getByRole("button", { name: "Cancel invitation", exact: true }).click();
    await people.getByRole("button", { name: "Confirm cancel", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: "Invitation cancelled." })).toBeVisible();
    await expect(people).toContainText("Only you can open this File.");
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM shares").first()).toEqual({ total: 0 });
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM share_key_envelopes").first()).toEqual({
      total: 0,
    });
  } finally {
    await recipient.context.close();
  }
});

async function createFolder(page: Page, name: string) {
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create a name" });
  await create.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

test("a folder with imported Historical Comments is preparable, and the Collaborator reads them", async ({
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
    const folderId = await createFolder(page, "Archive");
    const encoder = new TextEncoder();
    const at = Date.parse("2026-10-01T12:00:00.000Z");
    const archive = await createZip(
      [
        {
          path: ARCHIVE_MANIFEST_PATH,
          data: encoder.encode(
            serializeArchiveManifest(
              createArchiveManifest([{ kind: "directory", path: "" }], "2026-10-01T12:00:00.000Z"),
            ),
          ),
        },
        {
          path: ARCHIVE_COMMENTS_PATH,
          data: encoder.encode(
            serializePrivateCommentsSidecar(
              createPrivateCommentsSidecar([
                {
                  path: "history.md",
                  comments: [
                    {
                      sequence: 1,
                      text: "Historical note from the archive",
                      pseudonym: "Past Self",
                      createdAt: at,
                      updatedAt: at,
                    },
                  ],
                },
              ]),
            ),
          ),
        },
        { path: "history.md", data: encoder.encode("# History\n") },
      ],
      { at: new Date(at) },
    );
    await page
      .getByTestId("import-files-input")
      .setInputFiles({ name: "history.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
    await expect(page.getByRole("dialog", { name: "Import review" })).toBeVisible();
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-complete")).toContainText("Added", { timeout: 30_000 });
    expect(
      await workspace.db
        .prepare(`SELECT count(*) AS total FROM import_comment_envelopes e JOIN vault_nodes n ON n.id = e.file_id
          WHERE n.parent_node_id = ?`)
        .bind(folderId)
        .first(),
    ).toEqual({ total: 1 });
    expect(
      await workspace.db
        .prepare(`SELECT count(*) AS total FROM key_envelopes k JOIN import_comment_envelopes e ON e.thread_id = k.object_id
          WHERE k.purpose = 'vault-recovery'`)
        .first(),
    ).toEqual({ total: 0 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Archive", exact: true })).toBeVisible();
    const dialog = await share(page, identifier, "Read-only");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Invitation sent and secure access prepared" }),
    ).toBeVisible({ timeout: 60_000 });

    await r.reload();
    await acceptInvitation(r);
    await r.getByRole("link", { name: "Open library", exact: true }).click();
    await r
      .getByRole("complementary", { name: "Files tree", exact: true })
      .getByRole("region", { name: "Shared with me", exact: true })
      .getByRole("link", { name: "Shared folder Read-only", exact: true })
      .click();
    await expect(r).toHaveURL(`${origin}/d/${folderId}`);
    await r.getByRole("list", { name: "Folder contents" }).getByRole("link", { name: "history.md, File" }).click();
    await expect(r.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue("# History\n");
    await r.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(
      r.getByRole("region", { name: "Private comments", exact: true }).getByText("Historical note from the archive"),
    ).toBeVisible();
  } finally {
    await recipient.context.close();
  }
});

test("a recipient's two enrolled devices are both prepared by the Owner before acceptance", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  test.setTimeout(360_000);
  const origin = new URL(baseURL!).origin;
  const recipient = await seededAccount(browser, server, origin, workspaceScript);
  const second = await enroll(browser, recipient, origin, workspaceScript);
  try {
    expect(
      await workspace.db
        .prepare("SELECT count(*) AS total FROM encryption_devices WHERE account_id = ? AND state = 'active'")
        .bind(recipient.accountId)
        .first(),
    ).toEqual({ total: 2 });
    // Only the Share dialog may stage keys here: no background provisioning on either side.
    await page.route(provisioningNext, (route) => route.abort());
    const identifier = await ownIdentifier(recipient.page);
    const dialog = await share(page, identifier, "Read-only");
    await expect(
      dialog.getByRole("status").filter({ hasText: "Invitation sent and secure access prepared" }),
    ).toBeVisible({ timeout: 60_000 });
    expect(await workspace.db.prepare("SELECT count(*) AS total FROM share_key_envelopes").first()).toEqual({
      total: 2,
    });

    await recipient.page.reload();
    await acceptInvitation(recipient.page);
    for (const device of [recipient.page, second.page]) {
      await device.getByRole("link", { name: "Open library", exact: true }).click();
      await device
        .getByRole("complementary", { name: "Files tree", exact: true })
        .getByRole("region", { name: "Shared with me", exact: true })
        .getByRole("link", { name: "Shared File Read-only", exact: true })
        .click();
      await expect(device).toHaveURL(`${origin}/f/${workspace.fileId}`);
      await expect(device.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(sharedMarkdown);
    }
  } finally {
    await second.context.close();
    await recipient.context.close();
  }
});
