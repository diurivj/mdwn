import { hasEmptyBody, readAuthJsonText, record } from "~/auth/request.server";
import { createDb, sql } from "~/db/client.server";
import { authorizePrivateRequest, commitPrivateBatch, commitPrivateMutation, privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { newOpaqueId } from "~/opaque-id";
import { isV7 } from "~/tree/wire";
import { shareHandleLookupToken } from "./address";

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
    target_id: string; target_kind: string; permission: string; revision?: number; key_epoch?: number }>(sql`
    SELECT * FROM ${table} WHERE (owner_id = ${auth.accountId} OR recipient_id = ${auth.accountId})
      AND id > ${cursor ?? ""} AND ${privateReadGuard(auth)} ORDER BY id LIMIT 101`);
  const relationships = rows.slice(0, 100).map((row) => ({
    ...(kind === "shares" ? { shareId: row.id } : { grantId: row.id, revision: row.revision, keyEpoch: row.key_epoch }),
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
  const target = await db.get<{ kind: string }>(sql`SELECT kind FROM vault_nodes
    WHERE id = ${input.targetId} AND owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!target) return notFound();
  const account = await db.get<{ id: string }>(sql`SELECT id FROM accounts
    WHERE ${address} AND id != ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!account) return notFound();
  const shareId = newOpaqueId();
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    INSERT INTO shares (id, owner_id, recipient_id, target_id, target_kind, permission, created_at)
    SELECT ${shareId}, ${auth.accountId}, ${account.id}, n.id, n.kind, ${input.permission}, ${Date.now()}
    FROM vault_nodes n WHERE n.id = ${input.targetId} AND n.owner_id = ${auth.accountId}
      AND NOT EXISTS (SELECT 1 FROM grants WHERE owner_id = ${auth.accountId}
        AND recipient_id = ${account.id} AND target_id = n.id) AND ${guard}
    ON CONFLICT (owner_id, recipient_id, target_id) DO NOTHING`);
  return committed ? Response.json({ shareId }, { status: 201, headers }) : conflict();
}

async function acceptShare(env: Env, auth: AuthorizedDevice, shareId: string, value: unknown) {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const pending = await createDb(env.DB).get(sql`SELECT 1 FROM shares
    WHERE id = ${shareId} AND recipient_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!pending) return notFound();
  const grantId = newOpaqueId(), now = Date.now();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    INSERT INTO grants (id, owner_id, recipient_id, target_id, target_kind, permission, revision, key_epoch, created_at, updated_at)
    SELECT ${grantId}, owner_id, recipient_id, target_id, target_kind, permission, 1, 1, ${now}, ${now}
    FROM shares WHERE id = ${shareId} AND recipient_id = ${auth.accountId} AND ${guard}
    ON CONFLICT (owner_id, recipient_id, target_id) DO NOTHING`, (committed) => [
    sql`DELETE FROM shares WHERE id = ${shareId} AND recipient_id = ${auth.accountId} AND ${committed}`,
  ]);
  return committed ? Response.json({ grantId }, { status: 201, headers }) : conflict();
}

async function removeShare(env: Env, auth: AuthorizedDevice, shareId: string, role: "owner" | "recipient", value: unknown) {
  const input = record(value);
  if (!input || !exact(input, [])) return invalid();
  const actor = role === "owner" ? sql`owner_id` : sql`recipient_id`;
  const committed = await commitPrivateMutation(env, auth, (guard) => sql`
    DELETE FROM shares WHERE id = ${shareId} AND ${actor} = ${auth.accountId} AND ${guard}`);
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
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    DELETE FROM grants WHERE id = ${grantId} AND ${actor} = ${auth.accountId}
      AND revision = ${input.expectedRevision} AND ${guard}`, (committed) => [
    sql`INSERT INTO sharing_write_blocks (target_id, owner_id, target_kind, created_at)
      SELECT ${target.target_id}, ${target.owner_id}, ${target.target_kind}, ${Date.now()} WHERE ${committed}
      ON CONFLICT (target_id) DO NOTHING`,
  ]);
  return committed ? Response.json({ removed: true }, { headers }) : conflict();
}

async function changeGrant(env: Env, auth: AuthorizedDevice, grantId: string, value: unknown) {
  const input = record(value);
  if (!input || !exact(input, ["expectedRevision", "permission"]) ||
      !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1 ||
      !Number.isSafeInteger((input.expectedRevision as number) + 1) ||
      (input.permission !== "read_only" && input.permission !== "read_write")) return invalid();
  if (!await createDb(env.DB).get(sql`SELECT 1 FROM grants WHERE id = ${grantId}
    AND owner_id = ${auth.accountId} AND ${privateReadGuard(auth)}`)) return notFound();
  const committed = await commitPrivateBatch(env, auth, (guard) => sql`
    UPDATE grants SET permission = ${input.permission}, revision = revision + 1, key_epoch = key_epoch + 1, updated_at = ${Date.now()}
    WHERE id = ${grantId} AND owner_id = ${auth.accountId} AND revision = ${input.expectedRevision} AND ${guard}`,
    (committed) => [sql`INSERT INTO sharing_write_blocks (target_id, owner_id, target_kind, created_at)
      SELECT target_id, owner_id, target_kind, ${Date.now()} FROM grants WHERE id = ${grantId} AND ${committed}
      ON CONFLICT (target_id) DO NOTHING`]);
  return committed ? Response.json({ revision: (input.expectedRevision as number) + 1 }, { headers }) : conflict();
}

/** Device-proof-bound, exact-address invitations; no Account discovery endpoint. */
export async function sharingAction(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  const shares = path === "/api/private/shares", grants = path === "/api/private/grants";
  const address = path === "/api/private/shares/address";
  const accept = /^\/api\/private\/shares\/([0-9a-f-]+)\/accept$/.exec(path);
  const decline = /^\/api\/private\/shares\/([0-9a-f-]+)\/decline$/.exec(path);
  const cancel = /^\/api\/private\/shares\/([0-9a-f-]+)$/.exec(path);
  const revoke = /^\/api\/private\/grants\/([0-9a-f-]+)$/.exec(path);
  const leave = /^\/api\/private\/grants\/([0-9a-f-]+)\/leave$/.exec(path);
  if (!(shares && (request.method === "POST" || request.method === "PUT") ||
        (grants || address) && request.method === "POST" || (accept || decline) && request.method === "POST" && isV7((accept || decline)![1]) ||
        cancel && request.method === "DELETE" && isV7(cancel[1]) ||
        revoke && (request.method === "DELETE" || request.method === "PATCH") && isV7(revoke[1]) ||
        leave && request.method === "POST" && isV7(leave[1]))) return notFound();
  const reading = (shares || grants || address) && request.method === "POST";
  const cursor = url.searchParams.get("cursor");
  if (Array.from(url.searchParams.keys()).some((key) => !reading || address || key !== "cursor") ||
      url.searchParams.getAll("cursor").length > 1 || cursor !== null && !isV7(cursor)) return invalid();
  let raw = "", value: unknown;
  try {
    if (reading) { if (!await hasEmptyBody(request)) return denied(); }
    else { const parsed = await readAuthJsonText(request, 4096); raw = parsed.raw; value = parsed.value; }
  } catch { return invalid(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const auth = await authorizePrivateRequest(request, env, proof, raw);
  if (!auth) return denied();
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
