/**
 * Ticket 33 acceptance: the private plaintext boundary.
 *
 * The buildable spec (§12.1) requires integration tests proving that no
 * private name, Markdown, front matter, Comment body, or displayed pseudonym
 * reaches Worker or D1 plaintext, and that passkeys cannot derive or decrypt
 * content. Existing per-feature suites prove each artifact's own envelope
 * shape; this suite seals a unique sentinel into every private artifact,
 * proves the browser can still open the stored ciphertext, and then sweeps
 * every D1 table and every private Worker response for the sentinels.
 */

import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { sealAttribution, sealCommentBody } from "../../app/shared/comments/content";
import { openSymmetric } from "../../app/shared/crypto/enc-v1";
import { decodeFileRepresentation, sealVaultRecoveryEnvelope } from "../../app/shared/crypto/vault";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/shared/tree/wire";
import {
  opaqueId, renamePayload, savePayload, sharingRequest, sharingAccount, treeChild, type SharingAccount,
} from "./sharing-fixtures";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SENTINEL = {
  name: `MDWN-SWEEP-NAME-${crypto.randomUUID()}`,
  frontMatter: `MDWN-SWEEP-FRONT-MATTER-${crypto.randomUUID()}`,
  markdown: `MDWN-SWEEP-MARKDOWN-${crypto.randomUUID()}`,
  comment: `MDWN-SWEEP-COMMENT-${crypto.randomUUID()}`,
  pseudonym: `MDWN-SWEEP-PSEUDONYM-${crypto.randomUUID()}`,
} as const;

type ThreadFixture = { threadId: string; epochId: string; capabilityId: string;
  capability: Uint8Array<ArrayBuffer>; vaultRootKey: Uint8Array };

/** Owner creates the one Private thread with a real `vault-recovery` envelope. */
async function createThread(owner: SharingAccount, fileId: string): Promise<ThreadFixture> {
  const threadId = opaqueId(), epochId = opaqueId(), capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const vaultRootKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(vaultRootKey,
    { scope: "owned", objectId: threadId, keyId: capabilityId, key: capability },
    { purpose: "vault-recovery", vaultId: owner.accountId, objectId: threadId, keyId: capabilityId, keyEpoch: 1, revision: 1 });
  const response = await sharingRequest(owner, `/api/private/comments/files/${fileId}`, "PUT",
    { threadId, epochId, capabilityId, recoveryEnvelope: encodeTreeBytes(recoveryEnvelope) });
  if (response.status !== 201) throw new Error(`thread create failed: ${response.status} ${await response.text()}`);
  return { threadId, epochId, capabilityId, capability, vaultRootKey };
}

/** Every value a D1 row can carry is searched for the sentinel bytes. */
function expectNoSentinel(value: unknown, sentinels: readonly Uint8Array[], where: string): void {
  if (typeof value === "string") {
    for (const sentinel of sentinels) {
      expect(value, `${where} leaked ${decoder.decode(sentinel)}`).not.toContain(decoder.decode(sentinel));
    }
    return;
  }
  if (value instanceof ArrayBuffer) return expectNoSentinel(new Uint8Array(value), sentinels, where);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (const sentinel of sentinels) {
      for (let offset = 0; offset + sentinel.length <= bytes.length; offset += 1) {
        if (sentinel.every((byte, index) => bytes[offset + index] === byte)) {
          throw new Error(`${where} leaked ${decoder.decode(sentinel)} as ciphertext bytes`);
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => expectNoSentinel(item, sentinels, `${where}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) expectNoSentinel(item, sentinels, `${where}.${key}`);
  }
}

describe("MVP acceptance: private plaintext never reaches the service", () => {
  it("seals every private artifact and keeps the sentinels out of D1 and every private response", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);

    // A private name, Markdown, and front matter sentinel through the real routes.
    const renamed = await sharingRequest(owner, `/api/private/tree/nodes/${fileId}/name`, "PATCH",
      await renamePayload(owner, owner.accountId, fileId, owner.rootId, SENTINEL.name));
    expect(renamed.status).toBe(200);
    const markdown = `---\ntitle: ${SENTINEL.frontMatter}\n---\n# ${SENTINEL.markdown}\n`;
    const saved = await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH",
      await savePayload(owner, owner.accountId, fileId, owner.rootId, markdown));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 2 });

    // A private Comment body and displayed pseudonym sentinel through the real routes.
    const thread = await createThread(owner, fileId);
    const commentId = opaqueId();
    const sealed = await sealCommentBody(thread.capability, { vaultId: owner.accountId, commentId,
      capabilityId: thread.capabilityId, keyEpoch: 1, revision: 1, text: SENTINEL.comment });
    const attributionId = opaqueId();
    const attribution = await sealAttribution(thread.capability, { vaultId: owner.accountId, attributionId,
      pseudonym: SENTINEL.pseudonym, capabilityId: thread.capabilityId, keyEpoch: 1 });
    expect((await sharingRequest(owner, `/api/private/comments/files/${fileId}/entries`, "POST",
      { commentId, threadId: thread.threadId, capabilityId: thread.capabilityId, capabilityEpoch: 1,
        epochId: thread.epochId, bodyCiphertext: sealed.bodyCiphertext,
        contentKeyEnvelope: sealed.contentKeyEnvelope, attribution })).status).toBe(201);

    // The browser can still open the stored ciphertext back into the sentinels.
    const read = await sharingRequest(owner, `/api/private/tree/files/${fileId}`);
    const file = await read.json() as { revision: number; contentKeyId: string; keyEpoch: number;
      ciphertext: string; representationKeyEnvelope: string };
    const capabilityKey = owner.keys.get(fileId)!;
    const contentKey = await openSymmetric(decodeTreeBytes(file.representationKeyEnvelope), capabilityKey,
      { context: { purpose: "file-content-key", vaultId: owner.accountId, objectId: fileId,
        keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision } });
    const contentContext = { purpose: "file-content" as const, vaultId: owner.accountId, objectId: fileId,
      keyId: file.contentKeyId, keyEpoch: file.keyEpoch, revision: file.revision };
    const representation = await openSymmetric(decodeTreeBytes(file.ciphertext, 524_288), contentKey, { context: contentContext });
    expect(decodeFileRepresentation(representation).markdown).toBe(markdown);

    // Sweep every application table for every sentinel, text or raw bytes.
    const sentinels = Object.values(SENTINEL).map((sentinel) => encoder.encode(sentinel));
    const tables = (await env.DB.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`)
      .all<{ name: string }>()).results;
    expect(tables.length).toBeGreaterThan(20);
    for (const { name } of tables) {
      const rows = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
      rows.forEach((row, index) => expectNoSentinel(row, sentinels, `${name}[${index}]`));
    }

    // The same sweep over every private response the app serves for this File.
    const listingText = await (await sharingRequest(owner, `/api/private/tree/directories/${owner.rootId}`)).text();
    const fileText = await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).text();
    const commentsText = await (await sharingRequest(owner, `/api/private/comments/files/${fileId}`)).text();
    const responses: [string, string][] = [
      [`/f/${fileId}`, await (await SELF.fetch(`https://mdwn.test/f/${fileId}`,
        { headers: { cookie: owner.session.cookie } })).text()],
      [`listing ${owner.rootId}`, listingText],
      [`file ${fileId}`, fileText],
      [`comments ${fileId}`, commentsText],
    ];
    for (const [where, text] of responses) expectNoSentinel(text, sentinels, where);
    // Anonymous routes serve only the public shell, never this File's private state.
    for (const path of [`/f/${fileId}`, `/d/${owner.rootId}`]) {
      const anonymous = await SELF.fetch(`https://mdwn.test${path}`);
      expectNoSentinel(await anonymous.text(), sentinels, `anonymous ${path}`);
    }

    // The stored name and Comment ciphertext are what the sentinel sweep just cleared:
    // opening each with the browser-held capability returns the sealed plaintext.
    const entry = (await (await sharingRequest(owner, `/api/private/tree/directories/${owner.rootId}`)).json() as
      { entries: { nodeId: string; nameCiphertext: string }[] }).entries.find((item) => item.nodeId === fileId)!;
    const storedName = await openSymmetric(decodeTreeBytes(entry.nameCiphertext), owner.keys.get(owner.rootId)!,
      { context: { purpose: "directory-metadata", vaultId: owner.accountId, objectId: fileId,
        keyId: owner.rootId, keyEpoch: 1, revision: 1 } });
    expect(decoder.decode(storedName)).toBe(SENTINEL.name);
    const threadBody = await (await sharingRequest(owner, `/api/private/comments/files/${fileId}`)).json() as
      { comments: { id: string; bodyCiphertext: string; contentKeyEnvelope: string }[] };
    const stored = threadBody.comments.find((comment) => comment.id === commentId)!;
    const commentKey = await openSymmetric(decodeTreeBytes(stored.contentKeyEnvelope), thread.capability,
      { context: { purpose: "comment-content", vaultId: owner.accountId, objectId: commentId,
        keyId: thread.capabilityId, keyEpoch: 1, revision: 1 } });
    const body = await openSymmetric(decodeTreeBytes(stored.bodyCiphertext), commentKey,
      { context: { purpose: "comment-content", vaultId: owner.accountId, objectId: commentId,
        keyId: commentId, keyEpoch: 1, revision: 1 } });
    expect(decoder.decode(body)).toBe(SENTINEL.comment);
  });

  it("keeps passkey credentials outside every content envelope", async () => {
    const owner = await sharingAccount();
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    await createThread(owner, fileId);

    const rows = (await env.DB.prepare(`SELECT purpose, object_id, recipient_id FROM key_envelopes
      WHERE account_id = ?`).bind(owner.accountId).all<{ purpose: string; object_id: string; recipient_id: string }>()).results;
    const credentials = (await env.DB.prepare(`SELECT credential_id, public_key FROM passkeys
      WHERE account_id = ?`).bind(owner.accountId).all<{ credential_id: string; public_key: ArrayBuffer }>()).results;
    expect(credentials).toHaveLength(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const envelope of rows) {
      for (const credential of credentials) {
        expect(envelope.purpose).not.toContain("passkey");
        expect(envelope.recipient_id).not.toBe(credential.credential_id);
        expect(envelope.object_id).not.toBe(credential.credential_id);
      }
    }
    // A passkey row carries only authentication public material: no private key,
    // no content key, and no ciphertext that could open an envelope.
    const columns = (await env.DB.prepare(`SELECT name FROM pragma_table_info('passkeys')`).all<{ name: string }>())
      .results.map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["credential_id", "public_key", "counter", "transports", "device_type", "backed_up"]));
    for (const forbidden of ["private_key", "content_key", "ciphertext", "envelope"]) {
      expect(columns).not.toContain(forbidden);
    }
  });
});
