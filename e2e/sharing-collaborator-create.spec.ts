import { test, expect } from "./fixtures";
import { accountShareId, inviteFromCurrentPage, openEditor } from "./sharing-browser.fixture";

test.setTimeout(360_000);
test.use({ trace: "off", screenshot: "off", video: "off" });

test("a Collaborator creates a File with their device while the Owner retains D1 ownership", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "OwnerSeed.md");
  const collaborator = await openEditor(browser, server, baseURL!, "CollaboratorPrivate.md");
  try {
    const env = await server.getWorker<{ DB: D1Database }>().getEnv();
    const recipientShareId = await accountShareId(server, collaborator.accountId);

    await owner.page.goto(`${origin}/d/${owner.rootId}`);
    await owner.page.getByRole("button", { name: "New folder", exact: true }).click();
    const folderDialog = owner.page.getByRole("dialog", { name: "Create a name" });
    await folderDialog.getByRole("textbox", { name: "Name" }).fill("Research");
    await folderDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(owner.page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    const directoryId = new URL(owner.page.url()).pathname.split("/").at(-1)!;
    const shareId = await inviteFromCurrentPage(owner.page, recipientShareId, "read_write");

    await collaborator.page.goto(`${origin}/d/${collaborator.rootId}`);
    const acceptance = collaborator.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/private/sharing/shares/${shareId}/accept`);
    await collaborator.page.getByText("Invitation to a folder (read/write)", { exact: true })
      .locator("..").getByRole("button", { name: "Accept", exact: true }).click();
    const accepted = await acceptance;
    expect(accepted.status()).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "ready" });

    await collaborator.page.goto(`${origin}/d/${directoryId}`);
    await expect(collaborator.page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await collaborator.page.getByRole("button", { name: "New File", exact: true }).click();
    const fileDialog = collaborator.page.getByRole("dialog", { name: "Create a name" });
    await fileDialog.getByRole("textbox", { name: "Name" }).fill("Collaborator note.md");
    await fileDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(collaborator.page.getByRole("heading", { name: "Collaborator note.md", exact: true }))
      .toBeVisible();

    const child = await env.DB.prepare("SELECT owner_id FROM vault_nodes WHERE id = ?")
      .bind(new URL(collaborator.page.url()).pathname.split("/").at(-1)!).first<{ owner_id: string }>();
    const listing = await env.DB.prepare("SELECT listing_device_id FROM directories WHERE node_id = ?")
      .bind(directoryId).first<{ listing_device_id: string }>();
    expect(child?.owner_id).toBe(owner.accountId);
    expect(listing?.listing_device_id).toBe(collaborator.deviceId);
  } finally {
    await collaborator.context.close();
    await owner.context.close();
  }
});
