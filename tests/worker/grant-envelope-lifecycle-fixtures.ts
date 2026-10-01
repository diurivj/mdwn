import { env } from "cloudflare:test";
import { opaqueId, sharingAccount } from "./sharing-fixtures";

/** Storage-boundary dependents for device-lifecycle tests, not an envelope-open
 * fixture. Real signed HPKE delivery/acceptance is covered by grant-delivery. */
export async function seedRecipientEnvelopeDependents(recipientId: string, deviceIds: string[]) {
  const registry = await env.DB.prepare("SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ?")
    .bind(recipientId).first<{ registry_epoch: number }>();
  if (!registry) throw new Error("Missing recipient registry");
  const relationships: { kind: "shares" | "grants"; id: string }[] = [];
  for (const kind of ["shares", "grants"] as const) {
    const owner = await sharingAccount(), id = opaqueId();
    await env.DB.prepare(kind === "shares" ?
      "INSERT INTO shares (id, owner_id, recipient_id, target_id, target_kind, permission, created_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1)" :
      "INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, 'directory', 'read_only', 1, 1, 1, 1)")
      .bind(id, owner.accountId, recipientId, owner.rootId).run();
    for (const deviceId of deviceIds) await env.DB.prepare(`INSERT INTO ${kind === "shares" ? "share_key_envelopes" : "grant_key_envelopes"}
      (relationship_id, device_id, capability_id, capability_epoch, grant_key_epoch, owner_registry_epoch, recipient_registry_epoch,
        ciphertext, signature, signer_device_id) VALUES (?, ?, ?, 1, 1, 1, ?, X'01', zeroblob(64), ?)`)
      .bind(id, deviceId, owner.rootId, registry.registry_epoch, owner.deviceId).run();
    relationships.push({ kind, id });
  }
  return relationships;
}
