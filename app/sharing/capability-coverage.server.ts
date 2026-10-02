import type { SQL } from "drizzle-orm";
import { sql } from "~/db/client.server";
import type { AuthorizedDevice } from "~/device/proof.server";

/** Correlated relationship s. A next-epoch fence immediately makes source
 * envelopes non-current, even before browser replacement has installed bytes. */
export function grantRootMatches(capabilityId: string | SQL, capabilityEpoch: number | SQL) {
  return sql`EXISTS (SELECT 1 FROM vault_nodes n
    LEFT JOIN directories d ON d.node_id = n.id LEFT JOIN files f ON f.node_id = n.id
    LEFT JOIN sharing_write_blocks b ON b.target_id = n.id
    WHERE n.id = s.target_id AND n.owner_id = s.owner_id AND n.kind = s.target_kind
      AND CASE WHEN n.kind = 'directory' THEN n.id ELSE f.capability_id END = ${capabilityId}
      AND max(CASE WHEN n.kind = 'directory' THEN d.key_epoch ELSE f.capability_epoch END,
        coalesce(b.key_epoch, 0)) = ${capabilityEpoch})`;
}
export function grantRootMatchesForEnvelope() {
  return grantRootMatches(sql`e.capability_id`, sql`e.capability_epoch`);
}

/** Directory descendants inherit their root capability, not per-node Grants.
 * Only independent Comment capabilities require additional device envelopes.
 */
export function requiredGrantComments() {
  return sql`WITH RECURSIVE scope(id, depth) AS (
    SELECT s.target_id, 0 UNION ALL
    SELECT n.id, p.depth + 1 FROM scope p JOIN vault_nodes n ON n.parent_node_id = p.id
      WHERE s.target_kind = 'directory' AND n.owner_id = s.owner_id AND p.depth < 100
  ) SELECT c.* FROM scope p JOIN sharing_comment_capabilities c ON c.file_id = p.id
    WHERE c.owner_id = s.owner_id`;
}

/** Pending acceptance stays pinned to both complete current registry snapshots. */
export function pendingGrantCoverage(auth: AuthorizedDevice) {
  return sql`EXISTS (SELECT 1 FROM encryption_devices d WHERE d.account_id = s.recipient_id AND d.state = 'active')
    AND NOT EXISTS (SELECT 1 FROM encryption_devices d WHERE d.account_id = s.recipient_id AND d.state = 'active'
      AND NOT EXISTS (SELECT 1 FROM share_key_envelopes e JOIN encryption_devices signer ON signer.id = e.signer_device_id
        JOIN account_encryption_identities owner_registry ON owner_registry.account_id = s.owner_id
        WHERE e.relationship_id = s.id AND e.device_id = d.id AND e.grant_key_epoch = 1
          AND e.recipient_registry_epoch = ${auth.registryEpoch}
          AND e.owner_registry_epoch = owner_registry.registry_epoch
          AND signer.account_id = s.owner_id AND signer.state = 'active'
          AND ${grantRootMatchesForEnvelope()}))`;
}
export function pendingCommentCoverage() {
  return sql`NOT EXISTS (SELECT 1 FROM (${requiredGrantComments()}) c
    CROSS JOIN encryption_devices d
    WHERE d.account_id = s.recipient_id AND d.state = 'active' AND NOT EXISTS (
      SELECT 1 FROM share_comment_key_envelopes e
      JOIN encryption_devices signer ON signer.id = e.signer_device_id
      JOIN account_encryption_identities owner_registry ON owner_registry.account_id = s.owner_id
      JOIN account_encryption_identities recipient_registry ON recipient_registry.account_id = s.recipient_id
      WHERE e.relationship_id = s.id AND e.object_id = c.object_id AND e.device_id = d.id
        AND e.capability_id = c.capability_id AND e.capability_epoch = c.capability_epoch AND e.grant_key_epoch = 1
        AND e.owner_registry_epoch = owner_registry.registry_epoch
        AND e.recipient_registry_epoch = recipient_registry.registry_epoch
        AND signer.account_id = s.owner_id AND signer.state = 'active'))`;
}

/** Accepted envelopes retain historical registry snapshots for unchanged active
 * devices. Current object and Grant epochs, not registry additions, supersede them.
 */
export function activeRootCoverage(deviceId: string | SQL) {
  return sql`EXISTS (SELECT 1 FROM grant_key_envelopes e
    WHERE e.relationship_id = s.id AND e.device_id = ${deviceId} AND e.grant_key_epoch = s.key_epoch
      AND ${grantRootMatchesForEnvelope()})`;
}
export function activeGrantCoverage(deviceId: string | SQL) {
  return sql`${activeRootCoverage(deviceId)}
    AND NOT EXISTS (SELECT 1 FROM (${requiredGrantComments()}) c WHERE NOT EXISTS (
      SELECT 1 FROM grant_comment_key_envelopes e WHERE e.relationship_id = s.id AND e.device_id = ${deviceId}
        AND e.object_id = c.object_id AND e.capability_id = c.capability_id
        AND e.capability_epoch = c.capability_epoch AND e.grant_key_epoch = s.key_epoch))`;
}
