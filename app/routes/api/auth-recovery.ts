import { AuthRequestError, readAuthJson, record, requireSameOrigin } from "~/auth/request.server";
import {
  beginAuthenticationRecovery, beginRecoveryRegistration,
  completeRecoveryRegistration, replaceAuthenticationRecoveryCodes,
} from "~/auth/recovery.server";
import {
  clearSessionCookie, getActiveSession, SessionConfigurationError,
} from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { AbuseControlUnavailableError, abuseControlUnavailableResponse } from "~/security/abuse-control.server";

import type { Route } from "./+types/auth-recovery";

const noStore = { "Cache-Control": "no-store" };
function failed(status = 401): Response {
  return Response.json({ error: "recovery_failed" }, { status, headers: noStore });
}

export async function loader({ request, context }: Route.LoaderArgs): Promise<Response> {
  try {
    const env = getEnv(context);
    const pathname = new URL(request.url).pathname;
    const session = await getActiveSession(request, env);
    if (pathname === "/api/auth/recovery/status") {
      return Response.json({ restricted: session?.purpose === "recovery" }, { headers: noStore });
    }
    if (pathname === "/api/auth/recovery/identifier") {
      if (!session || session.purpose !== "normal") return failed();
      return Response.json({ identifier: session.accountId }, { headers: noStore });
    }
    return failed(404);
  } catch { return failed(503); }
}

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return failed(405);
  try {
    requireSameOrigin(request);
    const body = record(await readAuthJson(request));
    const env = getEnv(context);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth/recovery/start") {
      return beginAuthenticationRecovery(request, env, body?.identifier, body?.code);
    }
    const session = await getActiveSession(request, env);
    if (pathname === "/api/auth/recovery/rotate") {
      if (!session || session.purpose !== "normal") return failed(403);
      return (await replaceAuthenticationRecoveryCodes(env, session, body?.hashes))
        ? Response.json({ ok: true }, { headers: noStore }) : failed();
    }
    if (!session || session.purpose !== "recovery") return failed(403);
    if (pathname === "/api/auth/recovery/options") {
      const start = await beginRecoveryRegistration(request, env, session);
      return start ? Response.json(start, { headers: noStore }) : failed();
    }
    if (pathname === "/api/auth/recovery/verify") {
      if (typeof body?.challengeId !== "string") return failed();
      const completed = await completeRecoveryRegistration(
        request, env, session, body.challengeId, body.response,
      );
      return completed
        ? Response.json({ ok: true }, {
          headers: { ...noStore, "Set-Cookie": await clearSessionCookie(env) },
        })
        : failed();
    }
    return failed(404);
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) return abuseControlUnavailableResponse();
    if (error instanceof SessionConfigurationError) return failed(503);
    if (error instanceof AuthRequestError) return failed(error.status);
    return failed(400);
  }
}
