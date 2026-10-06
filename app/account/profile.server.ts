import { createDb, sql } from "~/shared/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/shared/tree/wire";
import { nextPseudonymChangeAt } from "./pseudonym-guard.server";

const headers = { "Cache-Control": "no-store" };

/** The current encrypted Account profile. Only the browser opens the pseudonym.
 * `pseudonymChangedAt`/`nextChangeAt` are the server-enforced change cooldown. */
export async function readEncryptedProfile(env: Env, auth: AuthorizedDevice): Promise<Response> {
  const row = await createDb(env.DB).get<{ ciphertext: ArrayBuffer; epoch: number; revision: number;
    pseudonym_changed_at: number | null }>(sql`
    SELECT ciphertext, epoch, revision, pseudonym_changed_at FROM account_profiles
    WHERE account_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!row) return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json({ ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)),
    epoch: row.epoch, revision: row.revision, pseudonymChangedAt: row.pseudonym_changed_at,
    nextChangeAt: nextPseudonymChangeAt(row.pseudonym_changed_at) }, { headers });
}
