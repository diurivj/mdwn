import { requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { provisioningAction } from "~/sharing/provisioning.server";
import type { Route } from "./+types/grant-provisioning";

export function action({ request, context }: Route.ActionArgs) {
  try { requireSameOrigin(request); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403, headers: { "Cache-Control": "no-store" } }); }
  return provisioningAction(request, getEnv(context));
}
