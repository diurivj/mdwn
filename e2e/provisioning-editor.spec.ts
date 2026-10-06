import { test, expect, objectId } from "./workspace-fixture";

test("automatic shared provisioning preserves an unsaved File draft when private reloads fail", async ({
  page,
  workspace,
}) => {
  const progress = page.getByRole("region", { name: "Shared access provisioning", exact: true });
  await expect(progress).toHaveAttribute("aria-busy", "false");
  const recipientId = objectId();
  // Persist a crossed deadline at the external D1/time boundary. The browser must
  // run the real signed expiry action while the owned File remains readable.
  await workspace.db.batch([
    workspace.db
      .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(recipientId, objectId()),
    workspace.db
      .prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission,
      revision, key_epoch, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, 1, 1, 1, 1)`)
      .bind(objectId(), workspace.accountId, recipientId, workspace.rootId),
  ]);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const processing = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/private/grant-provisioning/expire", async (route) => {
    started();
    await held;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
  });
  try {
    await page.reload({ waitUntil: "commit" });
    const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
    await expect(source).toBeEditable();
    await processing;
    await expect(progress).toHaveAttribute("aria-busy", "true");
    const draft = "# Keep this unsaved draft";
    await source.fill(draft);
    await source.press("ControlOrMeta+s");
    await expect(page.getByRole("status", { name: "File save status", exact: true })).toHaveText("Couldn't save");
    // A background revalidation would fail and used to unmount the editor,
    // silently dropping the memory-only draft without invoking its blocker.
    let reloads = 0;
    await page.route(`**/api/private/tree/files/${workspace.fileId}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      reloads++;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
    });
    release();
    await expect(progress).toHaveAttribute("aria-busy", "false");
    await expect(source).toHaveValue(draft);
    await expect(page.getByRole("button", { name: "Download local draft", exact: true })).toBeVisible();
    expect(reloads).toBe(0);
  } finally {
    release();
  }
});
