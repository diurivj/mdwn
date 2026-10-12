import { openSymmetric } from "~/shared/crypto/enc-v1";
import { openDeviceEnrollmentEnvelope } from "~/shared/crypto/vault";
import { privateRequest } from "~/shared/device/private-client";
import type { StoredDevice } from "~/shared/device/store";
import { loadAncestors, loadDirectory, loadFile, openChildDirectory, openRoot } from "~/shared/tree/client";
import { decodeTreeBytes } from "~/shared/tree/wire";
import type { CommentKeyContext } from "./comment-keys";
import type { GrantKeyContext } from "./grant-keys";

/**
 * The Owner's own capabilities, opened for delivery to recipient devices.
 * Shared-content provisioning and share preparation both use these, so the
 * owned-scope verification below is one invariant: the target must be reached
 * by a verified walk from this Account's own root, at the exact capability
 * identity and epoch the proof-guarded delivery context names.
 */
type OwnedTarget =
  | { kind: "file"; file: Awaited<ReturnType<typeof loadFile>> }
  | { kind: "directory"; key: Uint8Array; keyEpoch: number };

/** Called before each private request, so a caller can bound its total work. */
type Spend = () => void;
const unbounded: Spend = () => {};

/** The verified walk from this Account's own root to an owned target. */
async function walkOwned(
  ownerId: string,
  targetId: string,
  signal?: AbortSignal,
  spend = unbounded,
): Promise<OwnedTarget> {
  spend();
  const access = await openRoot(signal);
  if (access.actorAccountId !== ownerId) throw new Error("Owner device required");
  spend();
  const path = await loadAncestors(targetId, signal);
  if (path[0] !== access.rootId) throw new Error("Invalid owned scope");
  let key = access.rootKey,
    keyEpoch = access.capability!.epoch;
  for (let index = 0; index < path.length - 1; index++) {
    spend();
    const listing = await loadDirectory(access, path[index]!, key, signal);
    const entry = listing.entries.find((entry) => entry.nodeId === path[index + 1]);
    if (!entry) throw new Error("Changed owned scope");
    if (entry.kind === "file") {
      if (index !== path.length - 2) throw new Error("Invalid owned scope");
      spend();
      return { kind: "file", file: await loadFile(access, targetId, key, signal) };
    }
    key = await openChildDirectory(access, key, entry);
    keyEpoch = entry.keyEpoch ?? 1;
  }
  return { kind: "directory", key, keyEpoch };
}

export async function ownedKey(context: GrantKeyContext, signal?: AbortSignal, spend = unbounded) {
  const target = await walkOwned(context.ownerId, context.targetId, signal, spend);
  if (target.kind === "file") {
    if (context.targetKind !== "file") throw new Error("Invalid owned scope");
    if (
      target.file.capability?.id !== context.capabilityId ||
      target.file.capability.epoch !== context.capabilityEpoch ||
      !target.file.capabilityKey
    )
      throw new Error("Changed File capability");
    return target.file.capabilityKey;
  }
  if (
    context.targetKind !== "directory" ||
    context.capabilityId !== context.targetId ||
    target.keyEpoch !== context.capabilityEpoch
  )
    throw new Error("Changed Directory capability");
  return target.key;
}

/** The Owner's current File capability key for an owned File, by the same verified walk. */
export async function ownedFileCapabilityKey(ownerId: string, fileId: string, signal?: AbortSignal, spend = unbounded) {
  const target = await walkOwned(ownerId, fileId, signal, spend);
  if (target.kind !== "file" || !target.file.capabilityKey) throw new Error("Changed File capability");
  return target.file.capabilityKey;
}

/**
 * Open an Owner Comment key from its own `vault-recovery` envelope, through
 * this device's enrollment envelope. The context pins the object, capability
 * and epoch; a wrong or stale envelope fails authentication.
 */
export async function openOwnedCommentKey(
  context: CommentKeyContext,
  envelope: string,
  device: StoredDevice,
  signal?: AbortSignal,
  spend = unbounded,
) {
  if (device.accountId !== context.ownerId) throw new Error("Owner device required");
  spend();
  const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
  if (!response.ok) throw new Error("Owned source unavailable");
  const boot = (await response.json()) as { enrollmentEnvelope: string };
  const root = await openDeviceEnrollmentEnvelope(decodeTreeBytes(boot.enrollmentEnvelope), device.transportKeyPair, {
    purpose: "device-enrollment",
    vaultId: device.accountId,
    objectId: device.deviceId,
    keyId: device.deviceId,
    keyEpoch: 1,
    revision: 1,
    recipientId: device.deviceId,
  });
  return openSymmetric(decodeTreeBytes(envelope), root, {
    context: {
      purpose: "vault-recovery",
      vaultId: context.ownerId,
      objectId: context.objectId,
      keyId: context.capabilityId,
      keyEpoch: context.capabilityEpoch,
      revision: 1,
    },
  });
}
