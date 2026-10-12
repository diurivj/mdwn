import { openImportedThreadCapability } from "~/shared/comments/comments-client";
import { PrivateAccessError, privateExchange } from "~/shared/device/private-client";
import type { StoredDevice } from "~/shared/device/store";
import { decodeTreeBytes, isV7 } from "~/shared/tree/wire";
import { createCommentKeyEnvelope, type CommentKeyContext } from "./comment-keys";
import { createGrantKeyEnvelope, type GrantKeyContext } from "./grant-keys";
import { openOwnedCommentKey, ownedFileCapabilityKey, ownedKey } from "./owned-capabilities";
import {
  KeyRotationRequiredError,
  readAllPages,
  SharingChangedError,
  throwSharingFailure,
  SharingNotFoundError,
  SharingPageLimitError,
} from "./relationships-client";
import { uploadSaved } from "./saved-upload";

/**
 * Prepare secure access for a pending Share (see docs/sharing.md): the Owner's
 * device stages a signed HPKE Grant envelope, and an envelope for every
 * required Comment capability, for each current recipient device. The server
 * upserts pending envelopes, so running a pass again is always safe; nothing
 * about progress is stored locally.
 */

/** The server's per-request envelope bound. */
export const MAX_ENVELOPES_PER_PACKET = 20;
/** Every read, upload and owned-key bootstrap of one pass counts against this bound. */
export const MAX_PASS_REQUESTS = 2_000;

export type SharePreparationReason =
  | "changed"
  | "not-found"
  | "sealed"
  | "missing-source"
  | "too-large"
  | "unavailable";

/** Pending Shares the Sharing page prepares by itself on each visit. */
export const AUTOMATIC_PREPARATIONS = 5;

/** The newest pending Shares first (opaque v7 identifiers sort by creation time), bounded per visit. */
export function selectAutomaticPreparations(shareIds: readonly string[], limit = AUTOMATIC_PREPARATIONS): string[] {
  return [...new Set(shareIds)].sort().reverse().slice(0, limit);
}

/** A preparation pass that cannot finish, with the reason a person can act on. */
export class SharePreparationError extends Error {
  constructor(readonly reason: SharePreparationReason) {
    super(`share preparation ${reason}`);
    this.name = "SharePreparationError";
  }
}

export type SharePreparationProgress = { prepared: number; total: number };
export type SharePreparationResult = { devices: number; envelopes: number; commentCapabilities: number };

type Snapshot = Pick<
  GrantKeyContext,
  "relationshipId" | "targetId" | "grantKeyEpoch" | "ownerRegistryEpoch" | "recipientRegistryEpoch"
>;
type DeviceTarget = { deviceId: string; transportPublicKey: string };
type Targets<C> = C & { devices: DeviceTarget[]; nextCursor: string | null };
type CommentSource = { kind: "recovery" | "import"; envelope: string };
type CommentTargets = Targets<CommentKeyContext> & { source?: CommentSource };

export function packets<T>(items: readonly T[], size = MAX_ENVELOPES_PER_PACKET): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** One pass pins one relationship, Grant epoch and pair of registry epochs. */
export function sameSnapshot(pass: Snapshot, context: Snapshot): boolean {
  return (
    context.relationshipId === pass.relationshipId &&
    context.targetId === pass.targetId &&
    context.grantKeyEpoch === pass.grantKeyEpoch &&
    context.ownerRegistryEpoch === pass.ownerRegistryEpoch &&
    context.recipientRegistryEpoch === pass.recipientRegistryEpoch
  );
}

export class WorkBudget {
  private used = 0;
  constructor(private readonly limit = MAX_PASS_REQUESTS) {}
  spend() {
    if (++this.used > this.limit) throw new SharePreparationError("too-large");
  }
}

/** A `409 sharing_changed` restarts the whole pass once with fresh targets. */
export async function restartOnce<T>(pass: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await pass();
  } catch (error) {
    if (signal?.aborted || !(error instanceof SharingChangedError)) throw error;
  }
  try {
    return await pass();
  } catch (error) {
    if (!signal?.aborted && error instanceof SharingChangedError) throw new SharePreparationError("changed");
    throw error;
  }
}

function invalid(): never {
  throw new SharePreparationError("unavailable");
}

function targets<C extends Snapshot>(value: unknown): Targets<C> {
  const body = value as Targets<C> | null;
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray(body.devices) ||
    body.devices.length > MAX_ENVELOPES_PER_PACKET ||
    !body.devices.every((device) => isV7(device?.deviceId) && typeof device.transportPublicKey === "string") ||
    (body.nextCursor !== null && !isV7(body.nextCursor))
  )
    invalid();
  return body;
}

async function importTransport(encoded: string) {
  return crypto.subtle.importKey("raw", decodeTreeBytes(encoded, 65), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

async function pass(
  shareId: string,
  options: { signal?: AbortSignal; onProgress?: (progress: SharePreparationProgress) => void },
): Promise<SharePreparationResult> {
  const { signal } = options;
  const budget = new WorkBudget();
  const base = `/api/private/shares/${shareId}`;
  let device: StoredDevice | null = null;
  const read = async (path: string) => {
    signal?.throwIfAborted();
    budget.spend();
    const exchange = await privateExchange(path, { method: "POST", signal });
    // Every read and signature in a pass comes from one Owner device.
    if (device !== null && exchange.device.deviceId !== device.deviceId) throw new SharingChangedError();
    device ??= exchange.device;
    if (!exchange.response.ok) return throwSharingFailure(exchange.response);
    return exchange.response.json() as Promise<unknown>;
  };
  const paged = <P extends { nextCursor: string | null }>(path: string, parse: (value: unknown) => P) =>
    readAllPages(async (cursor) => parse(await read(`${path}${cursor ? `?cursor=${cursor}` : ""}`)));

  // Read every target first, so no upload happens from a mixed snapshot.
  const root = await paged(`${base}/keys`, (value) => targets<GrantKeyContext>(value));
  const snapshot = root[0]!;
  if (
    snapshot.relationshipId !== shareId ||
    snapshot.ownerId !== device!.accountId ||
    !root.every((page) => sameSnapshot(snapshot, page) && page.capabilityId === snapshot.capabilityId)
  )
    throw new SharingChangedError();
  const capabilities = (
    await paged(`${base}/comment-keys`, (value) => {
      const body = value as { capabilities: CommentKeyContext[]; nextCursor: string | null } | null;
      if (!body || !Array.isArray(body.capabilities) || (body.nextCursor !== null && !isV7(body.nextCursor))) invalid();
      return body;
    })
  ).flatMap((page) => page.capabilities);
  const comments: { pages: CommentTargets[] }[] = [];
  for (const capability of capabilities) {
    if (!isV7(capability?.objectId) || !sameSnapshot(snapshot, capability)) throw new SharingChangedError();
    const pages = await paged(`${base}/comment-keys/${capability.objectId}`, (value) =>
      targets<CommentKeyContext>(value),
    );
    if (
      !pages.every(
        (page) =>
          sameSnapshot(snapshot, page) &&
          page.objectId === capability.objectId &&
          page.capabilityId === capability.capabilityId &&
          page.capabilityEpoch === capability.capabilityEpoch,
      )
    )
      throw new SharingChangedError();
    comments.push({ pages: pages as CommentTargets[] });
  }

  const devices = root.reduce((total, page) => total + page.devices.length, 0);
  const total = devices * (1 + comments.length);
  let prepared = 0;
  options.onProgress?.({ prepared, total });
  const signer = device!;
  const upload = async (
    path: string,
    context: Snapshot & { capabilityId: string; capabilityEpoch: number },
    envelopes: unknown[],
  ) => {
    for (const packet of packets(envelopes)) {
      signal?.throwIfAborted();
      budget.spend();
      const body = JSON.stringify({
        capabilityId: context.capabilityId,
        capabilityEpoch: context.capabilityEpoch,
        ownerRegistryEpoch: context.ownerRegistryEpoch,
        recipientRegistryEpoch: context.recipientRegistryEpoch,
        envelopes: packet,
      });
      const response = await uploadSaved(path, body, signal);
      if (!response.ok) await throwSharingFailure(response);
      prepared += packet.length;
      options.onProgress?.({ prepared, total });
    }
  };

  budget.spend();
  const rootKey = await ownedKey(snapshot, signal);
  for (const page of root) {
    const envelopes = [];
    for (const target of page.devices)
      envelopes.push(
        await createGrantKeyEnvelope(
          rootKey,
          await importTransport(target.transportPublicKey),
          signer.assertionKeyPair.privateKey,
          {
            ...snapshot,
            deviceId: target.deviceId,
            signerDeviceId: signer.deviceId,
          },
        ),
      );
    await upload(`${base}/keys`, snapshot, envelopes);
  }

  let missing = 0;
  for (const { pages } of comments) {
    const context = pages[0]!;
    const source = context.source;
    // Without an owned source (the Owner's recovery envelope, or an imported
    // thread's envelope under its File capability) this capability cannot be
    // prepared from any device; never fabricate a key. Keep preparing the others.
    if (!source || typeof source.envelope !== "string" || (source.kind !== "recovery" && source.kind !== "import")) {
      missing++;
      continue;
    }
    budget.spend();
    const { devices: _devices, nextCursor: _cursor, source: _source, ...commentContext } = context;
    const key =
      source.kind === "recovery"
        ? await openOwnedCommentKey(commentContext, source.envelope, signer, signal)
        : await openImportedThreadCapability(
            source.envelope,
            await ownedFileCapabilityKey(commentContext.ownerId, commentContext.fileId, signal),
            commentContext,
          );
    for (const page of pages) {
      const envelopes = [];
      for (const target of page.devices)
        envelopes.push(
          await createCommentKeyEnvelope(
            key,
            await importTransport(target.transportPublicKey),
            signer.assertionKeyPair.privateKey,
            { ...commentContext, deviceId: target.deviceId, signerDeviceId: signer.deviceId },
          ),
        );
      await upload(`${base}/comment-keys/${context.objectId}`, commentContext, envelopes);
    }
  }
  if (missing) throw new SharePreparationError("missing-source");
  return { devices, envelopes: prepared, commentCapabilities: comments.length };
}

/**
 * Stage every envelope a pending Share needs for acceptance, from this Owner
 * device. Resumable and safe to repeat; a changed relationship restarts once,
 * then fails with `SharePreparationError("changed")`.
 */
export async function prepareShare(
  shareId: string,
  options: { signal?: AbortSignal; onProgress?: (progress: SharePreparationProgress) => void } = {},
): Promise<SharePreparationResult> {
  if (!isV7(shareId)) throw new SharePreparationError("not-found");
  try {
    return await restartOnce(() => pass(shareId, options), options.signal);
  } catch (error) {
    if (options.signal?.aborted || error instanceof SharePreparationError || error instanceof PrivateAccessError)
      throw error;
    if (error instanceof SharingNotFoundError) throw new SharePreparationError("not-found");
    if (error instanceof KeyRotationRequiredError) throw new SharePreparationError("sealed");
    if (error instanceof SharingPageLimitError) throw new SharePreparationError("too-large");
    throw new SharePreparationError("unavailable");
  }
}
