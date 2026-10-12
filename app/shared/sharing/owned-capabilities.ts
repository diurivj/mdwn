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
export async function ownedKey(context: GrantKeyContext, signal?: AbortSignal) {
  const access = await openRoot(signal);
  if (access.actorAccountId !== context.ownerId) throw new Error("Owner device required");
  const path = await loadAncestors(context.targetId, signal);
  if (path[0] !== access.rootId) throw new Error("Invalid owned scope");
  let key = access.rootKey,
    keyEpoch = access.capability!.epoch;
  for (let index = 0; index < path.length - 1; index++) {
    const listing = await loadDirectory(access, path[index]!, key, signal);
    const entry = listing.entries.find((entry) => entry.nodeId === path[index + 1]);
    if (!entry) throw new Error("Changed owned scope");
    if (entry.kind === "file") {
      if (index !== path.length - 2 || context.targetKind !== "file") throw new Error("Invalid owned scope");
      const file = await loadFile(access, context.targetId, key, signal);
      if (
        file.capability?.id !== context.capabilityId ||
        file.capability.epoch !== context.capabilityEpoch ||
        !file.capabilityKey
      )
        throw new Error("Changed File capability");
      return file.capabilityKey;
    }
    key = await openChildDirectory(access, key, entry);
    keyEpoch = entry.keyEpoch ?? 1;
  }
  if (
    context.targetKind !== "directory" ||
    context.capabilityId !== context.targetId ||
    keyEpoch !== context.capabilityEpoch
  )
    throw new Error("Changed Directory capability");
  return key;
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
) {
  if (device.accountId !== context.ownerId) throw new Error("Owner device required");
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
