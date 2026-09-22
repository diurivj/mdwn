import {
  beginFreshAssertion,
  beginPasskeyRegistration,
  beginSignIn,
  completeFreshAssertion,
  completePasskeyRegistration,
  completeSignIn,
  listPasskeys,
  removePasskey,
} from "~/auth/webauthn.server";
import { AuthRequestError, readAuthJson, record, requireSameOrigin, string } from "~/auth/request.server";
import {
  clearSessionCookie,
  getActiveSession,
  hasFreshAssertion,
  listActiveSessions,
  refreshNormalSession,
  revokeSession,
  revokeAllSessionsForActor,
  revokeSessionForActor,
  SessionConfigurationError,
  type ActiveSession,
} from "~/auth/session.server";
import type { RevocationResult } from "~/auth/contracts";
import { getEnv } from "~/context/env";

import type { Route } from "./+types/auth";

type NormalSession = ActiveSession & {
  purpose: "normal";
  authenticatedPasskeyId: string;
};

type NormalSessionResult =
  | { session: NormalSession }
  | { failure: Response };

function failure(status: number, headers?: HeadersInit): Response {
  return Response.json({ error: "authentication_failed" }, { status, headers });
}

function restrictedSession(): Response {
  return Response.json({ error: "session_restricted" }, { status: 403 });
}

async function requireNormalSession(
  request: Request,
  env: Env,
): Promise<NormalSessionResult> {
  const session = await getActiveSession(request, env);
  if (!session) return { failure: failure(401) };
  if (session.purpose !== "normal") return { failure: restrictedSession() };
  if (typeof session.authenticatedPasskeyId !== "string") return { failure: failure(401) };
  return { session: session as NormalSession };
}

async function requireFreshNormalSession(
  request: Request,
  env: Env,
): Promise<NormalSessionResult> {
  const result = await requireNormalSession(request, env);
  if ("failure" in result || !hasFreshAssertion(result.session)) {
    return "failure" in result ? result : { failure: failure(401) };
  }
  return result;
}

/** Reads the signed opaque cookie through D1 without extending its lifetime. */
export async function loader({ request, context }: Route.LoaderArgs): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  try {
    const env = getEnv(context);
    if (pathname === "/api/auth/session") {
      const session = await getActiveSession(request, env);
      return Response.json({ authenticated: session !== null });
    }
    if (pathname === "/api/auth/sessions") {
      const result = await requireNormalSession(request, env);
      if ("failure" in result) return result.failure;
      return Response.json({
        sessions: await listActiveSessions(env, result.session.accountId, result.session.id),
      });
    }
    if (pathname === "/api/auth/passkeys") {
      const result = await requireNormalSession(request, env);
      if ("failure" in result) return result.failure;
      return Response.json({
        passkeys: await listPasskeys(
          env,
          result.session.accountId,
          result.session.authenticatedPasskeyId,
        ),
      });
    }
    return failure(404);
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      return Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    return failure(400);
  }
}

/** Resource route for the deliberately small ticket-06 sign-in ceremony. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return failure(405);

  try {
    requireSameOrigin(request);
    const body = await readAuthJson(request);
    const pathname = new URL(request.url).pathname;
    const env = getEnv(context);

    if (pathname === "/api/auth/sign-in/options") {
      return Response.json(await beginSignIn(request, env));
    }

    if (pathname === "/api/auth/sign-in/verify") {
      const parsed = record(body);
      const challengeId = parsed ? string(parsed.challengeId) : null;
      const result = challengeId
        ? await completeSignIn(request, env, challengeId, parsed?.response)
        : null;
      return result
        ? Response.json({ ok: true }, { headers: { "Set-Cookie": result.setCookie } })
        : failure(401);
    }

    if (pathname === "/api/auth/sign-out") {
      const session = await getActiveSession(request, env);
      if (session) await revokeSession(env, session.accountId, session.id);
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": await clearSessionCookie(env) } },
      );
    }

    const normal = await requireNormalSession(request, env);
    if ("failure" in normal) return normal.failure;

    if (pathname === "/api/auth/passkeys/fresh/options") {
      return Response.json(await beginFreshAssertion(request, env, normal.session));
    }

    if (pathname === "/api/auth/passkeys/fresh/verify") {
      const parsed = record(body);
      const challengeId = parsed ? string(parsed.challengeId) : null;
      const completed = challengeId
        ? await completeFreshAssertion(
          request,
          env,
          normal.session,
          challengeId,
          parsed?.response,
        )
        : false;
      return completed ? Response.json({ ok: true }) : failure(401);
    }

    if (pathname === "/api/auth/passkeys/registration/options") {
      const start = await beginPasskeyRegistration(request, env, normal.session);
      return start ? Response.json(start) : failure(401);
    }

    if (pathname === "/api/auth/passkeys/registration/verify") {
      const parsed = record(body);
      const challengeId = parsed ? string(parsed.challengeId) : null;
      const completed = challengeId
        ? await completePasskeyRegistration(
          request,
          env,
          normal.session,
          challengeId,
          parsed?.response,
        )
        : false;
      return completed ? Response.json({ ok: true }) : failure(401);
    }

    if (pathname === "/api/auth/passkeys/remove") {
      const fresh = await requireFreshNormalSession(request, env);
      if ("failure" in fresh) return fresh.failure;
      const parsed = record(body);
      const credentialId = parsed ? string(parsed.credentialId) : null;
      const removed = credentialId
        ? await removePasskey(env, fresh.session, credentialId)
        : false;
      if (!removed) return failure(401);
      const signedOut = credentialId === fresh.session.authenticatedPasskeyId;
      const headers = signedOut ? { "Set-Cookie": await clearSessionCookie(env) } : undefined;
      return Response.json({ ok: true, signedOut } satisfies RevocationResult, { headers });
    }

    if (pathname === "/api/auth/session/refresh") {
      if (await refreshNormalSession(env, normal.session)) {
        return Response.json({ ok: true });
      }
      return failure(401, { "Set-Cookie": await clearSessionCookie(env) });
    }

    if (pathname === "/api/auth/sessions/revoke") {
      const parsed = record(body);
      const sessionId = parsed ? string(parsed.sessionId) : null;
      if (!sessionId) return failure(400);
      const outcome = await revokeSessionForActor(env, normal.session, sessionId);
      if (outcome === "actor_inactive") {
        return failure(401, { "Set-Cookie": await clearSessionCookie(env) });
      }
      if (outcome === "target_not_found") return failure(404);
      const signedOut = sessionId === normal.session.id;
      const headers = signedOut ? { "Set-Cookie": await clearSessionCookie(env) } : undefined;
      return Response.json({ ok: true, signedOut } satisfies RevocationResult, { headers });
    }

    if (pathname === "/api/auth/sessions/revoke-all") {
      if (!(await revokeAllSessionsForActor(env, normal.session))) {
        return failure(401, { "Set-Cookie": await clearSessionCookie(env) });
      }
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": await clearSessionCookie(env) } },
      );
    }

    return failure(404);
  } catch (error) {
    if (error instanceof SessionConfigurationError) {
      return Response.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    if (error instanceof AuthRequestError) return failure(error.status);
    return failure(400);
  }
}
