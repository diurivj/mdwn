import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { digestEnvelope } from "~/crypto/enc-v1";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitDirectoryMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, MAX_REPRESENTATION_BYTES, treeEnvelope } from "./wire";
import { MAX_LISTING_BYTES, verifyListingSignature, type ListingHead } from "./listing";

const headers = { "Cache-Control": "no-store" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers });
const badRequest = () => Response.json({ error: "invalid_tree_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "namespace_changed" }, { status: 409, headers });
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers });

type EntryRow = {
  node_id: string | null; kind: "directory" | "file" | null;
  parent_node_id: string | null; entries_revision: number;
  name_ciphertext: ArrayBuffer | null; order_ciphertext: ArrayBuffer | null;
  key_envelope: ArrayBuffer | null;
  listing_ciphertext: ArrayBuffer | null; listing_digest: ArrayBuffer | null;
  listing_signature: ArrayBuffer | null; listing_device_id: string | null;
  signer_public_key: ArrayBuffer | null;
};

/** Read and authorize in the same ciphertext SELECT; never return private data from SSR. */
async function listDirectory(env: Env, auth: AuthorizedDevice, directoryId: string): Promise<Response> {
  const rows = await createDb(env.DB).all<EntryRow>(sql`
    SELECT d.entries_revision, e.child_node_id AS node_id, n.kind, n.parent_node_id,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope,
      d.listing_ciphertext, d.listing_digest, d.listing_signature, d.listing_device_id,
      signer.assertion_public_key AS signer_public_key
    FROM directories d JOIN vault_nodes parent ON parent.id = d.node_id AND parent.owner_id = d.owner_id
    LEFT JOIN encryption_devices signer ON signer.id = d.listing_device_id AND signer.account_id = d.owner_id
    LEFT JOIN directory_entries e ON e.parent_node_id = d.node_id AND e.owner_id = d.owner_id
    LEFT JOIN vault_nodes n ON n.id = e.child_node_id AND n.owner_id = d.owner_id
    WHERE d.node_id = ${directoryId} AND d.owner_id = ${auth.accountId}
      AND ${privateReadGuard(auth)}
    ORDER BY e.child_node_id`);
  if (!rows.length) return notFound();
  if (rows.some((row) => row.node_id && (!row.kind || !row.name_ciphertext || !row.order_ciphertext || !row.key_envelope))) return denied();
  const current = rows[0]!;
  if ((current.entries_revision === 1 && (rows.length !== 1 || current.node_id || current.listing_ciphertext)) ||
      (current.entries_revision > 1 && (!current.listing_ciphertext || !current.listing_digest ||
        !current.listing_signature || !current.listing_device_id || !current.signer_public_key))) return denied();
  return Response.json({ directoryId, entriesRevision: current.entries_revision,
    listingHead: current.listing_ciphertext ? {
      ciphertext: encodeTreeBytes(new Uint8Array(current.listing_ciphertext)),
      digest: encodeTreeBytes(new Uint8Array(current.listing_digest!)),
      signature: encodeTreeBytes(new Uint8Array(current.listing_signature!)),
      signerDeviceId: current.listing_device_id,
      signerPublicKey: encodeTreeBytes(new Uint8Array(current.signer_public_key!)),
    } : null,
    entries: rows.filter((row) => row.node_id).map((row) => ({
      nodeId: row.node_id, kind: row.kind,
      nameCiphertext: encodeTreeBytes(new Uint8Array(row.name_ciphertext!)),
      orderCiphertext: encodeTreeBytes(new Uint8Array(row.order_ciphertext!)),
      keyEnvelope: encodeTreeBytes(new Uint8Array(row.key_envelope!)),
    })),
  }, { headers });
}

async function ancestors(env: Env, auth: AuthorizedDevice, nodeId: string): Promise<Response> {
  const rows = await createDb(env.DB).all<{ id: string; parent_node_id: string | null; depth: number }>(sql`
    WITH RECURSIVE lineage(id, parent_node_id, depth) AS (
      SELECT n.id, n.parent_node_id, 0 FROM vault_nodes n
      WHERE n.id = ${nodeId} AND n.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}
      UNION ALL
      SELECT parent.id, parent.parent_node_id, child.depth + 1
      FROM vault_nodes parent JOIN lineage child ON child.parent_node_id = parent.id
      WHERE parent.owner_id = ${auth.accountId} AND child.depth < 100
    )
    SELECT id, parent_node_id, depth FROM lineage ORDER BY depth DESC`);
  if (!rows.length || rows[0]!.parent_node_id !== null) return notFound();
  return Response.json({ ancestors: rows.map((row) => row.id) }, { headers });
}

type FileRow = {
  parent_node_id: string; revision: number; representation_id: string;
  ciphertext: ArrayBuffer; key_epoch: number; content_key_id: string;
  name_ciphertext: ArrayBuffer; order_ciphertext: ArrayBuffer; key_envelope: ArrayBuffer;
};

async function currentFile(env: Env, auth: AuthorizedDevice, fileId: string) {
  return createDb(env.DB).get<FileRow>(sql`
    SELECT n.parent_node_id, f.current_revision AS revision, r.id AS representation_id,
      r.ciphertext, r.key_epoch, r.content_key_id,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope
    FROM vault_nodes n JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    JOIN file_representations r ON r.id = f.current_representation_id
      AND r.file_node_id = f.node_id AND r.owner_id = f.owner_id AND r.revision = f.current_revision
    JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
    WHERE n.id = ${fileId} AND n.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
}

async function readFile(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const row = await currentFile(env, auth, fileId);
  if (!row) return notFound();
  return Response.json({ fileId, parentId: row.parent_node_id, revision: row.revision,
    representationId: row.representation_id, contentKeyId: row.content_key_id, keyEpoch: row.key_epoch,
    ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)),
    nameCiphertext: encodeTreeBytes(new Uint8Array(row.name_ciphertext)),
    orderCiphertext: encodeTreeBytes(new Uint8Array(row.order_ciphertext)),
    keyEnvelope: encodeTreeBytes(new Uint8Array(row.key_envelope)),
  }, { headers });
}

type Create = { nodeId: string; expectedRevision: number; kind: "directory" | "file";
  nameCiphertext: Uint8Array; orderCiphertext: Uint8Array; keyEnvelope: Uint8Array;
  representation?: { id: string; contentKeyId: string; keyEpoch: number; revision: 1; ciphertext: Uint8Array } };

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

async function signedListing(value: unknown, auth: AuthorizedDevice, directoryId: string,
  expectedRevision: number): Promise<{ ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array }> {
  const input = record(value);
  if (!input || !exact(input, ["ciphertext", "digest", "signature"])) throw new Error("invalid listing head");
  const revision = expectedRevision + 1;
  const ciphertext = treeEnvelope(input.ciphertext, MAX_LISTING_BYTES, {
    purpose: "directory-metadata", vaultId: auth.accountId, objectId: directoryId,
    keyId: directoryId, keyEpoch: 1, revision,
  });
  const digest = decodeTreeBytes(input.digest, 32);
  const signature = decodeTreeBytes(input.signature, 64);
  const computed = await digestEnvelope(ciphertext);
  if (digest.length !== 32 || signature.length !== 64 ||
      !computed.every((byte, i) => byte === digest[i]) ||
      !await verifyListingSignature(input as ListingHead, {
        vaultId: auth.accountId, directoryId, deviceId: auth.deviceId, revision,
        publicKey: auth.assertionPublicKey,
      })) throw new Error("invalid listing head");
  return { ciphertext, digest, signature };
}

function createPayload(value: unknown, accountId: string, parentId: string): Create {
  const input = record(value);
  if (!input || !isV7(input.nodeId) || (input.kind !== "directory" && input.kind !== "file") ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
      !exact(input, input.kind === "file" ? ["nodeId", "kind", "expectedRevision", "nameCiphertext",
        "orderCiphertext", "keyEnvelope", "representation", "listingHead"] : ["nodeId", "kind", "expectedRevision",
        "nameCiphertext", "orderCiphertext", "keyEnvelope", "listingHead"])) throw new Error("invalid tree request");
  const nodeId = input.nodeId;
  const context = { vaultId: accountId, objectId: nodeId, keyId: parentId, keyEpoch: 1, revision: 1 };
  const nameCiphertext = treeEnvelope(input.nameCiphertext, 1024, { ...context, purpose: "directory-metadata" });
  const orderCiphertext = treeEnvelope(input.orderCiphertext, 4096, { ...context, purpose: "directory-metadata" });
  if (input.kind === "directory") {
    const keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, { ...context, keyId: nodeId, purpose: "directory-capability" });
    return { nodeId, expectedRevision: input.expectedRevision as number, kind: "directory",
      nameCiphertext, orderCiphertext, keyEnvelope };
  }
  const repr = record(input.representation);
  if (!repr || !exact(repr, ["id", "contentKeyId", "keyEpoch", "revision", "ciphertext"]) ||
      !isV7(repr.id) || !isV7(repr.contentKeyId) || !Number.isSafeInteger(repr.keyEpoch) ||
      (repr.keyEpoch as number) < 1 || repr.revision !== 1) throw new Error("invalid tree request");
  const keyId = repr.contentKeyId;
  const keyEpoch = repr.keyEpoch as number;
  const keyEnvelope = treeEnvelope(input.keyEnvelope, 1024,
    { purpose: "file-content-key", vaultId: accountId, objectId: nodeId, keyId, keyEpoch, revision: 1 });
  const ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES,
    { purpose: "file-content", vaultId: accountId, objectId: nodeId, keyId, keyEpoch, revision: 1 });
  return { nodeId, expectedRevision: input.expectedRevision as number, kind: "file", nameCiphertext,
    orderCiphertext, keyEnvelope,
    representation: { id: repr.id, contentKeyId: keyId, keyEpoch, revision: 1, ciphertext } };
}

async function createChild(env: Env, auth: AuthorizedDevice, parentId: string, value: unknown): Promise<Response> {
  let input: Create;
  try { input = createPayload(value, auth.accountId, parentId); }
  catch { return badRequest(); }
  const exists = await createDb(env.DB).get<{ id: string }>(sql`
    SELECT id FROM vault_nodes WHERE id = ${parentId} AND owner_id = ${auth.accountId}
      AND kind = 'directory' AND ${privateReadGuard(auth)}`);
  if (!exists) return notFound();
  const { accountId } = auth;
  const now = Date.now();
  try {
    const head = await signedListing(record(value)?.listingHead, auth, parentId, input.expectedRevision);
    const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision, head,
      sql`EXISTS (SELECT 1 FROM vault_nodes WHERE id = ${parentId}
        AND owner_id = ${accountId} AND kind = 'directory')`,
      (previous) => [
        sql`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
          SELECT ${input.nodeId}, ${input.kind}, ${accountId}, ${parentId}, ${now}, ${now} WHERE ${previous}`,
        ...(input.kind === "directory" ? [
          sql`INSERT INTO directories (node_id, owner_id, entries_revision)
            SELECT ${input.nodeId}, ${accountId}, 1 WHERE ${previous}`,
        ] : [
          sql`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
            SELECT ${input.nodeId}, ${accountId}, ${input.representation!.id}, 1 WHERE ${previous}`,
          sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
            key_epoch, ciphertext, ciphertext_size, created_at)
            SELECT ${input.representation!.id}, ${input.nodeId}, ${accountId}, 1,
              ${input.representation!.contentKeyId}, ${input.representation!.keyEpoch},
              ${input.representation!.ciphertext}, ${input.representation!.ciphertext.byteLength}, ${now}
            WHERE ${previous}`,
        ]),
        sql`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
          name_ciphertext, order_ciphertext, key_envelope)
          SELECT ${input.nodeId}, ${accountId}, ${parentId}, ${input.nameCiphertext},
            ${input.orderCiphertext}, ${input.keyEnvelope} WHERE ${previous}`,
      ]);
    return committed ? Response.json({ nodeId: input.nodeId, entriesRevision: input.expectedRevision + 1 },
      { status: 201, headers }) : changed();
  } catch { return badRequest(); }
}

async function renameChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "nameCiphertext", "orderCiphertext", "listingHead"]) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) return badRequest();
  const row = await createDb(env.DB).get<{ parent_node_id: string }>(sql`
    SELECT n.parent_node_id FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id
    WHERE n.id = ${nodeId} AND n.owner_id = ${auth.accountId}
      AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id AND ${privateReadGuard(auth)}`);
  if (!row) return notFound(); // The hidden root cannot be renamed.
  const parentId = row.parent_node_id;
  let name: Uint8Array, order: Uint8Array;
  try {
    const context = { purpose: "directory-metadata" as const, vaultId: auth.accountId,
      objectId: nodeId, keyId: parentId, keyEpoch: 1, revision: 1 };
    name = treeEnvelope(input.nameCiphertext, 1024, context);
    order = treeEnvelope(input.orderCiphertext, 4096, context);
  } catch { return badRequest(); }
  let head: Awaited<ReturnType<typeof signedListing>>;
  try { head = await signedListing(input.listingHead, auth, parentId, input.expectedRevision as number); }
  catch { return badRequest(); }
  const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision as number, head,
    sql`EXISTS (SELECT 1 FROM directory_entries WHERE child_node_id = ${nodeId}
      AND owner_id = ${auth.accountId} AND parent_node_id = ${parentId})`,
    (previous) => [sql`UPDATE directory_entries SET name_ciphertext = ${name}, order_ciphertext = ${order}
      WHERE child_node_id = ${nodeId} AND owner_id = ${auth.accountId}
        AND parent_node_id = ${parentId} AND ${previous}`]);
  return committed ? Response.json({ entriesRevision: (input.expectedRevision as number) + 1 }, { headers }) : changed();
}

async function saveFile(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const current = await currentFile(env, auth, fileId);
  if (!current) return notFound();
  const input = record(value);
  const repr = record(input?.representation);
  const incrementable = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value + 1);
  if (!input || !repr || !exact(input, ["expectedRevision", "expectedParentRevision", "keyEnvelope", "representation", "listingHead"]) ||
      !exact(repr, ["id", "contentKeyId", "keyEpoch", "revision", "ciphertext"]) ||
      !incrementable(input.expectedRevision) || !incrementable(input.expectedParentRevision) ||
      !isV7(repr.id) || !isV7(repr.contentKeyId) || !incrementable(current.key_epoch) ||
      !Number.isSafeInteger(repr.keyEpoch) || !Number.isSafeInteger(repr.revision) ||
      repr.revision !== input.expectedRevision + 1) return badRequest();
  const expectedRevision = input.expectedRevision as number;
  const expectedParentRevision = input.expectedParentRevision as number;
  if (current.revision !== expectedRevision) return Response.json({ error: "file_changed" }, { status: 409, headers });
  if (repr.id === current.representation_id || repr.contentKeyId === current.content_key_id ||
      repr.keyEpoch !== current.key_epoch + 1) return badRequest();
  let keyEnvelope: Uint8Array, ciphertext: Uint8Array;
  let head: Awaited<ReturnType<typeof signedListing>>;
  try {
    const context = { vaultId: auth.accountId, objectId: fileId, keyId: repr.contentKeyId as string,
      keyEpoch: repr.keyEpoch as number, revision: expectedRevision + 1 };
    keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, { ...context, purpose: "file-content-key" });
    ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES, { ...context, purpose: "file-content" });
    head = await signedListing(input.listingHead, auth, current.parent_node_id, expectedParentRevision);
  } catch { return badRequest(); }
  const { accountId } = auth;
  try {
    const committed = await commitDirectoryMutation(env, auth, current.parent_node_id, expectedParentRevision, head,
      sql`EXISTS (SELECT 1 FROM files f JOIN file_representations r ON r.id = f.current_representation_id
        JOIN vault_nodes n ON n.id = f.node_id AND n.owner_id = f.owner_id
        JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id
          AND e.parent_node_id = n.parent_node_id
        WHERE f.node_id = ${fileId} AND f.owner_id = ${accountId} AND f.current_revision = ${expectedRevision}
          AND f.current_representation_id = ${current.representation_id} AND r.file_node_id = f.node_id
          AND r.owner_id = f.owner_id AND r.revision = f.current_revision
          AND r.content_key_id = ${current.content_key_id} AND r.key_epoch = ${current.key_epoch}
          AND n.parent_node_id = ${current.parent_node_id})`,
      (previous) => [
        sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
          key_epoch, ciphertext, ciphertext_size, created_at)
          SELECT ${repr.id as string}, ${fileId}, ${accountId}, ${expectedRevision + 1},
            ${repr.contentKeyId as string}, ${repr.keyEpoch as number}, ${ciphertext}, ${ciphertext.byteLength}, ${Date.now()}
          WHERE ${previous}`,
        sql`UPDATE directory_entries SET key_envelope = ${keyEnvelope}
          WHERE child_node_id = ${fileId} AND owner_id = ${accountId}
            AND parent_node_id = ${current.parent_node_id} AND ${previous}`,
        sql`UPDATE files SET current_representation_id = ${repr.id as string}, current_revision = ${expectedRevision + 1}
          WHERE node_id = ${fileId} AND owner_id = ${accountId}
            AND current_revision = ${expectedRevision} AND current_representation_id = ${current.representation_id}
            AND ${previous}`,
        sql`DELETE FROM file_representations WHERE id = ${current.representation_id}
          AND file_node_id = ${fileId} AND owner_id = ${accountId} AND ${previous}
          AND NOT EXISTS (SELECT 1 FROM files WHERE current_representation_id = ${current.representation_id})`,
      ]);
    if (committed) return Response.json({ revision: expectedRevision + 1, entriesRevision: expectedParentRevision + 1 }, { headers });
    // A competing File save can win after the initial read. Never invite a namespace retry for a stale draft.
    if (auth.expiresAt <= Date.now() || await createDb(env.DB).get(sql`
      SELECT 1 FROM device_proof_uses WHERE account_id = ${accountId} AND proof_id = ${auth.proofId}`)) return denied();
    const latest = await currentFile(env, auth, fileId);
    if (!latest) return denied();
    return latest.revision !== expectedRevision || latest.representation_id !== current.representation_id ||
      latest.content_key_id !== current.content_key_id || latest.key_epoch !== current.key_epoch
      ? Response.json({ error: "file_changed" }, { status: 409, headers }) : changed();
  } catch { return badRequest(); }
}

/** Resource-only tree API; every private read is a proof-guarded, bodyless POST. */
export async function treeAction(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const directory = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)$/.exec(path);
  const create = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path);
  const file = /^\/api\/private\/tree\/files\/([0-9a-f-]+)$/.exec(path);
  const rename = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/name$/.exec(path);
  const pathToNode = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/ancestors$/.exec(path);
  if (!(directory || create || file || rename || pathToNode) ||
      !((directory || file || pathToNode) && request.method === "POST" || create && request.method === "PUT" ||
        (rename || file) && request.method === "PATCH")) return notFound();
  const nodeId = (directory || create || file || rename || pathToNode)![1]!;
  if (!isV7(nodeId)) return notFound();
  let raw = "", value: unknown;
  try {
    if (request.method === "POST") {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, 1536 * 1024);
      raw = parsed.raw; value = parsed.value;
    }
  } catch { return badRequest(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (directory) return listDirectory(env, auth, nodeId);
  if (file) return request.method === "PATCH" ? saveFile(env, auth, nodeId, value) : readFile(env, auth, nodeId);
  if (pathToNode) return ancestors(env, auth, nodeId);
  if (create) return createChild(env, auth, nodeId, value);
  return renameChild(env, auth, nodeId, value);
}
