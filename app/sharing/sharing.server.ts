import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitPrivateBatch, commitPrivateMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { newOpaqueId } from "~/opaque-id";
import { isV7 } from "~/tree/wire";
import { shareHandleLookupToken } from "./address";
import { liveGrant } from "./grant-lifetime.server";
import { readGrantKeys, uploadGrantKeys } from "./grant-keys.server";
import { sharingWriteBlocked } from "./access.server";
import { listCommentKeys, readCommentKey, uploadCommentKeys } from "./comment-keys.server";
import { pendingGrantCoverage, pendingCommentCoverage, requiredGrantComments } from "./capability-coverage.server";
import { readProvisioningNeeds, reconcileGrantNeeds, reconcileProvisioningNeeds } from "./provisioning-needs.server";
import { planRotation, rotationIdentity, rotationSnapshot, startRotation } from "./rotation.server";

const headers = { "Cache-Control": "no-store" };
const failure = (error: string, status: number) => Response.json({ error }, { status, headers });
const notFound = () => failure("not_found", 404);
const conflict = () => failure("sharing_changed", 409);
const invalid = () => failure("invalid_sharing_request", 400);
const denied = () => failure("device_proof_required", 403);

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function listRelationships(env: Env, auth: AuthorizedDevice, kind: "shares" | "grants", cursor: string | null) {
  const table = kind === "shares" ? sql`shares` : sql`grants`;
  const rows = await createDb(env.DB).all<{ id: string; owner_id: string; recipient_id: string;
    target_id: string; target_kind: string; permission: string; revision?: number; key_epoch?: number; expires_at?: number | null }>(sql`
    SELECT * FROM ${table} WHERE (owner_id = ${auth.accountId} OR recipient_id = ${auth.accountId})
      AND ${kind === "shares" ? sql`1` : liveGrant(sql`expires_at`)}
      AND id > ${cursor ?? ""} AND ${privateReadGuard(auth)} ORDER BY id LIMIT 101`);
  const relationships = rows.slice(0, 100).map((row) => ({
    ...(kind === "shares" ? { shareId: row.id } : { grantId: row.id, revision: row.revision, keyEpoch: row.key_epoch, expiresAt: row.expires_at }),
    ownerId: row.owner_id, recipientId: row.recipient_id, targetId: row.target_id,
    targetKind: row.target_kind, permission: row.permission,
  }));
  return Response.json({
    ...(kind === "shares" ? { incoming: relationships.filter((row) => row.recipientId === auth.accountId),
      outgoing: relationships.filter((row) => row.ownerId === auth.accountId) } : {
      received: relationships.filter((row) => row.recipientId === auth.accountId),
      owned: relationships.filter((row) => row.ownerId === auth.accountId),
    }),
    nextCursor: rows.length > 100 ? rows[99]!.id : null,
  }, { headers });
}

async function createShare(env: Env, auth: AuthorizedDevice, value: unknown) {
  const input = record(value), recipient = record(input?.recipient);
  if (!input || !exact(input, ["targetId", "recipient", "permission"]) || !isV7(input.targetId) ||
      (input.permission !== "read_only" && input.permission !== "read_write") || !recipient) return invalid();
  let address;
  if (exact(recipient, ["shareId"]) && typeof recipient.shareId === "string" &&
      recipient.shareId.length > 0 && recipient.shareId.length <= 128) address = sql`share_id = ${recipient.shareId}`;
  else if (exact(recipient, ["handle"]) && typeof recipient.handle === "string") {
    try { address = sql`share_handle_lookup_token = ${await shareHandleLookupToken(recipient.handle)}`; }
    catch { return invalid(); }
  } else return invalid();
  const db = createDb(env.DB);
  const target = await db.get<{ kind: string; capability_id: string | null; capability_epoch: number | null }>(sql`
    SELECT n.kind, f.capability_id, f.capability_epoch FROM vault_nodes n
    LEFT JOIN files f ON f.node_id = n.id AND f.owner_id = n.owner_id
    WHERE n.id = ${input.targetId} AND n.owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!target) return notFound();
  if (target.kind === "file" && (!target.capability_id || !target.capability_epoch))
    return failure("shared_content_provisioning_required", 409);
  const account = await db.get<{ id: string }>(sql`SELECT id FROM accounts
    WHERE ${address} AND id != ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!account) return notFound();
  const shareId = newOpaqueId();
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    INSERT INTO shares (id, owner_id, recipient_id, target_id, target_kind, permission, created_at)
    SELECT ${shareId}, ${auth.accountId}, ${account.id}, n.id, n.kind, ${input.permission}, ${Date.now()}
    FROM vault_nodes n WHERE n.id = ${input.targetId} AND n.owner_id = ${auth.accountId}
      AND (n.kind = 'directory' OR EXISTS (SELECT 1 FROM files f WHERE f.node_id = n.id
        AND f.owner_id = n.owner_id AND f.capability_id IS NOT NULL AND f.capability_epoch IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM grants WHERE owner_id = ${auth.accountId}
        AND recipient_id = ${account.id} AND target_id = n.id) AND ${guard}
    ON CONFLICT (owner_id, recipient_id, target_id) DO NOTHING`);
  return committed ? Response.json({ shareId }, { status: 201, headers }) : conflict();
}

async function acceptShare(env: Env, auth: AuthorizedDevice, shareId: string, value: unknown) {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const pending = await createDb(env.DB).get<{ target_id: string }>(sql`SELECT target_id FROM shares
    WHERE id = ${shareId} AND recipient_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!pending) return notFound();
  const grantId = shareId, now = Date.now();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at)
    SELECT ${grantId}, s.owner_id, s.recipient_id, s.target_id, s.target_kind, s.permission, 1, 1, ${now}, ${now}
    FROM shares s WHERE s.id = ${shareId} AND s.recipient_id = ${auth.accountId}
      AND ${pendingGrantCoverage(auth)} AND ${pendingCommentCoverage()}
      AND NOT ${sharingWriteBlocked(pending.target_id)} AND ${guard}
    ON CONFLICT (owner_id, recipient_id, target_id) DO NOTHING`, (committed) => [
    sql`INSERT INTO grant_key_envelopes SELECT e.* FROM share_key_envelopes e
      JOIN encryption_devices d ON d.id = e.device_id
      WHERE e.relationship_id = ${shareId} AND d.account_id = ${auth.accountId} AND d.state = 'active' AND ${committed}`,
    sql`INSERT INTO grant_comment_key_envelopes SELECT e.* FROM share_comment_key_envelopes e
      JOIN shares s ON s.id = e.relationship_id JOIN encryption_devices d ON d.id = e.device_id
      JOIN sharing_comment_capabilities c ON c.object_id = e.object_id
      WHERE s.id = ${shareId} AND d.account_id = s.recipient_id AND d.state = 'active'
        AND e.capability_id = c.capability_id AND e.capability_epoch = c.capability_epoch
        AND e.object_id IN (SELECT object_id FROM (${requiredGrantComments()})) AND ${committed}`,
    sql`DELETE FROM share_comment_key_envelopes WHERE relationship_id = ${shareId} AND ${committed}`,
    sql`DELETE FROM share_key_envelopes WHERE relationship_id = ${shareId} AND ${committed}`,
    sql`DELETE FROM shares WHERE id = ${shareId} AND recipient_id = ${auth.accountId} AND ${committed}`,
  ]);
  return committed ? Response.json({ grantId }, { status: 201, headers }) : conflict();
}

async function removeShare(env: Env, auth: AuthorizedDevice, shareId: string, role: "owner" | "recipient", value: unknown) {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const actor = role === "owner" ? sql`owner_id` : sql`recipient_id`;
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE shares SET created_at = created_at WHERE id = ${shareId} AND ${actor} = ${auth.accountId} AND ${guard}`,
    (marker) => [sql`DELETE FROM share_comment_key_envelopes WHERE relationship_id = ${shareId} AND ${marker}`,
      sql`DELETE FROM share_key_envelopes WHERE relationship_id = ${shareId} AND ${marker}`,
      sql`DELETE FROM shares WHERE id = ${shareId} AND ${marker}`]);
  return committed ? Response.json({ removed: true }, { headers }) : notFound();
}

async function removeGrant(env: Env, auth: AuthorizedDevice, grantId: string, role: "owner" | "recipient", value: unknown) {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision"]) || !Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 1) return invalid();
  const actor = role === "owner" ? sql`owner_id` : sql`recipient_id`;
  const target = await createDb(env.DB).get<{ target_id: string; owner_id: string; target_kind: string }>(sql`
    SELECT target_id, owner_id, target_kind FROM grants WHERE id = ${grantId}
      AND ${actor} = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!target) return notFound();
  const rotation = await planRotation(env, auth, target);
  if (!rotation) return conflict();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE grants SET updated_at = updated_at WHERE id = ${grantId} AND ${actor} = ${auth.accountId}
      AND revision = ${input.expectedRevision} AND ${rotationSnapshot(target, rotation)} AND ${guard}`, (committed) => [
    sql`DELETE FROM grant_comment_key_envelopes WHERE relationship_id = ${grantId} AND ${committed}`,
    sql`DELETE FROM grant_key_envelopes WHERE relationship_id = ${grantId} AND ${committed}`,
    sql`DELETE FROM provisioning_needs WHERE grant_id = ${grantId} AND ${committed}`,
    sql`DELETE FROM grants WHERE id = ${grantId} AND ${committed}`,
    ...startRotation(auth, target, rotation, committed),
  ]);
  return committed ? Response.json({ removed: true, rotation: rotationIdentity(rotation) }, { headers }) : conflict();
}

async function changeGrant(env: Env, auth: AuthorizedDevice, grantId: string, value: unknown) {
  const input = record(value);
  if (!input || !Object.hasOwn(input, "expectedRevision") ||
      !Object.keys(input).every((key) => ["expectedRevision", "permission", "expiresAt"].includes(key)) ||
      !(Object.hasOwn(input, "permission") || Object.hasOwn(input, "expiresAt")) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
      !Number.isSafeInteger((input.expectedRevision as number) + 1) ||
      Object.hasOwn(input, "permission") && input.permission !== "read_only" && input.permission !== "read_write" ||
      Object.hasOwn(input, "expiresAt") && input.expiresAt !== null &&
        (!Number.isSafeInteger(input.expiresAt) || (input.expiresAt as number) <= Date.now())) return invalid();
  const deadline = Object.hasOwn(input, "expiresAt") ? sql`${input.expiresAt}` : sql`expires_at`;
  const target = await createDb(env.DB).get<{ target_id: string; owner_id: string; target_kind: string }>(sql`
    SELECT target_id, owner_id, target_kind FROM grants WHERE id = ${grantId}
      AND owner_id = ${auth.accountId} AND ${liveGrant(sql`expires_at`)} AND ${privateReadGuard(auth)}`);
  if (!target) return notFound();
  if (!Object.hasOwn(input, "permission")) {
    const committed = await commitPrivateBatch(env, auth, (guard) => sql`UPDATE grants
      SET expires_at = ${deadline}, revision = revision + 1, updated_at = ${Date.now()}
      WHERE id = ${grantId} AND owner_id = ${auth.accountId} AND revision = ${input.expectedRevision}
        AND ${liveGrant(sql`expires_at`)} AND ${liveGrant(deadline)} AND ${guard}`, () => []);
    return committed ? Response.json({ revision: (input.expectedRevision as number) + 1 }, { headers }) : conflict();
  }
  const rotation = await planRotation(env, auth, target);
  if (!rotation) return conflict();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE grants SET permission = ${input.permission}, expires_at = ${deadline}, revision = revision + 1, key_epoch = key_epoch + 1, updated_at = ${Date.now()}
    WHERE id = ${grantId} AND owner_id = ${auth.accountId} AND revision = ${input.expectedRevision}
      AND ${liveGrant(sql`expires_at`)} AND ${liveGrant(deadline)} AND ${rotationSnapshot(target, rotation)} AND ${guard}`,
    (committed) => [sql`DELETE FROM grant_comment_key_envelopes WHERE relationship_id = ${grantId} AND ${committed}`,
      sql`DELETE FROM grant_key_envelopes WHERE relationship_id = ${grantId} AND ${committed}`,
      ...startRotation(auth, target, rotation, committed), ...reconcileGrantNeeds(grantId, committed)]);
  return committed ? Response.json({ revision: (input.expectedRevision as number) + 1,
    rotation: rotationIdentity(rotation) }, { headers }) : conflict();
}

/** Device-proof-bound, exact-address invitations; no Account discovery endpoint. */
export async function sharingAction(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const shares = path === "/api/private/shares", grants = path === "/api/private/grants";
  const address = path === "/api/private/shares/address";
  const needs = /^\/api\/private\/grants\/([0-9a-f-]+)\/needs$/.exec(path);
  const commentKey = /^\/api\/private\/(shares|grants)\/([0-9a-f-]+)\/comment-keys\/([0-9a-f-]+)$/.exec(path);
  const commentKeys = /^\/api\/private\/(shares|grants)\/([0-9a-f-]+)\/comment-keys$/.exec(path);
  const keys = /^\/api\/private\/(shares|grants)\/([0-9a-f-]+)\/keys$/.exec(path);
  const accept = /^\/api\/private\/shares\/([0-9a-f-]+)\/accept$/.exec(path);
  const decline = /^\/api\/private\/shares\/([0-9a-f-]+)\/decline$/.exec(path);
  const cancel = /^\/api\/private\/shares\/([0-9a-f-]+)$/.exec(path);
  const revoke = /^\/api\/private\/grants\/([0-9a-f-]+)$/.exec(path);
  const leave = /^\/api\/private\/grants\/([0-9a-f-]+)\/leave$/.exec(path);
  if (!(shares && (request.method === "POST" || request.method === "PUT") ||
        (grants || address) && request.method === "POST" || (accept || decline) && request.method === "POST" && isV7((accept || decline)![1]) ||
        cancel && request.method === "DELETE" && isV7(cancel[1]) ||
        revoke && (request.method === "DELETE" || request.method === "PATCH") && isV7(revoke[1]) ||
        leave && request.method === "POST" && isV7(leave[1]) ||
        keys && (request.method === "POST" || request.method === "PUT") && isV7(keys[2]) ||
        needs && (request.method === "POST" || request.method === "PUT") && isV7(needs[1]) ||
        commentKeys && request.method === "POST" && isV7(commentKeys[2]) ||
        commentKey && (request.method === "POST" || request.method === "PUT") && isV7(commentKey[2]) && isV7(commentKey[3]))) return notFound();
  const reading = (shares || grants || address || keys || commentKeys || commentKey || needs) && request.method === "POST";
  const cursor = url.searchParams.get("cursor");
  if (Array.from(url.searchParams.keys()).some((key) => !reading || address || key !== "cursor") ||
      url.searchParams.getAll("cursor").length > 1 || cursor !== null && !isV7(cursor)) return invalid();
  let raw = "", value: unknown;
  try {
    if (reading) { if (!await hasEmptyBody(request)) return denied(); }
    else { const parsed = await readAuthJsonText(request, keys || commentKey ? 524_288 : 4096); raw = parsed.raw; value = parsed.value; }
  } catch { return invalid(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
  if (needs) return reading ? readProvisioningNeeds(env, auth, needs[1]!, cursor) : reconcileProvisioningNeeds(env, auth, needs[1]!, value);
  if (commentKey) return reading ? readCommentKey(env, auth, commentKey[1] as "shares" | "grants", commentKey[2]!, commentKey[3]!, cursor)
    : uploadCommentKeys(env, auth, commentKey[1] as "shares" | "grants", commentKey[2]!, commentKey[3]!, value);
  if (commentKeys) return listCommentKeys(env, auth, commentKeys[1] as "shares" | "grants", commentKeys[2]!, cursor);
  if (keys) return reading ? readGrantKeys(env, auth, keys[1] as "shares" | "grants", keys[2]!, cursor)
    : uploadGrantKeys(env, auth, keys[1] as "shares" | "grants", keys[2]!, value);
  if (address) {
    const account = await createDb(env.DB).get<{ share_id: string }>(sql`SELECT share_id FROM accounts
      WHERE id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
    return account ? Response.json({ shareId: account.share_id }, { headers }) : denied();
  }
  if (reading) return listRelationships(env, auth, shares ? "shares" : "grants", cursor);
  if (shares) return createShare(env, auth, value);
  if (cancel || decline) return removeShare(env, auth, (cancel || decline)![1]!, cancel ? "owner" : "recipient", value);
  if (revoke && request.method === "PATCH") return changeGrant(env, auth, revoke[1]!, value);
  if (revoke || leave) return removeGrant(env, auth, (revoke || leave)![1]!, revoke ? "owner" : "recipient", value);
  return acceptShare(env, auth, accept![1]!, value);
}
