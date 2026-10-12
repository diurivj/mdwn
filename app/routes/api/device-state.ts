import { getEnv } from "~/context/env";
import { readDeviceState } from "~/device/device-state.server";

import type { Route } from "./+types/device-state";

/**
 * Public-in-the-Account state: never returns private envelopes or Account profile.
 * A private request that cannot reuse recent state starts with this read; every
 * proof-guarded response also carries its fields in `X-Mdwn-Device-State`.
 */
export async function loader({ request, context }: Route.LoaderArgs): Promise<Response> {
  const requestedCandidate = new URL(request.url).searchParams.get("candidateDeviceId");
  const candidateId = requestedCandidate && /^[0-9a-f-]{36}$/.test(requestedCandidate) ? requestedCandidate : null;
  const state = await readDeviceState(request, getEnv(context), candidateId);
  if (!state) return Response.json({ error: "authentication_failed" }, { status: 401 });
  return Response.json(state, { headers: { "Cache-Control": "no-store" } });
}
