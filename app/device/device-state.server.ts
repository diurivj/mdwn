import { getActiveSession, sessionCookieId } from "~/auth/session.server";
import { createDb, sql } from "~/shared/db/client.server";
import { encodeDeviceState } from "~/shared/device/device-state";
import { sessionBindingDigest } from "~/shared/device/proof";

type Registry = {
  registry_epoch: number;
  active_device_id: string | null;
  candidate_device_id: string | null;
};

/** The `/api/device/state` answer for a live normal Session. */
export type DeviceStateAnswer = {
  accountId: string;
  sessionBinding: string;
  registryEpoch: number | null;
  deviceId: string | null;
  candidateActive: boolean;
};

/**
 * Public-in-the-Account state: never private envelopes or Account profile.
 * The registry row is read beside the Session, keyed by the same signed
 * identifier, and used only for a live normal Session; anything else is null.
 */
export async function readDeviceState(
  request: Request,
  env: Env,
  candidateId: string | null = null,
): Promise<DeviceStateAnswer | null> {
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
  if (!session || session.purpose !== "normal") return null;
  return {
    accountId: session.accountId,
    sessionBinding: await sessionBindingDigest(session.id),
    registryEpoch: registry?.registry_epoch ?? null,
    deviceId: registry?.active_device_id ?? null,
    candidateActive: candidateId !== null && registry?.candidate_device_id === candidateId,
  };
}

/**
 * Start the device-state read for a request that carries a Device proof, to
 * run beside its handler (ticket 57). It resolves to the compact
 * `X-Mdwn-Device-State` value, or null for a request without a proof, without
 * a normal Session with a registry, or when the read fails: the header is an
 * optimization and never fails the response. The Worker still verifies every
 * proof, so a header the browser adopts too late still fails closed.
 */
export function startDeviceStateHeader(request: Request, env: Env): Promise<string | null> | null {
  if (!request.headers.has("X-Mdwn-Device-Proof")) return null;
  return readDeviceState(request, env).then(
    (state) =>
      state && state.registryEpoch !== null
        ? encodeDeviceState({ ...state, registryEpoch: state.registryEpoch })
        : null,
    () => null,
  );
}
