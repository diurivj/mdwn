import { getActiveSession, sessionCookieId } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { createDb, sql } from "~/shared/db/client.server";
import { sessionBindingDigest } from "~/shared/device/proof";

import type { Route } from "./+types/device-state";

type Registry = {
  registry_epoch: number;
  active_device_id: string | null;
  candidate_device_id: string | null;
};

/**
 * Public-in-the-Account state: never returns private envelopes or Account profile.
 * Every private request starts with this read, so its registry row is read beside
 * the Session, keyed by the same signed identifier, and used only for a live one.
 */
export async function loader({ request, context }: Route.LoaderArgs): Promise<Response> {
  const env = getEnv(context);
  const requestedCandidate = new URL(request.url).searchParams.get("candidateDeviceId");
  const candidateId = requestedCandidate && /^[0-9a-f-]{36}$/.test(requestedCandidate) ? requestedCandidate : null;
  const sessionId = await sessionCookieId(request, env);
  const [session, registry] = await Promise.all([
    getActiveSession(request, env),
    sessionId
      ? createDb(env.DB).get<Registry>(sql`
          SELECT r.registry_epoch, d.id AS active_device_id, c.id AS candidate_device_id
          FROM sessions s
          JOIN account_encryption_identities r ON r.account_id = s.account_id
          LEFT JOIN encryption_devices d ON d.id = s.device_id
            AND d.account_id = r.account_id AND d.state = 'active'
          LEFT JOIN encryption_devices c ON c.id = ${candidateId}
            AND c.account_id = r.account_id AND c.state = 'active'
          WHERE s.id = ${sessionId}
        `)
      : null,
  ]);
  if (!session || session.purpose !== "normal") {
    return Response.json({ error: "authentication_failed" }, { status: 401 });
  }
  return Response.json(
    {
      accountId: session.accountId,
      sessionBinding: await sessionBindingDigest(session.id),
      registryEpoch: registry?.registry_epoch ?? null,
      deviceId: registry?.active_device_id ?? null,
      candidateActive: candidateId !== null && registry?.candidate_device_id === candidateId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
