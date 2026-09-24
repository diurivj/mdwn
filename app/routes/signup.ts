import { AuthRequestError, readAuthJson, record, requireSameOrigin, string } from "~/auth/request.server";
import { SessionConfigurationError } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { AbuseControlUnavailableError, abuseControlUnavailableResponse } from "~/security/abuse-control.server";
import { beginSignupChallenge, beginSignupRegistration, completeSignup } from "~/signup/signup.server";

import type { Route } from "./+types/signup";

function failed(status = 400): Response {
  return Response.json({ error: "request_failed" }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return failed(405);
  try {
    requireSameOrigin(request);
    const env = getEnv(context);
    const path = new URL(request.url).pathname;
    if (path === "/api/signup/challenge") {
      await readAuthJson(request);
      return beginSignupChallenge(request, env);
    }
    const body = await readAuthJson(request);
    const payload = record(body);
    if (path === "/api/signup/options") {
      const challengeId = payload ? string(payload.challengeId) : null;
      const nonce = payload ? string(payload.nonce) : null;
      return challengeId && nonce
        ? beginSignupRegistration(request, env, challengeId, nonce, payload?.transcript)
        : failed();
    }
    if (path === "/api/signup/verify") return completeSignup(request, env, body);
    return failed(404);
  } catch (error) {
    if (error instanceof SessionConfigurationError || error instanceof AbuseControlUnavailableError) {
      return abuseControlUnavailableResponse();
    }
    if (error instanceof AuthRequestError) return failed(error.status);
    return failed();
  }
}
