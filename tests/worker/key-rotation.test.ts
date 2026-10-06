import { newPublicationIdentifier } from "../../app/shared/publications/capability";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  addSharingDevice,
  deletePayload,
  grant,
  invite,
  opaqueId,
  prepareGrantKeys,
  savePayload,
  sharingAccount,
  sharingRequest,
  treeChild,
} from "./sharing-fixtures";
import { createSymmetricWriter, openSymmetric } from "../../app/shared/crypto/enc-v1";
import {
  createRecoveryMaterial,
  sealDeviceEnrollmentEnvelope,
  sealVaultRecoveryEnvelope,
} from "../../app/shared/crypto/vault";
import { openGrantKeyEnvelope } from "../../app/shared/sharing/grant-keys";
import {
  createCommentKeyEnvelope,
  openCommentKeyEnvelope,
  type CommentKeyContext,
} from "../../app/shared/sharing/comment-keys";
import { resumeRotation, type RotationBrowser } from "../../app/shared/sharing/rotation-client";
import type { SharingAccount } from "./sharing-fixtures";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/shared/tree/wire";
import { rotationResumeContext, type RotationNext, type RotationEntries } from "../../app/shared/sharing/rotation-wire";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function rotationBrowser(owner: SharingAccount): Promise<RotationBrowser> {
  const vaultRootKey = crypto.getRandomValues(new Uint8Array(32));
  const material = await createRecoveryMaterial(owner.accountId, { vaultRootKey });
  const recovery = await sealVaultRecoveryEnvelope(
    vaultRootKey,
    { key: owner.keys.get(owner.rootId)!, objectId: owner.rootId, keyId: owner.rootId, scope: "owned" },
    {
      purpose: "vault-recovery",
      vaultId: owner.accountId,
      objectId: owner.rootId,
      keyId: owner.rootId,
      keyEpoch: 1,
      revision: 1,
    },
  );
  const enrollment = await sealDeviceEnrollmentEnvelope(vaultRootKey, owner.transport.publicKey, {
    purpose: "device-enrollment",
    vaultId: owner.accountId,
    objectId: owner.deviceId,
    keyId: owner.deviceId,
    keyEpoch: 1,
    revision: 1,
    recipientId: owner.deviceId,
  });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1), (?, 'device-enrollment', ?, ?, ?, 1)`).bind(
      owner.accountId,
      owner.rootId,
      recovery,
      owner.accountId,
      owner.deviceId,
      owner.deviceId,
      enrollment,
    ),
    env.DB.prepare(`INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key)
      VALUES (?, 1, ?, ?, ?)`).bind(
      owner.accountId,
      material.record.recoverySalt,
      material.record.capsule,
      material.recoveryVerificationPublicKeyBytes,
    ),
    env.DB.prepare(
      `INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, X'01', 1, 1, 1, 1)`,
    ).bind(owner.accountId),
  ]);
  return {
    accountId: owner.accountId,
    deviceId: owner.deviceId,
    vaultRootKey,
    assertionKey: owner.assertion.privateKey,
    request: (path, method = "POST", body) => sharingRequest(owner, path, method, body),
  };
}

it("revocation denies server access and starts an Owner-resumable, epoch-advanced rotation before any browser work", async () => {
  const owner = await sharingAccount(),
    removed = await sharingAccount(),
    remaining = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, targetId, "file", owner.accountId, true);
  const revoked = await grant(owner, removed, targetId, "read_write");
  await grant(owner, remaining, targetId);
  const response = await sharingRequest(owner, `/api/private/grants/${revoked.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ removed: true, rotation: { targetId, keyEpoch: 2, state: "pending" } });
  expect((await sharingRequest(removed, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", {})).status).toBe(409);
  const jobs = await sharingRequest(owner, "/api/private/key-rotations");
  expect(jobs.status).toBe(200);
  expect(await jobs.json()).toMatchObject({
    jobs: [{ targetId, keyEpoch: 2, state: "pending", progress: 0 }],
    nextCursor: null,
  });
  expect(await (await sharingRequest(removed, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [] });
});

it("only an enrolled Owner device can read the next bounded rotation unit", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const active = await grant(owner, recipient, targetId);
  const revoked = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const { rotation } = (await revoked.json()) as { rotation: { jobId: string } };
  const path = `/api/private/key-rotations/${rotation.jobId}/next`;
  const response = await sharingRequest(owner, path);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    operation: "start",
    item: { objectId: targetId, kind: "directory" },
    source: { keyEpoch: 1, entriesRevision: 1 },
    job: { keyEpoch: 2, progress: 0 },
  });
  expect((await sharingRequest(recipient, path)).status).toBe(404);
});

it("checkpointing a replacement stores only a job-bound envelope and exact retries never reset progress", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const active = await grant(owner, recipient, targetId);
  const revoked = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const { rotation } = (await revoked.json()) as { rotation: { jobId: string } };
  const writer = await createSymmetricWriter(crypto.getRandomValues(new Uint8Array(32)));
  const resumeEnvelope = encodeTreeBytes(
    await writer.seal(
      crypto.getRandomValues(new Uint8Array(32)),
      rotationResumeContext(owner.accountId, rotation.jobId, targetId, 2),
    ),
  );
  const packet = {
    operation: "start",
    operationId: opaqueId(),
    objectId: targetId,
    sourceEpoch: 1,
    sourceRevision: 1,
    targetEpoch: 2,
    capabilityId: targetId,
    resumeEnvelope,
  };
  const path = `/api/private/key-rotations/${rotation.jobId}/step`;
  expect((await sharingRequest(owner, path, "PATCH", packet)).status).toBe(200);
  expect((await sharingRequest(owner, path, "PATCH", packet)).status).toBe(200);
  expect((await sharingRequest(owner, path, "PATCH", { ...packet, targetEpoch: 3 })).status).toBe(409);
  const next = await (await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/next`)).json();
  expect(next).toMatchObject({
    operation: "promote",
    item: { state: "staging", resumeEnvelope, targetEpoch: 2 },
    job: { progress: 0 },
  });
});

it("an interrupted browser rotation resumes the installed hierarchy, restores remaining access and rejects old capability envelopes", async () => {
  const owner = await sharingAccount(),
    removed = await sharingAccount(),
    remaining = await sharingAccount();
  const browser = await rotationBrowser(owner);
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, targetId, "file", owner.accountId, true);
  const revoked = await grant(owner, removed, targetId);
  const kept = await grant(owner, remaining, targetId);
  const oldGrant = (await (
    await sharingRequest(remaining, `/api/private/grants/${kept.grantId}/keys`)
  ).json()) as Parameters<typeof openGrantKeyEnvelope>[0];
  const oldFile = (await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json()) as {
    keyEnvelope: string;
    representationKeyEnvelope: string;
    contentKeyId: string;
    keyEpoch: number;
    revision: number;
    capability: { id: string; epoch: number };
  };
  const removedResponse = await sharingRequest(owner, `/api/private/grants/${revoked.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const { rotation } = (await removedResponse.json()) as { rotation: { jobId: string } };
  expect(await resumeRotation(rotation.jobId, browser, { maxSteps: 3 })).toBe(false);
  expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", {})).status).toBe(409);
  expect((await sharingRequest(remaining, `/api/private/grants/${kept.grantId}/keys`)).status).toBe(409);
  expect(await resumeRotation(rotation.jobId, { ...browser }, { maxSteps: 20 })).toBe(true);
  const currentGrant = (await (
    await sharingRequest(remaining, `/api/private/grants/${kept.grantId}/keys`)
  ).json()) as Parameters<typeof openGrantKeyEnvelope>[0];
  expect(currentGrant.capabilityEpoch).toBe(2);
  const rootKey = await openGrantKeyEnvelope({ ...currentGrant, recipient: remaining.transport });
  const file = (await (await sharingRequest(remaining, `/api/private/tree/files/${fileId}`)).json()) as typeof oldFile;
  expect(file.capability.epoch).toBe(2);
  const capability = await openSymmetric(decodeTreeBytes(file.keyEnvelope), rootKey, {
    context: {
      purpose: "file-capability",
      vaultId: owner.accountId,
      objectId: fileId,
      keyId: file.capability.id,
      keyEpoch: 2,
      revision: 1,
    },
  });
  expect(
    (
      await openSymmetric(decodeTreeBytes(file.representationKeyEnvelope), capability, {
        context: {
          purpose: "file-content-key",
          vaultId: owner.accountId,
          objectId: fileId,
          keyId: file.contentKeyId,
          keyEpoch: file.keyEpoch,
          revision: file.revision,
        },
      })
    ).length,
  ).toBe(32);
  await expect(
    openGrantKeyEnvelope({ ...oldGrant, capabilityEpoch: 2, recipient: remaining.transport }),
  ).rejects.toThrow();
  await expect(
    openSymmetric(decodeTreeBytes(oldFile.keyEnvelope), rootKey, {
      context: {
        purpose: "file-capability",
        vaultId: owner.accountId,
        objectId: fileId,
        keyId: file.capability.id,
        keyEpoch: 2,
        revision: 1,
      },
    }),
  ).rejects.toThrow();
  expect((await sharingRequest(removed, `/api/private/tree/files/${fileId}`)).status).toBe(404);
  expect(await resumeRotation(rotation.jobId, browser)).toBe(true);
});

it.each(["leave", "permission"] as const)(
  "%s changes server authority first and restores safe direct File writes only after rotation",
  async (operation) => {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const browser = await rotationBrowser(owner);
    const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
    const active = await grant(owner, recipient, fileId, "read_write");
    const oldKey = new Uint8Array(owner.keys.get(fileId)!);
    const prepared = await savePayload(owner, owner.accountId, fileId, owner.rootId);
    const path = `/api/private/grants/${active.grantId}`;
    const changed =
      operation === "leave"
        ? await sharingRequest(recipient, `${path}/leave`, "POST", { expectedRevision: 1 })
        : await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, permission: "read_only" });
    expect(changed.status).toBe(200);
    const { rotation } = (await changed.json()) as { rotation: { jobId: string } };
    expect((await sharingRequest(recipient, `/api/private/tree/files/${fileId}`, "PATCH", prepared)).status).toBe(404);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", prepared)).status).toBe(409);
    expect(await resumeRotation(rotation.jobId, browser)).toBe(true);
    const current = (await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json()) as {
      capability: { id: string; epoch: number };
      keyEnvelope: string;
    };
    owner.keys.set(
      fileId,
      await openSymmetric(decodeTreeBytes(current.keyEnvelope), owner.keys.get(owner.rootId)!, {
        context: {
          purpose: "file-capability",
          vaultId: owner.accountId,
          objectId: fileId,
          keyId: current.capability.id,
          keyEpoch: 2,
          revision: 1,
        },
      }),
    );
    const save = await savePayload(owner, owner.accountId, fileId, owner.rootId);
    expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", save)).status).toBe(200);
    const file = (await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json()) as {
      representationKeyEnvelope: string;
      contentKeyId: string;
      keyEpoch: number;
      revision: number;
    };
    await expect(
      openSymmetric(decodeTreeBytes(file.representationKeyEnvelope), oldKey, {
        context: {
          purpose: "file-content-key",
          vaultId: owner.accountId,
          objectId: fileId,
          keyId: file.contentKeyId,
          keyEpoch: file.keyEpoch,
          revision: file.revision,
        },
      }),
    ).rejects.toThrow();
    if (operation === "permission") expect((await sharingRequest(recipient, `${path}/keys`)).status).toBe(200);
    else expect((await sharingRequest(recipient, `${path}/keys`)).status).toBe(404);
  },
);

it("a different enrolled Owner device resumes after removing the initiator, without routine removal rotating more keys", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const browser = await rotationBrowser(owner);
  const fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const active = await grant(owner, recipient, owner.rootId);
  const changed = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const { rotation } = (await changed.json()) as { rotation: { jobId: string } };
  expect(await resumeRotation(rotation.jobId, browser, { maxSteps: 3 })).toBe(false);
  const second = await addSharingDevice(owner);
  const nextOwner = { ...owner, ...second };
  const envelope = await sealDeviceEnrollmentEnvelope(browser.vaultRootKey, second.transport.publicKey, {
    purpose: "device-enrollment",
    vaultId: owner.accountId,
    objectId: second.deviceId,
    keyId: second.deviceId,
    keyEpoch: 1,
    revision: 1,
    recipientId: second.deviceId,
  });
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(second.deviceId, owner.session.id),
    env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
      VALUES (?, 'device-enrollment', ?, ?, ?, 1)`).bind(owner.accountId, second.deviceId, second.deviceId, envelope),
  ]);
  expect((await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/next`)).status).toBe(403);
  const removal = await sharingRequest(nextOwner, "/api/private/devices/remove", "POST", {
    targetDeviceId: owner.deviceId,
    expectedEpoch: 2,
    labelDigest: encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array()))),
    confirmation: "remove-device",
  });
  expect(removal.status).toBe(200);
  nextOwner.registryEpoch = 3;
  const nextBrowser: RotationBrowser = {
    ...browser,
    deviceId: second.deviceId,
    assertionKey: second.assertion.privateKey,
    request: (path, method = "POST", body) => sharingRequest(nextOwner, path, method, body),
  };
  expect(await resumeRotation(rotation.jobId, nextBrowser)).toBe(true);
  const file = await (await sharingRequest(nextOwner, `/api/private/tree/files/${fileId}`)).json();
  expect(file).toMatchObject({ capability: { epoch: 2 }, keyEpoch: 1, revision: 1 });
  const bootstrap = await (await sharingRequest(nextOwner, "/api/private/bootstrap")).json();
  expect(bootstrap).toMatchObject({ rootKeyEpoch: 2 });
});

it("rotation cannot unseal root-only delivery and rewraps current Private and retained Public Comment coverage", async () => {
  const owner = await sharingAccount(),
    removed = await sharingAccount(),
    remaining = await sharingAccount();
  const browser = await rotationBrowser(owner),
    fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const capabilities = ["private-comment-thread", "public-comment-audience-epoch"] as const;
  const objects = capabilities.map((purpose) => ({ objectId: opaqueId(), capabilityId: opaqueId(), purpose }));
  const oldKey = new Uint8Array(32).fill(85);
  for (const item of objects) {
    const recovery = await sealVaultRecoveryEnvelope(
      browser.vaultRootKey,
      { key: oldKey, objectId: item.objectId, keyId: item.capabilityId, scope: "owned" },
      {
        purpose: "vault-recovery",
        vaultId: owner.accountId,
        objectId: item.objectId,
        keyId: item.capabilityId,
        keyEpoch: 1,
        revision: 1,
      },
    );
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sharing_comment_capabilities (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).bind(
        item.objectId,
        owner.accountId,
        fileId,
        item.objectId,
        item.purpose,
        item.purpose === "private-comment-thread" ? null : newPublicationIdentifier(),
        item.capabilityId,
      ),
      env.DB.prepare(`INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch)
        VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)`).bind(owner.accountId, item.objectId, recovery),
    ]);
  }
  const grantIds: string[] = [];
  for (const recipient of [removed, remaining]) {
    const { shareId } = await invite(owner, recipient, fileId);
    await prepareGrantKeys(owner, shareId);
    for (const item of objects) {
      const path = `/api/private/shares/${shareId}/comment-keys/${item.objectId}`;
      const context = (await (await sharingRequest(owner, path)).json()) as CommentKeyContext;
      const envelope = await createCommentKeyEnvelope(
        oldKey,
        recipient.transport.publicKey,
        owner.assertion.privateKey,
        { ...context, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId },
      );
      expect(
        (
          await sharingRequest(owner, path, "PUT", {
            capabilityId: item.capabilityId,
            capabilityEpoch: 1,
            ownerRegistryEpoch: 1,
            recipientRegistryEpoch: 1,
            envelopes: [envelope],
          })
        ).status,
      ).toBe(200);
    }
    expect((await sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {})).status).toBe(201);
    grantIds.push(shareId);
  }
  const changed = await sharingRequest(owner, `/api/private/grants/${grantIds[0]}`, "DELETE", { expectedRevision: 1 });
  const { rotation } = (await changed.json()) as { rotation: { jobId: string } };
  expect(await resumeRotation(rotation.jobId, browser, { maxSteps: 2 })).toBe(false);
  expect(
    (
      await sharingRequest(owner, `/api/private/key-rotations/${rotation.jobId}/step`, "PATCH", {
        operation: "finish",
        operationId: opaqueId(),
      })
    ).status,
  ).toBe(409);
  expect(await resumeRotation(rotation.jobId, browser)).toBe(true);
  for (const item of objects) {
    const response = await sharingRequest(
      remaining,
      `/api/private/grants/${grantIds[1]}/comment-keys/${item.objectId}`,
    );
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as Parameters<typeof openCommentKeyEnvelope>[0];
    const key = await openCommentKeyEnvelope({ ...envelope, recipient: remaining.transport });
    if (item.purpose === "private-comment-thread") {
      expect(envelope.capabilityEpoch).toBe(2);
      expect(key).not.toEqual(oldKey);
    } else {
      expect(envelope.capabilityEpoch).toBe(1);
      expect(key).toEqual(oldKey);
    }
    expect(
      (await sharingRequest(removed, `/api/private/grants/${grantIds[0]}/comment-keys/${item.objectId}`)).status,
    ).toBe(404);
  }
});

it("a later ancestor revocation preempts descendant work so no replacement key is promoted beneath the revoked parent", async () => {
  const owner = await sharingAccount(),
    outerRecipient = await sharingAccount(),
    innerRecipient = await sharingAccount();
  const browser = await rotationBrowser(owner);
  const outer = await treeChild(owner, owner.rootId, "directory"),
    inner = await treeChild(owner, outer, "directory");
  await treeChild(owner, inner, "file", owner.accountId, true);
  const outerGrant = await grant(owner, outerRecipient, outer),
    innerGrant = await grant(owner, innerRecipient, inner);
  const innerResponse = await sharingRequest(owner, `/api/private/grants/${innerGrant.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const innerJob = ((await innerResponse.json()) as { rotation: { jobId: string } }).rotation.jobId;
  expect(await resumeRotation(innerJob, browser, { maxSteps: 1 })).toBe(false);
  const outerResponse = await sharingRequest(owner, `/api/private/grants/${outerGrant.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const outerJob = ((await outerResponse.json()) as { rotation: { jobId: string } }).rotation.jobId;
  expect((await sharingRequest(owner, `/api/private/key-rotations/${innerJob}/next`)).status).toBe(409);
  expect(await resumeRotation(outerJob, browser)).toBe(true);
  expect(await resumeRotation(innerJob, browser)).toBe(true);
  expect(await (await sharingRequest(owner, `/api/private/tree/directories/${inner}`)).json()).toMatchObject({
    keyEpoch: 3,
  });
});

it("inner, unrelated, and ancestor revocations keep eligible work runnable and all resume", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const browser = await rotationBrowser(owner);
  const outer = await treeChild(owner, owner.rootId, "directory"),
    inner = await treeChild(owner, outer, "directory");
  const unrelated = await treeChild(owner, owner.rootId, "directory");
  const innerFile = await treeChild(owner, inner, "file", owner.accountId, true);
  const unrelatedFile = await treeChild(owner, unrelated, "file", owner.accountId, true);
  const innerGrant = await grant(owner, recipient, inner),
    unrelatedGrant = await grant(owner, recipient, unrelated);
  const outerGrant = await grant(owner, recipient, outer);
  const jobs: string[] = [];
  for (const active of [innerGrant, unrelatedGrant, outerGrant]) {
    const response = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
      expectedRevision: 1,
    });
    expect(response.status).toBe(200);
    jobs.push(((await response.json()) as { rotation: { jobId: string } }).rotation.jobId);
  }
  const innerJob = jobs[0]!,
    unrelatedJob = jobs[1]!,
    outerJob = jobs[2]!;
  expect(innerJob < unrelatedJob && unrelatedJob < outerJob).toBe(true);
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({
    jobs: [
      { jobId: innerJob, runnable: false },
      { jobId: unrelatedJob, runnable: true },
      { jobId: outerJob, runnable: false },
    ],
  });
  expect((await sharingRequest(owner, `/api/private/key-rotations/${innerJob}/next`)).status).toBe(409);
  expect((await sharingRequest(owner, `/api/private/tree/files/${innerFile}`, "PATCH", {})).status).toBe(409);
  expect((await sharingRequest(owner, `/api/private/tree/files/${unrelatedFile}`, "PATCH", {})).status).toBe(409);
  expect(await resumeRotation(unrelatedJob, browser)).toBe(true);
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({
    jobs: [
      { jobId: innerJob, runnable: false },
      { jobId: outerJob, runnable: true },
    ],
  });
  expect(await resumeRotation(outerJob, browser)).toBe(true);
  expect(await resumeRotation(innerJob, browser)).toBe(true);
  expect(await (await sharingRequest(owner, "/api/private/key-rotations")).json()).toMatchObject({ jobs: [] });
  expect(await (await sharingRequest(owner, `/api/private/tree/directories/${inner}`)).json()).toMatchObject({
    keyEpoch: 3,
  });
  expect(await (await sharingRequest(owner, `/api/private/tree/files/${innerFile}`)).json()).toMatchObject({
    canEdit: true,
    capability: { epoch: 3 },
  });
  expect(await (await sharingRequest(owner, `/api/private/tree/files/${unrelatedFile}`)).json()).toMatchObject({
    canEdit: true,
    capability: { epoch: 2 },
  });
});

it("hard deletion of a staged child invalidates the source snapshot and safely resumes without reviving the deleted object", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const browser = await rotationBrowser(owner),
    targetId = await treeChild(owner, owner.rootId, "directory");
  const fileId = await treeChild(owner, targetId, "file", owner.accountId, true);
  const active = await grant(owner, recipient, targetId);
  const response = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const jobId = ((await response.json()) as { rotation: { jobId: string } }).rotation.jobId;
  expect(await resumeRotation(jobId, browser, { maxSteps: 2 })).toBe(false);
  expect(
    (
      await sharingRequest(
        owner,
        `/api/private/tree/nodes/${fileId}`,
        "DELETE",
        await deletePayload(owner, owner.accountId, fileId, targetId),
      )
    ).status,
  ).toBe(200);
  expect(await (await sharingRequest(owner, `/api/private/key-rotations/${jobId}/next`)).json()).toMatchObject({
    operation: "restart",
  });
  expect(await resumeRotation(jobId, browser)).toBe(true);
  expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).status).toBe(404);
});

it("pages a wide Directory and resumes after a ciphertext-only staging page without double promotion", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const browser = await rotationBrowser(owner),
    targetId = await treeChild(owner, owner.rootId, "directory");
  for (let index = 0; index < 21; index++) await treeChild(owner, targetId, "file");
  const active = await grant(owner, recipient, targetId);
  const response = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const jobId = ((await response.json()) as { rotation: { jobId: string } }).rotation.jobId;
  expect(await resumeRotation(jobId, browser, { maxSteps: 2 })).toBe(false);
  const next = (await (await sharingRequest(owner, `/api/private/key-rotations/${jobId}/next`)).json()) as RotationNext;
  expect(next).toMatchObject({
    operation: "stage",
    job: { progress: 0 },
    item: { state: "staging", cursor: expect.any(String) },
  });
  const page = (await (
    await sharingRequest(
      owner,
      `/api/private/key-rotations/${jobId}/items/${targetId}/entries?cursor=${next.item!.cursor}`,
    )
  ).json()) as RotationEntries;
  expect(page.entries).toHaveLength(1);
  expect(page.nextCursor).toBeNull();
  expect(await resumeRotation(jobId, browser, { maxSteps: 100 })).toBe(true);
  expect(await (await sharingRequest(owner, `/api/private/key-rotations/${jobId}/next`)).json()).toMatchObject({
    operation: "complete",
    job: { progress: 22 },
  });
  const listing = (await (await sharingRequest(owner, `/api/private/tree/directories/${targetId}`)).json()) as {
    keyEpoch: number;
    entries: unknown[];
  };
  expect(listing.keyEpoch).toBe(2);
  expect(listing.entries).toHaveLength(21);
  expect(await resumeRotation(jobId, browser)).toBe(true);
});

it("repeated same-target revocation supersedes interrupted ciphertext and fences the newest epoch", async () => {
  const owner = await sharingAccount(),
    first = await sharingAccount(),
    second = await sharingAccount();
  const browser = await rotationBrowser(owner),
    fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const firstGrant = await grant(owner, first, fileId),
    secondGrant = await grant(owner, second, fileId);
  const firstResponse = await sharingRequest(owner, `/api/private/grants/${firstGrant.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const firstJob = ((await firstResponse.json()) as { rotation: { jobId: string } }).rotation.jobId;
  expect(await resumeRotation(firstJob, browser, { maxSteps: 1 })).toBe(false);
  const secondResponse = await sharingRequest(owner, `/api/private/grants/${secondGrant.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const { rotation } = (await secondResponse.json()) as { rotation: { jobId: string; keyEpoch: number } };
  expect(rotation.keyEpoch).toBe(3);
  expect((await sharingRequest(owner, `/api/private/key-rotations/${firstJob}/next`)).status).toBe(409);
  expect(await resumeRotation(rotation.jobId, browser)).toBe(true);
  expect(await (await sharingRequest(owner, `/api/private/tree/files/${fileId}`)).json()).toMatchObject({
    capability: { epoch: 3 },
  });
});

it("missing current Private Comment key material leaves rotation sealed rather than silently abandoning current history", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const browser = await rotationBrowser(owner),
    fileId = await treeChild(owner, owner.rootId, "file", owner.accountId, true);
  const active = await grant(owner, recipient, fileId);
  const objectId = opaqueId();
  await env.DB.prepare(`INSERT INTO sharing_comment_capabilities (object_id, owner_id, file_id, thread_id, purpose, capability_id, capability_epoch)
    VALUES (?, ?, ?, ?, 'private-comment-thread', ?, 1)`)
    .bind(objectId, owner.accountId, fileId, objectId, opaqueId())
    .run();
  const prepared = await savePayload(owner, owner.accountId, fileId, owner.rootId);
  const response = await sharingRequest(owner, `/api/private/grants/${active.grantId}`, "DELETE", {
    expectedRevision: 1,
  });
  const jobId = ((await response.json()) as { rotation: { jobId: string } }).rotation.jobId;
  await expect(resumeRotation(jobId, browser)).rejects.toThrow("Current Comment key is not available");
  expect(await (await sharingRequest(owner, `/api/private/key-rotations/${jobId}/next`)).json()).toMatchObject({
    operation: "start",
    job: { progress: 1 },
    item: { kind: "private_comment" },
    source: { capabilityEpoch: 1 },
  });
  expect((await sharingRequest(owner, `/api/private/tree/files/${fileId}`, "PATCH", prepared)).status).toBe(409);
});
