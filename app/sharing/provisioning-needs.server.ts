import type { SQL } from "drizzle-orm";
import { createDb, sql } from "~/shared/db/client.server";
import { record } from "~/auth/request.server";
import { commitPrivateBatch, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { activeGrantCoverage } from "./capability-coverage.server";
import { liveGrant } from "./grant-lifetime.server";

/** Reconcile only live Grants/devices against current capabilities. A page or
 * rotation step may call this under its own invocation marker; no crypto opens.
 */
export function reconcileGrantNeeds(grantId: string, marker: SQL) {
  return [
    sql`DELETE FROM provisioning_needs WHERE grant_id = ${grantId} AND ${marker}
      AND NOT EXISTS (SELECT 1 FROM grants s JOIN encryption_devices d ON d.account_id = s.recipient_id
        WHERE s.id = provisioning_needs.grant_id AND d.id = provisioning_needs.device_id AND d.state = 'active'
          AND ${liveGrant()} AND s.key_epoch = provisioning_needs.grant_key_epoch AND NOT (${activeGrantCoverage(sql`d.id`)}))`,
    sql`INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
      SELECT s.id, d.id, s.key_epoch FROM grants s JOIN encryption_devices d
        ON d.account_id = s.recipient_id AND d.state = 'active'
      WHERE s.id = ${grantId} AND ${liveGrant()} AND NOT (${activeGrantCoverage(sql`d.id`)}) AND ${marker}
      ON CONFLICT (grant_id, device_id) DO NOTHING`,
  ];
}

/** Invoke inside the same guarded envelope/rotation transaction. Never retire
 * a need for root-only coverage when retained Comment history is still missing.
 */
export function retireFulfilledNeeds(grantId: string | SQL, marker: SQL) {
  return sql`DELETE FROM provisioning_needs WHERE grant_id = ${grantId} AND ${marker}
    AND EXISTS (SELECT 1 FROM grants s JOIN encryption_devices d ON d.account_id = s.recipient_id
      WHERE s.id = provisioning_needs.grant_id AND d.id = provisioning_needs.device_id AND d.state = 'active'
        AND s.key_epoch = provisioning_needs.grant_key_epoch AND ${activeGrantCoverage(sql`d.id`)})`;
}

/** File/subtree deletion can complete a Comment-only need on a surviving
 * ancestor Grant. Limit that reconciliation to the bounded ancestor path.
 */
export function retireDeletedScopeNeeds(ownerId: string, nodeId: string, marker: SQL) {
  const covering = sql`provisioning_needs.grant_id IN (WITH RECURSIVE ancestors(id, parent_node_id, depth) AS (
    SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = ${nodeId} AND owner_id = ${ownerId}
    UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM ancestors a JOIN vault_nodes n ON n.id = a.parent_node_id
      WHERE n.owner_id = ${ownerId} AND a.depth < 100
  ) SELECT s.id FROM ancestors a JOIN grants s ON s.target_id = a.id AND s.owner_id = ${ownerId})`;
  return retireFulfilledNeeds(sql`provisioning_needs.grant_id`, sql`${marker} AND ${covering}`);
}

export async function reconcileProvisioningNeeds(env: Env, auth: AuthorizedDevice, grantId: string, value: unknown) {
  const headers = { "Cache-Control": "no-store" },
    input = record(value);
  if (!input || Object.keys(input).length)
    return Response.json({ error: "invalid_sharing_request" }, { status: 400, headers });
  if (
    !(await createDb(env.DB).get(sql`SELECT 1 FROM grants WHERE id = ${grantId} AND ${liveGrant(sql`expires_at`)}
    AND (owner_id = ${auth.accountId} OR recipient_id = ${auth.accountId}) AND ${privateReadGuard(auth)}`))
  )
    return Response.json({ error: "not_found" }, { status: 404, headers });
  const committed = await commitPrivateBatch(
    env,
    auth,
    (guard) => sql`UPDATE grants SET updated_at = updated_at
    WHERE id = ${grantId} AND ${liveGrant(sql`expires_at`)} AND (owner_id = ${auth.accountId} OR recipient_id = ${auth.accountId}) AND ${guard}`,
    (marker) => reconcileGrantNeeds(grantId, marker),
  );
  return committed
    ? Response.json({ reconciled: true }, { headers })
    : Response.json({ error: "sharing_changed" }, { status: 409, headers });
}

export async function readProvisioningNeeds(env: Env, auth: AuthorizedDevice, grantId: string, cursor: string | null) {
  const headers = { "Cache-Control": "no-store" };
  const relationship = await createDb(env.DB).get<{ owner_id: string }>(sql`SELECT owner_id FROM grants
    WHERE id = ${grantId} AND ${liveGrant(sql`expires_at`)} AND (owner_id = ${auth.accountId} OR recipient_id = ${auth.accountId}) AND ${privateReadGuard(auth)}`);
  if (!relationship) return Response.json({ error: "not_found" }, { status: 404, headers });
  if (relationship.owner_id !== auth.accountId && cursor !== null)
    return Response.json({ error: "invalid_sharing_request" }, { status: 400, headers });
  const rows = await createDb(env.DB).all<{ deviceId: string; grantKeyEpoch: number }>(sql`
    SELECT n.device_id AS deviceId, n.grant_key_epoch AS grantKeyEpoch FROM provisioning_needs n
    JOIN grants s ON s.id = n.grant_id JOIN encryption_devices d ON d.id = n.device_id
    WHERE s.id = ${grantId} AND ${liveGrant()} AND d.account_id = s.recipient_id AND d.state = 'active' AND n.grant_key_epoch = s.key_epoch
      AND (s.owner_id = ${auth.accountId} OR s.recipient_id = ${auth.accountId} AND d.id = ${auth.deviceId})
      AND n.device_id > ${cursor ?? ""} AND ${privateReadGuard(auth)} ORDER BY n.device_id LIMIT 21`);
  return Response.json(
    {
      needs: rows.slice(0, 20).map((row) => ({ grantId, ...row })),
      nextCursor: rows.length > 20 ? rows[19]!.deviceId : null,
    },
    { headers },
  );
}
