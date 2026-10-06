import { openSymmetric } from "~/shared/crypto/enc-v1";
import { openDeviceEnrollmentEnvelope } from "~/shared/crypto/vault";
import { PrivateAccessError, privateRequest } from "~/shared/device/private-client";
import { getDevice } from "~/shared/device/store";
import { loadAncestors, loadDirectory, loadFile, openChildDirectory, openRoot } from "~/shared/tree/client";
import { decodeTreeBytes } from "~/shared/tree/wire";
import { createGrantKeyEnvelope, openGrantKeyEnvelope, type GrantKeyContext } from "./grant-keys";
import { createCommentKeyEnvelope, openCommentKeyEnvelope, type CommentKeyContext } from "./comment-keys";

type Context = GrantKeyContext | CommentKeyContext;
type SourceEnvelope = Omit<Parameters<typeof openGrantKeyEnvelope>[0], "recipient">;
type Item = {
  context: Context;
  device: { deviceId: string; transportPublicKey: string };
  source: { kind: "owned" } | { kind: "recovery"; envelope: string } | { kind: "grant"; envelope: SourceEnvelope };
};
type Next = { item: Item | null; pending: boolean; expirationPending?: boolean };

export async function readNextProvisioning(signal?: AbortSignal): Promise<Next> {
  const response = await privateRequest("/api/private/grant-provisioning/next", { method: "POST", signal });
  if (!response.ok) throw new Error("Shared access unavailable");
  return response.json() as Promise<Next>;
}

async function ownedKey(context: GrantKeyContext, signal?: AbortSignal) {
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

/** Each pass handles at most twenty envelopes by default. Server coverage, not
 * local progress or saved nonce state, determines the next item after a crash. */
export async function resumeGrantProvisioning(options: { signal?: AbortSignal; maxSteps?: number } = {}) {
  const { signal } = options,
    maxSteps = options.maxSteps ?? 20;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error("Invalid provisioning bound");
  let pending = false;
  for (let processed = 0; processed < maxSteps; processed++) {
    signal?.throwIfAborted();
    const next = await readNextProvisioning(signal);
    pending = next.pending;
    if (next.expirationPending) {
      const response = await privateRequest("/api/private/grant-provisioning/expire", {
        method: "PATCH",
        body: "{}",
        signal,
      });
      if (!response.ok) throw new Error("Shared access changed. Refresh and resume.");
      continue;
    }
    if (!next.item) return { complete: true, pending, processed };
    const { context, device: target, source } = next.item;
    const stateResponse = await fetch("/api/device/state", { cache: "no-store", signal });
    if (!stateResponse.ok) throw new Error("Device state unavailable");
    const state = (await stateResponse.json()) as { accountId: string; deviceId: string };
    const device = await getDevice(state.accountId);
    if (
      !device ||
      device.deviceId !== state.deviceId ||
      ![context.ownerId, context.recipientId].includes(state.accountId)
    )
      throw new Error("An authorized enrolled device is required");
    let key: Uint8Array;
    if (source.kind === "grant") {
      const envelope = source.envelope;
      // Historical registry epochs are signed provenance. Every other source
      // identity/epoch must match the current proof-guarded delivery context.
      for (const field of Object.keys(context) as (keyof Context)[]) {
        if (field !== "ownerRegistryEpoch" && field !== "recipientRegistryEpoch" && envelope[field] !== context[field])
          throw new Error("Changed Grant source");
      }
      if (envelope.deviceId !== device.deviceId || context.recipientId !== state.accountId)
        throw new Error("Invalid source device");
      key =
        "purpose" in context
          ? await openCommentKeyEnvelope({
              ...envelope,
              ...context,
              ownerRegistryEpoch: envelope.ownerRegistryEpoch,
              recipientRegistryEpoch: envelope.recipientRegistryEpoch,
              recipient: device.transportKeyPair,
            })
          : await openGrantKeyEnvelope({ ...envelope, recipient: device.transportKeyPair });
    } else if (source.kind === "recovery" && "purpose" in context && state.accountId === context.ownerId) {
      const response = await privateRequest("/api/private/bootstrap", { method: "POST", signal });
      if (!response.ok) throw new Error("Owned source unavailable");
      const boot = (await response.json()) as { enrollmentEnvelope: string };
      const root = await openDeviceEnrollmentEnvelope(
        decodeTreeBytes(boot.enrollmentEnvelope),
        device.transportKeyPair,
        {
          purpose: "device-enrollment",
          vaultId: state.accountId,
          objectId: device.deviceId,
          keyId: device.deviceId,
          keyEpoch: 1,
          revision: 1,
          recipientId: device.deviceId,
        },
      );
      key = await openSymmetric(decodeTreeBytes(source.envelope), root, {
        context: {
          purpose: "vault-recovery",
          vaultId: context.ownerId,
          objectId: context.objectId,
          keyId: context.capabilityId,
          keyEpoch: context.capabilityEpoch,
          revision: 1,
        },
      });
    } else if (source.kind === "owned" && !("purpose" in context)) key = await ownedKey(context, signal);
    else throw new Error("Invalid provisioning source");
    const publicKey = await crypto.subtle.importKey(
      "raw",
      decodeTreeBytes(target.transportPublicKey, 65),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const addressed = { ...context, deviceId: target.deviceId, signerDeviceId: device.deviceId };
    const envelope =
      "purpose" in context
        ? await createCommentKeyEnvelope(key, publicKey, device.assertionKeyPair.privateKey, {
            ...context,
            deviceId: target.deviceId,
            signerDeviceId: device.deviceId,
          })
        : await createGrantKeyEnvelope(key, publicKey, device.assertionKeyPair.privateKey, addressed);
    const body = JSON.stringify({
      capabilityId: context.capabilityId,
      capabilityEpoch: context.capabilityEpoch,
      ownerRegistryEpoch: context.ownerRegistryEpoch,
      recipientRegistryEpoch: context.recipientRegistryEpoch,
      envelopes: [envelope],
    });
    const path = `/api/private/grants/${context.relationshipId}/${"purpose" in context ? `comment-keys/${context.objectId}` : "keys"}`;
    let response: Response;
    try {
      response = await privateRequest(path, { method: "PUT", body, signal });
    } catch (error) {
      if (signal?.aborted || !(error instanceof PrivateAccessError && error.state === "unavailable")) throw error;
      // An uncertain response retries saved ciphertext bytes with a fresh proof,
      // never re-seals or restores an HPKE context/nonce counter.
      response = await privateRequest(path, { method: "PUT", body, signal });
    }
    if (!response.ok) throw new Error("Shared access changed. Refresh and resume.");
  }
  return { complete: false, pending, processed: maxSteps };
}
