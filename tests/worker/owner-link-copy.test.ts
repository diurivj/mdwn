import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { filePublished } from "../../app/publications/publications.server";
import { createSymmetricWriter } from "../../app/shared/crypto/enc-v1";
import { createDb, sql } from "../../app/shared/db/client.server";
import { generateVaultRootKey, openVaultRecoveryEnvelope } from "../../app/shared/crypto/vault";
import {
  formatPublicationFragment,
  newPublicationIdentifier,
  ownerLinkContext,
} from "../../app/shared/publications/capability";
import { sealAuthorDeclaration } from "../../app/shared/publications/content";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/shared/tree/wire";
import { ownerLinkCopy, publicationCreation, publish, rotationPayload } from "./publication-fixtures";
import {
  deletePayload,
  grant,
  opaqueId,
  sharingAccount,
  sharingRequest,
  treeChild,
  treeListing,
} from "./sharing-fixtures";

/**
 * Ticket 68: the Owner link copy, and the published marks in Directory
 * listings. The Worker validates the copy's header, stores ciphertext it
 * cannot open, returns it to the Owner alone and removes it with its link.
 */

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

type Panel = {
  isOwner: boolean;
  publication: null | {
    publicationId: string;
    state: string;
    linkId?: string | null;
    ownerLink?: string | null;
  };
};

async function panel(actor: Awaited<ReturnType<typeof sharingAccount>>, fileId: string): Promise<Panel> {
  const response = await sharingRequest(actor, `/api/private/publications/files/${fileId}`);
  if (!response.ok) throw new Error(`panel read failed: ${response.status}`);
  return response.json() as Promise<Panel>;
}

function contains(haystack: Uint8Array, needle: Uint8Array) {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((byte, index) => haystack[start + index] === byte)) return true;
  }
  return false;
}

async function count(table: string, where = "1", ...values: unknown[]) {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...values)
    .first<{ n: number }>())!.n;
}

describe("the Owner link copy", () => {
  it("is kept for the Owner alone, as ciphertext only the Owner's Vault root key opens", async () => {
    const owner = await sharingAccount(),
      editor = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await grant(owner, editor, fileId, "read_write");
    const vaultRootKey = generateVaultRootKey();
    const publication = await publish(owner, fileId, "public", vaultRootKey);

    // D1 holds exactly the submitted envelope, never the scalar itself.
    const row = await env.DB.prepare("SELECT owner_link_envelope FROM publication_links WHERE id = ?")
      .bind(publication.linkId)
      .first<{ owner_link_envelope: ArrayBuffer }>();
    const stored = new Uint8Array(row!.owner_link_envelope);
    expect(encodeTreeBytes(stored)).toBe(publication.ownerLink);
    expect(contains(stored, publication.linkKey.privateKey)).toBe(false);

    // The Owner's panel returns it, and only the Owner's Vault root key opens it.
    const ownerView = (await panel(owner, fileId)).publication!;
    expect(ownerView).toMatchObject({ linkId: publication.linkId, ownerLink: publication.ownerLink });
    const context = ownerLinkContext(owner.accountId, publication.publicationId, publication.linkId);
    const opened = await openVaultRecoveryEnvelope(decodeTreeBytes(ownerView.ownerLink, 1024), vaultRootKey, context);
    expect(formatPublicationFragment(opened)).toBe(publication.fragment);
    await expect(
      openVaultRecoveryEnvelope(decodeTreeBytes(ownerView.ownerLink, 1024), generateVaultRootKey(), context),
    ).rejects.toThrow();

    // An editor of the File never receives the link identity or its copy, and
    // neither do the File responses or the anonymous Public route.
    const editorView = (await panel(editor, fileId)).publication!;
    expect(editorView).not.toHaveProperty("linkId");
    expect(editorView).not.toHaveProperty("ownerLink");
    for (const actor of [owner, editor]) {
      expect(await (await sharingRequest(actor, `/api/private/tree/files/${fileId}`)).text()).not.toContain(
        publication.ownerLink,
      );
    }
    const anonymous = await SELF.fetch(`https://mdwn.test/api/public/publications/${publication.linkId}`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.text()).not.toContain(publication.ownerLink);
  });

  it("refuses a mis-bound or malformed copy before creating anything", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const vaultRootKey = generateVaultRootKey();
    const creation = await publicationCreation(owner, fileId, "public", vaultRootKey);
    const scalar = creation.linkKey.privateKey;
    const bound = ownerLinkContext(owner.accountId, creation.publicationId, creation.linkId);
    const writer = await createSymmetricWriter(vaultRootKey);
    const variants: Record<string, unknown> = {
      otherPath: await ownerLinkCopy(owner.accountId, creation, scalar, vaultRootKey, {
        ...bound,
        objectId: newPublicationIdentifier(),
      }),
      otherPublication: await ownerLinkCopy(owner.accountId, creation, scalar, vaultRootKey, {
        ...bound,
        keyId: newPublicationIdentifier(),
      }),
      otherVault: await ownerLinkCopy(owner.accountId, creation, scalar, vaultRootKey, {
        ...bound,
        vaultId: opaqueId(),
      }),
      otherEpoch: await ownerLinkCopy(owner.accountId, creation, scalar, vaultRootKey, { ...bound, keyEpoch: 2 }),
      otherPurpose: encodeTreeBytes(await writer.seal(scalar, { ...bound, purpose: "file-capability" })),
      publicEnvelope: encodeTreeBytes(
        await sealAuthorDeclaration(
          {
            publicationId: creation.publicationId,
            linkId: creation.linkId,
            publicKey: creation.linkKey.publicKey,
            declarationId: newPublicationIdentifier(),
            revision: 1,
          },
          "Member Owner",
        ),
      ),
      oversized: encodeTreeBytes(new Uint8Array(1025)),
      number: 7,
      empty: null,
    };
    for (const [name, ownerLink] of Object.entries(variants)) {
      const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", {
        ...creation.body,
        ownerLink,
      });
      expect(response.status, name).toBe(400);
    }
    expect(await count("publications", "file_id = ?", fileId)).toBe(0);
  });

  it("is absent for a link published or replaced by a page that sends none", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const creation = await publicationCreation(owner, fileId);
    const { ownerLink: _created, ...older } = creation.body;
    expect((await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", older)).status).toBe(201);
    expect((await panel(owner, fileId)).publication).toMatchObject({ linkId: creation.linkId, ownerLink: null });
    expect(await count("publication_links", "id = ? AND owner_link_envelope IS NULL", creation.linkId)).toBe(1);
  });

  it("follows the link: replaced on rotation, never bound to a retired path, and removed on Unpublishing", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    const files = `/api/private/publications/files/${fileId}`;

    const rotation = await rotationPayload(owner, fileId, publication);
    // The retired link's copy cannot ride along with the new path.
    const stale = await sharingRequest(owner, `${files}/link`, "PUT", {
      ...rotation,
      ownerLink: publication.ownerLink,
    });
    expect(stale.status).toBe(400);
    expect((await sharingRequest(owner, `${files}/link`, "PUT", rotation)).status).toBe(200);
    expect((await panel(owner, fileId)).publication).toMatchObject({
      linkId: rotation.linkId,
      ownerLink: rotation.ownerLink,
    });
    expect(
      await count(
        "publication_links",
        "publication_id = ? AND owner_link_envelope IS NOT NULL",
        publication.publicationId,
      ),
    ).toBe(1);

    // A page that sends no copy leaves its new link without one, never the old copy.
    const { ownerLink: _replaced, ...older } = await rotationPayload(owner, fileId, publication);
    expect((await sharingRequest(owner, `${files}/link`, "PUT", older)).status).toBe(200);
    expect((await panel(owner, fileId)).publication).toMatchObject({ linkId: older.linkId, ownerLink: null });

    // Unpublishing seals the Publication: the link and any copy are gone at once.
    const again = await rotationPayload(owner, fileId, publication);
    expect((await sharingRequest(owner, `${files}/link`, "PUT", again)).status).toBe(200);
    expect((await sharingRequest(owner, `${files}/unpublish`, "POST")).status).toBe(200);
    expect((await panel(owner, fileId)).publication).toMatchObject({
      state: "deleting",
      linkId: null,
      ownerLink: null,
    });
    expect(await count("publication_links", "publication_id = ?", publication.publicationId)).toBe(0);
  });

  it("is removed with its link when the File is deleted", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const publication = await publish(owner, fileId);
    expect(await count("publication_links", "id = ? AND owner_link_envelope IS NOT NULL", publication.linkId)).toBe(1);
    const deleted = await sharingRequest(
      owner,
      `/api/private/tree/nodes/${fileId}`,
      "DELETE",
      await deletePayload(owner, owner.accountId, fileId, owner.rootId),
    );
    expect(deleted.status).toBe(200);
    expect(await count("publication_links", "publication_id = ?", publication.publicationId)).toBe(0);
  });
});

describe("published marks in Directory listings", () => {
  it("mark exactly the Files with an active Publication, for everyone who can list them", async () => {
    const owner = await sharingAccount(),
      reader = await sharingAccount();
    const directoryId = await treeChild(owner, owner.rootId, "directory");
    const published = await treeChild(owner, directoryId, "file", owner.accountId, true);
    const unpublished = await treeChild(owner, directoryId, "file", owner.accountId, true);
    const folder = await treeChild(owner, directoryId, "directory");
    await grant(owner, reader, directoryId, "read_only");
    const marks = async (actor: typeof owner) =>
      Object.fromEntries(
        (await treeListing(actor, directoryId)).entries.map((entry) => [
          entry.nodeId,
          (entry as { published?: unknown }).published ?? "unmarked",
        ]),
      );
    const none = { [published]: "unmarked", [unpublished]: "unmarked", [folder]: "unmarked" };
    expect(await marks(owner)).toEqual(none);

    await publish(owner, published);
    const marked = { ...none, [published]: true };
    expect(await marks(owner)).toEqual(marked);
    expect(await marks(reader)).toEqual(marked);

    // A sealed Publication no longer counts as published.
    expect((await sharingRequest(owner, `/api/private/publications/files/${published}/unpublish`, "POST")).status).toBe(
      200,
    );
    expect(await marks(owner)).toEqual(none);
    expect(await marks(reader)).toEqual(none);
  });

  it("finds each entry's Publication through its point index", async () => {
    // The production per-entry mark, compiled as the listing query uses it.
    const plan = (
      await createDb(env.DB).all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN SELECT n.id, ${filePublished(sql`n.id`, sql`n.owner_id`)}
          FROM vault_nodes n WHERE n.parent_node_id = ${"x"}`,
      )
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toMatch(/SEARCH p USING (?:COVERING )?INDEX publications_(?:file|current)_idx \(file_id=\?/);
    expect(plan).not.toMatch(/SCAN p\b/);
  });
});
