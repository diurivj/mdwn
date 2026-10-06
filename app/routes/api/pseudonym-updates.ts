import { requireSameOrigin } from "~/auth/request.server";
import { pseudonymAction } from "~/account/pseudonym.server";
import { getEnv } from "~/context/env";

import type { Route } from "./+types/pseudonym-updates";

export async function action({ request, context }: Route.ActionArgs) {
  try {
    requireSameOrigin(request);
  } catch {
    return Response.json({ error: "device_proof_required" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return pseudonymAction(request, getEnv(context));
}
