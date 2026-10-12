import type { Page, Request } from "@playwright/test";
import { installWorkspaceScript, test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";
import { forgetTabMemory, withoutTabMessages } from "./support/tab-memory";

const changed = "This folder changed on another device. Nothing was added, replaced, or overwritten.";
async function create(page: Page, name: string, kind: "File" | "folder") {
  await page.getByRole("button", { name: `New ${kind}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}
async function openDraft(page: Page, fileId: string) {
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Draft.md", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/f/${fileId}$`));
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
}
async function confirmDelete(page: Page) {
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete permanently", exact: true });
  await expect(dialog.getByRole("button", { name: "Delete permanently", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
}

for (const sourceKind of ["file", "directory"] as const)
  for (const pendingLoader of [false, true])
    test(`a completed ${sourceKind} deletion response cannot override a newer ${pendingLoader ? "pending " : ""}Back navigation`, async ({
      page,
      workspace,
    }) => {
      const deletingDirectory = sourceKind === "directory";
      const folder = await create(page, deletingDirectory ? "Doomed folder" : "Surviving folder", "folder");
      const sourceName = deletingDirectory ? "Doomed folder" : "Draft.md";
      const destinationName = deletingDirectory ? "Draft.md" : "Surviving folder";
      const destinationId = deletingDirectory ? workspace.fileId : folder;
      const destinationUrl = `/${deletingDirectory ? "f" : "d"}/${destinationId}`;
      if (!deletingDirectory)
        await page
          .getByRole("navigation", { name: "Files", exact: true })
          .getByRole("link", { name: "Draft.md", exact: true })
          .click();
      await expect(page.getByRole("heading", { name: sourceName, exact: true })).toBeVisible();
      const path = `/api/private/tree/nodes/${deletingDirectory ? folder : workspace.fileId}`;
      let release: (() => void) | undefined;
      let releaseBack: (() => void) | undefined;
      if (pendingLoader)
        await page.route(`**/api/private/tree/nodes/${destinationId}/ancestors`, async (route) => {
          const response = await route.fetch();
          await new Promise<void>((resolve) => {
            releaseBack = resolve;
          });
          await route.fulfill({ response }).catch(() => {
            /* A newer intent may cancel this loader. */
          });
        });
      const settled = new Promise<void>((resolve) => {
        const onSettled = (request: Request) => {
          if (new URL(request.url()).pathname === path && request.method() === "DELETE") resolve();
        };
        page.on("requestfinished", onSettled);
        page.on("requestfailed", onSettled);
      });
      await page.route(`**${path}`, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200); // The database commit already happened.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({ response }).catch(() => {
          /* Navigation may abort the browser request. */
        });
      });
      try {
        await confirmDelete(page);
        await expect.poll(() => Boolean(release)).toBe(true);
        // Only a destination this tab does not remember has a loader to hold (ticket 57).
        if (pendingLoader) await forgetTabMemory(page);
        await page.goBack();
        // While its loader runs, the library previews the Back destination in place of the deleted source.
        const opening = page.getByRole("status").filter({ hasText: `Opening ${destinationName}…` });
        if (pendingLoader) {
          await expect.poll(() => Boolean(releaseBack)).toBe(true);
          await expect(opening).toBeAttached();
          await expect(page.getByRole("heading", { name: sourceName, exact: true })).toBeHidden();
        } else await expect(page.getByRole("heading", { name: destinationName, exact: true })).toBeVisible();
        release!();
        await settled;
        await page.waitForTimeout(300); // Allow the held response's continuation to run.
        await expect(page).toHaveURL(new RegExp(`${destinationUrl}$`));
        if (pendingLoader) {
          // The settled deletion neither navigates nor restores the source over the newer Back preview.
          await expect(opening).toBeAttached();
          await expect(page.getByRole("heading", { name: sourceName, exact: true })).toBeHidden();
          releaseBack!();
        }
        await expect(page.getByRole("heading", { name: destinationName, exact: true })).toBeVisible();
      } finally {
        release?.();
        releaseBack?.();
      }
    });

test("selected File order survives reload", async ({ page, workspace }) => {
  expect(workspace.fileId).toBeTruthy();
  await page.getByRole("button", { name: "New File", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Second.md");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Second.md", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Draft.md", exact: true })
    .click();
  await page.getByRole("button", { name: "Move up", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link")).toHaveText([
    "Draft.md",
    "Second.md",
  ]);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link")).toHaveText([
    "Draft.md",
    "Second.md",
  ]);
  // Stay in-app: document navigation can cancel the provisioning route's lazy import.
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Library", exact: true })
    .click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("button", { name: "Move up", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
});

test("moves a File with contents after canonical collision review, then deletes it irreversibly", async ({
  page,
  workspace,
}) => {
  await create(page, "Destination", "folder");
  const folder = await create(page, "Nested destination", "folder");
  await create(page, "DRAFT.md", "File");
  await openDraft(page, workspace.fileId);
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await source.fill("# Contents travel with this File");
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move", exact: true });
  await dialog.getByRole("button", { name: "Open destination Destination", exact: true }).click();
  await dialog.getByRole("button", { name: "Open destination Nested destination", exact: true }).click();
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(
    dialog.getByText("That name is already in this folder. Choose another name; nothing was overwritten.", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Moved.md");
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await expect(page.getByRole("heading", { name: "Moved.md", exact: true })).toBeVisible();
  await expect(source).toHaveValue("# Contents travel with this File");
  await source.fill("# Saved using the new parent key");
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await waitForSharedProvisioning(page);
  await page.reload();
  await expect(source).toHaveValue("# Saved using the new parent key");
  await confirmDelete(page);
  await expect(page).toHaveURL(new RegExp(`/d/${folder}$`));
  await waitForSharedProvisioning(page);
  await page.goto(`/f/${workspace.fileId}`);
  await expect(page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  const deleted = await page.getByRole("main").innerText();
  await page.goto("/f/019950d7-98c0-7000-8000-000000000014");
  await expect(page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  expect(await page.getByRole("main").innerText()).toBe(deleted);
});

test("hard-deletes a Directory and all descendants", async ({ page, workspace }) => {
  expect(workspace.rootId).toBeTruthy();
  const folder = await create(page, "Delete tree", "folder");
  const nested = await create(page, "Nested", "folder");
  const file = await create(page, "Descendant.md", "File");
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Delete tree", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Delete tree", exact: true })).toBeVisible();
  await confirmDelete(page);
  await expect(page).toHaveURL(/\/files$/);
  await waitForSharedProvisioning(page);
  for (const path of [`/d/${folder}`, `/d/${nested}`, `/f/${file}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
  }
});

for (const affected of ["source", "destination"] as const) {
  test(`refreshes a changed move ${affected} before explicit retry and preserves the requested name`, async ({
    page,
    context,
    baseURL,
    workspaceScript,
    workspace,
  }) => {
    const folder = await create(page, "Destination", "folder");
    await openDraft(page, workspace.fileId);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Move", exact: true });
    await dialog.getByRole("button", { name: "Open destination Destination", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Requested.md");
    const other = await context.newPage();
    // The concurrent change comes from another device, which this tab hears about only on conflict.
    await withoutTabMessages(other);
    await installWorkspaceScript(other, workspaceScript, baseURL!);
    try {
      await other.evaluate(
        async ({ affected, folder }) => {
          const api = window.workspaceFixture;
          const access = await api.openRoot();
          const root = await api.loadDirectory(access, access.rootId, access.rootKey);
          const entry = root.entries.find((item) => item.nodeId === folder)!;
          const key =
            affected === "source" ? access.rootKey : await api.openChildDirectory(access, access.rootKey, entry);
          const parent = affected === "source" ? root : await api.loadDirectory(access, folder, key);
          const payload = await api.prepareTreeCreate({
            vaultId: access.vaultId,
            parentId: parent.directoryId,
            parentKey: key,
            entriesRevision: parent.entriesRevision,
            existingNames: parent.entries.map((item) => item.name),
            requestedName: affected === "destination" ? "Requested.md" : "Concurrent.md",
            kind: "file",
          });
          await api.createTreeChild(access, parent.directoryId, payload, parent, key);
        },
        { affected, folder },
      );
      await dialog.getByRole("button", { name: "Move", exact: true }).click();
      await expect(dialog.getByText(changed, { exact: true })).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Requested.md");
      await dialog.getByRole("button", { name: "Refresh and retry", exact: true }).click();
      if (affected === "destination") {
        await expect(
          dialog.getByText("That name is already in this folder. Choose another name; nothing was overwritten.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Requested.md");
        await dialog.getByRole("button", { name: "Rename", exact: true }).click();
        await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Resolved.md");
        await dialog.getByRole("button", { name: "Move", exact: true }).click();
      }
      const finalName = affected === "destination" ? "Resolved.md" : "Requested.md";
      await expect(page.getByRole("heading", { name: finalName, exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { name: finalName, exact: true })).toBeVisible();
    } finally {
      await other.close();
    }
  });
}

test("over-cap Directory deletion changes nothing and asks the user to reduce the subtree", async ({
  page,
  workspace,
}) => {
  test.setTimeout(90_000);
  const folder = await create(page, "Large folder", "folder");
  const reloadLargeFolder = async () => {
    // This persistence check loads 500 real encrypted entries, not a fast UI-only fixture.
    const listing = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/private/tree/directories/${folder}`,
    );
    await page.reload();
    const response = await listing;
    expect(response.status()).toBe(200);
    expect(await response.finished()).toBeNull();
    await expect(page.getByRole("heading", { name: "Large folder", exact: true })).toBeVisible();
  };
  // Seed at the real D1 boundary, using actual browser encryption and a signed Directory listing.
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
  const seeded = await page.evaluate(
    async ({ folder }) => {
      const api = window.workspaceFixture,
        access = await api.openRoot();
      const root = await api.loadDirectory(access, access.rootId, access.rootKey);
      const key = await api.openChildDirectory(
        access,
        access.rootKey,
        root.entries.find((entry) => entry.nodeId === folder)!,
      );
      const children = [];
      for (let index = 0; index < 500; index++)
        children.push(
          await api.prepareTreeCreate({
            vaultId: access.vaultId,
            parentId: folder,
            parentKey: key,
            entriesRevision: 1,
            existingNames: [],
            requestedName: `Child ${index}`,
            kind: "directory",
          }),
        );
      const device = (await api.getDevice(access.vaultId))!;
      const head = await api.createListingHead(key, device.assertionKeyPair.privateKey, {
        vaultId: access.vaultId,
        directoryId: folder,
        deviceId: device.deviceId,
        revision: 2,
        entries: children.map((child) => ({
          nodeId: child.nodeId,
          kind: child.kind,
          nameCiphertext: child.nameCiphertext,
          orderCiphertext: child.orderCiphertext,
          keyEnvelope: child.keyEnvelope,
        })),
      });
      return { children, head, deviceId: device.deviceId };
    },
    { folder },
  );
  const decode = (value: string) => Uint8Array.from(Buffer.from(value, "base64url"));
  for (let start = 0; start < seeded.children.length; start += 25)
    await workspace.db.batch(
      seeded.children
        .slice(start, start + 25)
        .flatMap((child) => [
          workspace.db
            .prepare(
              "INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at) VALUES (?, 'directory', ?, ?, 1, 1)",
            )
            .bind(child.nodeId, workspace.accountId, folder),
          workspace.db
            .prepare("INSERT INTO directories (node_id, owner_id, entries_revision) VALUES (?, ?, 1)")
            .bind(child.nodeId, workspace.accountId),
          workspace.db
            .prepare(
              "INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(
              child.nodeId,
              workspace.accountId,
              folder,
              decode(child.nameCiphertext),
              decode(child.orderCiphertext),
              decode(child.keyEnvelope),
            ),
        ]),
    );
  await workspace.db
    .prepare(
      "UPDATE directories SET entries_revision = 2, listing_ciphertext = ?, listing_digest = ?, listing_signature = ?, listing_device_id = ? WHERE node_id = ?",
    )
    .bind(
      decode(seeded.head.ciphertext),
      decode(seeded.head.digest),
      decode(seeded.head.signature),
      seeded.deviceId,
      folder,
    )
    .run();
  await reloadLargeFolder();
  await confirmDelete(page);
  await expect(page.getByRole("alert")).toHaveText(
    "This folder contains more than 500 nodes. Reduce the subtree by moving or deleting smaller folders or Files first. Nothing was deleted.",
  );
  await page
    .getByRole("dialog", { name: "Delete permanently", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await waitForSharedProvisioning(page);
  await reloadLargeFolder();
  await page.getByRole("button", { name: "Expand Large folder", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Files", exact: true }).getByRole("link", { name: /^Child / }),
  ).toHaveCount(500);
});

for (const operation of ["move", "delete"] as const) {
  test(`blocks custom paste while a ${operation} holds the saved File frozen`, async ({ page, workspace }) => {
    const folder = operation === "move" ? await create(page, "Paste target", "folder") : undefined;
    if (folder) await openDraft(page, workspace.fileId);
    const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
    await source.fill("# Saved before structure");
    await source.press("ControlOrMeta+s");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const path =
      operation === "move"
        ? `**/api/private/tree/nodes/${workspace.fileId}/parent`
        : `**/api/private/tree/nodes/${workspace.fileId}`;
    let release: (() => void) | undefined;
    await page.route(path, async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.continue();
    });
    try {
      if (operation === "move") {
        await page.getByRole("button", { name: "Move", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Move", exact: true });
        await dialog.getByRole("button", { name: "Open destination Paste target", exact: true }).click();
        await dialog.getByRole("button", { name: "Move", exact: true }).click();
      } else await confirmDelete(page);
      await expect.poll(() => Boolean(release)).toBe(true);
      await expect(source).toHaveAttribute("readonly", "");
      await source.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        const data = new DataTransfer();
        data.setData("text/plain", "\nThis must not become a discarded draft");
        const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: data });
        textarea.dispatchEvent(event);
      });
      await expect(source).toHaveValue("# Saved before structure");
      release!();
      if (folder)
        await expect(
          page
            .getByRole("navigation", { name: "Breadcrumbs" })
            .getByRole("link", { name: "Paste target", exact: true }),
        ).toHaveAttribute("href", `/d/${folder}`);
      else await expect(page).toHaveURL(/\/files$/);
    } finally {
      release?.();
    }
  });
}

test("structural controls protect pending, failed, saving, and composing File drafts", async ({ page, workspace }) => {
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  const controls = ["Rename", "Move", "Delete", "Move up", "Move down"];
  const time = new Date(Date.now() - 10_000);
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await source.fill("# Pending draft stays here");
  for (const name of controls) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await page.route(`**/api/private/tree/files/${workspace.fileId}`, (route) =>
    route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
  );
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  for (const name of controls) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(source).toHaveValue("# Pending draft stays here");
  await page.unroute(`**/api/private/tree/files/${workspace.fileId}`);
  let release: (() => void) | undefined;
  await page.route(`**/api/private/tree/files/${workspace.fileId}`, async (route) => {
    if (route.request().method() === "PATCH")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.continue();
  });
  await source.press("ControlOrMeta+s");
  await expect(page.getByText("Saving", { exact: true })).toBeVisible();
  for (const name of controls) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await source.dispatchEvent("compositionstart");
  for (const name of controls) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await source.dispatchEvent("compositionend");
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeEnabled();
  await expect(source).toHaveValue("# Pending draft stays here");
});

test("a created or deleted node's own navigation is not reported as an interruption", async ({ page, workspace }) => {
  await expect(page.getByRole("heading", { name: "Draft.md", exact: true })).toBeVisible();
  expect(workspace.fileId).toBeTruthy();
  // Hold each destination's path read so the departing page stays rendered while it loads.
  await page.route("**/api/private/tree/nodes/*/ancestors", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue().catch(() => {
      /* A later navigation may cancel this loader. */
    });
  });
  await page.evaluate(() => {
    const seen = { interrupted: false };
    Object.assign(window, { interruptionProbe: seen });
    new MutationObserver(() => {
      if (document.body.textContent?.includes("Navigation interrupted")) seen.interrupted = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const interrupted = () =>
    page.evaluate(
      () => (window as unknown as { interruptionProbe: { interrupted: boolean } }).interruptionProbe.interrupted,
    );
  await create(page, "From a File.md", "File");
  await create(page, "From a File folder", "folder");
  await create(page, "From a folder.md", "File");
  await confirmDelete(page);
  await expect(page.getByRole("heading", { name: "From a File folder", exact: true })).toBeVisible();
  expect(await interrupted()).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
