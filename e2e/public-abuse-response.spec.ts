import { publishToggle } from "./publish-panel";
import { expect, objectId, test } from "./workspace-fixture";

/**
 * Ticket 26 at the browser boundary: a signed-in Account reports another
 * Account's Public Comment by category only, and a Public-participation
 * suspension pauses posting while unpublishing and its bounded teardown still
 * finish.
 */
test("reports a comment by category and unpublishes while suspended", async ({ page, workspace }) => {
  await publishToggle(page).click();
  const publishPanel = page.getByRole("region", { name: "Publish", exact: true });
  await publishPanel.getByRole("button", { name: "Publish File" }).click();
  await expect(publishPanel.getByRole("heading", { name: "Published", exact: true })).toBeVisible();

  // Post a real Comment through the workspace Public panel.
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  const section = page.getByRole("region", { name: "Public comments", exact: true });
  await section.getByLabel("Add a public comment").fill("Report this one");
  await section.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(section.getByText("Report this one")).toBeVisible();

  // Attribute it to a different Account; the UI never offers a self-report.
  const foreign = objectId(),
    now = Date.now();
  await workspace.db
    .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(foreign, objectId(), now, now)
    .run();
  const commentQuery = workspace.db
    .prepare(`SELECT c.id AS commentId FROM comments c
    JOIN comment_threads t ON t.id = c.thread_id
    WHERE t.file_id = ? AND t.purpose = 'public'`)
    .bind(workspace.fileId);
  await expect
    .poll(async () => (await commentQuery.first<{ commentId: string }>())?.commentId ?? null, { timeout: 10_000 })
    .not.toBeNull();
  const commented = await commentQuery.first<{ commentId: string }>();
  const renamed = await workspace.db
    .prepare("UPDATE comments SET author_id = ? WHERE id = ?")
    .bind(foreign, commented!.commentId)
    .run();
  expect(renamed.meta.changes).toBe(1);

  await page.reload();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("tab", { name: "Public", exact: true }).click();
  await expect(section.getByText("Report this one")).toBeVisible();
  await section.getByRole("button", { name: "Report", exact: true }).click();
  await section.getByLabel("Spam or advertising").check();
  await section.getByRole("button", { name: "Send report", exact: true }).click();
  await expect(section.getByText("Report received.")).toBeVisible();

  await expect
    .poll(
      async () =>
        (await workspace.db
          .prepare("SELECT reporter_id, category FROM public_comment_reports")
          .first<{ reporter_id: string; category: string }>()) ?? null,
    )
    .toMatchObject({ reporter_id: workspace.accountId, category: "spam" });
  // The operator applies a suspension at the fixed metadata boundary.
  await workspace.db
    .prepare(`INSERT INTO public_participation_suspensions
      (account_id, strike_count, reason, started_at, expires_at, updated_at)
    VALUES (?, 1, 'report_pattern', ?, ?, ?)`)
    .bind(workspace.accountId, now, now + 7 * 86_400_000, now)
    .run();

  await section.getByLabel("Add a public comment").fill("Blocked while suspended");
  await section.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(section.getByText(/public participation is suspended/i)).toBeVisible();
  await expect(section.getByText(/it ends automatically on/i)).toBeVisible();
  expect(
    await workspace.db
      .prepare(`SELECT count(*) AS n FROM comments
    WHERE thread_id = (SELECT id FROM comment_threads WHERE file_id = ? AND purpose = 'public')`)
      .bind(workspace.fileId)
      .first<{ n: number }>(),
  ).toMatchObject({ n: 1 });

  // Unpublish is never blocked; the seal counts the Comment and the Owner's
  // bounded teardown removes it and the report with it.
  if (!(await publishPanel.isVisible())) await publishToggle(page).click();
  await publishPanel.getByRole("button", { name: "Unpublish…", exact: true }).click();
  await publishPanel.getByRole("button", { name: "Unpublish and permanently delete 1 Public Comment" }).click();
  // The Owner's browser drives the bounded teardown to completion and the panel
  // returns to the unpublished form; the report disappears with its Comment.
  await expect(publishPanel.getByRole("button", { name: "Publish File" })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await workspace.db.prepare("SELECT count(*) AS n FROM public_comment_reports").first<{ n: number }>())?.n,
      { timeout: 10_000 },
    )
    .toBe(0);
});
