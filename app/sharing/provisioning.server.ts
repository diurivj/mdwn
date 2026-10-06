import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { createDb, sql } from "~/shared/db/client.server";
import { authorizePrivateRequest, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/shared/tree/wire";
import { sharingWriteBlocked } from "./access.server";
import { activeRootCoverage, requiredGrantComments } from "./capability-coverage.server";
import { currentCommentEnvelope, rootDeliveryAuthority } from "./delivery-authority.server";
import { deliveryContext, readCommentKey } from "./comment-keys.server";
import { contextFor, readGrantKeys } from "./grant-keys.server";
import { expireGrantBatch, hasExpiredGrants, liveGrant } from "./grant-expiry.server";

const headers = { "Cache-Control": "no-store" };

async function nextProvisioning(env: Env, auth: AuthorizedDevice) {
  const db = createDb(env.DB);
  const pending = !!await db.get(sql`SELECT 1 FROM provisioning_needs n JOIN grants s ON s.id = n.grant_id
    WHERE s.recipient_id = ${auth.accountId} AND n.device_id = ${auth.deviceId}
      AND n.grant_key_epoch = s.key_epoch AND ${liveGrant()} AND ${privateReadGuard(auth)} LIMIT 1`);
  const expirationPending = !!await db.get(sql`SELECT 1 WHERE ${hasExpiredGrants(auth)} AND ${privateReadGuard(auth)}`);
  const status = { pending, ...(expirationPending ? { expirationPending: true } : {}) };
  type Need = { grantId: string; deviceId: string; transport: ArrayBuffer; grantKeyEpoch: number; objectId: string | null; recovery: ArrayBuffer | null };
  const need = await db.get<Need>(sql`
    SELECT s.id AS grantId, d.id AS deviceId, d.transport_public_key AS transport, s.key_epoch AS grantKeyEpoch,
      NULL AS objectId, NULL AS recovery
    FROM provisioning_needs n JOIN grants s ON s.id = n.grant_id
    JOIN encryption_devices d ON d.id = n.device_id AND d.account_id = s.recipient_id AND d.state = 'active'
    WHERE n.grant_key_epoch = s.key_epoch AND ${liveGrant()} AND ${rootDeliveryAuthority(auth, "grants")}
      AND NOT (${activeRootCoverage(sql`d.id`)}) AND NOT ${sharingWriteBlocked(sql`s.target_id`)}
      AND ${privateReadGuard(auth)} ORDER BY s.id, d.id LIMIT 1`) ?? await db.get<Need>(sql`
    SELECT s.id AS grantId, d.id AS deviceId, d.transport_public_key AS transport, s.key_epoch AS grantKeyEpoch,
      c.object_id AS objectId, k.ciphertext AS recovery
    FROM provisioning_needs n JOIN grants s ON s.id = n.grant_id
    JOIN encryption_devices d ON d.id = n.device_id AND d.account_id = s.recipient_id AND d.state = 'active'
    JOIN sharing_comment_capabilities c ON c.object_id IN (SELECT object_id FROM (${requiredGrantComments()}))
    LEFT JOIN key_envelopes k ON k.account_id = c.owner_id AND k.object_id = c.object_id
      AND k.purpose = 'vault-recovery' AND k.recipient_id = 'vault-root'
      AND k.key_epoch = c.capability_epoch AND k.superseded_at IS NULL
    WHERE n.grant_key_epoch = s.key_epoch AND ${liveGrant()}
      AND NOT (${currentCommentEnvelope(sql`d.id`, sql`c.object_id`, sql`c.capability_id`, sql`c.capability_epoch`)})
      AND (s.owner_id = ${auth.accountId} AND k.ciphertext IS NOT NULL OR s.recipient_id = ${auth.accountId}
        AND ${currentCommentEnvelope(auth.deviceId, sql`c.object_id`, sql`c.capability_id`, sql`c.capability_epoch`)})
      AND NOT ${sharingWriteBlocked(sql`c.file_id`)} AND ${privateReadGuard(auth)}
    ORDER BY s.id, d.id, c.object_id LIMIT 1`);
  if (!need) return Response.json({ item: null, ...status }, { headers });
  const context = need.objectId ? (await deliveryContext(env, auth, "grants", need.grantId, need.objectId))?.comment
    : await contextFor(env, auth, "grants", need.grantId);
  if (!context?.capabilityId || !context.capabilityEpoch || context.grantKeyEpoch !== need.grantKeyEpoch)
    return Response.json({ error: "sharing_changed" }, { status: 409, headers });
  let source: object = need.objectId && need.recovery ? { kind: "recovery", envelope: encodeTreeBytes(new Uint8Array(need.recovery)) }
    : { kind: "owned" };
  if (auth.accountId === context.recipientId) {
    const response = need.objectId ? await readCommentKey(env, auth, "grants", need.grantId, need.objectId, null)
      : await readGrantKeys(env, auth, "grants", need.grantId, null);
    if (!response.ok) return response;
    source = { kind: "grant", envelope: await response.json() };
  }
  return Response.json({ item: { context, device: { deviceId: need.deviceId,
    transportPublicKey: encodeTreeBytes(new Uint8Array(need.transport)) }, source }, ...status }, { headers });
}

export async function provisioningAction(request: Request, env: Env) {
  const url = new URL(request.url);
  const reading = url.pathname === "/api/private/grant-provisioning/next" && request.method === "POST";
  const expiring = url.pathname === "/api/private/grant-provisioning/expire" && request.method === "PATCH";
  if ((!reading && !expiring) || url.search) return Response.json({ error: "not_found" }, { status: 404, headers });
  let raw = "";
  try {
    if (reading) {
      if (!await hasEmptyBody(request)) return Response.json({ error: "device_proof_required" }, { status: 403, headers });
    } else {
      const parsed = await readAuthJsonText(request, 4096), input = record(parsed.value);
      if (!input || Object.keys(input).length) throw new Error("invalid request");
      raw = parsed.raw;
    }
  } catch { return Response.json({ error: "invalid_sharing_request" }, { status: 400, headers }); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403, headers }); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return Response.json({ error: "device_proof_required" }, { status: 403, headers });
  return expiring ? expireGrantBatch(env, auth) : nextProvisioning(env, auth);
}
