import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { digestEnvelope, inspectEnvelope } from "~/crypto/enc-v1";
import { SYMMETRIC_SUITE } from "~/crypto/enc-v1/format";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitDirectoryMutation, commitPrivateBatch, commitTreeMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { decodeTreeBytes, encodeTreeBytes, isV7, MAX_REPRESENTATION_BYTES, treeEnvelope } from "./wire";
import { MAX_LISTING_BYTES, verifyListingSignature, type ListingHead } from "./listing";
import { verifyFileHead, type FileHead, type FileHeadIdentity } from "./file-head";
import { accessPredicate, effectiveAccessQuery, exitsSharedScope, moveAccessPredicate, sharingWriteBlocked } from "~/sharing/access.server";
import { retireDeletedScopeNeeds } from "~/sharing/provisioning-needs.server";

const headers = { "Cache-Control": "no-store" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers });
const badRequest = () => Response.json({ error: "invalid_tree_request" }, { status: 400, headers });
const changed = () => Response.json({ error: "namespace_changed" }, { status: 409, headers });
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers });
const rotationRequired = () => Response.json({ error: "key_rotation_required" }, { status: 409, headers });

type EntryRow = {
  node_id: string | null; kind: "directory" | "file" | null;
  parent_node_id: string | null; entries_revision: number; key_epoch: number; child_key_epoch: number | null; can_create: number;
  name_ciphertext: ArrayBuffer | null; order_ciphertext: ArrayBuffer | null;
  key_envelope: ArrayBuffer | null;
  listing_ciphertext: ArrayBuffer | null; listing_digest: ArrayBuffer | null;
  listing_signature: ArrayBuffer | null; listing_device_id: string | null;
  signer_public_key: ArrayBuffer | null;
};

/** Read and authorize in the same ciphertext SELECT; never return private data from SSR. */
async function listDirectory(env: Env, auth: AuthorizedDevice, directoryId: string): Promise<Response> {
  const rows = await createDb(env.DB).all<EntryRow>(sql`
    SELECT d.entries_revision, d.key_epoch, child_directory.key_epoch AS child_key_epoch,
      a.permission_rank >= 2 AS can_create, e.child_node_id AS node_id, n.kind, n.parent_node_id,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope,
      d.listing_ciphertext, d.listing_digest, d.listing_signature, d.listing_device_id,
      signer.assertion_public_key AS signer_public_key
    FROM directories d JOIN vault_nodes parent ON parent.id = d.node_id AND parent.owner_id = d.owner_id
    JOIN (${effectiveAccessQuery(auth, directoryId)}) a ON a.node_id = d.node_id AND a.owner_id = d.owner_id
    LEFT JOIN encryption_devices signer ON signer.id = d.listing_device_id
    LEFT JOIN directory_entries e ON e.parent_node_id = d.node_id AND e.owner_id = d.owner_id
    LEFT JOIN vault_nodes n ON n.id = e.child_node_id AND n.owner_id = d.owner_id
    LEFT JOIN directories child_directory ON child_directory.node_id = n.id AND child_directory.owner_id = n.owner_id
    WHERE d.node_id = ${directoryId}
    ORDER BY e.child_node_id`);
  if (!rows.length) return notFound();
  if (rows.some((row) => row.node_id && (!row.kind || !row.name_ciphertext || !row.order_ciphertext || !row.key_envelope))) return denied();
  const current = rows[0]!;
  if ((current.entries_revision === 1 && (rows.length !== 1 || current.node_id || current.listing_ciphertext)) ||
      (current.entries_revision > 1 && (!current.listing_ciphertext || !current.listing_digest ||
        !current.listing_signature || !current.listing_device_id || !current.signer_public_key))) return denied();
  return Response.json({ directoryId, canCreate: Boolean(current.can_create), entriesRevision: current.entries_revision,
    ...(current.key_epoch !== 1 ? { keyEpoch: current.key_epoch } : {}),
    listingHead: current.listing_ciphertext ? {
      ciphertext: encodeTreeBytes(new Uint8Array(current.listing_ciphertext)),
      digest: encodeTreeBytes(new Uint8Array(current.listing_digest!)),
      signature: encodeTreeBytes(new Uint8Array(current.listing_signature!)),
      signerDeviceId: current.listing_device_id,
      signerPublicKey: encodeTreeBytes(new Uint8Array(current.signer_public_key!)),
    } : null,
    entries: rows.filter((row) => row.node_id).map((row) => ({
      nodeId: row.node_id, kind: row.kind,
      ...(row.kind === "directory" && row.child_key_epoch !== 1 ? { keyEpoch: row.child_key_epoch } : {}),
      nameCiphertext: encodeTreeBytes(new Uint8Array(row.name_ciphertext!)),
      orderCiphertext: encodeTreeBytes(new Uint8Array(row.order_ciphertext!)),
      keyEnvelope: encodeTreeBytes(new Uint8Array(row.key_envelope!)),
    })),
  }, { headers });
}

async function ancestors(env: Env, auth: AuthorizedDevice, nodeId: string): Promise<Response> {
  const rows = await createDb(env.DB).all<{ id: string; depth: number }>(sql`
    WITH RECURSIVE access AS (${effectiveAccessQuery(auth, nodeId)}), lineage(id, parent_node_id, depth) AS (
      SELECT n.id, n.parent_node_id, 0 FROM vault_nodes n JOIN access a ON a.node_id = n.id
      UNION ALL
      SELECT parent.id, parent.parent_node_id, child.depth + 1
      FROM vault_nodes parent JOIN lineage child ON child.parent_node_id = parent.id
      JOIN access a ON a.owner_id = parent.owner_id WHERE child.depth < 100
    )
    SELECT l.id, l.depth FROM lineage l CROSS JOIN access a
    WHERE (a.permission_rank = 3 OR l.depth = 0 OR EXISTS (
      SELECT 1 FROM lineage root JOIN json_each(a.directory_read_roots) scope ON scope.value = root.id
      WHERE l.depth <= root.depth))
      AND (a.permission_rank != 3 OR EXISTS (SELECT 1 FROM lineage WHERE parent_node_id IS NULL))
    ORDER BY l.depth DESC`);
  if (!rows.length) return notFound();
  return Response.json({ ancestors: rows.map((row) => row.id) }, { headers });
}

type FileRow = {
  parent_node_id: string; owner_id: string; has_directory_access: number; can_edit: number; revision: number; representation_id: string;
  ciphertext: ArrayBuffer; key_epoch: number; content_key_id: string;
  capability_id: string | null; capability_epoch: number | null;
  representation_key_envelope: ArrayBuffer | null; head_digest: ArrayBuffer | null; head_signature: ArrayBuffer | null;
  head_device_id: string | null; head_public_key: ArrayBuffer | null;
  name_ciphertext: ArrayBuffer; order_ciphertext: ArrayBuffer; key_envelope: ArrayBuffer;
};

async function currentFile(env: Env, auth: AuthorizedDevice, fileId: string) {
  return createDb(env.DB).get<FileRow>(sql`
    SELECT n.parent_node_id, n.owner_id,
      a.permission_rank = 3 OR json_array_length(a.directory_read_roots) > 0 AS has_directory_access,
      a.permission_rank >= 2 AS can_edit,
      f.current_revision AS revision, r.id AS representation_id,
      r.ciphertext, r.key_epoch, r.content_key_id, f.capability_id, f.capability_epoch,
      r.key_envelope AS representation_key_envelope, r.head_digest, r.head_signature, r.head_device_id,
      signer.assertion_public_key AS head_public_key,
      e.name_ciphertext, e.order_ciphertext, e.key_envelope
    FROM (${effectiveAccessQuery(auth, fileId)}) a
    JOIN vault_nodes n ON n.id = a.node_id JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    JOIN file_representations r ON r.id = f.current_representation_id
      AND r.file_node_id = f.node_id AND r.owner_id = f.owner_id AND r.revision = f.current_revision
    JOIN directory_entries e ON e.child_node_id = n.id AND e.parent_node_id = n.parent_node_id
    LEFT JOIN encryption_devices signer ON signer.id = r.head_device_id
    WHERE n.id = ${fileId}`);
}

async function readFile(env: Env, auth: AuthorizedDevice, fileId: string): Promise<Response> {
  const row = await currentFile(env, auth, fileId);
  if (!row) return notFound();
  if (row.capability_id && (!row.capability_epoch || !row.representation_key_envelope || !row.head_digest ||
      !row.head_signature || !row.head_device_id || !row.head_public_key)) return denied();
  return Response.json({ fileId, ownerId: row.owner_id, canEdit: Boolean(row.can_edit), revision: row.revision,
    representationId: row.representation_id, contentKeyId: row.content_key_id, keyEpoch: row.key_epoch,
    ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)),
    ...(row.capability_id ? { capability: { id: row.capability_id, epoch: row.capability_epoch },
      representationKeyEnvelope: encodeTreeBytes(new Uint8Array(row.representation_key_envelope!)),
      fileHead: { digest: encodeTreeBytes(new Uint8Array(row.head_digest!)),
        signature: encodeTreeBytes(new Uint8Array(row.head_signature!)), signerDeviceId: row.head_device_id,
        signerPublicKey: encodeTreeBytes(new Uint8Array(row.head_public_key!)) } } : {}),
    ...(row.has_directory_access ? { parentId: row.parent_node_id,
      nameCiphertext: encodeTreeBytes(new Uint8Array(row.name_ciphertext)),
      orderCiphertext: encodeTreeBytes(new Uint8Array(row.order_ciphertext)),
      keyEnvelope: encodeTreeBytes(new Uint8Array(row.key_envelope)) } : {}),
  }, { headers });
}

type Create = { nodeId: string; expectedRevision: number; kind: "directory" | "file";
  nameCiphertext: Uint8Array; orderCiphertext: Uint8Array; keyEnvelope: Uint8Array;
  capability?: Capability;
  representation?: { id: string; contentKeyId: string; keyEpoch: number; revision: 1; ciphertext: Uint8Array; keyEnvelope?: Uint8Array } };

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

async function signedListing(value: unknown, auth: AuthorizedDevice, directoryId: string,
  expectedRevision: number, ownerId = auth.accountId, keyEpoch = 1): Promise<{ ciphertext: Uint8Array; digest: Uint8Array; signature: Uint8Array }> {
  const input = record(value);
  if (!input || !exact(input, ["ciphertext", "digest", "signature"])) throw new Error("invalid listing head");
  const revision = expectedRevision + 1;
  const ciphertext = treeEnvelope(input.ciphertext, MAX_LISTING_BYTES, {
    purpose: "directory-metadata", vaultId: ownerId, objectId: directoryId,
    keyId: directoryId, keyEpoch, revision,
  });
  const digest = decodeTreeBytes(input.digest, 32);
  const signature = decodeTreeBytes(input.signature, 64);
  const computed = await digestEnvelope(ciphertext);
  if (digest.length !== 32 || signature.length !== 64 ||
      !computed.every((byte, i) => byte === digest[i]) ||
      !await verifyListingSignature(input as ListingHead, {
        vaultId: ownerId, directoryId, deviceId: auth.deviceId, revision,
        publicKey: auth.assertionPublicKey,
      })) throw new Error("invalid listing head");
  return { ciphertext, digest, signature };
}

function createPayload(value: unknown, accountId: string, parentId: string, parentEpoch: number): Create {
  const input = record(value);
  const converted = Boolean(input && Object.hasOwn(input, "capability"));
  if (!input || !isV7(input.nodeId) || (input.kind !== "directory" && input.kind !== "file") ||
      !validRevision(input.expectedRevision) ||
      !exact(input, input.kind === "file" ? ["nodeId", "kind", "expectedRevision", "nameCiphertext",
        "orderCiphertext", "keyEnvelope", "representation", "listingHead", ...(converted ? ["capability"] : [])] : ["nodeId", "kind", "expectedRevision",
        "nameCiphertext", "orderCiphertext", "keyEnvelope", "listingHead"])) throw new Error("invalid tree request");
  const nodeId = input.nodeId;
  const context = { vaultId: accountId, objectId: nodeId, keyId: parentId, keyEpoch: parentEpoch, revision: 1 };
  const nameCiphertext = treeEnvelope(input.nameCiphertext, 1024, { ...context, purpose: "directory-metadata" });
  const orderCiphertext = treeEnvelope(input.orderCiphertext, 4096, { ...context, purpose: "directory-metadata" });
  if (input.kind === "directory") {
    const keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, { ...context, keyId: nodeId, keyEpoch: 1, purpose: "directory-capability" });
    return { nodeId, expectedRevision: input.expectedRevision as number, kind: "directory",
      nameCiphertext, orderCiphertext, keyEnvelope };
  }
  const repr = record(input.representation);
  if (!repr || !exact(repr, ["id", "contentKeyId", "keyEpoch", "revision", "ciphertext", ...(converted ? ["keyEnvelope", "fileHead"] : [])]) ||
      !isV7(repr.id) || !isV7(repr.contentKeyId) || !Number.isSafeInteger(repr.keyEpoch) ||
      (repr.keyEpoch as number) < 1 || repr.revision !== 1) throw new Error("invalid tree request");
  const keyId = repr.contentKeyId;
  const keyEpoch = repr.keyEpoch as number;
  const capability = converted ? fileCapability(input.capability) : undefined;
  if (capability && capability.epoch !== 1) throw new Error("invalid tree request");
  const keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, capability
    ? { purpose: "file-capability", vaultId: accountId, objectId: nodeId, keyId: capability.id, keyEpoch: 1, revision: 1 }
    : { purpose: "file-content-key", vaultId: accountId, objectId: nodeId, keyId, keyEpoch, revision: 1 });
  const ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES,
    { purpose: "file-content", vaultId: accountId, objectId: nodeId, keyId, keyEpoch, revision: 1 });
  const representationKeyEnvelope = capability ? treeEnvelope(repr.keyEnvelope, 16_384,
    { purpose: "file-content-key", vaultId: accountId, objectId: nodeId, keyId, keyEpoch, revision: 1 }) : undefined;
  return { nodeId, expectedRevision: input.expectedRevision as number, kind: "file", nameCiphertext,
    orderCiphertext, keyEnvelope, capability,
    representation: { id: repr.id, contentKeyId: keyId, keyEpoch, revision: 1, ciphertext, keyEnvelope: representationKeyEnvelope } };
}

async function createChild(env: Env, auth: AuthorizedDevice, parentId: string, value: unknown): Promise<Response> {
  const parent = await authorizedDirectory(env, auth, parentId, "create");
  if (!parent) return notFound();
  const accountId = parent.owner_id;
  const blocked = sharingWriteBlocked(parentId);
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
  let input: Create;
  try { input = createPayload(value, accountId, parentId, parent.key_epoch); }
  catch { return badRequest(); }
  const now = Date.now();
  try {
    const head = await signedListing(record(value)?.listingHead, auth, parentId, input.expectedRevision, accountId, parent.key_epoch);
    const fileHead = input.capability ? await signedFileHead(record(record(value)?.representation)?.fileHead, auth,
      { vaultId: accountId, fileId: input.nodeId, capabilityId: input.capability.id, capabilityEpoch: input.capability.epoch,
        representationId: input.representation!.id, contentKeyId: input.representation!.contentKeyId,
        keyEpoch: input.representation!.keyEpoch, revision: 1,
        ciphertext: encodeTreeBytes(input.representation!.ciphertext), keyEnvelope: encodeTreeBytes(input.representation!.keyEnvelope!) }) : null;
    const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision, head,
      sql`${accessPredicate(auth, parentId, "create")} AND NOT ${blocked} AND EXISTS (SELECT 1 FROM vault_nodes WHERE id = ${parentId}
        AND owner_id = ${accountId} AND kind = 'directory')`,
      (previous) => [
        sql`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
          SELECT ${input.nodeId}, ${input.kind}, ${accountId}, ${parentId}, ${now}, ${now} WHERE ${previous}`,
        ...(input.kind === "directory" ? [
          sql`INSERT INTO directories (node_id, owner_id, entries_revision)
            SELECT ${input.nodeId}, ${accountId}, 1 WHERE ${previous}`,
        ] : [
          sql`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision, capability_id, capability_epoch)
            SELECT ${input.nodeId}, ${accountId}, ${input.representation!.id}, 1,
              ${input.capability?.id ?? null}, ${input.capability?.epoch ?? null} WHERE ${previous}`,
          sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id,
            key_epoch, ciphertext, ciphertext_size, created_at, key_envelope, head_digest, head_signature, head_device_id)
            SELECT ${input.representation!.id}, ${input.nodeId}, ${accountId}, 1,
              ${input.representation!.contentKeyId}, ${input.representation!.keyEpoch},
              ${input.representation!.ciphertext}, ${input.representation!.ciphertext.byteLength}, ${now},
              ${input.representation!.keyEnvelope ?? null}, ${fileHead?.digest ?? null}, ${fileHead?.signature ?? null},
              ${fileHead ? auth.deviceId : null} WHERE ${previous}`,
        ]),
        sql`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id,
          name_ciphertext, order_ciphertext, key_envelope)
          SELECT ${input.nodeId}, ${accountId}, ${parentId}, ${input.nameCiphertext},
            ${input.orderCiphertext}, ${input.keyEnvelope} WHERE ${previous}`,
      ], accountId);
    return committed ? Response.json({ nodeId: input.nodeId, entriesRevision: input.expectedRevision + 1 },
      { status: 201, headers }) : changed();
  } catch { return badRequest(); }
}

async function renameChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["parentId", "expectedRevision", "nameCiphertext", "orderCiphertext", "listingHead"]) ||
      !isV7(input.parentId) || !validRevision(input.expectedRevision)) return badRequest();
  const parent = await authorizedDirectory(env, auth, input.parentId, "create");
  if (!parent) return notFound();
  const ownerId = parent.owner_id;
  if (parent.entries_revision !== input.expectedRevision) return changed();
  const row = await createDb(env.DB).get<{ parent_node_id: string }>(sql`
    SELECT n.parent_node_id FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${input.parentId}
      AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id AND ${accessPredicate(auth, nodeId, "structure")}`);
  if (!row) return structuralFailure(env, auth, [{ directoryId: input.parentId, expectedRevision: input.expectedRevision }], notFound());
  // The hidden root cannot be renamed.
  const parentId = row.parent_node_id;
  const blocked = sharingWriteBlocked(nodeId);
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
  let name: Uint8Array, order: Uint8Array;
  try {
    const context = { purpose: "directory-metadata" as const, vaultId: ownerId,
      objectId: nodeId, keyId: parentId, keyEpoch: parent.key_epoch, revision: 1 };
    name = treeEnvelope(input.nameCiphertext, 1024, context);
    order = treeEnvelope(input.orderCiphertext, 4096, context);
  } catch { return badRequest(); }
  let head: Awaited<ReturnType<typeof signedListing>>;
  try { head = await signedListing(input.listingHead, auth, parentId, input.expectedRevision as number, ownerId, parent.key_epoch); }
  catch { return badRequest(); }
  const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision as number, head,
    sql`${accessPredicate(auth, parentId, "create")} AND ${accessPredicate(auth, nodeId, "structure")} AND NOT ${blocked}
      AND EXISTS (SELECT 1 FROM directory_entries WHERE child_node_id = ${nodeId}
        AND owner_id = ${ownerId} AND parent_node_id = ${parentId})`,
    (previous) => [sql`UPDATE directory_entries SET name_ciphertext = ${name}, order_ciphertext = ${order}
      WHERE child_node_id = ${nodeId} AND owner_id = ${ownerId}
        AND parent_node_id = ${parentId} AND ${previous}`], ownerId);
  return committed ? Response.json({ entriesRevision: (input.expectedRevision as number) + 1 }, { headers }) : changed();
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value + 1);
}

async function authorizedDirectory(env: Env, auth: AuthorizedDevice, directoryId: string, operation: "read" | "create" = "read") {
  return createDb(env.DB).get<{ entries_revision: number; owner_id: string; key_epoch: number }>(sql`
    SELECT d.entries_revision, d.owner_id, d.key_epoch FROM directories d JOIN vault_nodes n ON n.id = d.node_id AND n.owner_id = d.owner_id
    WHERE d.node_id = ${directoryId} AND n.kind = 'directory' AND ${accessPredicate(auth, directoryId, operation)}`);
}

type ExpectedDirectory = { directoryId: string; expectedRevision: number };

/** A structural winner may land between a preflight revision read and a target
 * read/envelope validation. Recheck live, authorized namespaces before an early
 * 404/400; those interleavings must still get the nameless refresh conflict.
 */
async function structuralFailure(env: Env, auth: AuthorizedDevice, expected: ExpectedDirectory[], fallback: Response) {
  const changedSinceRead = await createDb(env.DB).get(sql`
    SELECT 1 FROM json_each(${JSON.stringify(expected)}) expected JOIN directories d
      ON d.node_id = json_extract(expected.value, '$.directoryId')
    WHERE d.entries_revision != json_extract(expected.value, '$.expectedRevision')
      AND ${accessPredicate(auth, sql`d.node_id`)} LIMIT 1`);
  return changedSinceRead ? changed() : fallback;
}

async function reorderChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["parentId", "expectedRevision", "orders", "listingHead"]) ||
      !isV7(input.parentId) || !validRevision(input.expectedRevision) || !Array.isArray(input.orders) ||
      input.orders.length < 1 || input.orders.length > 2) return badRequest();
  const parent = await authorizedDirectory(env, auth, input.parentId, "create");
  if (!parent) return notFound();
  if (parent.entries_revision !== input.expectedRevision) return changed();
  const parentId = input.parentId, ownerId = parent.owner_id;
  const blocked = sharingWriteBlocked(parentId);
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
  try {
    const orders = input.orders.map((value) => {
      const order = record(value);
      if (!order || !exact(order, ["nodeId", "orderCiphertext"]) || !isV7(order.nodeId)) throw new Error("invalid order");
      return { nodeId: order.nodeId, ciphertext: treeEnvelope(order.orderCiphertext, 4096, {
        purpose: "directory-metadata", vaultId: ownerId, objectId: order.nodeId,
        keyId: parentId, keyEpoch: parent.key_epoch, revision: 1,
      }) };
    });
    if (!orders.some((order) => order.nodeId === nodeId) || new Set(orders.map((order) => order.nodeId)).size !== orders.length) return badRequest();
    const members = sql.join(orders.map((order) => sql`${order.nodeId}`), sql`, `);
    const eligible = sql`(SELECT count(*) FROM directory_entries e JOIN vault_nodes n ON n.id = e.child_node_id
      AND n.owner_id = e.owner_id AND n.parent_node_id = e.parent_node_id
      WHERE e.owner_id = ${ownerId} AND e.parent_node_id = ${parentId}
        AND e.child_node_id IN (${members})) = ${orders.length}
      AND ${accessPredicate(auth, parentId, "create")}
      AND ${accessPredicate(auth, nodeId, "structure")} AND NOT ${blocked}`;
    if (!await createDb(env.DB).get(sql`SELECT 1 WHERE ${eligible} AND ${privateReadGuard(auth)}`)) {
      return structuralFailure(env, auth, [{ directoryId: parentId, expectedRevision: input.expectedRevision }], notFound());
    }
    const blockedOrders = sql.join(orders.map((order) => sharingWriteBlocked(order.nodeId)), sql` OR `);
    if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blockedOrders}`)) return rotationRequired();
    const head = await signedListing(input.listingHead, auth, parentId, input.expectedRevision, ownerId, parent.key_epoch);
    const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedRevision, head,
      sql`${eligible} AND NOT (${blockedOrders})`, (previous) => orders.map((order) => sql`UPDATE directory_entries SET order_ciphertext = ${order.ciphertext}
        WHERE child_node_id = ${order.nodeId} AND owner_id = ${ownerId}
          AND parent_node_id = ${parentId} AND ${previous}`), ownerId);
    return committed ? Response.json({ entriesRevision: input.expectedRevision + 1 }, { headers }) : changed();
  } catch { return badRequest(); }
}

async function moveChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || !exact(input, ["sourceId", "destinationId", "kind", "expectedSourceRevision", "expectedDestinationRevision",
      "nameCiphertext", "orderCiphertext", "keyEnvelope", "sourceListingHead", "destinationListingHead"]) ||
      !isV7(input.sourceId) || !isV7(input.destinationId) || input.sourceId === input.destinationId ||
      (input.kind !== "directory" && input.kind !== "file") ||
      !validRevision(input.expectedSourceRevision) || !validRevision(input.expectedDestinationRevision)) return badRequest();
  const sourceId = input.sourceId, destinationId = input.destinationId;
  const expected = [{ directoryId: sourceId, expectedRevision: input.expectedSourceRevision },
    { directoryId: destinationId, expectedRevision: input.expectedDestinationRevision }];
  const [source, destination] = await Promise.all([
    authorizedDirectory(env, auth, sourceId, "create"), authorizedDirectory(env, auth, destinationId, "create"),
  ]);
  if (!source || !destination || source.owner_id !== destination.owner_id) return notFound();
  const ownerId = source.owner_id;
  if (source.entries_revision !== input.expectedSourceRevision ||
      destination.entries_revision !== input.expectedDestinationRevision) return changed();
  const moveAuthority = moveAccessPredicate(auth, nodeId, destinationId);
  if (!await createDb(env.DB).get(sql`SELECT 1 WHERE ${moveAuthority}`)) {
    return structuralFailure(env, auth, expected, notFound());
  }
  const node = await createDb(env.DB).get<{ kind: string; key_epoch: number | null }>(sql`
    SELECT n.kind, d.key_epoch FROM vault_nodes n LEFT JOIN directories d ON d.node_id = n.id
    JOIN directory_entries e ON e.child_node_id = n.id
      AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
    WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId} AND n.parent_node_id = ${sourceId}
      AND ${moveAuthority}`);
  if (!node) return structuralFailure(env, auth, expected, notFound());
  if (node.kind !== input.kind) return structuralFailure(env, auth, expected, badRequest());
  const scopeExit = exitsSharedScope(nodeId, destinationId);
  const blocked = sql`${scopeExit} OR ${sharingWriteBlocked(nodeId)} OR ${sharingWriteBlocked(destinationId)}`;
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
  // Match the existing 100-edge private path bound. Never silently truncate
  // ancestry: an overflow or an unrooted chain fails closed, just like a cycle.
  const invalidLineage = sql`EXISTS (WITH RECURSIVE lineage(id) AS (
    SELECT ${destinationId} UNION
    SELECT n.parent_node_id FROM vault_nodes n JOIN lineage a ON n.id = a.id
    WHERE n.parent_node_id IS NOT NULL LIMIT 101
  ) SELECT 1 WHERE (SELECT count(*) FROM lineage) > 100
    OR EXISTS (SELECT 1 FROM lineage WHERE id = ${nodeId})
    OR NOT EXISTS (SELECT 1 FROM lineage a JOIN vault_nodes n ON n.id = a.id
      WHERE n.owner_id = ${ownerId} AND n.parent_node_id IS NULL))`;
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${invalidLineage}`)) return structuralFailure(env, auth, expected, badRequest());
  const file = input.kind === "file" ? await currentFile(env, auth, nodeId) : null;
  if (input.kind === "file" && !file) return structuralFailure(env, auth, expected, notFound());
  try {
    const metadata = { purpose: "directory-metadata" as const, vaultId: ownerId,
      objectId: nodeId, keyId: destinationId, keyEpoch: destination.key_epoch, revision: 1 };
    const name = treeEnvelope(input.nameCiphertext, 1024, metadata);
    const order = treeEnvelope(input.orderCiphertext, 4096, metadata);
    const keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, file?.capability_id ? {
      purpose: "file-capability", vaultId: ownerId, objectId: nodeId,
      keyId: file.capability_id, keyEpoch: file.capability_epoch!, revision: 1,
    } : file ? {
      purpose: "file-content-key", vaultId: ownerId, objectId: nodeId,
      keyId: file.content_key_id, keyEpoch: file.key_epoch, revision: file.revision,
    } : { purpose: "directory-capability", vaultId: ownerId, objectId: nodeId,
      keyId: nodeId, keyEpoch: node.key_epoch!, revision: 1 });
    const sourceHead = await signedListing(input.sourceListingHead, auth, sourceId, input.expectedSourceRevision, ownerId, source.key_epoch);
    const destinationHead = await signedListing(input.destinationListingHead, auth, destinationId, input.expectedDestinationRevision, ownerId, destination.key_epoch);
    const eligible = sql`EXISTS (SELECT 1 FROM vault_nodes n JOIN directory_entries e ON e.child_node_id = n.id
      AND e.owner_id = n.owner_id AND e.parent_node_id = n.parent_node_id
      WHERE n.id = ${nodeId} AND n.owner_id = ${ownerId} AND n.kind = ${input.kind}
        AND n.parent_node_id = ${sourceId}) AND NOT ${invalidLineage} AND ${moveAuthority} AND NOT (${blocked})`;
    const committed = await commitTreeMutation(env, auth, [
      { directoryId: sourceId, expectedRevision: input.expectedSourceRevision, head: sourceHead },
      { directoryId: destinationId, expectedRevision: input.expectedDestinationRevision, head: destinationHead },
    ], eligible, (committed) => [
      sql`UPDATE vault_nodes SET parent_node_id = ${destinationId}, updated_at = ${Date.now()}
        WHERE id = ${nodeId} AND owner_id = ${ownerId} AND parent_node_id = ${sourceId} AND ${committed}`,
      sql`UPDATE directory_entries SET parent_node_id = ${destinationId}, name_ciphertext = ${name},
          order_ciphertext = ${order}, key_envelope = ${keyEnvelope}
        WHERE child_node_id = ${nodeId} AND owner_id = ${ownerId} AND parent_node_id = ${sourceId} AND ${committed}`,
    ], ownerId);
    return committed ? Response.json({ sourceEntriesRevision: input.expectedSourceRevision + 1,
      destinationEntriesRevision: input.expectedDestinationRevision + 1 }, { headers }) : changed();
  } catch { return structuralFailure(env, auth, expected, badRequest()); }
}

const MAX_DELETE_NODES = 500;

/** Include the selected node in the cap. UNION deduplicates; LIMIT bounds the
 * recursive work as well as its output, including an unexpectedly wide tree.
 */
function deletionIds(nodeId: string) {
  return sql`WITH RECURSIVE subtree(id) AS (
    SELECT ${nodeId} UNION
    SELECT n.id FROM vault_nodes n JOIN subtree parent ON n.parent_node_id = parent.id
    LIMIT ${MAX_DELETE_NODES + 1}
  ) SELECT id FROM subtree`;
}

type DeletionNode = { id: string; kind: string; owner_id: string; parent_node_id: string | null;
  entries_revision: number | null; current_revision: number | null; current_representation_id: string | null;
  edge_parent: string | null; directory_owner: string | null; file_owner: string | null };

async function deleteChild(env: Env, auth: AuthorizedDevice, nodeId: string, value: unknown): Promise<Response> {
  const input = record(value);
  if (!input || (input.kind !== "directory" && input.kind !== "file") ||
      !exact(input, input.kind === "directory"
        ? ["parentId", "kind", "expectedRevision", "expectedDirectoryRevision", "listingHead"]
        : ["parentId", "kind", "expectedRevision", "listingHead"]) ||
      !isV7(input.parentId) || !validRevision(input.expectedRevision) ||
      (input.kind === "directory" && !validRevision(input.expectedDirectoryRevision))) return badRequest();
  const parent = await authorizedDirectory(env, auth, input.parentId, "create");
  if (!parent) return notFound();
  const ownerId = parent.owner_id;
  // Even a second same-revision delete is a namespace conflict, not a revealing
  // deleted-object response. The supplied parent must first be authorized.
  if (parent.entries_revision !== input.expectedRevision) return changed();
  const rows = await createDb(env.DB).all<DeletionNode>(sql`
    SELECT n.id, n.kind, n.owner_id, n.parent_node_id, d.entries_revision, f.current_revision,
      f.current_representation_id, e.parent_node_id AS edge_parent,
      d.owner_id AS directory_owner, f.owner_id AS file_owner
    FROM vault_nodes n LEFT JOIN directories d ON d.node_id = n.id
    LEFT JOIN files f ON f.node_id = n.id
    LEFT JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id
    WHERE n.id IN (${deletionIds(nodeId)}) AND ${privateReadGuard(auth)}
      AND EXISTS (SELECT 1 FROM vault_nodes root WHERE root.id = ${nodeId}
        AND root.owner_id = ${ownerId} AND root.parent_node_id = ${input.parentId})
      AND ${accessPredicate(auth, nodeId, "structure")}`);
  if (!rows.length) return structuralFailure(env, auth, [{ directoryId: input.parentId, expectedRevision: input.expectedRevision }], notFound());
  const root = rows.find((row) => row.id === nodeId)!;
  if (root.kind !== input.kind) return badRequest();
  if (input.kind === "directory" && root.entries_revision !== input.expectedDirectoryRevision) return changed();
  if (rows.some((row) => row.owner_id !== ownerId || row.parent_node_id === null ||
      row.edge_parent !== row.parent_node_id || (row.kind === "directory"
        ? row.directory_owner !== ownerId || row.entries_revision === null
        : row.kind !== "file" || row.file_owner !== ownerId || row.current_revision === null || !row.current_representation_id))) {
    return notFound();
  }
  if (rows.length > MAX_DELETE_NODES) return Response.json({ error: "directory_too_large", maxNodes: MAX_DELETE_NODES }, { status: 413, headers });
  try {
    const head = await signedListing(input.listingHead, auth, input.parentId, input.expectedRevision, ownerId, parent.key_epoch);
    const snapshot = JSON.stringify(rows);
    const ids = sql`SELECT json_extract(value, '$.id') FROM json_each(${snapshot})`;
    // Pin the full enumerated graph, all Directory revisions, and File pointers.
    // Descendant inserts, moves, renames, saves or deletions after enumeration
    // make the first CAS lose; no proof, head, envelope or node can then change.
    const eligible = sql`${accessPredicate(auth, input.parentId, "create")} AND ${accessPredicate(auth, nodeId, "structure")}
      AND (SELECT count(*) FROM (${deletionIds(nodeId)})) = ${rows.length}
      AND NOT EXISTS (SELECT 1 FROM json_each(${snapshot}) expected
        LEFT JOIN vault_nodes n ON n.id = json_extract(expected.value, '$.id') AND n.owner_id = ${ownerId}
        LEFT JOIN directories d ON d.node_id = n.id AND d.owner_id = n.owner_id
        LEFT JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
        LEFT JOIN directory_entries e ON e.child_node_id = n.id AND e.owner_id = n.owner_id
        WHERE n.id IS NULL OR n.kind IS NOT json_extract(expected.value, '$.kind')
          OR n.parent_node_id IS NOT json_extract(expected.value, '$.parent_node_id') OR e.parent_node_id IS NOT n.parent_node_id
          OR d.entries_revision IS NOT json_extract(expected.value, '$.entries_revision')
          OR f.current_revision IS NOT json_extract(expected.value, '$.current_revision')
          OR f.current_representation_id IS NOT json_extract(expected.value, '$.current_representation_id'))`;
    const committed = await commitTreeMutation(env, auth, [
      { directoryId: input.parentId, expectedRevision: input.expectedRevision, head },
    ], eligible, (committed) => [
      sql`DELETE FROM key_rotation_entries WHERE (child_id IN (${ids}) OR directory_id IN (${ids})
        OR job_id IN (SELECT id FROM crypto_jobs WHERE target_id IN (${ids}))) AND ${committed}`,
      sql`DELETE FROM key_rotation_items WHERE (object_id IN (${ids}) OR file_id IN (${ids})
        OR job_id IN (SELECT id FROM crypto_jobs WHERE target_id IN (${ids}))) AND ${committed}`,
      sql`DELETE FROM key_rotation_receipts WHERE job_id IN (SELECT id FROM crypto_jobs WHERE target_id IN (${ids})) AND ${committed}`,
      sql`DELETE FROM crypto_jobs WHERE target_id IN (${ids}) AND account_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM share_key_envelopes WHERE relationship_id IN
        (SELECT id FROM shares WHERE target_id IN (${ids}) AND owner_id = ${ownerId}) AND ${committed}`,
      sql`DELETE FROM grant_key_envelopes WHERE relationship_id IN
        (SELECT id FROM grants WHERE target_id IN (${ids}) AND owner_id = ${ownerId}) AND ${committed}`,
      sql`DELETE FROM share_comment_key_envelopes WHERE object_id IN
        (SELECT object_id FROM sharing_comment_capabilities WHERE file_id IN (${ids}) AND owner_id = ${ownerId}) AND ${committed}`,
      sql`DELETE FROM grant_comment_key_envelopes WHERE object_id IN
        (SELECT object_id FROM sharing_comment_capabilities WHERE file_id IN (${ids}) AND owner_id = ${ownerId}) AND ${committed}`,
      sql`DELETE FROM provisioning_needs WHERE grant_id IN
        (SELECT id FROM grants WHERE target_id IN (${ids}) AND owner_id = ${ownerId}) AND ${committed}`,
      sql`DELETE FROM sharing_comment_capabilities WHERE file_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      retireDeletedScopeNeeds(ownerId, nodeId, committed),
      sql`DELETE FROM shares WHERE target_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM grants WHERE target_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM sharing_write_blocks WHERE target_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM directory_entries WHERE child_node_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM key_envelopes WHERE object_id IN (${ids}) AND account_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM file_representations WHERE file_node_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM files WHERE node_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM directories WHERE node_id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
      sql`DELETE FROM vault_nodes WHERE id IN (${ids}) AND owner_id = ${ownerId} AND ${committed}`,
    ], ownerId);
    return committed ? Response.json({ entriesRevision: input.expectedRevision + 1 }, { headers }) : changed();
  } catch { return badRequest(); }
}

type Capability = { id: string; epoch: number };
function fileCapability(value: unknown): Capability {
  const input = record(value);
  if (!input || !exact(input, ["id", "epoch"]) || !isV7(input.id) || !validRevision(input.epoch)) {
    throw new Error("invalid file capability");
  }
  return { id: input.id, epoch: input.epoch };
}

async function signedFileHead(value: unknown, auth: AuthorizedDevice, identity: Omit<FileHeadIdentity, "deviceId">) {
  const input = record(value);
  if (!input || !exact(input, ["digest", "signature"]) ||
      !await verifyFileHead(auth.assertionPublicKey, { ...identity, deviceId: auth.deviceId }, input as FileHead)) {
    throw new Error("invalid file head");
  }
  return { digest: decodeTreeBytes(input.digest, 32), signature: decodeTreeBytes(input.signature, 64) };
}

const fileChanged = () => Response.json({ error: "file_changed" }, { status: 409, headers });
const capabilityChanged = () => Response.json({ error: "capability_changed" }, { status: 409, headers });

/** Convert opaque wrappers, not content: the browser's parent and File heads
 * pin one wholly legacy snapshot before the proof-gated namespace CAS.
 */
async function convertFileCapability(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const current = await currentFile(env, auth, fileId);
  if (!current || !current.can_edit || !await authorizedDirectory(env, auth, current.parent_node_id, "create")) return notFound();
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "expectedRepresentationId", "expectedParentRevision", "capability",
      "keyEnvelope", "representationKeyEnvelope", "fileHead", "listingHead"]) || !validRevision(input.expectedRevision) ||
      !isV7(input.expectedRepresentationId) || !validRevision(input.expectedParentRevision)) return badRequest();
  if (current.capability_id) return capabilityChanged();
  if (current.revision !== input.expectedRevision || current.representation_id !== input.expectedRepresentationId) return fileChanged();
  const parentId = current.parent_node_id, ownerId = current.owner_id;
  const blocked = sharingWriteBlocked(fileId);
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
  try {
    const capability = fileCapability(input.capability);
    if (capability.epoch !== 1) return badRequest();
    const keyEnvelope = treeEnvelope(input.keyEnvelope, 16_384, { purpose: "file-capability", vaultId: ownerId,
      objectId: fileId, keyId: capability.id, keyEpoch: 1, revision: 1 });
    const representationKeyEnvelope = treeEnvelope(input.representationKeyEnvelope, 16_384, {
      purpose: "file-content-key", vaultId: ownerId, objectId: fileId, keyId: current.content_key_id,
      keyEpoch: current.key_epoch, revision: current.revision,
    });
    if (inspectEnvelope(keyEnvelope).suite !== SYMMETRIC_SUITE ||
        inspectEnvelope(representationKeyEnvelope).suite !== SYMMETRIC_SUITE) return badRequest();
    const fileHead = await signedFileHead(input.fileHead, auth, { vaultId: ownerId, fileId,
      capabilityId: capability.id, capabilityEpoch: 1, representationId: current.representation_id,
      contentKeyId: current.content_key_id, keyEpoch: current.key_epoch, revision: current.revision,
      ciphertext: encodeTreeBytes(new Uint8Array(current.ciphertext)), keyEnvelope: input.representationKeyEnvelope as string });
    const head = await signedListing(input.listingHead, auth, parentId, input.expectedParentRevision, ownerId);
    const committed = await commitDirectoryMutation(env, auth, parentId, input.expectedParentRevision, head,
      sql`${accessPredicate(auth, parentId, "create")} AND ${accessPredicate(auth, fileId, "edit")} AND NOT ${blocked}
        AND EXISTS (SELECT 1 FROM files f JOIN vault_nodes n ON n.id = f.node_id AND n.owner_id = f.owner_id
          JOIN file_representations r ON r.id = f.current_representation_id AND r.file_node_id = f.node_id AND r.owner_id = f.owner_id
          JOIN directory_entries e ON e.child_node_id = f.node_id AND e.parent_node_id = n.parent_node_id AND e.owner_id = f.owner_id
          WHERE f.node_id = ${fileId} AND f.owner_id = ${ownerId} AND f.current_revision = ${current.revision}
            AND f.current_representation_id = ${current.representation_id} AND f.capability_id IS NULL AND f.capability_epoch IS NULL
            AND r.content_key_id = ${current.content_key_id} AND r.key_epoch = ${current.key_epoch}
            AND n.parent_node_id = ${parentId} AND e.key_envelope = ${new Uint8Array(current.key_envelope)})`, (marker) => [
        sql`UPDATE files SET capability_id = ${capability.id}, capability_epoch = 1 WHERE node_id = ${fileId} AND ${marker}`,
        sql`UPDATE file_representations SET key_envelope = ${representationKeyEnvelope}, head_digest = ${fileHead.digest},
          head_signature = ${fileHead.signature}, head_device_id = ${auth.deviceId} WHERE id = ${current.representation_id} AND ${marker}`,
        sql`UPDATE directory_entries SET key_envelope = ${keyEnvelope} WHERE child_node_id = ${fileId}
          AND owner_id = ${ownerId} AND parent_node_id = ${parentId} AND ${marker}`,
      ], ownerId);
    return committed ? Response.json({ capability, revision: current.revision,
      entriesRevision: input.expectedParentRevision + 1 }, { headers }) : changed();
  } catch { return badRequest(); }
}

/** The stable capability replaces the parent namespace as the wrapping scope.
 * Live authority, the root epoch and exact previous pointer are checked in the
 * first File CAS; only its fresh invocation marker can install/remove rows.
 */
async function saveConvertedFile(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown, current: FileRow): Promise<Response> {
  const input = record(value), repr = record(input?.representation);
  if (!input || !repr || !exact(input, ["expectedRevision", "expectedRepresentationId", "capability", "representation"]) ||
      !exact(repr, ["id", "contentKeyId", "keyEpoch", "revision", "ciphertext", "keyEnvelope", "fileHead"]) ||
      !validRevision(input.expectedRevision) || !isV7(input.expectedRepresentationId) || !isV7(repr.id) || !isV7(repr.contentKeyId) ||
      !validRevision(current.key_epoch) || repr.revision !== input.expectedRevision + 1) return badRequest();
  let capability: Capability;
  try { capability = fileCapability(input.capability); } catch { return badRequest(); }
  if (capability.id !== current.capability_id || capability.epoch !== current.capability_epoch) return capabilityChanged();
  if (input.expectedRevision !== current.revision || input.expectedRepresentationId !== current.representation_id) return fileChanged();
  if (repr.id === current.representation_id || repr.contentKeyId === current.content_key_id || repr.keyEpoch !== current.key_epoch + 1) return badRequest();
  const ownerId = current.owner_id, revision = input.expectedRevision + 1;
  const keyEpoch = repr.keyEpoch as number, representationId = repr.id, contentKeyId = repr.contentKeyId;
  const blocked = sharingWriteBlocked(fileId);
  try {
    const context = { vaultId: ownerId, objectId: fileId, keyId: contentKeyId, keyEpoch, revision };
    const ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES, { ...context, purpose: "file-content" });
    const keyEnvelope = treeEnvelope(repr.keyEnvelope, 16_384, { ...context, purpose: "file-content-key" });
    const head = await signedFileHead(repr.fileHead, auth, { vaultId: ownerId, fileId,
      capabilityId: capability.id, capabilityEpoch: capability.epoch, representationId, contentKeyId, keyEpoch, revision,
      ciphertext: repr.ciphertext as string, keyEnvelope: repr.keyEnvelope as string });
    const committed = await commitPrivateBatch(env, auth, (guard) => sql`
      UPDATE files SET current_revision = ${revision}, current_representation_id = ${representationId}
      WHERE node_id = ${fileId} AND owner_id = ${ownerId} AND current_revision = ${input.expectedRevision}
        AND current_representation_id = ${input.expectedRepresentationId} AND capability_id = ${capability.id}
        AND capability_epoch = ${capability.epoch} AND ${accessPredicate(auth, fileId, "edit")} AND NOT ${blocked} AND ${guard}
        AND EXISTS (SELECT 1 FROM file_representations r WHERE r.id = files.current_representation_id
          AND r.file_node_id = files.node_id AND r.owner_id = files.owner_id AND r.revision = files.current_revision
          AND r.content_key_id = ${current.content_key_id} AND r.key_epoch = ${current.key_epoch})`, (marker) => [
      sql`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch,
        ciphertext, ciphertext_size, created_at, key_envelope, head_digest, head_signature, head_device_id)
        SELECT ${representationId}, ${fileId}, ${ownerId}, ${revision}, ${contentKeyId}, ${keyEpoch},
          ${ciphertext}, ${ciphertext.length}, ${Date.now()}, ${keyEnvelope}, ${head.digest}, ${head.signature}, ${auth.deviceId} WHERE ${marker}`,
      sql`DELETE FROM file_representations WHERE id = ${current.representation_id} AND file_node_id = ${fileId}
        AND owner_id = ${ownerId} AND ${marker} AND NOT EXISTS (SELECT 1 FROM files WHERE current_representation_id = ${current.representation_id})`,
    ]);
    if (committed) return Response.json({ revision, representationId, capability }, { headers });
    if (auth.expiresAt <= Date.now() || await createDb(env.DB).get(sql`SELECT 1 FROM device_proof_uses
      WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId}`)) return denied();
    const latest = await currentFile(env, auth, fileId);
    if (!latest || !latest.can_edit) return notFound();
    if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
    if (latest.capability_id !== capability.id || latest.capability_epoch !== capability.epoch) return capabilityChanged();
    return latest.revision !== input.expectedRevision || latest.representation_id !== input.expectedRepresentationId ? fileChanged() : denied();
  } catch { return badRequest(); }
}

async function saveFile(env: Env, auth: AuthorizedDevice, fileId: string, value: unknown): Promise<Response> {
  const current = await currentFile(env, auth, fileId);
  if (!current || !current.can_edit) return notFound();
  const accountId = current.owner_id;
  const blocked = sharingWriteBlocked(fileId);
  if (await createDb(env.DB).get(sql`SELECT 1 WHERE ${blocked}`)) return rotationRequired();
  if (current.capability_id) return saveConvertedFile(env, auth, fileId, value, current);
  // Legacy direct writers remain fail-closed until an authorized browser
  // converts the parent-wrapped key under its signed namespace.
  if (!current.has_directory_access || !await authorizedDirectory(env, auth, current.parent_node_id, "create")) {
    return Response.json({ error: "shared_content_provisioning_required" }, { status: 409, headers });
  }
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
  let expectedParentId: string;
  try {
    const context = inspectEnvelope(decodeTreeBytes(record(input.listingHead)?.ciphertext, MAX_LISTING_BYTES)).context;
    if (context.purpose !== "directory-metadata" || context.vaultId !== accountId ||
        context.objectId !== context.keyId) return badRequest();
    expectedParentId = context.objectId;
  } catch { return badRequest(); }
  // A move can win before this File preflight or while its save is being
  // validated. The requested signed head pins the draft's original parent.
  if (current.parent_node_id !== expectedParentId) return changed();
  const expected = [{ directoryId: expectedParentId, expectedRevision: expectedParentRevision }];
  if (current.revision !== expectedRevision) return Response.json({ error: "file_changed" }, { status: 409, headers });
  if (repr.id === current.representation_id || repr.contentKeyId === current.content_key_id ||
      repr.keyEpoch !== current.key_epoch + 1) return badRequest();
  let keyEnvelope: Uint8Array, ciphertext: Uint8Array;
  let head: Awaited<ReturnType<typeof signedListing>>;
  try {
    const context = { vaultId: accountId, objectId: fileId, keyId: repr.contentKeyId as string,
      keyEpoch: repr.keyEpoch as number, revision: expectedRevision + 1 };
    keyEnvelope = treeEnvelope(input.keyEnvelope, 1024, { ...context, purpose: "file-content-key" });
    ciphertext = treeEnvelope(repr.ciphertext, MAX_REPRESENTATION_BYTES, { ...context, purpose: "file-content" });
    head = await signedListing(input.listingHead, auth, current.parent_node_id, expectedParentRevision, accountId);
  } catch { return structuralFailure(env, auth, expected, badRequest()); }
  try {
    const committed = await commitDirectoryMutation(env, auth, current.parent_node_id, expectedParentRevision, head,
      sql`${accessPredicate(auth, fileId, "edit")} AND ${accessPredicate(auth, current.parent_node_id, "create")} AND NOT ${blocked}
        AND EXISTS (SELECT 1 FROM files f JOIN file_representations r ON r.id = f.current_representation_id
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
      ], accountId);
    if (committed) return Response.json({ revision: expectedRevision + 1, entriesRevision: expectedParentRevision + 1 }, { headers });
    // A competing File save can win after the initial read. Never invite a namespace retry for a stale draft.
    if (auth.expiresAt <= Date.now() || await createDb(env.DB).get(sql`
      SELECT 1 FROM device_proof_uses WHERE account_id = ${auth.accountId} AND proof_id = ${auth.proofId}`)) return denied();
    const latest = await currentFile(env, auth, fileId);
    if (!latest) return structuralFailure(env, auth, expected, denied());
    if (latest.parent_node_id !== expectedParentId) return changed();
    return latest.revision !== expectedRevision || latest.representation_id !== current.representation_id ||
      latest.content_key_id !== current.content_key_id || latest.key_epoch !== current.key_epoch
      ? Response.json({ error: "file_changed" }, { status: 409, headers }) : changed();
  } catch { return structuralFailure(env, auth, expected, badRequest()); }
}

/** Resource-only tree API; every private read is a proof-guarded, bodyless POST. */
export async function treeAction(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const directory = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)$/.exec(path);
  const create = /^\/api\/private\/tree\/directories\/([0-9a-f-]+)\/children$/.exec(path);
  const file = /^\/api\/private\/tree\/files\/([0-9a-f-]+)$/.exec(path);
  const capability = /^\/api\/private\/tree\/files\/([0-9a-f-]+)\/capability$/.exec(path);
  const rename = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/name$/.exec(path);
  const reorder = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/order$/.exec(path);
  const move = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/parent$/.exec(path);
  const remove = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)$/.exec(path);
  const pathToNode = /^\/api\/private\/tree\/nodes\/([0-9a-f-]+)\/ancestors$/.exec(path);
  if (!(directory || create || file || capability || rename || reorder || move || remove || pathToNode) ||
      !((directory || file || pathToNode) && request.method === "POST" || (create || capability) && request.method === "PUT" ||
        (rename || reorder || move || file) && request.method === "PATCH" || remove && request.method === "DELETE")) return notFound();
  const nodeId = (directory || create || file || capability || rename || reorder || move || remove || pathToNode)![1]!;
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
  if (capability) return convertFileCapability(env, auth, nodeId, value);
  if (create) return createChild(env, auth, nodeId, value);
  if (reorder) return reorderChild(env, auth, nodeId, value);
  if (move) return moveChild(env, auth, nodeId, value);
  if (remove) return deleteChild(env, auth, nodeId, value);
  return renameChild(env, auth, nodeId, value);
}
