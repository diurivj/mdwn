import { getActiveSession } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { createDb, sql } from "~/db/client.server";
import { sessionBindingDigest } from "~/device/proof";

import type { Route } from "./+types/device-state";

/** Public-in-the-Account state: never returns private envelopes or Account profile. */
export async function loader({ request, context }: Route.LoaderArgs): Promise<Response> {
  const env = getEnv(context);
  const session = await getActiveSession(request, env);
  if (!session || session.purpose !== "normal") {
    return Response.json({ error: "authentication_failed" }, { status: 401 });
  }
  const registry = await createDb(env.DB).get<{ registry_epoch: number }>(sql`
    SELECT registry_epoch FROM account_encryption_identities WHERE account_id = ${session.accountId}
  `);
  return Response.json({
    sessionBinding: await sessionBindingDigest(session.id),
    registryEpoch: registry?.registry_epoch ?? null,
    deviceId: session.deviceId ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
