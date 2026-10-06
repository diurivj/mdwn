import { hasEmptyBody, readAuthJsonText, record, requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { authorizePrivateRequest } from "~/device/proof.server";
import { finishOwnedProvisioning, nextOwnedEnvelope, stepOwnedProvisioning } from "~/recovery/provision.server";

import type { Route } from "./+types/recovery-provision";

const denied = () =>
  Response.json(
    { error: "device_proof_required" },
    {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    },
  );

/** Only recovered, currently bound devices may progress their own non-authorizing job. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST" && request.method !== "PATCH") return denied();
  try {
    requireSameOrigin(request);
  } catch {
    return denied();
  }
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/api/private/recovery-provision/next") {
    if (!(await hasEmptyBody(request))) return denied();
    let proof: unknown;
    try {
      proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null");
    } catch {
      return denied();
    }
    const env = getEnv(context);
    const authorized = await authorizePrivateRequest(request, env, proof);
    return authorized ? nextOwnedEnvelope(env, authorized) : denied();
  }
  if (request.method !== "PATCH" || path !== "/api/private/recovery-provision/step") return denied();
  try {
    const { raw, value } = await readAuthJsonText(request);
    const body = record(value);
    if (!body) return denied();
    const proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null") as unknown;
    const env = getEnv(context);
    const authorized = await authorizePrivateRequest(request, env, proof, raw);
    if (!authorized) return denied();
    return body.operation === "finish"
      ? finishOwnedProvisioning(env, authorized)
      : body.operation === "step"
        ? stepOwnedProvisioning(env, authorized, body)
        : denied();
  } catch {
    return denied();
  }
}
