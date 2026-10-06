import type { SQL } from "drizzle-orm";
import { sql } from "~/shared/db/client.server";
import type { AuthorizedDevice } from "~/device/proof.server";
import { activeRootCoverage } from "./capability-coverage.server";

/** Correlated relationship s. Forwarding within the same recipient Account is
 * provisioning, never resharing. Possession without current server authority is insufficient. */
export function rootDeliveryAuthority(auth: AuthorizedDevice, kind: "shares" | "grants") {
  if (kind === "shares") return sql`s.owner_id = ${auth.accountId}`;
  return sql`(s.owner_id = ${auth.accountId} OR (s.recipient_id = ${auth.accountId}
    AND ${activeRootCoverage(auth.deviceId)}))`;
}

export function currentCommentEnvelope(
  deviceId: string | SQL,
  objectId: string | SQL,
  capabilityId: string | SQL,
  capabilityEpoch: number | SQL,
) {
  return sql`EXISTS (SELECT 1 FROM grant_comment_key_envelopes e
    WHERE e.relationship_id = s.id AND e.device_id = ${deviceId} AND e.object_id = ${objectId}
      AND e.capability_id = ${capabilityId} AND e.capability_epoch = ${capabilityEpoch}
      AND e.grant_key_epoch = s.key_epoch)`;
}

export function commentDeliveryAuthority(
  auth: AuthorizedDevice,
  kind: "shares" | "grants",
  context: { objectId: string | SQL; capabilityId: string | SQL; capabilityEpoch: number | SQL },
) {
  if (kind === "shares") return sql`s.owner_id = ${auth.accountId}`;
  return sql`(s.owner_id = ${auth.accountId} OR (s.recipient_id = ${auth.accountId}
    AND ${currentCommentEnvelope(auth.deviceId, context.objectId, context.capabilityId, context.capabilityEpoch)}))`;
}
