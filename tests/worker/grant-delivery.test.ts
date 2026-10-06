import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { invite, sharingAccount, sharingRequest, treeChild } from "./sharing-fixtures";
import { decodeTreeBytes, encodeTreeBytes } from "../../app/shared/tree/wire";
import {
  createGrantKeyEnvelope,
  openGrantKeyEnvelope,
  type GrantKeyContext,
} from "../../app/shared/sharing/grant-keys";
import type { SharingAccount } from "./sharing-fixtures";
import { signDeviceProof, sessionBindingDigest } from "../../app/shared/device/proof";
import { opaqueId } from "./sharing-fixtures";
import { sealToRecipient } from "../../app/shared/crypto/enc-v1";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("only the pending Share Owner can retrieve its current delivery targets", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { shareId } = await invite(owner, recipient, targetId);
  const path = `/api/private/shares/${shareId}/keys`;
  const response = await sharingRequest(owner, path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    relationshipId: shareId,
    ownerId: owner.accountId,
    recipientId: recipient.accountId,
    targetId,
    targetKind: "directory",
    capabilityId: targetId,
    capabilityEpoch: 1,
    grantKeyEpoch: 1,
    ownerRegistryEpoch: 1,
    recipientRegistryEpoch: 1,
    devices: [
      {
        deviceId: recipient.deviceId,
        transportPublicKey: encodeTreeBytes(
          new Uint8Array(await crypto.subtle.exportKey("raw", recipient.transport.publicKey)),
        ),
      },
    ],
    nextCursor: null,
  });
  expect((await sharingRequest(recipient, path)).status).toBe(404);
  expect((await sharingRequest(stranger, path)).status).toBe(404);
});

const rootKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
type Targets = GrantKeyContext & {
  devices: { deviceId: string; transportPublicKey: string }[];
  nextCursor: string | null;
};
async function prepare(owner: SharingAccount, recipient: SharingAccount) {
  const targetId = await treeChild(owner, owner.rootId, "directory");
  const { shareId } = await invite(owner, recipient, targetId);
  const path = `/api/private/shares/${shareId}/keys`;
  const response = await sharingRequest(owner, path);
  expect(response.status).toBe(200);
  const context = (await response.json()) as Targets;
  const envelope = await createGrantKeyEnvelope(rootKey, recipient.transport.publicKey, owner.assertion.privateKey, {
    ...context,
    deviceId: recipient.deviceId,
    signerDeviceId: owner.deviceId,
  });
  const packet = {
    capabilityId: context.capabilityId,
    capabilityEpoch: context.capabilityEpoch,
    ownerRegistryEpoch: context.ownerRegistryEpoch,
    recipientRegistryEpoch: context.recipientRegistryEpoch,
    envelopes: [envelope],
  };
  return { shareId, path, context, envelope, packet };
}
async function accept(recipient: SharingAccount, shareId: string) {
  return sharingRequest(recipient, `/api/private/shares/${shareId}/accept`, "POST", {});
}
async function atEpoch(account: SharingAccount, path: string, epoch: number, value?: object, method = "POST") {
  const url = `https://mdwn.test${path}`,
    body = value === undefined ? undefined : JSON.stringify(value);
  const proof = await signDeviceProof(account.assertion.privateKey, {
    sessionBinding: await sessionBindingDigest(account.session.id),
    deviceId: account.deviceId,
    registryEpoch: epoch,
    method,
    url,
    body,
  });
  return SELF.fetch(url, {
    method,
    headers: {
      cookie: account.session.cookie,
      origin: "https://mdwn.test",
      "X-Mdwn-Device-Proof": JSON.stringify(proof),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
}
async function addDevice(account: SharingAccount) {
  const deviceId = opaqueId();
  const transport = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const assertion = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  await env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key,
    state, approval_provenance, registry_epoch, created_at)
    SELECT ?, account_id, ?, ?, 'active', 'signup', registry_epoch + 1, ?
    FROM account_encryption_identities WHERE account_id = ?`)
    .bind(
      deviceId,
      new Uint8Array(await crypto.subtle.exportKey("raw", transport.publicKey)),
      new Uint8Array(await crypto.subtle.exportKey("raw", assertion.publicKey)),
      Date.now(),
      account.accountId,
    )
    .run();
  return { deviceId, transport, assertion };
}

it("requires delivery before accepting, atomically preserves the relationship and decrypts the literal root key", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const pending = await prepare(owner, recipient);
  expect((await accept(recipient, pending.shareId)).status).toBe(409);
  expect(await (await sharingRequest(recipient, "/api/private/grants")).json()).toMatchObject({ received: [] });
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
  const accepted = await accept(recipient, pending.shareId);
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toEqual({ grantId: pending.shareId });
  expect((await sharingRequest(owner, pending.path)).status).toBe(404);
  expect(await (await sharingRequest(recipient, "/api/private/shares")).json()).toMatchObject({ incoming: [] });
  const activePath = `/api/private/grants/${pending.shareId}/keys`;
  expect((await sharingRequest(owner, activePath)).status).toBe(200);
  expect((await sharingRequest(owner, activePath, "PUT", pending.packet)).status).toBe(200);
  const response = await sharingRequest(recipient, activePath);
  expect(response.status).toBe(200);
  const record = (await response.json()) as Parameters<typeof openGrantKeyEnvelope>[0];
  expect(record).not.toHaveProperty("devices");
  expect(await openGrantKeyEnvelope({ ...record, recipient: recipient.transport })).toEqual(rootKey);
  for (const mutation of [
    { recipientId: owner.accountId },
    { deviceId: owner.deviceId },
    { targetId: owner.rootId },
    { capabilityEpoch: 2 },
    { grantKeyEpoch: 2 },
    { ownerRegistryEpoch: 2 },
    { recipientRegistryEpoch: 2 },
  ]) {
    await expect(openGrantKeyEnvelope({ ...record, ...mutation, recipient: recipient.transport })).rejects.toThrow();
  }
  await expect(openGrantKeyEnvelope({ ...record, recipient: owner.transport })).rejects.toThrow();
});

it("rejects wrong device, object, purpose, epochs and non-Owner signed packets without allowing acceptance", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount(),
    stranger = await sharingAccount();
  const pending = await prepare(owner, recipient);
  expect((await sharingRequest(recipient, pending.path, "PUT", pending.packet)).status).toBe(404);
  expect((await sharingRequest(stranger, pending.path, "PUT", pending.packet)).status).toBe(404);
  for (const mutation of [
    { deviceId: owner.deviceId },
    { targetId: owner.rootId },
    { recipientId: stranger.accountId },
    { relationshipId: owner.rootId },
    { ownerRegistryEpoch: 2 },
    { recipientRegistryEpoch: 2 },
    { grantKeyEpoch: 2 },
  ]) {
    const wrong = await createGrantKeyEnvelope(rootKey, recipient.transport.publicKey, owner.assertion.privateKey, {
      ...pending.context,
      deviceId: recipient.deviceId,
      signerDeviceId: owner.deviceId,
      ...mutation,
    });
    expect((await sharingRequest(owner, pending.path, "PUT", { ...pending.packet, envelopes: [wrong] })).ok).toBe(
      false,
    );
  }
  const wrongPurpose = await sealToRecipient(rootKey, recipient.transport.publicKey, {
    purpose: "device-enrollment",
    vaultId: owner.accountId,
    objectId: pending.context.targetId,
    keyId: pending.context.capabilityId,
    keyEpoch: 1,
    revision: 1,
    recipientId: recipient.deviceId,
  });
  const digest = encodeTreeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", wrongPurpose)));
  const statement = new TextEncoder().encode(
    JSON.stringify([
      "mdwn/grant-key-envelope",
      1,
      pending.shareId,
      owner.accountId,
      recipient.accountId,
      pending.context.targetId,
      "directory",
      pending.context.capabilityId,
      1,
      1,
      1,
      1,
      recipient.deviceId,
      owner.deviceId,
      digest,
    ]),
  );
  const signature = encodeTreeBytes(
    new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, owner.assertion.privateKey, statement)),
  );
  expect(
    (
      await sharingRequest(owner, pending.path, "PUT", {
        ...pending.packet,
        envelopes: [{ deviceId: recipient.deviceId, ciphertext: encodeTreeBytes(wrongPurpose), signature }],
      })
    ).status,
  ).toBe(400);
  const ciphertext = decodeTreeBytes(pending.envelope.ciphertext, 16_384);
  ciphertext[ciphertext.length - 1] ^= 1;
  expect(
    (
      await sharingRequest(owner, pending.path, "PUT", {
        ...pending.packet,
        envelopes: [{ ...pending.envelope, ciphertext: encodeTreeBytes(ciphertext) }],
      })
    ).status,
  ).toBe(400);
  expect((await sharingRequest(owner, pending.path, "PUT", { ...pending.packet, capabilityEpoch: 2 })).status).toBe(
    409,
  );
  expect((await accept(recipient, pending.shareId)).status).toBe(409);
});

it("proof replay cannot overwrite delivered ciphertext or write a second packet", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const pending = await prepare(owner, recipient);
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet, "upload")).status).toBe(200);
  const replacementKey = new Uint8Array(32).fill(42);
  const replacement = await createGrantKeyEnvelope(
    replacementKey,
    recipient.transport.publicKey,
    owner.assertion.privateKey,
    { ...pending.context, deviceId: recipient.deviceId, signerDeviceId: owner.deviceId },
  );
  expect(
    (await sharingRequest(owner, pending.path, "PUT", { ...pending.packet, envelopes: [replacement] })).status,
  ).toBe(200);
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet, "upload")).status).toBe(409);
  expect((await accept(recipient, pending.shareId)).status).toBe(201);
  const record = (await (
    await sharingRequest(recipient, `/api/private/grants/${pending.shareId}/keys`)
  ).json()) as Parameters<typeof openGrantKeyEnvelope>[0];
  expect(record.ciphertext).toBe(replacement.ciphertext);
  expect(await openGrantKeyEnvelope({ ...record, recipient: recipient.transport })).toEqual(replacementKey);
});

it("cancellation, decline, revoke and leave clean dependent envelopes at the HTTP seam", async () => {
  for (const operation of ["cancel", "decline", "revoke", "leave"] as const) {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const pending = await prepare(owner, recipient);
    expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
    if (operation === "cancel" || operation === "decline") {
      const response =
        operation === "cancel"
          ? await sharingRequest(owner, `/api/private/shares/${pending.shareId}`, "DELETE", {})
          : await sharingRequest(recipient, `/api/private/shares/${pending.shareId}/decline`, "POST", {});
      expect(response.status).toBe(200);
      expect((await accept(recipient, pending.shareId)).status).toBe(404);
    } else {
      expect((await accept(recipient, pending.shareId)).status).toBe(201);
      const path = `/api/private/grants/${pending.shareId}`;
      const response =
        operation === "revoke"
          ? await sharingRequest(owner, path, "DELETE", { expectedRevision: 1 })
          : await sharingRequest(recipient, `${path}/leave`, "POST", { expectedRevision: 1 });
      expect(response.status).toBe(200);
      expect((await sharingRequest(recipient, `${path}/keys`)).status).toBe(404);
    }
  }
});

it("permission changes invalidate envelopes and block provisioning beneath the sealed target", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const pending = await prepare(owner, recipient);
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
  expect((await accept(recipient, pending.shareId)).status).toBe(201);
  const path = `/api/private/grants/${pending.shareId}`;
  expect(
    (await sharingRequest(recipient, path, "PATCH", { expectedRevision: 1, permission: "read_write" })).status,
  ).toBe(404);
  expect((await sharingRequest(owner, path, "PATCH", { expectedRevision: 1, permission: "read_write" })).status).toBe(
    200,
  );
  expect((await sharingRequest(recipient, `${path}/keys`)).status).toBe(409);
  const response = await sharingRequest(owner, `${path}/keys`);
  const context = (await response.json()) as Targets;
  const envelope = await createGrantKeyEnvelope(rootKey, recipient.transport.publicKey, owner.assertion.privateKey, {
    ...context,
    deviceId: recipient.deviceId,
    signerDeviceId: owner.deviceId,
  });
  expect(
    (await sharingRequest(owner, `${path}/keys`, "PUT", { ...pending.packet, envelopes: [envelope] })).status,
  ).toBe(409);
});

it("a partial device packet cannot accept; subsequent packet completes the same current snapshot", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const second = await addDevice(recipient);
  const pending = await prepare(owner, recipient);
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
  expect((await atEpoch(recipient, `/api/private/shares/${pending.shareId}/accept`, 2, {})).status).toBe(409);
  const envelope = await createGrantKeyEnvelope(rootKey, second.transport.publicKey, owner.assertion.privateKey, {
    ...pending.context,
    deviceId: second.deviceId,
    signerDeviceId: owner.deviceId,
  });
  expect((await sharingRequest(owner, pending.path, "PUT", { ...pending.packet, envelopes: [envelope] })).status).toBe(
    200,
  );
  expect((await atEpoch(recipient, `/api/private/shares/${pending.shareId}/accept`, 2, {})).status).toBe(201);
});

it("registry changes and revoked Owner signers deny pending acceptance without creating a Grant", async () => {
  for (const changed of ["owner", "recipient", "signer"] as const) {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const pending = await prepare(owner, recipient);
    expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
    if (changed === "signer")
      await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(owner.deviceId).run();
    else
      await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id = ?")
        .bind(changed === "owner" ? owner.accountId : recipient.accountId)
        .run();
    const response =
      changed === "recipient"
        ? await atEpoch(recipient, `/api/private/shares/${pending.shareId}/accept`, 2, {})
        : await accept(recipient, pending.shareId);
    expect(response.status).toBe(409);
    const grants =
      changed === "recipient"
        ? await atEpoch(recipient, "/api/private/grants", 2)
        : await sharingRequest(recipient, "/api/private/grants");
    expect(await grants.json()).toMatchObject({ received: [] });
  }
});

it("historical active envelopes survive registry growth and signer revocation, but new devices wait for provisioning", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const pending = await prepare(owner, recipient);
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
  expect((await accept(recipient, pending.shareId)).status).toBe(201);
  const second = await addDevice(recipient);
  await env.DB.batch([
    env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = 2 WHERE account_id IN (?, ?)").bind(
      owner.accountId,
      recipient.accountId,
    ),
    env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(owner.deviceId),
  ]);
  const path = `/api/private/grants/${pending.shareId}/keys`;
  const response = await atEpoch(recipient, path, 2);
  expect(response.status).toBe(200);
  const record = (await response.json()) as Parameters<typeof openGrantKeyEnvelope>[0];
  expect(record.ownerRegistryEpoch).toBe(1);
  expect(record.recipientRegistryEpoch).toBe(1);
  expect(await openGrantKeyEnvelope({ ...record, recipient: recipient.transport })).toEqual(rootKey);
  await env.DB.prepare("UPDATE sessions SET device_id = ? WHERE id = ?")
    .bind(second.deviceId, recipient.session.id)
    .run();
  expect((await atEpoch({ ...recipient, ...second }, path, 2)).status).toBe(409);
  await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(second.deviceId).run();
  expect((await atEpoch({ ...recipient, ...second }, path, 2)).status).toBe(403);
});

it.each(["owner", "recipient"] as const)(
  "refreshing one active device after %s registry growth preserves other devices' historical envelopes",
  async (changed) => {
    const owner = await sharingAccount(),
      recipient = await sharingAccount();
    const second = await addDevice(recipient);
    const pending = await prepare(owner, recipient);
    const secondEnvelope = await createGrantKeyEnvelope(
      rootKey,
      second.transport.publicKey,
      owner.assertion.privateKey,
      { ...pending.context, deviceId: second.deviceId, signerDeviceId: owner.deviceId },
    );
    expect(
      (
        await sharingRequest(owner, pending.path, "PUT", {
          ...pending.packet,
          envelopes: [pending.envelope, secondEnvelope],
        })
      ).status,
    ).toBe(200);
    expect((await atEpoch(recipient, `/api/private/shares/${pending.shareId}/accept`, 2, {})).status).toBe(201);

    await addDevice(changed === "owner" ? owner : recipient);
    const ownerEpoch = changed === "owner" ? 2 : 1;
    const recipientEpoch = changed === "recipient" ? 3 : 2;
    const path = `/api/private/grants/${pending.shareId}/keys`;
    const targets = await atEpoch(owner, path, ownerEpoch);
    expect(targets.status).toBe(200);
    const context = (await targets.json()) as Targets;
    expect(context.ownerRegistryEpoch).toBe(ownerEpoch);
    expect(context.recipientRegistryEpoch).toBe(recipientEpoch);
    const refreshed = await createGrantKeyEnvelope(rootKey, second.transport.publicKey, owner.assertion.privateKey, {
      ...context,
      deviceId: second.deviceId,
      signerDeviceId: owner.deviceId,
    });
    expect(
      (
        await atEpoch(
          owner,
          path,
          ownerEpoch,
          {
            capabilityId: context.capabilityId,
            capabilityEpoch: context.capabilityEpoch,
            ownerRegistryEpoch: context.ownerRegistryEpoch,
            recipientRegistryEpoch: context.recipientRegistryEpoch,
            envelopes: [refreshed],
          },
          "PUT",
        )
      ).status,
    ).toBe(200);

    const response = await atEpoch(recipient, path, recipientEpoch);
    expect(response.status).toBe(200);
    const record = (await response.json()) as Parameters<typeof openGrantKeyEnvelope>[0];
    expect(record.ciphertext).toBe(pending.envelope.ciphertext);
    expect(record.ownerRegistryEpoch).toBe(1);
    expect(record.recipientRegistryEpoch).toBe(2);
    expect(await openGrantKeyEnvelope({ ...record, recipient: recipient.transport })).toEqual(rootKey);
  },
);

it("revoked recipients cannot receive or accept pending material", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  const pending = await prepare(owner, recipient);
  expect((await sharingRequest(owner, pending.path, "PUT", pending.packet)).status).toBe(200);
  await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?").bind(recipient.deviceId).run();
  expect((await accept(recipient, pending.shareId)).status).toBe(403);
  expect((await sharingRequest(recipient, pending.path)).status).toBe(403);
});

it("delivery targets paginate at twenty devices and strictly reject query and body extras", async () => {
  const owner = await sharingAccount(),
    recipient = await sharingAccount();
  for (let index = 0; index < 20; index++) await addDevice(recipient);
  const pending = await prepare(owner, recipient);
  expect(pending.context.devices).toHaveLength(20);
  expect(pending.context.nextCursor).not.toBeNull();
  const response = await sharingRequest(owner, `${pending.path}?cursor=${pending.context.nextCursor}`);
  const page = (await response.json()) as Targets;
  expect(page.devices).toHaveLength(1);
  expect(page.nextCursor).toBeNull();
  expect(new Set([...pending.context.devices, ...page.devices].map((device) => device.deviceId)).size).toBe(21);
  const sealTargets = async (devices: Targets["devices"]) =>
    Promise.all(
      devices.map(async (device) => {
        const publicKey = await crypto.subtle.importKey(
          "raw",
          decodeTreeBytes(device.transportPublicKey, 65),
          { name: "ECDH", namedCurve: "P-256" },
          true,
          [],
        );
        return createGrantKeyEnvelope(rootKey, publicKey, owner.assertion.privateKey, {
          ...pending.context,
          deviceId: device.deviceId,
          signerDeviceId: owner.deviceId,
        });
      }),
    );
  // Exercise the maximum-size real D1 upload anchor, not just a parser rejection.
  expect(
    (
      await sharingRequest(owner, pending.path, "PUT", {
        ...pending.packet,
        envelopes: await sealTargets(pending.context.devices),
      })
    ).status,
  ).toBe(200);
  expect((await atEpoch(recipient, `/api/private/shares/${pending.shareId}/accept`, 21, {})).status).toBe(409);
  expect(
    (
      await sharingRequest(owner, pending.path, "PUT", {
        ...pending.packet,
        envelopes: await sealTargets(page.devices),
      })
    ).status,
  ).toBe(200);
  expect((await atEpoch(recipient, `/api/private/shares/${pending.shareId}/accept`, 21, {})).status).toBe(201);
  expect((await sharingRequest(owner, `${pending.path}?account=${recipient.accountId}`)).status).toBe(400);
  expect(
    (await sharingRequest(owner, `${pending.path}?cursor=${recipient.deviceId}&cursor=${recipient.deviceId}`)).status,
  ).toBe(400);
  expect((await sharingRequest(owner, pending.path, "PUT", { ...pending.packet, extra: true })).status).toBe(400);
  expect(
    (
      await sharingRequest(owner, pending.path, "PUT", {
        ...pending.packet,
        envelopes: Array.from({ length: 21 }, () => pending.envelope),
      })
    ).status,
  ).toBe(400);
});
