import { env } from "cloudflare:test";
import { newPublicationIdentifier } from "../../app/shared/publications/capability";
import { opaqueId, sharingAccount, treeChild } from "./sharing-fixtures";

/** Storage-boundary dependents for device-lifecycle tests, not an envelope-open
 * fixture. Real signed HPKE delivery/acceptance is covered by grant-delivery. */
export async function seedRecipientEnvelopeDependents(recipientId: string, deviceIds: string[]) {
  const registry = await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
    .bind(recipientId)
    .first<{ registry_epoch: number }>();
  if (!registry) throw new Error("Missing recipient registry");
  const relationships: { kind: "shares" | "grants"; id: string; commentObjectIds: string[] }[] = [];
  for (const kind of ["shares", "grants"] as const) {
    const owner = await sharingAccount(),
      id = opaqueId();
    await env.DB.prepare(
      kind === "shares"
        ? "INSERT INTO shares (id, owner_id, recipient_id, target_id, target_kind, permission, created_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1)"
        : "INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, 1, 1, 1)",
    )
      .bind(id, owner.accountId, recipientId, owner.rootId)
      .run();
    for (const deviceId of deviceIds)
      await env.DB.prepare(`INSERT INTO ${kind === "shares" ? "share_key_envelopes" : "grant_key_envelopes"}
      (relationship_id, device_id, capability_id, capability_epoch, grant_key_epoch, owner_registry_epoch, recipient_registry_epoch,
        ciphertext, signature, signer_device_id) VALUES (?, ?, ?, 1, 1, 1, ?, X'01', zeroblob(64), ?)`)
        .bind(id, deviceId, owner.rootId, registry.registry_epoch, owner.deviceId)
        .run();
    const fileId = await treeChild(owner, owner.rootId, "file"),
      threadId = opaqueId();
    const commentObjectIds = [threadId, opaqueId()];
    for (const [index, objectId] of commentObjectIds.entries()) {
      const capabilityId = opaqueId();
      await env.DB.prepare(`INSERT INTO sharing_comment_capabilities
        (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
        .bind(
          objectId,
          owner.accountId,
          fileId,
          index === 0 ? objectId : opaqueId(),
          index === 0 ? "private-comment-thread" : "public-comment-audience-epoch",
          index === 0 ? null : newPublicationIdentifier(),
          capabilityId,
        )
        .run();
      for (const deviceId of deviceIds)
        await env.DB.prepare(`INSERT INTO ${kind === "shares" ? "share_comment_key_envelopes" : "grant_comment_key_envelopes"}
        (relationship_id, device_id, capability_id, capability_epoch, grant_key_epoch, owner_registry_epoch, recipient_registry_epoch,
          ciphertext, signature, signer_device_id, object_id) VALUES (?, ?, ?, 1, 1, 1, ?, X'01', zeroblob(64), ?, ?)`)
          .bind(id, deviceId, capabilityId, registry.registry_epoch, owner.deviceId, objectId)
          .run();
    }
    relationships.push({ kind, id, commentObjectIds });
  }
  return relationships;
}
