import type { Page } from "@playwright/test";

import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";

type CommitAcknowledgment =
  | "lost"
  | "malformed"
  | "null"
  | "unavailable"
  | "timeout"
  | "rate-limited"
  | "acknowledged"
  | "lose-once";

/** Control only the acknowledgment after a real Worker commit. Optional holding
 * deliberately ignores abort: client cancellation cannot undo this commit. */
async function controlCommitAcknowledgments(page: Page, acknowledgment: CommitAcknowledgment, hold = false) {
  return page.evaluateHandle(
    ({ acknowledgment, hold }) => {
      const fetch = window.fetch.bind(window);
      const replies: unknown[] = [];
      let entered!: () => void;
      let release!: () => void;
      let signal: AbortSignal | null = null;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      window.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.origin,
        );
        const response = await fetch(input, init);
        if (/\/api\/private\/imports\/[^/]+\/commit$/.test(url.pathname) && response.ok) {
          const body = await response.clone().json();
          if (!body || typeof body !== "object" || !("committed" in body) || body.committed !== true) {
            throw new Error("Expected a real committed Import");
          }
          replies.push(body);
          response.json = async () => body;
          if (hold) {
            signal = init?.signal ?? (input instanceof Request ? input.signal : null);
            entered();
            await held;
          }
          if (acknowledgment === "malformed") {
            return new Response("{", { headers: { "Content-Type": "application/json" } });
          }
          if (acknowledgment === "null") return Response.json(null);
          if (acknowledgment === "unavailable") return new Response("unavailable", { status: 503 });
          if (acknowledgment === "timeout") return new Response("upstream timed out", { status: 408 });
          if (acknowledgment === "rate-limited") return new Response("upstream rate limit", { status: 429 });
          if (acknowledgment === "lost" || (acknowledgment === "lose-once" && replies.length === 1)) {
            throw new TypeError("commit acknowledgment lost");
          }
        }
        return response;
      };
      return { reached, release, replies, aborted: () => signal?.aborted ?? false };
    },
    { acknowledgment, hold },
  );
}

for (const acknowledgment of ["lost", "malformed", "null", "unavailable", "timeout", "rate-limited"] as const) {
  test(`${acknowledgment} commit acknowledgments refresh Files but leave the Import outcome unconfirmed`, async ({
    page,
    workspace,
  }) => {
    const writes: { method: string; path: string }[] = [];
    let targetRefreshes = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/private/imports")) writes.push({ method: request.method(), path });
      if (path === `/api/private/tree/directories/${workspace.rootId}`) targetRefreshes += 1;
    });
    // Neither encryption nor D1 is mocked. The fetch wrapper remains installed
    // after its observation handle is disposed.
    const controlled = await controlCommitAcknowledgments(page, acknowledgment);
    await controlled.dispose();

    await page.getByTestId("import-files-input").setInputFiles({
      name: "uncertain.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Uncertain\n"),
    });
    await page.getByTestId("import-confirm").click();

    const dialog = page.getByRole("dialog", { name: "Import review" });
    await expect(dialog).toContainText("may have committed");
    await expect(page.getByTestId("import-unconfirmed")).toContainText("Check the latest Files");
    await expect(page.getByTestId("import-unconfirmed")).toContainText("before starting another Import");
    await expect(page.getByTestId("import-complete")).toHaveCount(0);
    await expect(page.getByTestId("import-error")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "uncertain.md", exact: true })).toBeVisible();
    await waitForSharedProvisioning(page);
    expect(targetRefreshes).toBe(1);
    expect(writes.map((write) => write.method)).toEqual(
      acknowledgment === "lost" ? ["POST", "PUT", "POST", "POST", "DELETE"] : ["POST", "PUT", "POST", "DELETE"],
    );
    const commits = writes.filter((write) => write.path.endsWith("/commit"));
    expect(new Set(commits.map((commit) => commit.path)).size).toBe(1);
    // Seeing the committed File does not turn the unconfirmed attempt into success.
    await expect(page.getByTestId("import-unconfirmed")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(acknowledgment === "lost" ? 5 : 4);
  });
}

test("an explicit authority rejection requires a fresh review, not an unconfirmed outcome", async ({
  page,
  workspace,
}) => {
  let opened = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/private/imports") opened += 1;
  });
  // Revoke at the external storage boundary after signing but before the
  // real Worker authorizes commit. Its 403 is an explicit rejection.
  await page.route("**/api/private/imports/*/commit", async (route) => {
    await workspace.db
      .prepare("UPDATE encryption_devices SET state = 'revoked' WHERE account_id = ?")
      .bind(workspace.accountId)
      .run();
    await route.continue();
  });
  await page.getByTestId("import-files-input").setInputFiles({
    name: "denied.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Denied\n"),
  });
  await page.getByTestId("import-confirm").click();

  await expect(page.getByTestId("import-error")).toContainText("Refresh the folder, review again");
  await expect(page.getByTestId("import-unconfirmed")).toHaveCount(0);
  await expect(page.getByTestId("import-complete")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "denied.md", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(opened).toBe(1);
});

for (const rejection of ["conflict", "expiry"] as const) {
  test(`an explicit ${rejection} rejection preserves fresh-review guidance`, async ({ page, workspace }) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/private/imports")) writes.push(request.method());
    });
    await page.route("**/api/private/imports/*/commit", async (route) => {
      if (rejection === "conflict") {
        await workspace.db
          .prepare("UPDATE directories SET entries_revision = entries_revision + 1 WHERE node_id = ?")
          .bind(workspace.rootId)
          .run();
      } else {
        const importId = new URL(route.request().url()).pathname.split("/").at(-2)!;
        await workspace.db
          .prepare("UPDATE import_sessions SET expires_at = created_at + 1 WHERE id = ?")
          .bind(importId)
          .run();
      }
      await route.continue();
    });
    await page.getByTestId("import-files-input").setInputFiles({
      name: "rejected.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Rejected\n"),
    });
    await page.getByTestId("import-confirm").click();

    await expect(page.getByTestId("import-error")).toContainText(
      rejection === "conflict" ? "Refresh the folder, review again" : "expired before it committed",
    );
    await expect(page.getByTestId("import-unconfirmed")).toHaveCount(0);
    await expect(page.getByTestId("import-complete")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "rejected.md", exact: true })).toHaveCount(0);
    expect(writes).toEqual(["POST", "PUT", "POST", "DELETE"]);
  });
}

for (const acknowledgment of ["lost", "acknowledged"] as const) {
  test(`a commit winning cancellation with its ${acknowledgment} response is classified from evidence`, async ({
    page,
    workspace,
  }) => {
    const held = await controlCommitAcknowledgments(page, acknowledgment, true);
    const writes: string[] = [];
    let targetRefreshes = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/private/imports")) writes.push(request.method());
      if (path === `/api/private/tree/directories/${workspace.rootId}`) targetRefreshes += 1;
    });
    try {
      await page.getByTestId("import-files-input").setInputFiles({
        name: "race.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Race\n"),
      });
      await page.getByTestId("import-confirm").click();
      await held.evaluate((gate) => gate.reached);
      await page.getByTestId("import-cancel-upload").click();
      expect(await held.evaluate((gate) => gate.aborted())).toBe(true);
      await held.evaluate((gate) => gate.release());

      if (acknowledgment === "lost") {
        await expect(page.getByTestId("import-unconfirmed")).toContainText("may have committed");
        await expect(page.getByTestId("import-complete")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("import-complete")).toContainText("Added 1 item");
        await expect(page.getByTestId("import-unconfirmed")).toHaveCount(0);
      }
      await expect(page.getByRole("link", { name: "race.md", exact: true })).toBeVisible();
      await waitForSharedProvisioning(page);
      expect(targetRefreshes).toBe(1);
      expect(writes).toEqual(acknowledgment === "lost" ? ["POST", "PUT", "POST", "DELETE"] : ["POST", "PUT", "POST"]);
    } finally {
      await held.evaluate((gate) => gate.release());
      await held.dispose();
    }
  });
}

test("an idempotent acknowledgment without a listing revision succeeds and refreshes Files", async ({
  page,
  workspace,
}) => {
  let targetRefreshes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/private/tree/directories/${workspace.rootId}`) targetRefreshes += 1;
  });
  const acknowledgments = await controlCommitAcknowledgments(page, "lose-once");
  try {
    await page.getByTestId("import-files-input").setInputFiles({
      name: "acknowledged.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Acknowledged\n"),
    });
    await page.getByTestId("import-confirm").click();

    await expect(page.getByTestId("import-complete")).toContainText("Added 1 item");
    await expect(page.getByTestId("import-unconfirmed")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "acknowledged.md", exact: true })).toBeVisible();
    await waitForSharedProvisioning(page);
    expect(targetRefreshes).toBe(1);
    const replies = await acknowledgments.evaluate((transport) => transport.replies);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toMatchObject({ committed: true, alreadyCommitted: true });
    expect(replies[1]).not.toHaveProperty("entriesRevision");
  } finally {
    await acknowledgments.dispose();
  }
});

test("a disposed unconfirmed attempt cannot refresh or replace a newer view", async ({ page, workspace }) => {
  const held = await controlCommitAcknowledgments(page, "lost", true);
  let targetRefreshes = 0;
  const writes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/private/imports")) writes.push(request.method());
  });
  try {
    await page.getByTestId("import-files-input").setInputFiles({
      name: "disposed.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Disposed\n"),
    });
    await page.getByTestId("import-confirm").click();
    await held.evaluate((gate) => gate.reached);
    await page
      .getByRole("navigation", { name: "Breadcrumbs" })
      .getByRole("link", { name: "Library", exact: true })
      .press("Enter");
    await expect(page).toHaveURL(/\/files$/);
    await waitForSharedProvisioning(page);
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/private/tree/directories/${workspace.rootId}`) targetRefreshes += 1;
    });
    await page.getByTestId("import-files-input").setInputFiles({
      name: "new-review.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# New review\n"),
    });
    await expect(page.getByTestId("import-summary-sources")).toHaveText("1");
    const cleanup = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname.startsWith("/api/private/imports/"),
    );
    expect(await held.evaluate((gate) => gate.aborted())).toBe(true);
    await held.evaluate((gate) => gate.release());
    await cleanup;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    await expect(page.getByTestId("import-summary-sources")).toHaveText("1");
    await expect(page.getByTestId("import-unconfirmed")).toHaveCount(0);
    await expect(page.getByTestId("import-complete")).toHaveCount(0);
    expect(targetRefreshes).toBe(0);
    expect(writes).toEqual(["POST", "PUT", "POST", "DELETE"]);
  } finally {
    await held.evaluate((gate) => gate.release());
    await held.dispose();
  }
});
