import { hasEmptyBody, MAX_AUTHENTICATED_BODY_BYTES, readAuthJsonText, record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitDirectoryMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, MAX_REPRESENTATION_BYTES, treeEnvelope } from "./wire";
import { signedListing } from "./listing.server";
import { saveFile } from "./save.server";
import { directoryAccessGuard, fileAccessGuard, structuralAccessGuard } from "~/sharing/access.server";
import { createV2Child, fileWriteContext, migrateV1File, migrationRecipients, readV2File, saveV2File,
  unblocked } from "./file-v2.server";
import { deleteNode, moveChild, reorderChild } from "./structure.server";
import { sharingBudget } from "~/sharing/budget.server";

const headers = { "Cache-Control": "no-store" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers });
const badRequest = () => Response.json({ error: "invalid_tree_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "namespace_changed" }, { status: 409, headers });
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers });

type EntryRow = {
  node_id: string | null; kind: "directory" | "file" | null;
  parent_node_id: string | null; entries_revision: number; listing_version: number;
  capability_key_id: string; capability_epoch: number;
  encoding: "directory" | "legacy-file" | "receiving-file" | null;
  receiving_key_id: string | null; receiving_epoch: number | null; wrap_revision: number | null;
  name_ciphertext: ArrayBuffer | null; order_ciphertext: ArrayBuffer | null;
  key_envelope: ArrayBuffer | null;
  listing_ciphertext: ArrayBuffer | null; listing_digest: ArrayBuffer | null;
  listing_signature: ArrayBuffer | null; listing_device_id: string | null;
  signer_public_key: ArrayBuffer | null;
};

/** Read and authorize in the same ciphertext SELECT; never return private data from SSR. */
async function listDirectory(env: Env, auth: AuthorizedDevice, directoryId: string): Promise<Response> {
  const ownerId = (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM directories
    WHERE node_id = ${directoryId}`))?.owner_id;
  if (!ownerId) return notFound();
  const rows = await createDb(env.DB).all<EntryRow>(sql`
    SELECT d.entries_revision, d.listing_version, d.capability_key_id, d.capability_epoch,
      e.child_node_id AS node_id, n.kind, n.parent_node_id,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope, e.encoding,
      e.receiving_key_id, e.receiving_epoch, e.wrap_revision,
      d.listing_ciphertext, d.listing_digest, d.listing_signature, d.listing_device_id,
      signer.assertion_public_key AS signer_public_key
    FROM directories d JOIN vault_nodes parent ON parent.id = d.node_id AND parent.owner_id = d.owner_id
    LEFT JOIN encryption_devices signer ON signer.id = d.listing_device_id
    LEFT JOIN directory_entries e ON e.parent_node_id = d.node_id AND e.owner_id = d.owner_id
    LEFT JOIN vault_nodes n ON n.id = e.child_node_id AND n.owner_id = d.owner_id
    WHERE d.node_id = ${directoryId} AND d.owner_id = ${ownerId}
      AND ${directoryAccessGuard(auth, ownerId, directoryId, "directory_read")}
    ORDER BY e.child_node_id`);
  if (!rows.length) return notFound();
  if (rows.some((row) => row.node_id && (!row.kind || !row.name_ciphertext || !row.order_ciphertext || !row.key_envelope))) return denied();
  const current = rows[0]!;
  if ((current.entries_revision === 1 && (rows.length !== 1 || current.node_id || current.listing_ciphertext)) ||
      (current.entries_revision > 1 && (!current.listing_ciphertext || !current.listing_digest ||
        !current.listing_signature || !current.listing_device_id || !current.signer_public_key))) return denied();
  return Response.json({ directoryId, entriesRevision: current.entries_revision,
    listingVersion: current.listing_version,
    capabilityKeyId: current.capability_key_id, capabilityEpoch: current.capability_epoch,
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
      ...(current.listing_version === 2 ? { encoding: row.encoding,
        ...(row.encoding === "receiving-file" ? { receivingKeyId: row.receiving_key_id,
          receivingEpoch: row.receiving_epoch, wrapRevision: row.wrap_revision } : {}) } : {}),
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
  parent_node_id: string; has_parent_capability: number; revision: number; representation_id: string;
  ciphertext: ArrayBuffer; key_epoch: number; content_key_id: string;
  name_ciphertext: ArrayBuffer; order_ciphertext: ArrayBuffer; key_envelope: ArrayBuffer;
};

async function readFile(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const coordinates = await createDb(env.DB).get<{ owner_id: string; parent_node_id: string }>(sql`
    SELECT owner_id, parent_node_id FROM vault_nodes WHERE id = ${fileId} AND kind = 'file'`);
  if (!coordinates) return notFound();
  const { owner_id: ownerId, parent_node_id: parentId } = coordinates;
  const row = await createDb(env.DB).get<FileRow>(sql`
    SELECT n.parent_node_id, CASE WHEN ${directoryAccessGuard(auth, ownerId, parentId, "directory_read")}
      THEN 1 ELSE 0 END AS has_parent_capability,
      f.current_revision AS revision, r.id AS representation_id,
      r.ciphertext, r.key_epoch, r.content_key_id,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope
    FROM vault_nodes n JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    JOIN file_representations r ON r.id = f.current_representation_id
      AND r.file_node_id = f.node_id AND r.owner_id = f.owner_id AND r.revision = f.current_revision
    JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
    WHERE n.id = ${fileId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${parentId}
      AND ${fileAccessGuard(auth, ownerId, fileId, "file_read")}`);
  if (!row) return notFound();
  if (!row.has_parent_capability) return Response.json({ error: "provisioning_required" }, { status: 202, headers });
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

/** Entry metadata is sealed at the parent's epoch; a new child Directory starts at epoch 1. */
function createPayload(value: unknown, accountId: string, parentId: string, parentEpoch: number): Create {
  const input = record(value);
  if (!input || !isV7(input.nodeId) || (input.kind !== "directory" && input.kind !== "file") ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
      !exact(input, input.kind === "file" ? ["nodeId", "kind", "expectedRevision", "nameCiphertext",
        "orderCiphertext", "keyEnvelope", "representation", "listingHead"] : ["nodeId", "kind", "expectedRevision",
        "nameCiphertext", "orderCiphertext", "keyEnvelope", "listingHead"])) throw new Error("invalid tree request");
  const nodeId = input.nodeId;
  const context = { vaultId: accountId, objectId: nodeId, keyId: parentId, keyEpoch: parentEpoch, revision: 1 };
  const nameCiphertext = treeEnvelope(input.nameCiphertext, 1024, { ...context, purpose: "directory-metadata" });
  const orderCiphertext = treeEnvelope(input.orderCiphertext, 4096, { ...context, purpose: "directory-metadata" });
  if (input.kind === "directory") {
    const keyEnvelope = treeEnvelope(input.keyEnvelope, 1024,
      { ...context, keyId: nodeId, keyEpoch: 1, purpose: "directory-capability" });
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
  if (record(value)?.encoding === "receiving-file") return createV2Child(env, auth, parentId, value);
  const contentOwner = (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM vault_nodes
    WHERE id = ${parentId} AND kind = 'directory'`))?.owner_id;
  if (!contentOwner) return notFound();
  const exists = await createDb(env.DB).get<{ id: string; listing_version: 1 | 2; capability_epoch: number }>(sql`
    SELECT n.id, d.listing_version, d.capability_epoch FROM vault_nodes n JOIN directories d ON d.node_id = n.id
    WHERE n.id = ${parentId} AND n.owner_id = ${contentOwner}
      AND n.kind = 'directory' AND ${directoryAccessGuard(auth, contentOwner, parentId, "child_create")}`);
  if (!exists) return notFound();
  let input: Create;
  try { input = createPayload(value, contentOwner, parentId, exists.capability_epoch); }
  catch { return badRequest(); }
  const accountId = contentOwner;
  const now = Date.now();
  try {
    const head = await signedListing(record(value)?.listingHead, auth, { directoryId: parentId,
      expectedRevision: input.expectedRevision, ownerId: contentOwner, version: exists.listing_version,
      epoch: exists.capability_epoch });
    const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision, head,
      sql`EXISTS (SELECT 1 FROM vault_nodes WHERE id = ${parentId}
        AND owner_id = ${accountId} AND kind = 'directory')
        AND ${directoryAccessGuard(auth, accountId, parentId, "child_create")}
        AND ${unblocked(accountId, parentId)}`,
      (previous) => [
        sql`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
          SELECT ${input.nodeId}, ${input.kind}, ${accountId}, ${parentId}, ${now}, ${now} WHERE ${previous}`,
        ...(input.kind === "directory" ? [
          sql`INSERT INTO directories (node_id, owner_id, entries_revision, listing_version, capability_key_id)
            SELECT ${input.nodeId}, ${accountId}, 1, ${exists.listing_version}, ${input.nodeId} WHERE ${previous}`,
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
          name_ciphertext, order_ciphertext, key_envelope, encoding)
          SELECT ${input.nodeId}, ${accountId}, ${parentId}, ${input.nameCiphertext},
            ${input.orderCiphertext}, ${input.keyEnvelope},
            ${input.kind === "directory" ? "directory" : "legacy-file"} WHERE ${previous}`,
      ], { ownerId: accountId, previousVersion: exists.listing_version });
    return committed ? Response.json({ nodeId: input.nodeId, entriesRevision: input.expectedRevision + 1 },
      { status: 201, headers }) : changed();
  } catch { return badRequest(); }
}

async function renameChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "nameCiphertext", "orderCiphertext", "listingHead"]) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) return badRequest();
  const ownerId = (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM vault_nodes
    WHERE id = ${nodeId}`))?.owner_id;
  if (!ownerId) return notFound();
  const row = await createDb(env.DB).get<{ parent_node_id: string; listing_version: 1 | 2;
    capability_epoch: number }>(sql`
    SELECT n.parent_node_id, d.listing_version, d.capability_epoch
    FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id
    JOIN directories d ON d.node_id = n.parent_node_id
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId}
      AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
      AND ${structuralAccessGuard(auth, ownerId, nodeId, "rename")}`);
  if (!row) return notFound(); // The hidden root cannot be renamed.
  const parentId = row.parent_node_id;
  let name: Uint8Array, order: Uint8Array;
  try {
    const context = { purpose: "directory-metadata" as const, vaultId: ownerId,
      objectId: nodeId, keyId: parentId, keyEpoch: row.capability_epoch, revision: 1 };
    name = treeEnvelope(input.nameCiphertext, 1024, context);
    order = treeEnvelope(input.orderCiphertext, 4096, context);
  } catch { return badRequest(); }
  let head: Awaited<ReturnType<typeof signedListing>>;
  try {
    head = await signedListing(input.listingHead, auth, { directoryId: parentId,
      expectedRevision: input.expectedRevision as number, ownerId, version: row.listing_version,
      epoch: row.capability_epoch });
  }
  catch { return badRequest(); }
  const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision as number, head,
    sql`EXISTS (SELECT 1 FROM directory_entries WHERE child_node_id = ${nodeId}
      AND owner_id = ${ownerId} AND parent_node_id = ${parentId})
      AND ${structuralAccessGuard(auth, ownerId, nodeId, "rename")}
      AND ${unblocked(ownerId, nodeId)}`,
    (previous) => [sql`UPDATE directory_entries SET name_ciphertext = ${name}, order_ciphertext = ${order}
      WHERE child_node_id = ${nodeId} AND owner_id = ${ownerId}
        AND parent_node_id = ${parentId} AND ${previous}`],
    { ownerId, previousVersion: row.listing_version });
  return committed ? Response.json({ entriesRevision: (input.expectedRevision as number) + 1 }, { headers }) : changed();
}

/** Resource-only tree API; every private read is a proof-guarded, bodyless POST. */
export async function treeAction(request: Request, platform: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const directory = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)$/.exec(path);
  const create = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path);
  const file = /^\/api\/private\/tree\/files\/([0-9a-f-]+)$/.exec(path);
  const fileContext = /^\/api\/private\/tree\/files\/([0-9a-f-]+)\/context$/.exec(path);
  const migrateFile = /^\/api\/private\/tree\/files\/([0-9a-f-]+)\/migrate$/.exec(path);
  const migrationDevices = /^\/api\/private\/tree\/files\/([0-9a-f-]+)\/migration-recipients$/.exec(path);
  const rename = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/name$/.exec(path);
  const reorder = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/order$/.exec(path);
  const move = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/parent$/.exec(path);
  const remove = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)$/.exec(path);
  const pathToNode = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/ancestors$/.exec(path);
  const match = directory || create || file || fileContext || migrateFile || migrationDevices || rename ||
    reorder || move || remove || pathToNode;
  if (!match || !((directory || file || fileContext || migrationDevices || pathToNode) && request.method === "POST" ||
      create && request.method === "PUT" || remove && request.method === "DELETE" ||
      (rename || reorder || move || file || migrateFile) && request.method === "PATCH")) return notFound();
  const nodeId = match[1]!;
  // Structural mutations are metered like sharing resources: <= 50 statements,
  // <= 100 bindings each, with a local-only diagnostic header for SELF.fetch tests.
  const structural = reorder || move || remove;
  const measured = structural ? sharingBudget(platform.DB) : null;
  const env = measured ? { ...platform, DB: measured.db } : platform;
  const report = async (response: Promise<Response>) => {
    const value = await response;
    if (measured && platform.APP_ENV === "local") value.headers.set("X-Mdwn-Sharing-Budget",
      `${measured.budget.queries};${measured.budget.maxBindings}`);
    return value;
  };
  if (!isV7(nodeId)) return notFound();
  let raw = "", value: unknown;
  try {
    if ((directory || file || fileContext || migrationDevices || pathToNode) && request.method === "POST") {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, MAX_AUTHENTICATED_BODY_BYTES);
      raw = parsed.raw; value = parsed.value;
    }
  } catch { return badRequest(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (directory) return listDirectory(env, auth, nodeId);
  if (fileContext) return fileWriteContext(env, auth, nodeId);
  if (migrationDevices) return migrationRecipients(env, auth, nodeId);
  if (migrateFile) return migrateV1File(env, auth, nodeId, value);
  if (file) {
    // Select the representation only after checking current File authority. A
    // missing, deleted or inaccessible File must not reveal its encoding or
    // current revision via a representation-specific parser or conflict.
    const ownerId = (await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM vault_nodes
      WHERE id = ${nodeId} AND kind = 'file'`))?.owner_id;
    if (!ownerId) return notFound();
    const row = await createDb(env.DB).get<{ encoding: string }>(sql`
      SELECT e.encoding FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id
        AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
      WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId} AND n.kind = 'file'
        AND ${fileAccessGuard(auth, ownerId, nodeId, request.method === "POST" ? "file_read" : "file_edit")}`);
    if (!row) return notFound();
    if (row.encoding === "receiving-file") return request.method === "POST" ?
      readV2File(env, auth, nodeId) : saveV2File(env, auth, ownerId, nodeId, value);
    return request.method === "POST" ? readFile(env, auth, nodeId) : saveFile(env, auth, nodeId, value);
  }
  if (pathToNode) return ancestors(env, auth, nodeId);
  if (create) return createChild(env, auth, nodeId, value);
  if (reorder) return report(reorderChild(env, auth, nodeId, value));
  if (move) return report(moveChild(env, auth, nodeId, value));
  if (remove) return report(deleteNode(env, auth, nodeId, value));
  return renameChild(env, auth, nodeId, value);
}
