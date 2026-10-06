import { test, expect, objectId } from "./workspace-fixture";

test.use({ initialSource: "# Rotation source\n\nDownloaded copies cannot be recalled." });

test("rotation rejects historical or forked Directory heads and checkpoints accepted promotions", async ({
  page,
  workspace,
}) => {
  const recipientId = objectId(),
    grantId = objectId();
  await workspace.db.batch([
    workspace.db
      .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(recipientId, objectId()),
    workspace.db
      .prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, 1, 1, 1)`)
      .bind(grantId, workspace.accountId, recipientId, workspace.rootId),
  ]);
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
  const checkpointKey = `mdwn:files-listing:${workspace.accountId}:${workspace.rootId}`;
  const checkpoint = await page.evaluate((key) => localStorage.getItem(key), checkpointKey);
  expect(checkpoint).not.toBeNull();
  const jobId = await page.evaluate(async (grantId) => {
    const response = await window.workspaceFixture.privateRequest(`/api/private/grants/${grantId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    if (!response.ok) throw new Error("Revocation failed");
    return ((await response.json()) as { rotation: { jobId: string } }).rotation.jobId;
  }, grantId);
  for (const kind of ["historical", "forked"] as const) {
    const error = await page.evaluate(
      async ({ checkpointKey, checkpoint, jobId, kind }) => {
        const [revision, digest] = JSON.parse(checkpoint!);
        localStorage.setItem(
          checkpointKey,
          JSON.stringify(kind === "historical" ? [revision + 1, digest] : [revision, "another-head-digest"]),
        );
        try {
          await window.workspaceFixture.resumeKeyRotation(jobId, { maxSteps: 2 });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : "unknown";
        }
      },
      { checkpointKey, checkpoint, jobId, kind },
    );
    expect(error).toBe("replayed-manifest");
    const state = await page.evaluate(async (jobId) => {
      const response = await window.workspaceFixture.privateRequest(`/api/private/key-rotations/${jobId}/next`, {
        method: "POST",
      });
      return response.json();
    }, jobId);
    expect(state).toMatchObject({ operation: "stage", job: { progress: 0 } });
  }
  await page.evaluate(({ key, checkpoint }) => localStorage.setItem(key, checkpoint!), {
    key: checkpointKey,
    checkpoint,
  });
  expect(await page.evaluate((jobId) => window.workspaceFixture.resumeKeyRotation(jobId), jobId)).toBe(true);
  const current = await page.evaluate(
    async ({ rootId, checkpointKey }) => {
      const response = await window.workspaceFixture.privateRequest(`/api/private/tree/directories/${rootId}`, {
        method: "POST",
      });
      const listing = (await response.json()) as { entriesRevision: number; listingHead: { digest: string } };
      return {
        checkpoint: JSON.parse(localStorage.getItem(checkpointKey)!),
        revision: listing.entriesRevision,
        digest: listing.listingHead.digest,
      };
    },
    { rootId: workspace.rootId, checkpointKey },
  );
  expect(current.checkpoint).toEqual([current.revision, current.digest]);
});

test("rotation respects File head checkpoints and records the capability cutover", async ({ page, workspace }) => {
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
  await page.evaluate(async (fileId) => {
    const api = window.workspaceFixture,
      access = await api.openRoot();
    const listing = await api.loadDirectory(access, access.rootId, access.rootKey);
    const file = await api.loadFile(access, fileId, access.rootKey);
    await api.convertFileCapability(access, fileId, file, access.rootKey, listing);
    await api.loadFile(access, fileId, access.rootKey);
  }, workspace.fileId);
  const recipientId = objectId(),
    grantId = objectId();
  await workspace.db.batch([
    workspace.db
      .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(recipientId, objectId()),
    workspace.db
      .prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'file', 'read_only', 1, 1, 1, 1)`)
      .bind(grantId, workspace.accountId, recipientId, workspace.fileId),
  ]);
  const checkpointKey = `mdwn:file-head:${workspace.accountId}:${workspace.fileId}`;
  const checkpoint = await page.evaluate((key) => localStorage.getItem(key), checkpointKey);
  expect(checkpoint).not.toBeNull();
  const jobId = await page.evaluate(async (grantId) => {
    const response = await window.workspaceFixture.privateRequest(`/api/private/grants/${grantId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    if (!response.ok) throw new Error("Revocation failed");
    return ((await response.json()) as { rotation: { jobId: string } }).rotation.jobId;
  }, grantId);
  for (const kind of ["epoch", "revision", "forked"] as const) {
    const error = await page.evaluate(
      async ({ checkpointKey, checkpoint, jobId, kind }) => {
        const [epoch, revision, digest] = JSON.parse(checkpoint!);
        localStorage.setItem(
          checkpointKey,
          JSON.stringify(
            kind === "epoch"
              ? [epoch + 1, revision, digest]
              : kind === "revision"
                ? [epoch, revision + 1, digest]
                : [epoch, revision, "another-head-digest"],
          ),
        );
        try {
          await window.workspaceFixture.resumeKeyRotation(jobId, { maxSteps: 2 });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : "unknown";
        }
      },
      { checkpointKey, checkpoint, jobId, kind },
    );
    expect(error).toBe("replayed-file-head");
    const state = await page.evaluate(async (jobId) => {
      const response = await window.workspaceFixture.privateRequest(`/api/private/key-rotations/${jobId}/next`, {
        method: "POST",
      });
      return response.json();
    }, jobId);
    expect(state).toMatchObject({ operation: "promote", job: { progress: 0 } });
  }
  await page.evaluate(({ key, checkpoint }) => localStorage.setItem(key, checkpoint!), {
    key: checkpointKey,
    checkpoint,
  });
  expect(await page.evaluate((jobId) => window.workspaceFixture.resumeKeyRotation(jobId), jobId)).toBe(true);
  const current = await page.evaluate(
    async ({ fileId, checkpointKey }) => {
      const response = await window.workspaceFixture.privateRequest(`/api/private/tree/files/${fileId}`, {
        method: "POST",
      });
      const file = (await response.json()) as {
        capability: { epoch: number };
        revision: number;
        fileHead: { digest: string };
      };
      return {
        checkpoint: JSON.parse(localStorage.getItem(checkpointKey)!),
        epoch: file.capability.epoch,
        revision: file.revision,
        digest: file.fileHead.digest,
      };
    },
    { fileId: workspace.fileId, checkpointKey },
  );
  expect(current.checkpoint).toEqual([current.epoch, current.revision, current.digest]);
});

test("an interrupted root rotation resumes from the progress UI without putting private material in SSR", async ({
  page,
  workspace,
}) => {
  const recipientId = objectId(),
    grantId = objectId();
  await workspace.db.batch([
    workspace.db
      .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(recipientId, objectId()),
    workspace.db
      .prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, 1, 1, 1)`)
      .bind(grantId, workspace.accountId, recipientId, workspace.rootId),
  ]);
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
  const jobId = await page.evaluate(async (grantId) => {
    const api = window.workspaceFixture;
    const response = await api.privateRequest(`/api/private/grants/${grantId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    if (!response.ok) throw new Error("Revocation failed");
    const { rotation } = (await response.json()) as { rotation: { jobId: string } };
    if (await api.resumeKeyRotation(rotation.jobId, { maxSteps: 3 }))
      throw new Error("Expected an interrupted bounded pass");
    return rotation.jobId;
  }, grantId);
  await page.getByRole("link", { name: "Secure access updates", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Secure access updates", exact: true })).toBeVisible();
  await expect(page.getByText("1 capability updated", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This cannot recall previously downloaded plaintext, ciphertext, or keys.", { exact: true }),
  ).toBeVisible();
  const html = await (await page.request.get("/account/key-rotations")).text();
  expect(html).not.toContain(jobId);
  expect(html).not.toContain(workspace.accountId);
  expect(html).not.toContain("Rotation source");
  await page.reload();
  await page.getByRole("button", { name: "Resume update", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "No secure access updates are waiting." })).toBeVisible();
  // Routine owned-key provisioning after cutover must reopen the new installed
  // root epoch rather than silently restoring old epoch-1 material.
  await workspace.db
    .prepare(`INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, created_at, updated_at)
    SELECT ?, account_id, id, 'enrollment_owned', 'pending', 2, 2 FROM encryption_devices
    WHERE account_id = ? AND state = 'active' LIMIT 1`)
    .bind(objectId(), workspace.accountId)
    .run();
  await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
  expect(await page.evaluate(() => window.workspaceFixture.resumeOwnedProvisioning())).toBe(true);
  await page.goto(`/f/${workspace.fileId}`);
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
    "# Rotation source\n\nDownloaded copies cannot be recalled.",
  );
  await page.getByRole("textbox", { name: "Markdown source", exact: true }).fill("# Safe future write");
  await expect(page.getByRole("status", { name: "File save status" })).toHaveText("Saved");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue("# Safe future write");
  await page
    .getByRole("complementary", { name: "Files tree", exact: true })
    .getByRole("link", { name: "Files", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/d/${workspace.rootId}$`));
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create a name" });
  await create.getByRole("textbox", { name: "Name", exact: true }).fill("After rotation");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "After rotation", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Files", exact: true })
    .getByRole("link", { name: "Draft.md", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/f/${workspace.fileId}$`));
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move", exact: true });
  await move.getByRole("textbox", { name: "Name", exact: true }).fill("moved.md");
  await move.getByRole("button", { name: "Open destination After rotation", exact: true }).click();
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("heading", { name: "moved.md", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue("# Safe future write");
});
