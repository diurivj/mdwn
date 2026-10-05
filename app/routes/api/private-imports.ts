import { requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { importAction } from "~/import/staging.server";

import type { Route } from "./+types/private-imports";

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  try { requireSameOrigin(request); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403,
    headers: { "Cache-Control": "no-store" } }); }
  return importAction(request, getEnv(context));
}
