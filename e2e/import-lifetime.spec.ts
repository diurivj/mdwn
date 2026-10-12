import type { Page, Response } from "@playwright/test";

import { test, expect } from "./workspace-fixture";
import { waitForSharedProvisioning } from "./support/navigation";

type HeldStage = "preparation" | "opening" | "upload" | "commit";

function isImportCleanup(response: Response): boolean {
  return (
    response.request().method() === "DELETE" && new URL(response.url()).pathname.startsWith("/api/private/imports/")
  );
}

/** Hold a real final browser calculation or a real Worker acknowledgment. The
 * transport deliberately delivers its late response even after abort: stopping
 * later stages and callbacks must not depend on fetch honoring the signal. */
async function holdImportStage(page: Page, stage: HeldStage) {
  if (stage === "preparation") {
    // The workspace seed's script was installed before its full-document open.
    await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
  }
  return page.evaluateHandle((stage) => {
    const fetch = window.fetch.bind(window);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const requests: { method: string; path: string }[] = [];
    let captured = false;
    let observing = false;
    let signal: AbortSignal | null = null;
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    if (stage === "preparation") {
      crypto.subtle.digest = async (algorithm, data) => {
        const result = await digest(algorithm, data);
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        let manifest = false;
        try {
          manifest = window.workspaceFixture.inspectEnvelope(bytes).context.purpose === "import-staging-manifest";
        } catch {
          // Other SHA-256 inputs need not be enc-v1 envelopes.
        }
        if (!captured && manifest) {
          captured = true;
          reached();
          await held;
        }
        return result;
      };
    }

    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        location.origin,
      );
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (observing) requests.push({ method, path: url.pathname });
      const response = await fetch(input, init);
      const matches =
        stage === "opening"
          ? method === "POST" && url.pathname === "/api/private/imports"
          : stage === "upload"
            ? method === "PUT" && /\/api\/private\/imports\/[^/]+\/chunks\/0$/.test(url.pathname)
            : stage === "commit" && method === "POST" && /\/api\/private\/imports\/[^/]+\/commit$/.test(url.pathname);
      if (!captured && matches) {
        captured = true;
        signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        // Settle body reading before holding the acknowledgment, so release
        // drains only promise continuations, not another network response.
        const body = await response.clone().json();
        response.json = async () => body;
        reached();
        await held;
      }
      return response;
    };

    return {
      entered,
      requests,
      aborted: () => signal?.aborted ?? false,
      release: () => {
        observing = true;
        release();
      },
    };
  }, stage);
}

async function releaseStage(held: Awaited<ReturnType<typeof holdImportStage>>) {
  await held.evaluate(async (gate) => {
    gate.release();
    // Yield a render turn after the held, already-settled calculation/response.
    // Its promise continuations (and any improper refresh) run before this.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

for (const stage of ["preparation", "opening", "upload", "commit"] as const) {
  test(`route disposal during Import ${stage} stops later work and excludes late refresh`, async ({
    page,
    workspace,
  }) => {
    expect(workspace.rootId).toBeTruthy();
    const writes: { method: string; path: string }[] = [];
    const cleanups: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/private/imports")) writes.push({ method: request.method(), path });
    });
    page.on("response", (response) => {
      if (isImportCleanup(response)) cleanups.push(response.url());
    });
    const held = await holdImportStage(page, stage);
    try {
      await page.getByTestId("import-files-input").setInputFiles({
        name: "abandoned.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Abandoned\n"),
      });
      await page.getByTestId("import-confirm").click();
      await held.evaluate((gate) => gate.entered);
      // Activate the real in-app link with the keyboard despite the modal's
      // pointer overlay; this is an SPA disposal, not a document reload.
      await page
        .getByRole("navigation", { name: "Breadcrumbs" })
        .getByRole("link", { name: "Library", exact: true })
        .press("Enter");
      await expect(page).toHaveURL(/\/files$/);
      await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
      await waitForSharedProvisioning(page);
      // A new view can already review a new selection before the old result arrives.
      await page.getByTestId("import-files-input").setInputFiles({
        name: "new-selection.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# New selection\n"),
      });
      await expect(page.getByTestId("import-summary-sources")).toHaveText("1");
      await releaseStage(held);

      if (stage === "preparation" || stage === "commit") {
        // No staging from discarded preparation; no global router refresh from
        // a disposed attempt whose real commit acknowledgment arrived late.
        expect(await held.evaluate((gate) => gate.requests)).toEqual([]);
        expect(writes.map((write) => write.method)).toEqual(stage === "preparation" ? [] : ["POST", "PUT", "POST"]);
      } else {
        expect(await held.evaluate((gate) => gate.aborted())).toBe(true);
        await expect.poll(() => cleanups.length).toBe(1);
        expect(writes.map((write) => write.method)).toEqual(
          stage === "opening" ? ["POST", "DELETE"] : ["POST", "PUT", "DELETE"],
        );
      }
      await expect(page.getByTestId("import-summary-sources")).toHaveText("1");
      await expect(page.getByTestId("import-complete")).toHaveCount(0);
    } finally {
      await releaseStage(held);
      await held.dispose();
    }
  });
}

test("a superseded attempt cannot clear the new attempt's success", async ({ page, workspace: _workspace }) => {
  const held = await holdImportStage(page, "opening");
  let cleanups = 0;
  page.on("response", (response) => {
    if (isImportCleanup(response)) cleanups += 1;
  });
  try {
    await page.getByTestId("import-files-input").setInputFiles({
      name: "old-selection.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Old\n"),
    });
    await page.getByTestId("import-confirm").click();
    await held.evaluate((gate) => gate.entered);
    await page.getByTestId("import-files-input").setInputFiles([
      { name: "new-a.md", mimeType: "text/markdown", buffer: Buffer.from("# New A\n") },
      { name: "new-b.md", mimeType: "text/markdown", buffer: Buffer.from("# New B\n") },
    ]);
    await expect(page.getByTestId("import-summary-sources")).toHaveText("2");
    await page.getByTestId("import-confirm").click();
    await expect(page.getByTestId("import-complete")).toContainText("Added 2 items");
    await waitForSharedProvisioning(page);
    await releaseStage(held);
    expect(await held.evaluate((gate) => gate.aborted())).toBe(true);
    await expect.poll(() => cleanups).toBe(1);
    await expect(page.getByTestId("import-complete")).toContainText("Added 2 items");
    await expect(page.getByTestId("import-error")).toHaveCount(0);
  } finally {
    await releaseStage(held);
    await held.dispose();
  }
});

test("the person can cancel encrypted preparation before any staging begins", async ({
  page,
  workspace: _workspace,
}) => {
  const held = await holdImportStage(page, "preparation");
  try {
    await page.getByTestId("import-files-input").setInputFiles({
      name: "cancelled.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Cancelled\n"),
    });
    await page.getByTestId("import-confirm").click();
    await held.evaluate((gate) => gate.entered);
    await expect(page.getByTestId("import-cancel-upload")).toBeVisible();
    await page.getByTestId("import-cancel-upload").click();
    await releaseStage(held);
    await expect(page.getByRole("dialog", { name: "Import review" })).toHaveCount(0);
    expect(await held.evaluate((gate) => gate.requests)).toEqual([]);
  } finally {
    await releaseStage(held);
    await held.dispose();
  }
});
