import { test, expect } from "./workspace-fixture";
import {
  enroll,
  expectCommentKeys,
  expectPending,
  loadFixture,
  manualPass,
  provisioningNext,
  recover,
  shareWithComments,
  sharedMarkdown,
  seededAccount,
} from "./support/provisioning-fixtures";

test.setTimeout(240_000);
test.use({ initialSource: sharedMarkdown });

test("routine enrollment waits for a recipient holder; bounded forwarding retries identical ciphertext and resumes Comments", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.route(provisioningNext, (route) => route.abort());
  const original = await seededAccount(browser, server, origin, workspaceScript);
  let candidate: Awaited<ReturnType<typeof enroll>> | undefined;
  try {
    const share = await shareWithComments(page, original, workspace);
    await original.page.goto(`${origin}/f/${workspace.fileId}`);
    await expect(original.page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
      sharedMarkdown,
    );
    candidate = await enroll(browser, original, origin, workspaceScript);
    await expectPending(candidate.page, origin, workspace.fileId, share.fragment);
    const own = await candidate.page.evaluate(async () => {
      const api = window.workspaceFixture,
        root = await api.openRoot();
      const directory = await api.loadDirectory(root, root.rootId, root.rootKey);
      return { rootId: root.rootId, entries: directory.entries.length };
    });
    expect(own.rootId).not.toBe(workspace.rootId);
    expect(own.entries).toBe(0);
    for (const objectId of share.comments)
      expect(
        await candidate.page.evaluate(
          async ({ grantId, objectId }) =>
            (
              await window.workspaceFixture.privateRequest(`/api/private/grants/${grantId}/comment-keys/${objectId}`, {
                method: "POST",
              })
            ).status,
          { grantId: share.grantId, objectId },
        ),
      ).toBe(409);

    await original.page.unroute(provisioningNext);
    const bodies: string[] = [];
    await original.page.route(`**/api/private/grants/${share.grantId}/keys`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      bodies.push(route.request().postData()!);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (bodies.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    const first = await original.page.evaluate(() => window.workspaceFixture.resumeGrantProvisioning({ maxSteps: 1 }));
    expect(first).toMatchObject({ complete: false, processed: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    // This Owner has no Comment recovery source. Root coverage must not
    // misreport missing private/public Comment history as fulfilled.
    await page.unroute(provisioningNext);
    expect(
      await page.evaluate(async () =>
        (
          await window.workspaceFixture.privateRequest("/api/private/grant-provisioning/next", { method: "POST" })
        ).json(),
      ),
    ).toEqual({ item: null, pending: false });
    await candidate.page.unroute(provisioningNext);
    expect(
      await candidate.page.evaluate(async () =>
        (
          await window.workspaceFixture.privateRequest("/api/private/grant-provisioning/next", { method: "POST" })
        ).json(),
      ),
    ).toEqual({ item: null, pending: true });
    await page.route(provisioningNext, (route) => route.abort());
    // A new document must resume from server coverage, not an in-memory cursor.
    await original.page.reload();
    await loadFixture(original.page);
    const rest = await original.page.evaluate(() => window.workspaceFixture.resumeGrantProvisioning());
    expect(rest).toMatchObject({ complete: true, pending: false, processed: 3 });
    await page.reload();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/private/tree/files/${workspace.fileId}`,
    );
    await page.getByRole("textbox", { name: "Markdown source", exact: true }).fill("# Current shared File");
    expect((await saved).status()).toBe(200);
    await candidate.page.reload();
    await expect(candidate.page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
      "# Current shared File",
    );
    await expectCommentKeys(candidate.page, share.grantId, share.comments);
  } finally {
    await candidate?.context.close();
    await original.context.close();
  }
});

test("Vault recovery restores only owned Files; the Owner fulfills shared root and retained Comment history", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.route(provisioningNext, (route) => route.abort());
  const original = await seededAccount(browser, server, origin, workspaceScript);
  let replacement: Awaited<ReturnType<typeof recover>> | undefined;
  try {
    const share = await shareWithComments(page, original, workspace, { ownerRecovery: true });
    await expectCommentKeys(original.page, share.grantId, share.comments);
    replacement = await recover(browser, original, origin, workspaceScript);
    await expectPending(replacement.page, origin, workspace.fileId, share.fragment);
    for (const objectId of share.comments)
      expect(
        await replacement.page.evaluate(
          async ({ grantId, objectId }) =>
            (
              await window.workspaceFixture.privateRequest(`/api/private/grants/${grantId}/comment-keys/${objectId}`, {
                method: "POST",
              })
            ).status,
          { grantId: share.grantId, objectId },
        ),
      ).toBe(409);
    expect(
      await replacement.page.evaluate(async () => {
        const response = await window.workspaceFixture.privateRequest("/api/private/recovery-provision/next", {
          method: "POST",
        });
        return response.json();
      }),
    ).toMatchObject({ state: "complete", item: null });
    await page.unroute(provisioningNext);
    await manualPass(page, origin);
    await replacement.page.getByRole("button", { name: "Check shared access", exact: true }).click();
    await expect(replacement.page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
      sharedMarkdown,
    );
    await expectCommentKeys(replacement.page, share.grantId, share.comments);
  } finally {
    await replacement?.context.close();
    await original.context.close();
  }
});

test("revocation rejects a prepared upload after recovery and never resurrects the shared File", async ({
  browser,
  page,
  workspace,
  workspaceScript,
  baseURL,
  server,
}) => {
  const origin = new URL(baseURL!).origin;
  await page.route(provisioningNext, (route) => route.abort());
  const original = await seededAccount(browser, server, origin, workspaceScript);
  let replacement: Awaited<ReturnType<typeof recover>> | undefined;
  let release: (() => void) | undefined;
  try {
    const share = await shareWithComments(page, original, workspace, { ownerRecovery: true });
    replacement = await recover(browser, original, origin, workspaceScript);
    await expectPending(replacement.page, origin, workspace.fileId, share.fragment);
    await page.unroute(provisioningNext);
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let prepared!: () => void;
    const ready = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let uploadStatus = 0;
    await page.route(`**/api/private/grants/${share.grantId}/keys`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      prepared();
      await held;
      const response = await route.fetch();
      uploadStatus = response.status();
      await route.fulfill({ response });
    });
    await loadFixture(page);
    const pass = page.evaluate(async () => {
      try {
        await window.workspaceFixture.resumeGrantProvisioning({ maxSteps: 1 });
        return "unexpected success";
      } catch {
        return "changed";
      }
    });
    await ready;
    expect(
      await page.evaluate(
        async (grantId) =>
          (
            await window.workspaceFixture.privateRequest(`/api/private/grants/${grantId}`, {
              method: "DELETE",
              body: JSON.stringify({ expectedRevision: 1 }),
            })
          ).status,
        share.grantId,
      ),
    ).toBe(200);
    release!();
    expect(await pass).toBe("changed");
    expect([404, 409]).toContain(uploadStatus);
    await replacement.page.reload();
    await expect(replacement.page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
    await expect(replacement.page.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveCount(0);
    await expect(replacement.page.getByText("Draft.md", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(async () =>
        (
          await window.workspaceFixture.privateRequest("/api/private/grant-provisioning/next", { method: "POST" })
        ).json(),
      ),
    ).toEqual({ item: null, pending: false });
  } finally {
    release?.();
    await replacement?.context.close();
    await original.context.close();
  }
});
