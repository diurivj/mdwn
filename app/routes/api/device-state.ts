import { getActiveSession } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { createDb, sql } from "~/shared/db/client.server";
import { sessionBindingDigest } from "~/shared/device/proof";

import type { Route } from "./+types/device-state";

/** Public-in-the-Account state: never returns private envelopes or Account profile. */
export async function loader({ request, context }: Route.LoaderArgs): Promise<Response> {
  const env = getEnv(context);
  const session = await getActiveSession(request, env);
  if (!session || session.purpose !== "normal") {
    return Response.json({ error: "authentication_failed" }, { status: 401 });
  }
  const requestedCandidate = new URL(request.url).searchParams.get("candidateDeviceId");
  const candidateId = requestedCandidate && /^[0-9a-f-]{36}$/.test(requestedCandidate)
    ? requestedCandidate : null;
  const registry = await createDb(env.DB).get<{
    registry_epoch: number; active_device_id: string | null; candidate_device_id: string | null;
  }>(sql`
    SELECT r.registry_epoch, d.id AS active_device_id, c.id AS candidate_device_id
    FROM account_encryption_identities r
    LEFT JOIN encryption_devices d ON d.id = ${session.deviceId ?? null}
      AND d.account_id = r.account_id AND d.state = 'active'
    LEFT JOIN encryption_devices c ON c.id = ${candidateId}
      AND c.account_id = r.account_id AND c.state = 'active'
    WHERE r.account_id = ${session.accountId}
  `);
  return Response.json({
    accountId: session.accountId,
    sessionBinding: await sessionBindingDigest(session.id),
    registryEpoch: registry?.registry_epoch ?? null,
    deviceId: registry?.active_device_id ?? null,
    candidateActive: candidateId !== null && registry?.candidate_device_id === candidateId,
  }, { headers: { "Cache-Control": "no-store" } });
}
