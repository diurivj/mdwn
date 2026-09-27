import { createHash } from "node:crypto";
import { test, expect } from "./fixtures";
import { accountShareId, addSecondDevice, inviteFromCurrentPage, openEditor } from "./sharing-browser.fixture";

const DIRECTORY_MARKDOWN = "DIRECTORY_CONTENT_THAT_MUST_STAY_ENCRYPTED";
const DIRECT_MARKDOWN = "DIRECT_FILE_CONTENT_THAT_MUST_STAY_ENCRYPTED";
const COLLABORATOR_MARKDOWN = "COLLABORATOR_CONTENT_OWNED_BY_THE_OWNER";

test.setTimeout(360_000);
test.use({ trace: "off", screenshot: "off", video: "off" });

type TestEnv = { DB: D1Database };
type FileState = { revision: number; representationId: string; contentKeyId: string; contentEpoch: number;
  recipientSetVersion: number; representationDigest: string; representationCount: number };

async function fileState(db: D1Database, fileId: string): Promise<FileState> {
  const row = await db.prepare(`SELECT f.current_revision AS revision,
    f.current_representation_id AS representationId, h.content_key_id AS contentKeyId,
    h.content_epoch AS contentEpoch, h.recipient_set_version AS recipientSetVersion,
    r.ciphertext AS ciphertext, (SELECT COUNT(*) FROM file_representations all_reps
      WHERE all_reps.file_node_id = f.node_id) AS representationCount
    FROM files f JOIN file_heads h ON h.file_node_id = f.node_id AND h.owner_id = f.owner_id
    JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id
    WHERE f.node_id = ?`).bind(fileId).first<Omit<FileState, "representationDigest"> & { ciphertext: ArrayBuffer }>();
  if (!row) throw new Error("Expected the File to have one current representation");
  return { revision: row.revision, representationId: row.representationId, contentKeyId: row.contentKeyId,
    contentEpoch: row.contentEpoch, recipientSetVersion: row.recipientSetVersion,
    representationDigest: createHash("sha256").update(new Uint8Array(row.ciphertext)).digest("hex"),
    representationCount: row.representationCount };
}

async function createFolder(page: import("@playwright/test").Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function createFile(page: import("@playwright/test").Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New File", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a name" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

function invitationRow(page: import("@playwright/test").Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..");
}

test("Owner-offline invitations keep an unprovisioned device nameless and allow signed, same-revision File provisioning", async ({
  browser, server, baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const owner = await openEditor(browser, server, baseURL!, "OwnerSeed.md");
  const recipient = await openEditor(browser, server, baseURL!, "RecipientPrivate.md");
  let secondDevice: { context: import("@playwright/test").BrowserContext; deviceId: string } | undefined;
  try {
    const env = await server.getWorker<TestEnv>().getEnv();
    const recipientShareId = await accountShareId(server, recipient.accountId);

    const directEditor = owner.page.getByRole("textbox", { name: "Markdown source" });
    await directEditor.fill(DIRECT_MARKDOWN);
    await expect(owner.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });

    await owner.page.goto(`${origin}/d/${owner.rootId}`);
    const directoryId = await createFolder(owner.page, "Research");
    await createFile(owner.page, "Directory.md");
    const directoryEditor = owner.page.getByRole("textbox", { name: "Markdown source" });
    await directoryEditor.fill(DIRECTORY_MARKDOWN);
    await expect(owner.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });

    await owner.page.goto(`${origin}/d/${directoryId}`);
    const directoryShareId = await inviteFromCurrentPage(owner.page, recipientShareId, "read_write");
    await owner.page.goto(`${origin}/f/${owner.fileId}`);
    const directShareId = await inviteFromCurrentPage(owner.page, recipientShareId, "read_only");

    // Both actual Owner-signed offers and their encrypted per-device material are
    // committed before the Owner loses all network access.
    await owner.context.setOffline(true);
    secondDevice = await addSecondDevice(browser, baseURL!, server, recipient);

    await recipient.page.goto(`${origin}/d/${recipient.rootId}`);
    await expect(recipient.page.getByRole("region", { name: "Invitations" })).toBeVisible();
    const directoryAcceptance = recipient.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/private/sharing/shares/${directoryShareId}/accept`);
    await invitationRow(recipient.page, "Invitation to a folder (read/write)")
      .getByRole("button", { name: "Accept", exact: true }).click();
    const directoryAccepted = await directoryAcceptance;
    expect(directoryAccepted.status()).toBe(200);
    expect(await directoryAccepted.json()).toMatchObject({ status: "ready" });

    // The second real device is active but was not present when the Owner sealed
    // either offer. The current Worker response withholds the label and capability;
    // the browser must not infer a name from the opaque target or historical offer.
    const secondPage = await secondDevice.context.newPage();
    try {
      await secondPage.goto(`${origin}/d/${recipient.rootId}`);
      await expect(secondPage.getByText("Shared content is being securely provisioned", { exact: true }))
        .toBeVisible({ timeout: 30_000 });
      await expect(secondPage.getByRole("link", { name: "Research (Shared as)", exact: true })).toHaveCount(0);
      await expect(secondPage.getByText("Directory.md", { exact: true })).toHaveCount(0);
      await expect(secondPage.getByText(DIRECTORY_MARKDOWN, { exact: true })).toHaveCount(0);
    } finally {
      await secondPage.close();
    }

    const directoryLink = recipient.page.getByRole("link", { name: "Research (Shared as)", exact: true });
    await expect(directoryLink).toBeVisible({ timeout: 30_000 });
    await directoryLink.click();
    await expect(recipient.page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await recipient.page.getByRole("link", { name: "Directory.md", exact: true }).click();
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" })).toHaveValue(DIRECTORY_MARKDOWN);

    // The acting Collaborator creates a child inside the granted Directory. The
    // Owner, not the actor, remains its D1 owner; the actual Collaborator device
    // signs the structural listing and the Owner can later decrypt/read the File.
    await recipient.page.goto(`${origin}/d/${directoryId}`);
    const collaboratorFileId = await createFile(recipient.page, "Collaborator note.md");
    await recipient.page.getByRole("textbox", { name: "Markdown source" }).fill(COLLABORATOR_MARKDOWN);
    await expect(recipient.page.getByRole("status", { name: "Save status" })).toHaveText("Saved", { timeout: 30_000 });
    const childOwner = await env.DB.prepare("SELECT owner_id FROM vault_nodes WHERE id = ?")
      .bind(collaboratorFileId).first<{ owner_id: string }>();
    const listingSigner = await env.DB.prepare("SELECT listing_device_id FROM directories WHERE node_id = ?")
      .bind(directoryId).first<{ listing_device_id: string }>();
    expect(childOwner?.owner_id).toBe(owner.accountId);
    expect(listingSigner?.listing_device_id).toBe(recipient.deviceId);

    await recipient.page.goto(`${origin}/d/${recipient.rootId}`);
    const directAcceptance = recipient.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/private/sharing/shares/${directShareId}/accept`);
    await invitationRow(recipient.page, "Invitation to a File (read-only)")
      .getByRole("button", { name: "Accept", exact: true }).click();
    const directAccepted = await directAcceptance;
    expect(directAccepted.status()).toBe(200);
    const directGrant = await directAccepted.json() as { grantId: string; status: string };
    expect(directGrant.status).toBe("provisioning");

    const directPaths: string[] = [];
    const observeDirectRequest = (request: import("@playwright/test").Request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/private/")) directPaths.push(path);
    };
    recipient.page.on("request", observeDirectRequest);
    const shellResponse = await recipient.page.request.get(`${origin}/f/${owner.fileId}`);
    expect(shellResponse.status()).toBe(200);
    const shell = await shellResponse.text();
    expect(shell).toContain("Opening Files");
    for (const privateValue of [owner.accountId, owner.deviceId, owner.rootId, owner.fileId,
      recipient.accountId, recipient.deviceId, "OwnerSeed.md", "Renamed owner file.md", "Research",
      "Directory.md", "Collaborator note.md", DIRECT_MARKDOWN, DIRECTORY_MARKDOWN, COLLABORATOR_MARKDOWN,
      "labelCiphertext", "Shared content is being securely provisioned"]) {
      expect(shell).not.toContain(privateValue);
    }

    await recipient.page.goto(`${origin}/f/${owner.fileId}`);
    expect(new URL(recipient.page.url()).pathname).toBe(`/f/${owner.fileId}`);
    await expect(recipient.page.getByText("Shared content is being securely provisioned", { exact: true }))
      .toBeVisible();
    await expect(recipient.page.getByRole("button", { name: "Retry secure access", exact: true })).toBeVisible();
    await expect(recipient.page.getByRole("heading", { name: "OwnerSeed.md", exact: true })).toHaveCount(0);
    expect(directPaths).not.toContain(`/api/private/tree/nodes/${owner.fileId}/ancestors`);

    const beforeCompletion = await fileState(env.DB, owner.fileId);
    const bootstrapWait = recipient.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/private/sharing/direct-files/${owner.fileId}/bootstrap`);
    const completionWait = recipient.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/private/sharing/direct-files/${owner.fileId}/complete`);
    await recipient.page.getByRole("button", { name: "Retry secure access", exact: true }).click();
    const [bootstrapResponse, completionResponse] = await Promise.all([bootstrapWait, completionWait]);
    expect(bootstrapResponse.status()).toBe(200);
    expect(completionResponse.status()).toBe(200);

    const bootstrap = await bootstrapResponse.json() as {
      ownerId: string; fileId: string; currentHead: { digest: string; bytes: string };
      recipients: { accountId: string; deviceId: string; registryEpoch: number; publicKey: string;
        grants: { id: string; generation: number }[] }[];
      retained: { ciphertext: string; contentKeyId: string; contentEpoch: number; revision: number;
        provenance: { grantId: string; offerBytes: string; offerDigest: string; offerSignature: string;
          signerDeviceId: string; signerPublicKey: string } };
    };
    expect(bootstrap).toMatchObject({ ownerId: owner.accountId, fileId: owner.fileId,
      retained: { provenance: { grantId: directGrant.grantId, signerDeviceId: owner.deviceId } } });
    expect(bootstrap.retained.ciphertext).toBeTruthy(); // The retained HPKE envelope, not a plaintext key.
    expect(bootstrap.retained.provenance.offerBytes).toBeTruthy();
    expect(bootstrap.retained.provenance.offerSignature).toBeTruthy();
    expect(bootstrap.recipients.map((item) => item.deviceId).sort()).toEqual(
      [recipient.deviceId, secondDevice.deviceId].sort());
    expect(bootstrap.recipients.every((item) => item.registryEpoch === 2)).toBe(true);
    expect(bootstrapResponse.request().method()).toBe("POST");
    expect(bootstrapResponse.request().postData() ?? "").toBe("");
    const bootstrapProof = JSON.parse(bootstrapResponse.request().headers()["x-mdwn-device-proof"]!) as {
      deviceId: string; registryEpoch: number;
    };
    expect(bootstrapProof).toMatchObject({ deviceId: recipient.deviceId, registryEpoch: 2 });
    expect(bootstrap).not.toHaveProperty("labelCiphertext");
    expect(bootstrap).not.toHaveProperty("ownerCopy");
    expect(bootstrap).not.toHaveProperty("parentId");
    expect(bootstrap).not.toHaveProperty("path");
    expect(bootstrap).not.toHaveProperty("siblings");
    expect(bootstrap.retained.provenance).not.toHaveProperty("labelCiphertext");
    const bootstrapText = JSON.stringify(bootstrap);
    for (const privateValue of [DIRECT_MARKDOWN, DIRECTORY_MARKDOWN, COLLABORATOR_MARKDOWN,
      "OwnerSeed.md", "Research", "Directory.md", "Collaborator note.md"]) {
      expect(bootstrapText).not.toContain(privateValue);
    }

    const completionBody = completionResponse.request().postDataJSON() as {
      expectedHeadDigest: string; expectedRevision: number; expectedRecipientSetVersion: number;
      signedHead: { bytes: string; digest: string; signature: string };
      recipientEnvelopes: { deviceId: string; ciphertext: string }[];
    };
    expect(completionResponse.request().method()).toBe("PATCH");
    expect(Object.keys(completionBody).sort()).toEqual([
      "expectedHeadDigest", "expectedRevision", "expectedRecipientSetVersion", "recipientEnvelopes", "signedHead",
    ].sort());
    expect(completionBody.expectedRevision).toBe(beforeCompletion.revision);
    expect(completionBody.expectedRecipientSetVersion).toBe(beforeCompletion.recipientSetVersion);
    expect(completionBody.recipientEnvelopes.map((item) => item.deviceId).sort()).toEqual(
      [recipient.deviceId, secondDevice.deviceId].sort());
    expect(completionBody.signedHead).toMatchObject({ bytes: expect.any(String), digest: expect.any(String),
      signature: expect.any(String) });
    const completionProof = JSON.parse(completionResponse.request().headers()["x-mdwn-device-proof"]!) as {
      deviceId: string; registryEpoch: number;
    };
    expect(completionProof).toMatchObject({ deviceId: recipient.deviceId, registryEpoch: 2 });
    const completionResponseBody = await completionResponse.json() as Record<string, unknown>;
    expect(Object.keys(completionResponseBody).sort()).toEqual(["headDigest", "status"]);
    expect(completionResponseBody.status).toBe("ready");
    for (const privateValue of [DIRECT_MARKDOWN, DIRECTORY_MARKDOWN, COLLABORATOR_MARKDOWN,
      "OwnerSeed.md", "Research", "Directory.md", "Collaborator note.md"]) {
      expect(JSON.stringify(completionBody)).not.toContain(privateValue);
      expect(JSON.stringify(completionResponseBody)).not.toContain(privateValue);
    }

    await expect(recipient.page.getByRole("heading", { name: "OwnerSeed.md", exact: true })).toBeVisible({ timeout: 30_000 });
    const directFileEditor = recipient.page.getByRole("textbox", { name: "Markdown source" });
    await expect(directFileEditor).toHaveValue(DIRECT_MARKDOWN);
    await expect(directFileEditor).toHaveAttribute("readonly", "");
    const breadcrumbs = recipient.page.getByRole("navigation", { name: "Breadcrumbs" });
    await expect(breadcrumbs.getByRole("link")).toHaveCount(1);
    await expect(breadcrumbs.getByRole("link")).toHaveAttribute("href", `/f/${owner.fileId}`);
    await expect(recipient.page.getByRole("button", { name: /rename|move|import|export/i })).toHaveCount(0);

    const afterCompletion = await fileState(env.DB, owner.fileId);
    expect(afterCompletion).toMatchObject({ revision: beforeCompletion.revision,
      representationId: beforeCompletion.representationId, contentKeyId: beforeCompletion.contentKeyId,
      contentEpoch: beforeCompletion.contentEpoch, recipientSetVersion: beforeCompletion.recipientSetVersion + 1,
      representationDigest: beforeCompletion.representationDigest, representationCount: beforeCompletion.representationCount });
    const completedHead = await env.DB.prepare("SELECT signer_device_id FROM file_heads WHERE file_node_id = ?")
      .bind(owner.fileId).first<{ signer_device_id: string }>();
    expect(completedHead?.signer_device_id).toBe(recipient.deviceId);

    // Reconnect the Owner only after the recipient completed from retained,
    // Owner-signed provenance. The Collaborator's real signed child is visible
    // to its Owner, while the direct File URL and Shared-as label remain stable.
    await owner.context.setOffline(false);
    await owner.page.goto(`${origin}/d/${directoryId}`);
    await expect(owner.page.getByRole("link", { name: "Collaborator note.md", exact: true })).toBeVisible();
    await owner.page.getByRole("link", { name: "Collaborator note.md", exact: true }).click();
    await expect(owner.page.getByRole("textbox", { name: "Markdown source" })).toHaveValue(COLLABORATOR_MARKDOWN);
    await owner.page.goto(`${origin}/f/${owner.fileId}`);
    await owner.page.getByRole("button", { name: "Rename", exact: true }).click();
    const rename = owner.page.getByRole("dialog", { name: "Rename" });
    await rename.getByRole("textbox", { name: "Name" }).fill("Renamed owner file.md");
    await rename.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(owner.page.getByRole("heading", { name: "Renamed owner file.md", exact: true })).toBeVisible();

    await recipient.page.reload();
    await expect(recipient.page.getByRole("heading", { name: "OwnerSeed.md", exact: true })).toBeVisible();
    await expect(recipient.page.getByRole("heading", { name: "Renamed owner file.md", exact: true })).toHaveCount(0);
    expect(new URL(recipient.page.url()).pathname).toBe(`/f/${owner.fileId}`);
    await expect(recipient.page.getByRole("textbox", { name: "Markdown source" })).toHaveAttribute("readonly", "");

    const directRoot = recipient.page.getByLabel("Shared content")
      .getByRole("link", { name: "OwnerSeed.md (Shared as)", exact: true });
    await expect(directRoot).toBeVisible();
    await directRoot.locator("..").getByRole("button", { name: "Leave", exact: true }).click();
    await expect(recipient.page.getByText("Share left.", { exact: true })).toBeVisible();
    await expect(recipient.page.getByLabel("Shared content")
      .getByRole("link", { name: "OwnerSeed.md (Shared as)", exact: true })).toHaveCount(0);
    recipient.page.off("request", observeDirectRequest);
  } finally {
    await secondDevice?.context.close();
    await recipient.context.close();
    await owner.context.close();
  }
});
