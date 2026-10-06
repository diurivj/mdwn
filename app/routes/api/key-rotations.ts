import { requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { rotationAction } from "~/sharing/rotation.server";
import type { Route } from "./+types/key-rotations";

export async function action({ request, context }: Route.ActionArgs) {
  try {
    requireSameOrigin(request);
  } catch {
    return Response.json({ error: "device_proof_required" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return rotationAction(request, getEnv(context));
}
