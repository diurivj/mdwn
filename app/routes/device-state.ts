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
  const registry = await createDb(env.DB).get<{ registry_epoch: number; active_device_id: string | null }>(sql`
    SELECT r.registry_epoch, d.id AS active_device_id
    FROM account_encryption_identities r
    LEFT JOIN encryption_devices d ON d.id = ${session.deviceId ?? null}
      AND d.account_id = r.account_id AND d.state = 'active'
    WHERE r.account_id = ${session.accountId}
  `);
  return Response.json({
    accountId: session.accountId,
    sessionBinding: await sessionBindingDigest(session.id),
    registryEpoch: registry?.registry_epoch ?? null,
    deviceId: registry?.active_device_id ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
