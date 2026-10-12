import { env, SELF } from "cloudflare:test";
import { createSymmetricWriter, inspectEnvelope, openSymmetric } from "../../app/shared/crypto/enc-v1";
import {
  createChildDirectoryCapability,
  createFileRepresentation,
  generateDirectoryCapabilityKey,
} from "../../app/shared/crypto/vault";
import { signDeviceProof, sessionBindingDigest, type DeviceProof } from "../../app/shared/device/proof";
import { authorizePrivateRequest } from "../../app/device/proof.server";
import { createListingHead, type SealedEntry } from "../../app/shared/tree/listing";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/shared/tree/wire";
import { seedNormalSession } from "./auth-fixtures";
import { createFileHead } from "../../app/shared/tree/file-head";
import {
  createGrantKeyEnvelope,
  openGrantKeyEnvelope,
  type GrantKeyContext,
} from "../../app/shared/sharing/grant-keys";

export function opaqueId(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}

export async function sharingAccount() {
  const accountId = opaqueId(),
    shareId = opaqueId(),
    rootId = opaqueId(),
    deviceId = opaqueId(),
    credentialId = opaqueId();
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      accountId,
      shareId,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)",
    ).bind(credentialId, accountId, now, now),
    env.DB.prepare(
      "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
    ).bind(accountId, rootId),
    env.DB.prepare(
      "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)",
    ).bind(
      deviceId,
      accountId,
      new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)),
      now,
    ),
  ]);
  const session = await seedNormalSession({ accountId, credentialIds: [credentialId] });
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(deviceId, session.id).run();
  return {
    accountId,
    shareId,
    rootId,
    deviceId,
    assertion,
    transport,
    session,
    registryEpoch: 1,
    proofs: new Map<string, DeviceProof>(),
    keys: new Map<string, Uint8Array>([[rootId, generateDirectoryCapabilityKey()]]),
  };
}
export type SharingAccount = Awaited<ReturnType<typeof sharingAccount>>;

/** Simulated approved membership at the external registry boundary. */
export async function addSharingDevice(account: SharingAccount) {
  const deviceId = opaqueId();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const next = account.registryEpoch + 1;
  await env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key,
    state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'routine', ?, ?)`)
    .bind(
      deviceId,
      account.accountId,
      new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)),
      next,
      Date.now(),
    )
    .run();
  account.registryEpoch = next;
  return { deviceId, transport, assertion };
}

export async function sharingRequest(
  account: SharingAccount,
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  value?: object,
  proofId?: string,
) {
  const url = `https://mdwn.test${path}`;
  const body = value === undefined ? undefined : JSON.stringify(value);
  const proof =
    (proofId && account.proofs.get(proofId)) ||
    (await signDeviceProof(account.assertion.privateKey, {
      sessionBinding: await sessionBindingDigest(account.session.id),
      deviceId: account.deviceId,
      registryEpoch: account.registryEpoch,
      method,
      url,
      body,
    }));
  if (proofId) account.proofs.set(proofId, proof);
  return SELF.fetch(url, {
    method,
    headers: {
      cookie: account.session.cookie,
      origin: "https://mdwn.test",
      // Real Workers requests always carry the edge address; network-scoped abuse
      // limits fail closed without it.
      "CF-Connecting-IP": "203.0.113.7",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
}

export async function sharingAuthorization(account: SharingAccount) {
  const url = "https://mdwn.test/api/private/grants";
  const proof = await signDeviceProof(account.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(account.session.id),
    deviceId: account.deviceId,
    registryEpoch: account.registryEpoch,
    method: "POST",
    url,
  });
  const auth = await authorizePrivateRequest(
    new Request(url, {
      method: "POST",
      headers: {
        cookie: account.session.cookie,
      },
    }),
    env,
    proof,
  );
  if (!auth) throw new Error("fixture authorization failed");
  return auth;
}

export async function treeListing(account: SharingAccount, directoryId: string) {
  const response = await sharingRequest(account, `/api/private/tree/directories/${directoryId}`);
  if (!response.ok) throw new Error(`listing failed: ${response.status}`);
  return response.json() as Promise<{ entriesRevision: number; entries: SealedEntry[] }>;
}

export async function treeChild(
  actor: SharingAccount,
  parentId: string,
  kind: "directory" | "file",
  ownerId = actor.accountId,
  converted = false,
) {
  const nodeId = opaqueId(),
    key = actor.keys.get(parentId)!;
  const listing = await treeListing(actor, parentId);
  const writer = await createSymmetricWriter(key);
  const context = {
    purpose: "directory-metadata" as const,
    vaultId: ownerId,
    objectId: nodeId,
    keyId: parentId,
    keyEpoch: 1,
    revision: 1,
  };
  const metadata = {
    nameCiphertext: encodeTreeBytes(await writer.seal(new TextEncoder().encode(`${kind}.md`), context)),
    orderCiphertext: encodeTreeBytes(await writer.seal(new TextEncoder().encode(nodeId), context)),
  };
  const child =
    kind === "directory"
      ? await createChildDirectoryCapability(key, {
          vaultId: ownerId,
          parentDirectoryId: parentId,
          childDirectoryId: nodeId,
        })
      : null;
  const capability = converted && kind === "file" ? { id: opaqueId(), epoch: 1 } : null;
  const fileCapabilityKey = capability ? generateDirectoryCapabilityKey() : null;
  const file =
    kind === "file"
      ? await createFileRepresentation(
          fileCapabilityKey ?? key,
          { markdown: "# private", metadata: new Uint8Array() },
          {
            vaultId: ownerId,
            fileId: nodeId,
          },
        )
      : null;
  const keyEnvelope = encodeTreeBytes(
    capability
      ? await writer.seal(fileCapabilityKey!, {
          purpose: "file-capability",
          vaultId: ownerId,
          objectId: nodeId,
          keyId: capability.id,
          keyEpoch: 1,
          revision: 1,
        })
      : child
        ? child.envelope
        : file!.fileContentKeyEnvelope,
  );
  const representationId = opaqueId();
  const fileHead = capability
    ? await createFileHead(actor.assertion.privateKey, {
        vaultId: ownerId,
        fileId: nodeId,
        capabilityId: capability.id,
        capabilityEpoch: 1,
        representationId,
        contentKeyId: nodeId,
        keyEpoch: 1,
        revision: 1,
        deviceId: actor.deviceId,
        ciphertext: encodeTreeBytes(file!.contentEnvelope),
        keyEnvelope: encodeTreeBytes(file!.fileContentKeyEnvelope),
      })
    : null;
  const entry = { nodeId, kind, ...metadata, keyEnvelope };
  const listingHead = await createListingHead(key, actor.assertion.privateKey, {
    vaultId: ownerId,
    directoryId: parentId,
    deviceId: actor.deviceId,
    revision: listing.entriesRevision + 1,
    entries: [...listing.entries, entry],
  });
  const response = await sharingRequest(actor, `/api/private/tree/directories/${parentId}/children`, "PUT", {
    ...entry,
    expectedRevision: listing.entriesRevision,
    listingHead,
    ...(capability ? { capability } : {}),
    ...(file
      ? {
          representation: {
            id: representationId,
            contentKeyId: nodeId,
            keyEpoch: 1,
            revision: 1,
            ciphertext: encodeTreeBytes(file.contentEnvelope),
            ...(capability ? { keyEnvelope: encodeTreeBytes(file.fileContentKeyEnvelope), fileHead } : {}),
          },
        }
      : {}),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  if (fileCapabilityKey) actor.keys.set(nodeId, fileCapabilityKey);
  if (child)
    actor.keys.set(
      nodeId,
      await openSymmetric(decodeTreeBytes(keyEnvelope), key, {
        context: {
          purpose: "directory-capability",
          vaultId: ownerId,
          objectId: nodeId,
          keyId: nodeId,
          keyEpoch: 1,
          revision: 1,
        },
      }),
    );
  return nodeId;
}

export async function renamePayload(
  actor: SharingAccount,
  ownerId: string,
  nodeId: string,
  parentId: string,
  name = "renamed.md",
) {
  const listing = await treeListing(actor, parentId);
  const writer = await createSymmetricWriter(actor.keys.get(parentId)!);
  const context = {
    purpose: "directory-metadata" as const,
    vaultId: ownerId,
    objectId: nodeId,
    keyId: parentId,
    keyEpoch: 1,
    revision: 1,
  };
  const nameCiphertext = encodeTreeBytes(await writer.seal(new TextEncoder().encode(name), context));
  const orderCiphertext = encodeTreeBytes(await writer.seal(new TextEncoder().encode("last"), context));
  return {
    parentId,
    expectedRevision: listing.entriesRevision,
    nameCiphertext,
    orderCiphertext,
    listingHead: await createListingHead(actor.keys.get(parentId)!, actor.assertion.privateKey, {
      vaultId: ownerId,
      directoryId: parentId,
      deviceId: actor.deviceId,
      revision: listing.entriesRevision + 1,
      entries: listing.entries.map((entry) =>
        entry.nodeId === nodeId ? { ...entry, nameCiphertext, orderCiphertext } : entry,
      ),
    }),
  };
}

export async function movePayload(
  actor: SharingAccount,
  ownerId: string,
  nodeId: string,
  sourceId: string,
  destinationId: string,
) {
  const source = await treeListing(actor, sourceId),
    destination = await treeListing(actor, destinationId);
  const entry = source.entries.find((entry) => entry.nodeId === nodeId)!;
  const context = inspectEnvelope(decodeTreeBytes(entry.keyEnvelope)).context;
  const key = await openSymmetric(decodeTreeBytes(entry.keyEnvelope), actor.keys.get(sourceId)!, { context });
  const writer = await createSymmetricWriter(actor.keys.get(destinationId)!);
  const metadata = {
    purpose: "directory-metadata" as const,
    vaultId: ownerId,
    objectId: nodeId,
    keyId: destinationId,
    keyEpoch: 1,
    revision: 1,
  };
  const updated = {
    ...entry,
    nameCiphertext: encodeTreeBytes(await writer.seal(new TextEncoder().encode("moved.md"), metadata)),
    orderCiphertext: encodeTreeBytes(await writer.seal(new TextEncoder().encode("last"), metadata)),
    keyEnvelope: encodeTreeBytes(await writer.seal(key, context)),
  };
  return {
    sourceId,
    destinationId,
    kind: entry.kind,
    expectedSourceRevision: source.entriesRevision,
    expectedDestinationRevision: destination.entriesRevision,
    nameCiphertext: updated.nameCiphertext,
    orderCiphertext: updated.orderCiphertext,
    keyEnvelope: updated.keyEnvelope,
    sourceListingHead: await createListingHead(actor.keys.get(sourceId)!, actor.assertion.privateKey, {
      vaultId: ownerId,
      directoryId: sourceId,
      deviceId: actor.deviceId,
      revision: source.entriesRevision + 1,
      entries: source.entries.filter((entry) => entry.nodeId !== nodeId),
    }),
    destinationListingHead: await createListingHead(actor.keys.get(destinationId)!, actor.assertion.privateKey, {
      vaultId: ownerId,
      directoryId: destinationId,
      deviceId: actor.deviceId,
      revision: destination.entriesRevision + 1,
      entries: [...destination.entries, updated],
    }),
  };
}

export async function savePayload(
  actor: SharingAccount,
  ownerId: string,
  fileId: string,
  parentId: string,
  markdown = "# saved by Collaborator",
) {
  const response = await sharingRequest(actor, `/api/private/tree/files/${fileId}`);
  const current = (await response.json()) as {
    revision: number;
    keyEpoch: number;
    representationId: string;
    keyEnvelope?: string;
    capability?: { id: string; epoch: number };
  };
  if (current.capability) {
    const key =
      actor.keys.get(fileId) ??
      (await openSymmetric(decodeTreeBytes(current.keyEnvelope), actor.keys.get(parentId)!, {
        context: {
          purpose: "file-capability",
          vaultId: ownerId,
          objectId: fileId,
          keyId: current.capability.id,
          keyEpoch: current.capability.epoch,
          revision: 1,
        },
      }));
    const contentKeyId = opaqueId(),
      id = opaqueId(),
      keyEpoch = current.keyEpoch + 1,
      revision = current.revision + 1;
    const file = await createFileRepresentation(
      key,
      { markdown, metadata: new Uint8Array() },
      { vaultId: ownerId, fileId, keyId: contentKeyId, keyEpoch, revision },
    );
    const ciphertext = encodeTreeBytes(file.contentEnvelope),
      keyEnvelope = encodeTreeBytes(file.fileContentKeyEnvelope);
    const fileHead = await createFileHead(actor.assertion.privateKey, {
      vaultId: ownerId,
      fileId,
      capabilityId: current.capability.id,
      capabilityEpoch: current.capability.epoch,
      representationId: id,
      contentKeyId,
      keyEpoch,
      revision,
      deviceId: actor.deviceId,
      ciphertext,
      keyEnvelope,
    });
    return {
      expectedRevision: current.revision,
      expectedRepresentationId: current.representationId,
      capability: current.capability,
      representation: { id, contentKeyId, keyEpoch, revision, ciphertext, keyEnvelope, fileHead },
    };
  }
  const listing = await treeListing(actor, parentId);
  const contentKeyId = opaqueId();
  const file = await createFileRepresentation(
    actor.keys.get(parentId)!,
    {
      markdown,
      metadata: new Uint8Array(),
    },
    { vaultId: ownerId, fileId, keyId: contentKeyId, keyEpoch: current.keyEpoch + 1, revision: current.revision + 1 },
  );
  const keyEnvelope = encodeTreeBytes(file.fileContentKeyEnvelope);
  return {
    expectedRevision: current.revision,
    expectedParentRevision: listing.entriesRevision,
    keyEnvelope,
    representation: {
      id: opaqueId(),
      contentKeyId,
      keyEpoch: current.keyEpoch + 1,
      revision: current.revision + 1,
      ciphertext: encodeTreeBytes(file.contentEnvelope),
    },
    listingHead: await createListingHead(actor.keys.get(parentId)!, actor.assertion.privateKey, {
      vaultId: ownerId,
      directoryId: parentId,
      deviceId: actor.deviceId,
      revision: listing.entriesRevision + 1,
      entries: listing.entries.map((entry) => (entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry)),
    }),
  };
}

export async function deletePayload(actor: SharingAccount, ownerId: string, nodeId: string, parentId: string) {
  const parent = await treeListing(actor, parentId);
  const entry = parent.entries.find((entry) => entry.nodeId === nodeId)!;
  return {
    parentId,
    kind: entry.kind,
    expectedRevision: parent.entriesRevision,
    ...(entry.kind === "directory"
      ? { expectedDirectoryRevision: (await treeListing(actor, nodeId)).entriesRevision }
      : {}),
    listingHead: await createListingHead(actor.keys.get(parentId)!, actor.assertion.privateKey, {
      vaultId: ownerId,
      directoryId: parentId,
      deviceId: actor.deviceId,
      revision: parent.entriesRevision + 1,
      entries: parent.entries.filter((entry) => entry.nodeId !== nodeId),
    }),
  };
}

export async function convertFixtureFile(owner: SharingAccount, fileId: string) {
  const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`);
  if (!response.ok) return; // A Directory target is not a File.
  const current = (await response.json()) as {
    ownerId: string;
    parentId: string;
    revision: number;
    representationId: string;
    contentKeyId: string;
    keyEpoch: number;
    ciphertext: string;
    keyEnvelope: string;
    capability?: { id: string; epoch: number };
  };
  if (current.ownerId !== owner.accountId) return;
  const parentKey = owner.keys.get(current.parentId)!;
  if (current.capability) {
    owner.keys.set(
      fileId,
      await openSymmetric(decodeTreeBytes(current.keyEnvelope), parentKey, {
        context: {
          purpose: "file-capability",
          vaultId: owner.accountId,
          objectId: fileId,
          keyId: current.capability.id,
          keyEpoch: current.capability.epoch,
          revision: 1,
        },
      }),
    );
    return;
  }
  const listing = await treeListing(owner, current.parentId);
  const key = generateDirectoryCapabilityKey(),
    capability = { id: opaqueId(), epoch: 1 };
  const contentContext = {
    purpose: "file-content-key" as const,
    vaultId: owner.accountId,
    objectId: fileId,
    keyId: current.contentKeyId,
    keyEpoch: current.keyEpoch,
    revision: current.revision,
  };
  const contentKey = await openSymmetric(decodeTreeBytes(current.keyEnvelope), parentKey, { context: contentContext });
  const keyEnvelope = encodeTreeBytes(
    await (await createSymmetricWriter(parentKey)).seal(key, {
      purpose: "file-capability",
      vaultId: owner.accountId,
      objectId: fileId,
      keyId: capability.id,
      keyEpoch: 1,
      revision: 1,
    }),
  );
  const representationKeyEnvelope = encodeTreeBytes(
    await (await createSymmetricWriter(key)).seal(contentKey, contentContext),
  );
  const fileHead = await createFileHead(owner.assertion.privateKey, {
    vaultId: owner.accountId,
    fileId,
    capabilityId: capability.id,
    capabilityEpoch: 1,
    representationId: current.representationId,
    contentKeyId: current.contentKeyId,
    keyEpoch: current.keyEpoch,
    revision: current.revision,
    deviceId: owner.deviceId,
    ciphertext: current.ciphertext,
    keyEnvelope: representationKeyEnvelope,
  });
  const listingHead = await createListingHead(parentKey, owner.assertion.privateKey, {
    vaultId: owner.accountId,
    directoryId: current.parentId,
    deviceId: owner.deviceId,
    revision: listing.entriesRevision + 1,
    entries: listing.entries.map((entry) => (entry.nodeId === fileId ? { ...entry, keyEnvelope } : entry)),
  });
  const converted = await sharingRequest(owner, `/api/private/tree/files/${fileId}/capability`, "PUT", {
    expectedRevision: current.revision,
    expectedRepresentationId: current.representationId,
    expectedParentRevision: listing.entriesRevision,
    capability,
    keyEnvelope,
    representationKeyEnvelope,
    fileHead,
    listingHead,
  });
  if (!converted.ok) throw new Error(`conversion failed: ${converted.status}`);
  owner.keys.set(fileId, key);
}

/** Basic acceptance covers every device in one pinned current snapshot. */
export async function prepareGrantKeys(
  owner: SharingAccount,
  relationshipId: string,
  kind: "shares" | "grants" = "shares",
) {
  let cursor: string | null = null;
  do {
    const path = `/api/private/${kind}/${relationshipId}/keys`;
    const response = await sharingRequest(owner, `${path}${cursor ? `?cursor=${cursor}` : ""}`);
    if (!response.ok) throw new Error(`delivery targets failed: ${response.status}`);
    const targets = (await response.json()) as GrantKeyContext & {
      devices: { deviceId: string; transportPublicKey: string }[];
      nextCursor: string | null;
    };
    const envelopes = await Promise.all(
      targets.devices.map(async (device) =>
        createGrantKeyEnvelope(
          owner.keys.get(targets.targetId)!,
          await crypto.subtle.importKey(
            "raw",
            decodeTreeBytes(device.transportPublicKey, 65),
            { name: "ECDH", namedCurve: "P-256" },
            true,
            [],
          ),
          owner.assertion.privateKey,
          { ...targets, deviceId: device.deviceId, signerDeviceId: owner.deviceId },
        ),
      ),
    );
    const uploaded = await sharingRequest(owner, path, "PUT", {
      capabilityId: targets.capabilityId,
      capabilityEpoch: targets.capabilityEpoch,
      ownerRegistryEpoch: targets.ownerRegistryEpoch,
      recipientRegistryEpoch: targets.recipientRegistryEpoch,
      envelopes,
    });
    if (!uploaded.ok) throw new Error(`delivery upload failed: ${uploaded.status}`);
    cursor = targets.nextCursor;
  } while (cursor);
}

/** An imported Historical thread: its key is wrapped under the File capability, with no recovery row. */
export async function importedThread(
  owner: SharingAccount,
  fileId: string,
  threadOwner = owner,
  threadFileId = fileId,
) {
  const threadId = opaqueId(),
    epochId = opaqueId(),
    capabilityId = opaqueId(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    env.DB.prepare(`INSERT INTO comment_thread_epochs (id, thread_id, audience, key_epoch, ordinal, state, created_at)
      VALUES (?, ?, NULL, 1, 1, 'active', ?)`).bind(epochId, threadId, now),
    env.DB.prepare(`INSERT INTO comment_threads (id, owner_id, file_id, purpose, publication_id, current_epoch_id,
      next_sequence, created_at) VALUES (?, ?, ?, 'private', NULL, ?, 1, ?)`).bind(
      threadId,
      threadOwner.accountId,
      threadFileId,
      epochId,
      now,
    ),
    env.DB.prepare(`INSERT INTO sharing_comment_capabilities
      (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      VALUES (?, ?, ?, ?, 'private-comment-thread', NULL, ?, 1)`).bind(
      threadId,
      owner.accountId,
      fileId,
      threadId,
      capabilityId,
    ),
    env.DB.prepare(`INSERT INTO import_comment_envelopes
      (thread_id, file_id, capability_id, capability_epoch, key_epoch, ciphertext) VALUES (?, ?, ?, 1, 1, ?)`).bind(
      threadId,
      threadFileId,
      capabilityId,
      new Uint8Array(40).fill(9),
    ),
  ]);
  return { objectId: threadId, capabilityId };
}

export async function invite(
  owner: SharingAccount,
  recipient: SharingAccount,
  targetId: string,
  permission: "read_only" | "read_write" = "read_only",
) {
  await convertFixtureFile(owner, targetId);
  const response = await sharingRequest(owner, "/api/private/shares", "PUT", {
    targetId,
    recipient: { shareId: recipient.shareId },
    permission,
  });
  if (response.status !== 201) throw new Error(`invite failed: ${response.status}`);
  return response.json() as Promise<{ shareId: string }>;
}

export async function grant(
  owner: SharingAccount,
  recipient: SharingAccount,
  targetId: string,
  permission: "read_only" | "read_write" = "read_only",
) {
  const share = await invite(owner, recipient, targetId, permission);
  await prepareGrantKeys(owner, share.shareId);
  const response = await sharingRequest(recipient, `/api/private/shares/${share.shareId}/accept`, "POST", {});
  if (response.status !== 201) throw new Error(`accept failed: ${response.status}`);
  const granted = (await response.json()) as { grantId: string };
  const envelope = (await (
    await sharingRequest(recipient, `/api/private/grants/${granted.grantId}/keys`)
  ).json()) as Parameters<typeof openGrantKeyEnvelope>[0];
  recipient.keys.set(targetId, await openGrantKeyEnvelope({ ...envelope, recipient: recipient.transport }));
  return granted;
}
