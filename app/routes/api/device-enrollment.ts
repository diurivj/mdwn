import { readAuthJsonText, record, requireSameOrigin } from "~/auth/request.server";
import { getActiveSession } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { authorizeDeviceForSession } from "~/device/proof.server";
import {
  approveDeviceEnrollment,
  commitDeviceEnrollment,
  deviceEnrollmentStatus,
  pendingDeviceEnrollment,
  startDeviceEnrollment,
  type EnrollmentCommit,
} from "~/enrollment/enrollment.server";
import type { CandidateTranscript, EnrollmentApproval } from "~/enrollment/protocol";

import type { Route } from "./+types/device-enrollment";

const noStore = { "Cache-Control": "no-store" };
const failed = (status = 400) => Response.json({ error: "enrollment_failed" }, { status, headers: noStore });

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return failed(405);
  try {
    requireSameOrigin(request);
    const { raw, value } = await readAuthJsonText(request);
    const body = record(value);
    const env = getEnv(context);
    const session = await getActiveSession(request, env);
    if (!session || session.purpose !== "normal") return failed(401);
    const path = new URL(request.url).pathname;
    if (path === "/api/device-enrollment/start" && body) {
      return startDeviceEnrollment(
        env,
        session,
        body.transcript as CandidateTranscript,
        body.transcriptDigest as string,
      );
    }
    if (path === "/api/device-enrollment/status" && typeof body?.enrollmentId === "string") {
      return deviceEnrollmentStatus(env, session, body.enrollmentId);
    }
    if (path === "/api/device-enrollment/commit" && body) {
      return commitDeviceEnrollment(env, session, body as EnrollmentCommit);
    }
    if (
      (path === "/api/device-enrollment/pending" || path === "/api/device-enrollment/approve") &&
      body &&
      typeof body.enrollmentId === "string"
    ) {
      const proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null") as unknown;
      const authorized = await authorizeDeviceForSession(env, session, request, proof, raw);
      if (!authorized) return failed(403);
      if (path === "/api/device-enrollment/pending") {
        return pendingDeviceEnrollment(env, authorized, body.enrollmentId);
      }
      return approveDeviceEnrollment(
        env,
        session,
        authorized,
        body.enrollmentId,
        body.approval as EnrollmentApproval,
        body.approvalSignature as string,
        body.enrollmentEnvelope as string,
      );
    }
    return failed(404);
  } catch {
    return failed();
  }
}
