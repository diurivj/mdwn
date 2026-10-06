import type { Request } from "@playwright/test";
import { objectId, test, expect } from "./workspace-fixture";

test.use({ initialSource: "# Public plan\n\nBody text." });

function sent(request: Request): string {
  const url = new URL(request.url());
  url.hash = "";
  return [url.href, JSON.stringify(request.headers()), request.postData() ?? ""].join("\n");
}

test("public readers decrypt public comments, signed-in visitors post, and the audience can be closed", async ({
  browser,
  page,
  workspace,
}) => {
  // The Owner publishes with the default public Comments audience.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publishPanel = page.getByRole("region", { name: "Publish", exact: true });
  await expect(publishPanel.getByText("Comments audience")).toBeVisible();
  await publishPanel.getByRole("button", { name: "Publish File" }).click();
  await expect(publishPanel.getByText(/^Published\./)).toBeVisible();
  const link = await publishPanel.getByLabel("Public link").inputValue();
  const fragment = new URL(link).hash.slice(1);

  // An anonymous reader sees the Public Comment section and may not post.
  const readerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const reader = await readerContext.newPage();
    await reader.goto(link);
    const section = reader.getByRole("region", { name: "Public comments", exact: true });
    await expect(section.getByText("No comments yet.")).toBeVisible();
    await expect(section.getByText("Sign in to add a comment.", { exact: false })).toBeVisible();
    await expect(section.getByLabel("Add a public comment")).toHaveCount(0);

    // The signed-in Owner opens the same complete link and posts with the
    // fragment capability held locally and a device-bound Session.
    const ownerTab = await page.context().newPage();
    const ownerRequests: Request[] = [];
    ownerTab.on("request", (request) => ownerRequests.push(request));
    await ownerTab.goto(link);
    const ownerSection = ownerTab.getByRole("region", { name: "Public comments", exact: true });
    await ownerSection.getByLabel("Add a public comment").fill("Hello from the public page");
    await ownerSection.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(ownerSection.getByText("Hello from the public page")).toBeVisible();
    await expect(ownerSection.getByText("Member Test")).toBeVisible();
    for (const request of ownerRequests) {
      const wire = sent(request);
      expect(wire).not.toContain(fragment);
    }

    // The anonymous reader decrypts the same Comment locally.
    await reader.reload();
    await expect(section.getByText("Hello from the public page")).toBeVisible();
    await expect(section.getByText("Member Test")).toBeVisible();

    // Closing the audience stops anonymous delivery immediately: the reader
    // sees the settled notice and no thread ciphertext.
    await publishPanel.getByRole("button", { name: "Make comments collaborators only" }).click();
    // Wait for the refreshed panel state, not the action button's own label.
    await expect(publishPanel.getByText("Audience: Collaborators only", { exact: false })).toBeVisible();
    await reader.reload();
    await expect(
      section.getByText("Sign in to see or add comments if you have access to this file.", { exact: false }),
    ).toBeVisible();
    await expect(section.getByText("Hello from the public page")).toHaveCount(0);
    const publicData = await readerContext.request.get(
      `/api/public/publications/${new URL(link).pathname.split("/").pop()}`,
    );
    const anonymousBody = await publicData.text();
    expect(anonymousBody).not.toContain("Hello from the public page");
    await ownerTab.close();

    // The Owner's authenticated workspace still reads retained history through
    // device envelopes, without receiving the fragment.
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await page.getByRole("tab", { name: "Public", exact: true }).click();
    const workspacePublic = page.getByRole("region", { name: "Public comments", exact: true });
    await expect(workspacePublic.getByText("Collaborators only", { exact: false })).toBeVisible();
    await expect(workspacePublic.getByText("Hello from the public page")).toBeVisible();

    // Reopening the audience starts a fresh public epoch; the previously public
    // Comment is not lost, and the Collaborators-only epoch still is not served.
    await publishPanel.getByRole("button", { name: "Make comments public" }).click();
    await expect(publishPanel.getByText("Audience: Public", { exact: false })).toBeVisible();
    await reader.reload();
    await expect(section.getByText("Hello from the public page")).toBeVisible();
  } finally {
    await readerContext.close();
  }
});

test("pages a long authenticated Public thread past the first bounded page", async ({ page, workspace }) => {
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const panel = page.getByRole("region", { name: "Publish", exact: true });
  await panel.getByRole("button", { name: "Publish File" }).click();
  await expect(panel.getByText(/^Published\./)).toBeVisible();
  const thread = await workspace.db
    .prepare(
      "SELECT id AS threadId, current_epoch_id AS epochId FROM comment_threads WHERE file_id = ? AND purpose = 'public'",
    )
    .bind(workspace.fileId)
    .first<{ threadId: string; epochId: string }>();
  expect(thread).not.toBeNull();
  // Fifty opaque rows fill the bounded first page at the storage boundary; the
  // real Comment is the only entry on page two and must decrypt after Load more.
  for (let sequence = 1; sequence <= 50; sequence++) {
    await workspace.db
      .prepare(`INSERT INTO comments (id, thread_id, epoch_id, author_id, sequence, revision,
        body_ciphertext, body_size, content_key_envelope, content_key_epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, X'01', 1, X'01', 1, 1, 1)`)
      .bind(objectId(), thread!.threadId, thread!.epochId, workspace.accountId, sequence)
      .run();
  }
  await workspace.db.prepare("UPDATE comment_threads SET next_sequence = 52 WHERE id = ?").bind(thread!.threadId).run();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  const section = page.getByRole("region", { name: "Public comments", exact: true });
  await expect(section.locator("li")).toHaveCount(50);
  await section.getByLabel("Add a public comment").fill("Second page text");
  await section.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(section.getByLabel("Add a public comment")).toHaveValue("");
  // The 51st Comment exists now: the panel's continuation affordance appears.
  await expect(section.getByRole("button", { name: "Load more comments" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  await expect(section.locator("li")).toHaveCount(50);
  await expect(section.getByText("Second page text")).toHaveCount(0);
  await section.getByRole("button", { name: "Load more comments" }).click();
  await expect(section.locator("li")).toHaveCount(51);
  // The fixed client continuation keeps each epoch's capability identity, so
  // the second page decrypts instead of degrading to display failures.
  await expect(section.getByText("Second page text")).toBeVisible();
  await expect(section.getByRole("button", { name: "Load more comments" })).toHaveCount(0);
});
