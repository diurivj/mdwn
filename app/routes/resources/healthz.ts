import { getEnv } from "~/context/env";
import { ping } from "~/shared/db/client.server";
import { DYNAMIC_CACHE_CONTROL } from "~/shared/security/headers";

import type { Route } from "./+types/healthz";

/**
 * Liveness/probe endpoint used by CI and ops. Gated by the HEALTHZ_TOKEN
 * secret (Bearer token) so it reveals environment and deployed Worker version
 * only to the owner. Returns plain JSON, never shell HTML or a secret value.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const env = getEnv(context);
  const secret = env.HEALTHZ_TOKEN;

  const auth = request.headers.get("authorization") ?? "";
  const expected = secret && secret.length > 0 ? `Bearer ${secret}` : null;
  if (expected && auth !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": DYNAMIC_CACHE_CONTROL,
  };
  const dbConnected = await ping(env.DB);
  if (!dbConnected) {
    return new Response(JSON.stringify({ ok: false, error: "d1-unreachable" }), {
      status: 503,
      headers,
    });
  }
  return new Response(
    JSON.stringify({
      ok: true,
      appEnv: env.APP_ENV,
      db: "connected",
      versionId: env.CF_VERSION_METADATA.id,
    }),
    { status: 200, headers },
  );
}
