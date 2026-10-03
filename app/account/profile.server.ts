import { createDb, sql } from "~/db/client.server";
import { privateReadGuard, type AuthorizedDevice } from "~/device/proof.server";
import { encodeTreeBytes } from "~/tree/wire";

const headers = { "Cache-Control": "no-store" };

/** The current encrypted Account profile. Only the browser opens the pseudonym. */
export async function readEncryptedProfile(env: Env, auth: AuthorizedDevice): Promise<Response> {
  const row = await createDb(env.DB).get<{ ciphertext: ArrayBuffer; epoch: number; revision: number }>(sql`
    SELECT ciphertext, epoch, revision FROM account_profiles
    WHERE account_id = ${auth.accountId} AND ${privateReadGuard(auth)}`);
  if (!row) return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json({ ciphertext: encodeTreeBytes(new Uint8Array(row.ciphertext)),
    epoch: row.epoch, revision: row.revision }, { headers });
}
