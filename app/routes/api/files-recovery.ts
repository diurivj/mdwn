import { getActiveSession, SessionConfigurationError } from "~/auth/session.server";
import { AuthRequestError, readAuthJson, record, requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import {
  challengeRecoveryEnrollment, commitRecoveryEnrollment, startRecoveryEnrollment,
  type RecoveryCommit,
} from "~/recovery/enrollment.server";
import type { RecoveryIntent } from "~/recovery/protocol";
import { AbuseControlUnavailableError, abuseControlUnavailableResponse } from "~/security/abuse-control.server";

import type { Route } from "./+types/files-recovery";

const noStore = { "Cache-Control": "no-store" };
const failed = (status = 400) => Response.json({ error: "recovery_failed" }, { status, headers: noStore });

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return failed(405);
  try {
    requireSameOrigin(request);
    const body = record(await readAuthJson(request));
    const env = getEnv(context);
    const session = await getActiveSession(request, env);
    if (!session || session.purpose !== "normal") return failed(401);
    const path = new URL(request.url).pathname;
    if (path === "/api/files-recovery/start") return startRecoveryEnrollment(request, env, session);
    if (!body || typeof body.enrollmentId !== "string" || !body.enrollmentId ||
        typeof body.intent !== "object" || body.intent === null || Array.isArray(body.intent) ||
        typeof body.intentSignature !== "string") return failed();
    if (path === "/api/files-recovery/challenge") {
      return challengeRecoveryEnrollment(env, session, body.enrollmentId,
        body.intent as RecoveryIntent, body.intentSignature);
    }
    if (path === "/api/files-recovery/commit") return commitRecoveryEnrollment(env, session, body as RecoveryCommit);
    return failed(404);
  } catch (error) {
    if (error instanceof AbuseControlUnavailableError) return abuseControlUnavailableResponse();
    if (error instanceof SessionConfigurationError) return failed(503);
    if (error instanceof AuthRequestError) return failed(error.status);
    return failed();
  }
}
