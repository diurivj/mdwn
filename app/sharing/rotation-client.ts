import { publicAttributionKeyContext, publicCommentKeyContext } from "~/comments/public-content";
import { createSymmetricWriter, openSymmetric } from "~/crypto/enc-v1";
import { openDeviceEnrollmentEnvelope } from "~/crypto/vault";
import { privateRequest } from "~/device/private-client";
import { getDevice } from "~/device/store";
import { newOpaqueId } from "~/opaque-id";
import { createListingHead, openDirectoryListing, openListingMembers, assertListingMember, rememberListing, type SealedEntry } from "~/tree/listing";
import { createFileHead, verifyFileHead } from "~/tree/file-head";
import { rememberFile } from "~/tree/file-capability-client";
import { decodeTreeBytes, encodeTreeBytes } from "~/tree/wire";
import { createGrantKeyEnvelope, type GrantKeyContext } from "./grant-keys";
import { createCommentKeyEnvelope, type CommentKeyContext } from "./comment-keys";
import { rotationResumeContext, rotationSourceVersion, type RotationDirectory, type RotationEntries, type RotationFile, type RotationItem,
  type RotationJob, type RotationNext, type RotationSource } from "./rotation-wire";

/** Browser-held crypto and a proof-bound external API transport; no plaintext is persisted. */
export type RotationBrowser = { accountId: string; deviceId: string; vaultRootKey: Uint8Array; assertionKey: CryptoKey;
  request(path: string, method?: "POST" | "PATCH" | "PUT", body?: object): Promise<Response> };
type Options = { maxSteps?: number; signal?: AbortSignal; onProgress?: (job: RotationJob) => void };
type Directory = RotationDirectory & { entries: SealedEntry[] };

async function json<T>(browser: RotationBrowser, path: string, method: "POST" | "PATCH" | "PUT" = "POST", body?: object): Promise<T> {
  const response = await browser.request(path, method, body);
  if (!response.ok) throw new Error(response.status === 409 ? "Secure access changed. Refresh and resume the update." : "Secure access update unavailable.");
  return response.json() as Promise<T>;
}
const epoch = (value: number) => { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid capability epoch"); return value; };
const cryptoContext = (accountId: string, purpose: "directory-capability" | "file-capability" | "file-content-key", objectId: string,
  keyId: string, keyEpoch: number, revision = 1) => ({ purpose, vaultId: accountId, objectId, keyId, keyEpoch: epoch(keyEpoch), revision });

async function directory(browser: RotationBrowser, directoryId: string, key: Uint8Array): Promise<Directory> {
  const listing = await json<{ directoryId: string; keyEpoch?: number; entriesRevision: number; entries: SealedEntry[];
    listingHead: RotationDirectory["listingHead"] }>(browser, `/api/private/tree/directories/${directoryId}`);
  if (listing.directoryId !== directoryId || !Array.isArray(listing.entries)) throw new Error("Invalid Directory");
  const keyEpoch = epoch(listing.keyEpoch ?? 1);
  await openDirectoryListing(key, { vaultId: browser.accountId, directoryId, keyEpoch, revision: listing.entriesRevision,
    entries: listing.entries, head: listing.listingHead ? { ...listing.listingHead,
      signerPublicKey: decodeTreeBytes(listing.listingHead.signerPublicKey, 65) } : null });
  return { kind: "directory", objectId: directoryId, parentId: null, keyEpoch, entriesRevision: listing.entriesRevision,
    listingHead: listing.listingHead, entries: listing.entries };
}

/** Reopen the installed hierarchy, rather than assuming another tab's cached key is current. */
async function resolveDirectory(browser: RotationBrowser, nodeId: string) {
  const boot = await json<{ rootDirectoryId: string; rootRecoveryEnvelope: string; rootKeyEpoch?: number }>(browser, "/api/private/bootstrap");
  let key = await openSymmetric(decodeTreeBytes(boot.rootRecoveryEnvelope), browser.vaultRootKey, { context: {
    purpose: "vault-recovery", vaultId: browser.accountId, objectId: boot.rootDirectoryId, keyId: boot.rootDirectoryId,
    keyEpoch: epoch(boot.rootKeyEpoch ?? 1), revision: 1,
  } });
  const path = await json<{ ancestors: string[] }>(browser, `/api/private/tree/nodes/${nodeId}/ancestors`);
  if (!Array.isArray(path.ancestors) || path.ancestors[0] !== boot.rootDirectoryId || path.ancestors.at(-1) !== nodeId || path.ancestors.length > 101)
    throw new Error("Invalid owned path");
  for (let index = 0; index < path.ancestors.length - 1; index++) {
    const listing = await directory(browser, path.ancestors[index]!, key);
    const id = path.ancestors[index + 1]!, entry = listing.entries.find((candidate) => candidate.nodeId === id);
    if (!entry || entry.kind !== "directory") throw new Error("Invalid owned path");
    key = await openSymmetric(decodeTreeBytes(entry.keyEnvelope), key, {
      context: cryptoContext(browser.accountId, "directory-capability", id, id, entry.keyEpoch ?? 1),
    });
  }
  return { key, listing: await directory(browser, nodeId, key) };
}

async function sourceKey(browser: RotationBrowser, source: RotationSource): Promise<Uint8Array<ArrayBuffer>> {
  if (source.kind === "directory") return (await resolveDirectory(browser, source.objectId)).key;
  if (source.kind === "file") {
    const parent = await resolveDirectory(browser, source.parentId);
    if (!parent.listing.entries.some((entry) => entry.nodeId === source.objectId && entry.keyEnvelope === source.keyEnvelope)) throw new Error("Changed File edge");
    return source.capability ? openSymmetric(decodeTreeBytes(source.keyEnvelope), parent.key, { context:
      cryptoContext(browser.accountId, "file-capability", source.objectId, source.capability.id, source.capability.epoch) }) : parent.key;
  }
  if (!source.recoveryEnvelope) throw new Error("Current Comment key is not available on this device. The update remains sealed.");
  return openSymmetric(decodeTreeBytes(source.recoveryEnvelope, 16_384), browser.vaultRootKey, { context: {
    purpose: "vault-recovery", vaultId: browser.accountId, objectId: source.objectId, keyId: source.capabilityId,
    keyEpoch: source.capabilityEpoch, revision: 1,
  } });
}

async function replacementKey(browser: RotationBrowser, job: RotationJob, item: RotationItem) {
  if (!item.resumeEnvelope || !item.targetEpoch) throw new Error("Missing rotation checkpoint");
  // Job IDs supply a separate authenticated namespace. Every sealing pass uses
  // a fresh enc-v1 writer; counters/salts are never persisted or restored.
  return openSymmetric(decodeTreeBytes(item.resumeEnvelope, 16_384), browser.vaultRootKey,
    { context: rotationResumeContext(browser.accountId, job.jobId, item.objectId, item.targetEpoch) });
}

async function start(browser: RotationBrowser, next: RotationNext) {
  const { item, source, job } = next;
  if (!item || !source || !item.targetEpoch) throw new Error("Invalid rotation step");
  // A retained Public Comment audience epoch is not a future audience key:
  // only its device envelopes change. A current Collaborators-only epoch
  // (item.rotate) advances in place so a revoked device's key cannot read
  // what follows.
  const currentComment = item.kind === "public_history" || item.kind === "private_comment" ? await sourceKey(browser, source) : null;
  if (currentComment && currentComment.length !== 32) throw new Error("Invalid current Comment key");
  const key = item.kind === "public_history" && !item.rotate ? currentComment! : crypto.getRandomValues(new Uint8Array(32));
  const resumeEnvelope = encodeTreeBytes(await (await createSymmetricWriter(browser.vaultRootKey)).seal(key,
    rotationResumeContext(browser.accountId, job.jobId, item.objectId, item.targetEpoch)));
  return { operation: "start", operationId: newOpaqueId(), objectId: item.objectId, sourceEpoch: item.sourceEpoch,
    sourceRevision: rotationSourceVersion(source).revision,
    targetEpoch: item.targetEpoch, capabilityId: item.capabilityId ?? newOpaqueId(), resumeEnvelope,
    ...(source.kind === "file" ? { sourceRepresentationId: source.representationId } : {}) };
}

type RotationCommentPage = { records: { recordId: string; kind: "comment" | "attribution"; revision: number;
  contentKeyEnvelope: string }[]; nextCursor: string | null };

/** Open each current per-record wrapper with the installed thread capability and
 * reseal the unchanged content key beneath the replacement capability. Body and
 * pseudonym ciphertext never change, so history and exact retries stay stable. */
async function stageComments(browser: RotationBrowser, next: RotationNext) {
  const { item, source, job } = next;
  if (!item || !source || !item.targetEpoch || !item.capabilityId || item.sourceEpoch === null) throw new Error("Invalid Comment step");
  const oldKey = await sourceKey(browser, source), key = await replacementKey(browser, job, item);
  const page = await json<RotationCommentPage>(browser,
    `/api/private/key-rotations/${job.jobId}/items/${item.objectId}/comment-items${item.cursor ? `?cursor=${item.cursor}` : ""}`);
  if (page.records.length < 1 || page.records.length > 20) throw new Error("Invalid Comment page");
  // Public Comment contexts bind the logical Publication, never the Owner Vault.
  const vaultId = source.kind === "public_history" ? source.publicationId! : browser.accountId;
  const writer = await createSymmetricWriter(key), records = [];
  for (const record of page.records) {
    const context = source.kind === "public_history"
      ? record.kind === "comment"
        ? publicCommentKeyContext(vaultId, record.recordId, item.capabilityId, item.sourceEpoch, record.revision)
        : publicAttributionKeyContext(vaultId, record.recordId, item.capabilityId, item.sourceEpoch, record.revision)
      : { purpose: record.kind === "comment" ? "comment-content" as const : "attribution" as const,
        vaultId, objectId: record.recordId, keyId: item.capabilityId,
        keyEpoch: item.sourceEpoch, revision: record.revision };
    const contentKey = await openSymmetric(decodeTreeBytes(record.contentKeyEnvelope, 16_384), oldKey, { context });
    if (contentKey.length !== 32) throw new Error("Invalid Comment content key");
    records.push({ recordId: record.recordId, kind: record.kind, revision: record.revision,
      contentKeyEnvelope: encodeTreeBytes(await writer.seal(contentKey, { ...context, keyEpoch: item.targetEpoch })) });
  }
  return { operation: "stage", operationId: newOpaqueId(), objectId: item.objectId, cursor: item.cursor, records };
}

async function stage(browser: RotationBrowser, next: RotationNext) {
  const { item, source, job } = next;
  if (source?.kind === "private_comment" || source?.kind === "public_history" && item?.rotate) {
    return stageComments(browser, next);
  }
  if (!item || source?.kind !== "directory") throw new Error("Invalid Directory step");
  const oldKey = await sourceKey(browser, source), key = await replacementKey(browser, job, item);
  const page = await json<RotationEntries>(browser, `/api/private/key-rotations/${job.jobId}/items/${item.objectId}/entries${item.cursor ? `?cursor=${item.cursor}` : ""}`);
  if (page.entries.length < 1 || page.entries.length > 20 || !source.listingHead) throw new Error("Invalid Directory page");
  const members = await openListingMembers(oldKey, { vaultId: browser.accountId, directoryId: item.objectId,
    keyEpoch: source.keyEpoch, revision: source.entriesRevision,
    head: { ...source.listingHead, signerPublicKey: decodeTreeBytes(source.listingHead.signerPublicKey, 65) } });
  rememberListing(browser.accountId, item.objectId, source.entriesRevision, source.listingHead.digest);
  const writer = await createSymmetricWriter(key), entries = [];
  for (const entry of page.entries) {
    await assertListingMember(entry, members);
    const before = { purpose: "directory-metadata" as const, vaultId: browser.accountId, objectId: entry.nodeId,
      keyId: item.objectId, keyEpoch: source.keyEpoch, revision: 1 };
    const name = await openSymmetric(decodeTreeBytes(entry.nameCiphertext), oldKey, { context: before });
    const order = await openSymmetric(decodeTreeBytes(entry.orderCiphertext), oldKey, { context: before });
    let context;
    if (entry.kind === "directory") context = cryptoContext(browser.accountId, "directory-capability", entry.nodeId, entry.nodeId, entry.keyEpoch ?? 1);
    else {
      const file = await json<{ capability?: { id: string; epoch: number }; contentKeyId: string; keyEpoch: number; revision: number }>(browser,
        `/api/private/tree/files/${entry.nodeId}`);
      context = file.capability ? cryptoContext(browser.accountId, "file-capability", entry.nodeId, file.capability.id, file.capability.epoch)
        : cryptoContext(browser.accountId, "file-content-key", entry.nodeId, file.contentKeyId, file.keyEpoch, file.revision);
    }
    const child = await openSymmetric(decodeTreeBytes(entry.keyEnvelope, 16_384), oldKey, { context });
    if (child.length !== 32) throw new Error("Invalid child key");
    entries.push({ nodeId: entry.nodeId, nameCiphertext: encodeTreeBytes(await writer.seal(name, { ...before, keyEpoch: item.targetEpoch! })),
      orderCiphertext: encodeTreeBytes(await writer.seal(order, { ...before, keyEpoch: item.targetEpoch! })),
      keyEnvelope: encodeTreeBytes(await writer.seal(child, context)) });
  }
  return { operation: "stage", operationId: newOpaqueId(), objectId: item.objectId, cursor: item.cursor, entries };
}

async function promote(browser: RotationBrowser, next: RotationNext) {
  const { job, item, source } = next;
  if (!item || !source || !item.targetEpoch || !item.capabilityId) throw new Error("Invalid promotion");
  const key = await replacementKey(browser, job, item);
  const recoveryEnvelope = encodeTreeBytes(await (await createSymmetricWriter(browser.vaultRootKey)).seal(key, {
    purpose: "vault-recovery", vaultId: browser.accountId, objectId: item.objectId, keyId: item.capabilityId, keyEpoch: item.targetEpoch, revision: 1,
  }));
  const common = { operation: "promote", operationId: newOpaqueId(), objectId: item.objectId, recoveryEnvelope };
  if (source.kind === "private_comment" || source.kind === "public_history") return common;
  let parent = null, keyEnvelope = recoveryEnvelope;
  if (source.parentId) {
    const current = await resolveDirectory(browser, source.parentId);
    keyEnvelope = encodeTreeBytes(await (await createSymmetricWriter(current.key)).seal(key,
      cryptoContext(browser.accountId, source.kind === "directory" ? "directory-capability" : "file-capability", item.objectId, item.capabilityId, item.targetEpoch)));
    if (!current.listing.entries.some((entry) => entry.nodeId === item.objectId)) throw new Error("Changed parent");
    parent = { directoryId: source.parentId, keyEpoch: current.listing.keyEpoch, expectedRevision: current.listing.entriesRevision,
      listingHead: await createListingHead(current.key, browser.assertionKey, { vaultId: browser.accountId,
        directoryId: source.parentId, keyEpoch: current.listing.keyEpoch, deviceId: browser.deviceId,
        revision: current.listing.entriesRevision + 1, entries: current.listing.entries.map((entry) => entry.nodeId === item.objectId ? { ...entry, keyEnvelope } : entry) }) };
  }
  if (source.kind === "directory") {
    const entries: SealedEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: RotationEntries = await json(browser, `/api/private/key-rotations/${job.jobId}/items/${item.objectId}/entries?staged=1${cursor ? `&cursor=${cursor}` : ""}`);
      if (page.entries.length > 20 || page.nextCursor && page.nextCursor === cursor) throw new Error("Invalid staged page");
      entries.push(...page.entries); cursor = page.nextCursor;
      // Even minimum-sized v1 member commitments cannot fit more than this in
      // the existing 512-KiB listing envelope. Never silently truncate a listing.
      if (entries.length > 8192) throw new Error("Directory listing exceeds its encrypted limit. The update remains sealed.");
    } while (cursor);
    return { ...common, parent, keyEnvelope, listingHead: await createListingHead(key, browser.assertionKey, {
      vaultId: browser.accountId, directoryId: item.objectId, keyEpoch: item.targetEpoch,
      deviceId: browser.deviceId, revision: source.entriesRevision + 1, entries }) };
  }
  const oldKey = await sourceKey(browser, source);
  if (source.capability) {
    if (!source.fileHead || !source.representationKeyEnvelope || !await verifyFileHead(decodeTreeBytes(source.fileHead.signerPublicKey, 65), {
      vaultId: browser.accountId, fileId: item.objectId, capabilityId: source.capability.id, capabilityEpoch: source.capability.epoch,
      representationId: source.representationId, contentKeyId: source.contentKeyId, keyEpoch: source.keyEpoch, revision: source.revision,
      deviceId: source.fileHead.signerDeviceId, ciphertext: source.ciphertext, keyEnvelope: source.representationKeyEnvelope,
    }, source.fileHead)) throw new Error("Invalid source File head");
    rememberFile(browser.accountId, item.objectId, source.capability.epoch, source.revision, source.fileHead.digest);
  }
  const context = cryptoContext(browser.accountId, "file-content-key", item.objectId, source.contentKeyId, source.keyEpoch, source.revision);
  const contentKey = await openSymmetric(decodeTreeBytes(source.capability ? source.representationKeyEnvelope : source.keyEnvelope, 16_384), oldKey, { context });
  if (contentKey.length !== 32) throw new Error("Invalid content key");
  const representationKeyEnvelope = encodeTreeBytes(await (await createSymmetricWriter(key)).seal(contentKey, context));
  const representationId = newOpaqueId();
  return { ...common, parent, keyEnvelope, representationId, representationKeyEnvelope,
    fileHead: await createFileHead(browser.assertionKey, { vaultId: browser.accountId, fileId: item.objectId,
      capabilityId: item.capabilityId, capabilityEpoch: item.targetEpoch, representationId, contentKeyId: source.contentKeyId,
      keyEpoch: source.keyEpoch, revision: source.revision, deviceId: browser.deviceId, ciphertext: source.ciphertext, keyEnvelope: representationKeyEnvelope }) };
}

function rememberPromotion(browser: RotationBrowser, item: RotationItem, source: RotationSource, packet: Awaited<ReturnType<typeof promote>>) {
  if ("parent" in packet && packet.parent) rememberListing(browser.accountId, packet.parent.directoryId,
    packet.parent.expectedRevision + 1, packet.parent.listingHead.digest);
  if (source.kind === "directory" && "listingHead" in packet) rememberListing(browser.accountId, item.objectId,
    source.entriesRevision + 1, packet.listingHead.digest);
  if (source.kind === "file" && "fileHead" in packet) rememberFile(browser.accountId, item.objectId,
    item.targetEpoch!, source.revision, packet.fileHead.digest);
}

async function deliver(browser: RotationBrowser, next: RotationNext) {
  const path = `/api/private/key-rotations/${next.job.jobId}/grants/${next.grantId}/${next.commentObjectId ? `comment-keys/${next.commentObjectId}` : "keys"}`;
  const targets = await json<(GrantKeyContext | CommentKeyContext) & { devices: { deviceId: string; transportPublicKey: string }[] }>(browser, path);
  if (targets.devices.length > 20) throw new Error("Invalid delivery targets");
  if (!targets.devices.length) return;
  let key: Uint8Array;
  if (next.commentObjectId) {
    const source = await json<RotationSource>(browser, `/api/private/key-rotations/${next.job.jobId}/comments/${next.commentObjectId}`);
    key = await sourceKey(browser, source);
  } else if (targets.targetKind === "directory") key = (await resolveDirectory(browser, targets.targetId)).key;
  else {
    const file = await json<{ parentId: string; capability: { id: string; epoch: number }; keyEnvelope: string }>(browser,
      `/api/private/tree/files/${targets.targetId}`);
    const parent = await resolveDirectory(browser, file.parentId);
    key = await openSymmetric(decodeTreeBytes(file.keyEnvelope), parent.key, {
      context: cryptoContext(browser.accountId, "file-capability", targets.targetId, file.capability.id, file.capability.epoch) });
  }
  const envelopes = [];
  for (const device of targets.devices) {
    const publicKey = await crypto.subtle.importKey("raw", decodeTreeBytes(device.transportPublicKey, 65), { name: "ECDH", namedCurve: "P-256" }, true, []);
    const context = { ...targets, deviceId: device.deviceId, signerDeviceId: browser.deviceId };
    envelopes.push(next.commentObjectId ? await createCommentKeyEnvelope(key, publicKey, browser.assertionKey, context as CommentKeyContext & { deviceId: string; signerDeviceId: string })
      : await createGrantKeyEnvelope(key, publicKey, browser.assertionKey, context));
  }
  await json(browser, path, "PUT", { capabilityId: targets.capabilityId, capabilityEpoch: targets.capabilityEpoch,
    ownerRegistryEpoch: targets.ownerRegistryEpoch, recipientRegistryEpoch: targets.recipientRegistryEpoch, envelopes });
}

/** One pass performs bounded packets. After interruption another enrolled Owner
 * device opens the encrypted checkpoint and continues with fresh writer namespaces. */
export async function resumeRotation(jobId: string, browser: RotationBrowser, options: Options = {}): Promise<boolean> {
  const maxSteps = options.maxSteps ?? 20;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error("Invalid rotation bound");
  for (let step = 0; step < maxSteps; step++) {
    options.signal?.throwIfAborted();
    const next = await json<RotationNext>(browser, `/api/private/key-rotations/${jobId}/next`);
    if (next.job.jobId !== jobId) throw new Error("Invalid rotation job");
    options.onProgress?.(next.job);
    if (next.operation === "complete") return true;
    if (next.operation === "deliver") { await deliver(browser, next); continue; }
    const promotion = next.operation === "promote" ? await promote(browser, next) : null;
    const packet = next.operation === "start" ? await start(browser, next) : next.operation === "stage" ? await stage(browser, next)
      : promotion ?? (next.operation === "finish"
        ? { operation: "finish", operationId: newOpaqueId() } : next.operation === "restart" || next.operation === "advance"
          ? { operation: next.operation, operationId: newOpaqueId(), objectId: next.item?.objectId } : null);
    if (!packet) throw new Error("Invalid rotation operation");
    options.signal?.throwIfAborted();
    await json(browser, `/api/private/key-rotations/${jobId}/step`, "PATCH", packet);
    if (promotion && next.item && next.source) rememberPromotion(browser, next.item, next.source, promotion);
  }
  return false;
}

/** Production adapter: device handles and Vault keys are loaded only in the browser. */
export async function resumeKeyRotation(jobId: string, options: Options = {}) {
  const stateResponse = await fetch("/api/device/state", { cache: "no-store", signal: options.signal });
  if (!stateResponse.ok) throw new Error("Device state unavailable");
  const state = await stateResponse.json() as { accountId: string; deviceId: string };
  const device = await getDevice(state.accountId);
  if (!device || device.deviceId !== state.deviceId) throw new Error("An enrolled device is required");
  const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal: options.signal });
  if (!response.ok) throw new Error("Private access unavailable");
  const boot = await response.json() as { enrollmentEnvelope: string };
  const vaultRootKey = await openDeviceEnrollmentEnvelope(decodeTreeBytes(boot.enrollmentEnvelope), device.transportKeyPair, {
    purpose: "device-enrollment", vaultId: state.accountId, objectId: state.deviceId, keyId: state.deviceId,
    keyEpoch: 1, revision: 1, recipientId: state.deviceId,
  });
  return resumeRotation(jobId, { accountId: state.accountId, deviceId: state.deviceId, vaultRootKey, assertionKey: device.assertionKeyPair.privateKey,
    request: (path, method = "POST", body) => privateRequest(path, { method, signal: options.signal, ...(body ? { body: JSON.stringify(body) } : {}) }) }, options);
}
